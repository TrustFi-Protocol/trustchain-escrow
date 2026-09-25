/**
 * Feature Flags Service
 *
 * Tenant-aware feature flag evaluation with percentage rollout and explicit
 * user targeting. Supports both global flags and tenant-scoped overrides so
 * that individual tenants can opt-in or opt-out of features independently of
 * the platform-wide rollout configuration.
 *
 * Evaluation is sampled-logged at the module logger level. The sampling rate
 * is controlled by FEATURE_FLAG_LOG_SAMPLE_RATE (float 0.0–1.0, default 0.1).
 * Logs never include userId/address in plain text — only a hashed token is
 * emitted when needed for debugging.
 *
 * @module services/featureFlags
 */

import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { log, AuditCategory } from './auditService.js';
import { createModuleLogger } from '../config/logger.js';

/** Module-level structured logger (named `logger` to avoid shadowing the audit `log` import). */
const logger = createModuleLogger('featureFlags');

/**
 * Sampling rate for evaluation log lines.
 * Reads FEATURE_FLAG_LOG_SAMPLE_RATE from the environment at call time so that
 * it can be overridden in tests without restarting the process.
 */
function getSamplingRate() {
  return parseFloat(process.env.FEATURE_FLAG_LOG_SAMPLE_RATE || '0.1');
}

/**
 * Deterministic hash of userId + flagKey → integer 0–99.
 * Same user always gets the same bucket for a given flag.
 */
function hashBucket(userId, flagKey) {
  const hash = crypto.createHash('sha256').update(`${userId}:${flagKey}`).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % 100;
}

/**
 * One-way hash of an arbitrary string for privacy-safe log fields.
 * Truncated to 16 hex chars — enough for correlation, not enough for reversal.
 *
 * @param {string} value
 * @returns {string}
 */
function privacyHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * Emit a sampled evaluation log line.
 *
 * Fields included:
 *   flagKey    — the flag being evaluated
 *   tenantId   — raw tenantId (tenant IDs are not user PII)
 *   userHash   — truncated SHA-256 of userId (never plain text)
 *   result     — boolean outcome
 *   variant    — 'on' | 'off'
 *   reason     — why the result was reached
 *
 * @param {object} opts
 * @param {string}  opts.flagKey
 * @param {unknown} opts.tenantId
 * @param {unknown} opts.userId
 * @param {boolean} opts.result
 * @param {string}  opts.reason
 */
function emitEvalLog({ flagKey, tenantId, userId, result, reason }) {
  const samplingRate = getSamplingRate();
  if (Math.random() >= samplingRate) return;

  logger.info('feature_flag_eval', {
    flagKey,
    tenantId: tenantId != null ? String(tenantId) : undefined,
    userHash: userId != null ? privacyHash(String(userId)) : undefined,
    result,
    variant: result ? 'on' : 'off',
    reason,
  });
}

/**
 * Evaluate whether a feature flag is active for a given user context.
 *
 * Evaluation order:
 *  1. Flag not found                   → false  (reason: flag_not_found)
 *  2. Tenant-level override exists     → use tenant value
 *                                         (reason: tenant_override_true | tenant_override_false)
 *  3. Flag disabled globally and user
 *     is in targetUsers                → true   (reason: globally_disabled_targeted)
 *  4. Flag disabled globally and user
 *     is NOT in targetUsers            → false  (reason: globally_disabled_not_targeted)
 *  5. User explicitly in targetUsers   → true   (reason: explicitly_targeted)
 *  6. User's hash bucket < percentage  → true   (reason: percentage_rollout)
 *  7. Otherwise                        → false  (reason: percentage_rollout)
 *
 * @param {string} flagKey
 * @param {{ id: string|number, tenantId?: string|number }} userContext
 * @returns {Promise<boolean>}
 */
export async function isFeatureEnabled(flagKey, userContext) {
  const flag = await prisma.featureFlag.findUnique({ where: { key: flagKey } });

  if (!flag) {
    emitEvalLog({
      flagKey,
      tenantId: userContext.tenantId,
      userId: userContext.id,
      result: false,
      reason: 'flag_not_found',
    });
    return false;
  }

  // ── Tenant-level override ────────────────────────────────────────────────
  if (userContext.tenantId) {
    const tenantOverride = await getTenantFlagOverride(flagKey, String(userContext.tenantId));
    if (tenantOverride !== null) {
      const reason = tenantOverride ? 'tenant_override_true' : 'tenant_override_false';
      emitEvalLog({
        flagKey,
        tenantId: userContext.tenantId,
        userId: userContext.id,
        result: tenantOverride,
        reason,
      });
      return tenantOverride;
    }
  }

  // ── Globally disabled path ───────────────────────────────────────────────
  if (!flag.isEnabled) {
    const targeted = flag.targetUsers.includes(String(userContext.id));
    const reason = targeted ? 'globally_disabled_targeted' : 'globally_disabled_not_targeted';
    emitEvalLog({
      flagKey,
      tenantId: userContext.tenantId,
      userId: userContext.id,
      result: targeted,
      reason,
    });
    return targeted;
  }

  // ── Explicit targeting ───────────────────────────────────────────────────
  if (flag.targetUsers.includes(String(userContext.id))) {
    emitEvalLog({
      flagKey,
      tenantId: userContext.tenantId,
      userId: userContext.id,
      result: true,
      reason: 'explicitly_targeted',
    });
    return true;
  }

  // ── Percentage rollout ───────────────────────────────────────────────────
  const result = hashBucket(String(userContext.id), flagKey) < flag.percentage;
  emitEvalLog({
    flagKey,
    tenantId: userContext.tenantId,
    userId: userContext.id,
    result,
    reason: 'percentage_rollout',
  });
  return result;
}

