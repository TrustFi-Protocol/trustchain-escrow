/**
 * Tests for tenant-aware feature flag evaluation logging (issue #199).
 *
 * Verifies that `isFeatureEnabled` emits structured log lines via the module
 * logger with the correct `reason`, `result`, `variant`, and privacy-safe
 * fields, and that sampling is correctly controlled by
 * FEATURE_FLAG_LOG_SAMPLE_RATE.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── In-memory flag store ─────────────────────────────────────────────────────
const flagStore = new Map();
const overrideStore = new Map(); // key: `${tenantId}:${flagKey}`

const prismaMock = {
  featureFlag: {
    findUnique: jest.fn(({ where }) => Promise.resolve(flagStore.get(where.key) ?? null)),
  },
  tenantFeatureFlagOverride: {
    findUnique: jest.fn(({ where }) => {
      const { tenantId, flagKey } = where.tenantId_flagKey;
      const hit = overrideStore.get(`${tenantId}:${flagKey}`);
      return Promise.resolve(hit ?? null);
    }),
  },
  auditLog: {
    create: jest.fn(() => Promise.resolve()),
  },
};

// ── Mock prisma ──────────────────────────────────────────────────────────────
jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

// ── Capture logger.info calls ────────────────────────────────────────────────
const loggerInfoMock = jest.fn();

jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: jest.fn(() => ({
    info: loggerInfoMock,
  })),
}));

// ── Mock auditService (log + AuditCategory) ──────────────────────────────────
jest.unstable_mockModule('../services/auditService.js', () => ({
  log: jest.fn(() => Promise.resolve()),
  AuditCategory: { ADMIN: 'ADMIN' },
}));

// ── Import SUT after all mocks are registered ────────────────────────────────
const { isFeatureEnabled } = await import('../services/featureFlags.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal flag object. */
function makeFlag(overrides = {}) {
  return {
    key: 'test-flag',
    isEnabled: true,
    percentage: 0,
    targetUsers: [],
    description: '',
    ...overrides,
  };
}

