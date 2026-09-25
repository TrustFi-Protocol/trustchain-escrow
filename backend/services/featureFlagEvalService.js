/**
 * Feature Flag Evaluation Service — Issue #232: Feature Flag Evaluation Preview
 *
 * Allows admins to preview whether a flag would apply for a specific tenant,
 * role, and user combination BEFORE persisting changes.
 * Supports: percentage rollout, target user lists, and binary enable/disable.
 */

import prisma from '../lib/prisma.js';

/**
 * Determine if a flag applies to a given context without persisting.
 * Used for the admin preview UI in Issue #232.
 *
 * @param {string} flagKey - Feature flag key
 * @param {object} context - Evaluation context
 * @param {string} context.address - Stellar wallet address (for user targeting)
 * @param {string} [context.role='user'] - User role (for role-based rollout)
 * @param {string} [context.tenantId] - Tenant ID (for multi-tenant rules)
 * @returns {Promise<object>} { applies: boolean, rule: string|null, variant: null }
 */
async function previewEvaluation(flagKey, context = {}) {
  const { address, role = 'user', tenantId = null } = context;

  // Fetch the flag
  const flag = await prisma.featureFlag.findUnique({
    where: { key: flagKey },
  });

  if (!flag) {
    return {
      applies: false,
      rule: 'flag_not_found',
      variant: null,
    };
  }

  // If the flag is globally disabled, it doesn't apply
  if (!flag.isEnabled) {
    return {
      applies: false,
      rule: 'flag_disabled',
      variant: null,
    };
  }

  // Check if user is in target users list
  if (address && flag.targetUsers && flag.targetUsers.length > 0) {
    if (flag.targetUsers.includes(address)) {
      return {
        applies: true,
        rule: 'target_user',
        variant: null,
      };
    }
    // If there's a target user list and this address isn't in it, don't apply
    return {
      applies: false,
      rule: 'not_in_target_list',
      variant: null,
    };
  }

  // Check percentage-based rollout
  if (flag.percentage > 0 && flag.percentage < 100) {
    // Deterministic hash based on address to ensure consistent rollout
    const hash = hashAddress(address || tenantId || 'anon');
    const rolloutValue = hash % 100;

    const applies = rolloutValue < flag.percentage;
    return {
      applies,
      rule: applies ? 'percentage_rollout_included' : 'percentage_rollout_excluded',
      variant: null,
      percentageValue: rolloutValue,
      percentageThreshold: flag.percentage,
    };
  }

  // If percentage is 100% or there's no targeting logic, flag applies
  return {
    applies: true,
    rule: 'globally_enabled',
    variant: null,
  };
}

/**
 * Save a feature flag rule configuration.
 * After admin previews with previewEvaluation, this persists the rule.
 */
async function saveFlag(key, config = {}) {
  const {
    description = '',
    isEnabled = false,
    percentage = 0,
    targetUsers = [],
  } = config;

  if (percentage < 0 || percentage > 100) {
    throw new Error('Percentage must be 0-100');
  }

  return prisma.featureFlag.upsert({
    where: { key },
    update: {
      description,
      isEnabled,
      percentage,
      targetUsers: targetUsers || [],
    },
    create: {
      key,
      description,
      isEnabled,
      percentage,
      targetUsers: targetUsers || [],
    },
  });
}

/** Get a flag configuration. */
async function getFlag(key) {
  return prisma.featureFlag.findUnique({ where: { key } });
}

/** List all flags. */
async function listFlags() {
  return prisma.featureFlag.findMany({
    orderBy: { updatedAt: 'desc' },
  });
}

/** Delete a flag. */
async function deleteFlag(key) {
  return prisma.featureFlag.delete({ where: { key } });
}

/**
 * Deterministic hash to ensure consistent rollout percentages per user.
 * Same address always gets the same result.
 */
function hashAddress(address) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    const char = address.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

export default {
  previewEvaluation,
  saveFlag,
  getFlag,
  listFlags,
  deleteFlag,
};