/**
 * Get a tenant-level override for a flag, if one exists.
 * Returns null when no override is set (fall through to global flag).
 *
 * @param {string} flagKey
 * @param {string} tenantId
 * @returns {Promise<boolean|null>}
 */
async function getTenantFlagOverride(flagKey, tenantId) {
  try {
    const override = await prisma.tenantFeatureFlagOverride.findUnique({
      where: { tenantId_flagKey: { tenantId, flagKey } },
    });
    return override ? override.isEnabled : null;
  } catch {
    // tenantFeatureFlagOverride table may not exist yet — return null gracefully
    return null;
  }
}

/**
 * List all flag states for a specific tenant, merging global flags with
 * any tenant-level overrides.
 *
 * @param {string} tenantId
 * @returns {Promise<Array<{ key: string, isEnabled: boolean, source: 'tenant'|'global' }>>}
 */
export async function listFlagsForTenant(tenantId) {
  const [globalFlags, overrides] = await Promise.all([
    prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
    prisma.tenantFeatureFlagOverride.findMany({ where: { tenantId } }).catch(() => []), // table may not exist yet
  ]);

  const overrideMap = new Map(overrides.map((o) => [o.flagKey, o.isEnabled]));

  return globalFlags.map((flag) => {
    const hasOverride = overrideMap.has(flag.key);
    return {
      key: flag.key,
      description: flag.description,
      isEnabled: hasOverride ? overrideMap.get(flag.key) : flag.isEnabled,
      percentage: flag.percentage,
      source: hasOverride ? 'tenant' : 'global',
    };
  });
}

/**
 * Set a tenant-level override for a feature flag.
 *
 * @param {string} flagKey
 * @param {string} tenantId
 * @param {boolean} isEnabled
 * @param {string} adminId  - who made the change (for audit)
 */
export async function setTenantFlagOverride(flagKey, tenantId, isEnabled, adminId) {
  await prisma.tenantFeatureFlagOverride
    .upsert({
      where: { tenantId_flagKey: { tenantId, flagKey } },
      create: { tenantId, flagKey, isEnabled },
      update: { isEnabled },
    })
    .catch(async () => {
      // If the model doesn't exist yet, log a warning but don't crash
      console.warn('[FeatureFlags] tenantFeatureFlagOverride model unavailable — skipping upsert');
    });

  await _auditFlagChange('TENANT_FLAG_OVERRIDE_SET', flagKey, adminId, {
    tenantId,
    isEnabled,
  });
}

/**
 * Remove a tenant-level override, reverting the tenant to global behaviour.
 *
 * @param {string} flagKey
 * @param {string} tenantId
 * @param {string} adminId
 */
export async function removeTenantFlagOverride(flagKey, tenantId, adminId) {
  await prisma.tenantFeatureFlagOverride
    .delete({
      where: { tenantId_flagKey: { tenantId, flagKey } },
    })
    .catch(() => {}); // no-op if override didn't exist

  await _auditFlagChange('TENANT_FLAG_OVERRIDE_REMOVED', flagKey, adminId, { tenantId });
}

/**
 * Return all flags (for admin listing).
 */
export async function listFlags() {
  return prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
}

/**
 * Create a new feature flag.
 */
export async function createFlag(
  { key, isEnabled = false, percentage = 0, targetUsers = [], description = '' },
  adminId,
) {
  const flag = await prisma.featureFlag.create({
    data: { key, isEnabled, percentage, targetUsers, description },
  });
  await _auditFlagChange('FLAG_CREATED', flag.key, adminId, { isEnabled, percentage });
  return flag;
}

/**
 * Update an existing flag. Logs every change.
 */
export async function updateFlag(key, patch, adminId) {
  const flag = await prisma.featureFlag.update({
    where: { key },
    data: patch,
  });
  await _auditFlagChange('FLAG_UPDATED', key, adminId, patch);
  return flag;
}

/**
 * Delete a flag.
 */
export async function deleteFlag(key, adminId) {
  await prisma.featureFlag.delete({ where: { key } });
  await _auditFlagChange('FLAG_DELETED', key, adminId, {});
}

async function _auditFlagChange(action, flagKey, adminId, changes) {
  await log({
    category: AuditCategory.ADMIN,
    action,
    actor: String(adminId ?? 'admin'),
    resourceId: flagKey,
    metadata: changes,
  });
}