/** Find the logged call matching reason (or return undefined). */
function findLogCall(reason) {
  return loggerInfoMock.mock.calls.find(([, meta]) => meta?.reason === reason);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('isFeatureEnabled — evaluation logging (issue #199)', () => {
  const originalEnv = process.env.FEATURE_FLAG_LOG_SAMPLE_RATE;

  beforeEach(() => {
    flagStore.clear();
    overrideStore.clear();
    jest.clearAllMocks();
    // Default: always log so we can assert on every test
    process.env.FEATURE_FLAG_LOG_SAMPLE_RATE = '1';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FEATURE_FLAG_LOG_SAMPLE_RATE;
    } else {
      process.env.FEATURE_FLAG_LOG_SAMPLE_RATE = originalEnv;
    }
  });

  // ── reason: flag_not_found ─────────────────────────────────────────────────
  describe('flag_not_found', () => {
    it('logs reason=flag_not_found when the flag does not exist', async () => {
      const result = await isFeatureEnabled('missing-flag', { id: 'user-1', tenantId: 'tenant-A' });

      expect(result).toBe(false);
      expect(loggerInfoMock).toHaveBeenCalledTimes(1);

      const [event, meta] = loggerInfoMock.mock.calls[0];
      expect(event).toBe('feature_flag_eval');
      expect(meta).toMatchObject({
        flagKey: 'missing-flag',
        result: false,
        variant: 'off',
        reason: 'flag_not_found',
      });
    });

    it('does not include userId in plain text in the log', async () => {
      await isFeatureEnabled('missing-flag', { id: 'super-secret-user-id', tenantId: 'tenant-A' });

      const [, meta] = loggerInfoMock.mock.calls[0];
      expect(meta).not.toHaveProperty('userId');
      // userHash should be present and NOT equal to the raw id
      expect(meta.userHash).toBeDefined();
      expect(meta.userHash).not.toBe('super-secret-user-id');
    });
  });

  // ── reason: tenant_override_true ──────────────────────────────────────────
  describe('tenant_override_true', () => {
    it('logs reason=tenant_override_true when tenant override is true', async () => {
      flagStore.set('feature-x', makeFlag({ key: 'feature-x', isEnabled: false }));
      overrideStore.set('tenant-B:feature-x', { isEnabled: true });

      const result = await isFeatureEnabled('feature-x', { id: 'user-2', tenantId: 'tenant-B' });

      expect(result).toBe(true);
      const call = findLogCall('tenant_override_true');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        flagKey: 'feature-x',
        tenantId: 'tenant-B',
        result: true,
        variant: 'on',
        reason: 'tenant_override_true',
      });
    });
  });

  // ── reason: tenant_override_false ─────────────────────────────────────────
  describe('tenant_override_false', () => {
    it('logs reason=tenant_override_false when tenant override is false', async () => {
      flagStore.set('feature-y', makeFlag({ key: 'feature-y', isEnabled: true, percentage: 100 }));
      overrideStore.set('tenant-C:feature-y', { isEnabled: false });

      const result = await isFeatureEnabled('feature-y', { id: 'user-3', tenantId: 'tenant-C' });

      expect(result).toBe(false);
      const call = findLogCall('tenant_override_false');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        flagKey: 'feature-y',
        tenantId: 'tenant-C',
        result: false,
        variant: 'off',
        reason: 'tenant_override_false',
      });
    });
  });

  // ── reason: globally_disabled_not_targeted ────────────────────────────────
  describe('globally_disabled_not_targeted', () => {
    it('logs reason=globally_disabled_not_targeted when flag is off and user is not targeted', async () => {
      flagStore.set('off-flag', makeFlag({ key: 'off-flag', isEnabled: false, percentage: 100 }));

      const result = await isFeatureEnabled('off-flag', { id: 'user-99' });

      expect(result).toBe(false);
      const call = findLogCall('globally_disabled_not_targeted');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        result: false,
        variant: 'off',
        reason: 'globally_disabled_not_targeted',
      });
    });
  });

  // ── reason: globally_disabled_targeted ───────────────────────────────────
  describe('globally_disabled_targeted', () => {
    it('logs reason=globally_disabled_targeted when flag is off but user is explicitly targeted', async () => {
      flagStore.set(
        'beta-flag',
        makeFlag({
          key: 'beta-flag',
          isEnabled: false,
          percentage: 0,
          targetUsers: ['user-42'],
        }),
      );

      const result = await isFeatureEnabled('beta-flag', { id: 'user-42' });

      expect(result).toBe(true);
      const call = findLogCall('globally_disabled_targeted');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        result: true,
        variant: 'on',
        reason: 'globally_disabled_targeted',
      });
    });
  });

  // ── reason: explicitly_targeted ──────────────────────────────────────────
  describe('explicitly_targeted', () => {
    it('logs reason=explicitly_targeted when flag is enabled and user is in targetUsers', async () => {
      flagStore.set(
        'targeted-flag',
        makeFlag({
          key: 'targeted-flag',
          isEnabled: true,
          percentage: 0,
          targetUsers: ['user-7'],
        }),
      );

      const result = await isFeatureEnabled('targeted-flag', { id: 'user-7' });

      expect(result).toBe(true);
      const call = findLogCall('explicitly_targeted');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        result: true,
        variant: 'on',
        reason: 'explicitly_targeted',
      });
    });
  });

  // ── reason: percentage_rollout ────────────────────────────────────────────
  describe('percentage_rollout', () => {
    it('logs reason=percentage_rollout when outcome is determined by hash bucket', async () => {
      // Use 100% rollout so every user hits the rollout path
      flagStore.set(
        'rollout-flag',
        makeFlag({
          key: 'rollout-flag',
          isEnabled: true,
          percentage: 100,
          targetUsers: [],
        }),
      );

      const result = await isFeatureEnabled('rollout-flag', { id: 'user-any' });

      expect(result).toBe(true);
      const call = findLogCall('percentage_rollout');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        result: true,
        variant: 'on',
        reason: 'percentage_rollout',
      });
    });

    it('logs reason=percentage_rollout with result=false when user is outside the bucket', async () => {
      // 0% rollout — no hash will be < 0
      flagStore.set(
        'zero-rollout',
        makeFlag({
          key: 'zero-rollout',
          isEnabled: true,
          percentage: 0,
          targetUsers: [],
        }),
      );

      const result = await isFeatureEnabled('zero-rollout', { id: 'user-any' });

      expect(result).toBe(false);
      const call = findLogCall('percentage_rollout');
      expect(call).toBeDefined();
      const [, meta] = call;
      expect(meta).toMatchObject({
        result: false,
        variant: 'off',
        reason: 'percentage_rollout',
      });
    });
  });

  // ── Sampling: always logs at 100% ─────────────────────────────────────────
  describe('sampling at 100%', () => {
    it('always emits a log when sample rate is 1.0', async () => {
      process.env.FEATURE_FLAG_LOG_SAMPLE_RATE = '1';
      flagStore.set(
        'sampled-flag',
        makeFlag({ key: 'sampled-flag', isEnabled: true, percentage: 100 }),
      );

      // Call multiple times — every call should produce a log line
      const CALLS = 10;
      for (let i = 0; i < CALLS; i++) {
        await isFeatureEnabled('sampled-flag', { id: `user-${i}` });
      }

      expect(loggerInfoMock).toHaveBeenCalledTimes(CALLS);
    });
  });

  // ── Sampling: never logs at 0% ────────────────────────────────────────────
  describe('sampling at 0%', () => {
    it('never emits a log when sample rate is 0.0', async () => {
      process.env.FEATURE_FLAG_LOG_SAMPLE_RATE = '0';
      flagStore.set(
        'silent-flag',
        makeFlag({ key: 'silent-flag', isEnabled: true, percentage: 100 }),
      );

      const CALLS = 20;
      for (let i = 0; i < CALLS; i++) {
        await isFeatureEnabled('silent-flag', { id: `user-${i}` });
      }

      expect(loggerInfoMock).not.toHaveBeenCalled();
    });
  });

  // ── Privacy: userHash is never raw userId ─────────────────────────────────
  describe('privacy', () => {
    it('emits userHash instead of raw userId for every reason path', async () => {
      const userId = 'plaintext-user-address-GAB1234';
      flagStore.set('priv-flag', makeFlag({ key: 'priv-flag', isEnabled: true, percentage: 100 }));

      await isFeatureEnabled('priv-flag', { id: userId });

      expect(loggerInfoMock).toHaveBeenCalledTimes(1);
      const [, meta] = loggerInfoMock.mock.calls[0];

      // Raw userId must NOT appear anywhere in the logged metadata
      expect(JSON.stringify(meta)).not.toContain(userId);
      // userHash must be present and be a short hex string
      expect(meta.userHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('includes tenantId in plain text (tenant IDs are not user PII)', async () => {
      flagStore.set(
        'tenant-priv',
        makeFlag({ key: 'tenant-priv', isEnabled: true, percentage: 100 }),
      );
      overrideStore.set('tenant-X:tenant-priv', { isEnabled: true });

      await isFeatureEnabled('tenant-priv', { id: 'user-1', tenantId: 'tenant-X' });

      const [, meta] = loggerInfoMock.mock.calls[0];
      expect(meta.tenantId).toBe('tenant-X');
    });
  });
});
