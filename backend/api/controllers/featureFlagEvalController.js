/**
 * Feature Flag Evaluation Controller — Issue #232: Feature Flag Evaluation Preview
 *
 * Routes:
 * POST /api/admin/flags/preview    — Preview flag evaluation (doesn't persist)
 * GET  /api/admin/flags/:key       — Get flag config
 * PATCH /api/admin/flags/:key      — Update flag config (persists preview results)
 */

import featureFlagEvalService from '../../services/featureFlagEvalService.js';
import { logControllerError } from '../../config/logger.js';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * POST /api/admin/flags/preview — Preview whether a flag would apply
 * for a given address, role, and tenant WITHOUT persisting changes.
 *
 * Body:
 * {
 *   flagKey: "string",
 *   address: "G...",
 *   role: "user|admin|superadmin",
 *   tenantId: "optional"
 * }
 *
 * Returns:
 * {
 *   applies: boolean,
 *   rule: "string (human-readable matching rule)",
 *   variant: null,
 *   percentageValue?: number,
 *   percentageThreshold?: number
 * }
 */
const previewEvaluation = async (req, res) => {
  try {
    const { flagKey, address, role = 'user', tenantId } = req.body;

    if (!flagKey) {
      return res.status(400).json({ error: 'Flag key required' });
    }

    if (address && !STELLAR_ADDRESS_RE.test(address)) {
      return res.status(400).json({ error: 'Invalid Stellar address' });
    }

    // Preview WITHOUT persisting to database
    const evaluation = await featureFlagEvalService.previewEvaluation(flagKey, {
      address,
      role,
      tenantId: tenantId || req.tenant?.id || 'default',
    });

    res.json(evaluation);
  } catch (err) {
    logControllerError('featureFlag.preview', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/admin/flags/:key — Get current flag configuration. */
const getFlag = async (req, res) => {
  try {
    const { key } = req.params;
    const flag = await featureFlagEvalService.getFlag(key);

    if (!flag) {
      return res.status(404).json({ error: 'Flag not found' });
    }

    res.json(flag);
  } catch (err) {
    logControllerError('featureFlag.get', err, req);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/admin/flags/:key — Update and persist flag configuration
 * after admin has previewed with previewEvaluation.
 *
 * Body:
 * {
 *   description: "string",
 *   isEnabled: boolean,
 *   percentage: 0-100,
 *   targetUsers: ["G...", "G..."]
 * }
 */
const updateFlag = async (req, res) => {
  try {
    const { key } = req.params;
    const { description, isEnabled, percentage, targetUsers } = req.body;

    if (percentage !== undefined && (percentage < 0 || percentage > 100)) {
      return res.status(400).json({ error: 'Percentage must be 0-100' });
    }

    // Validate target users if provided
    if (targetUsers && Array.isArray(targetUsers)) {
      for (const user of targetUsers) {
        if (!STELLAR_ADDRESS_RE.test(user)) {
          return res.status(400).json({ error: `Invalid Stellar address: ${user}` });
        }
      }
    }

    const flag = await featureFlagEvalService.saveFlag(key, {
      description,
      isEnabled,
      percentage,
      targetUsers,
    });

    res.json(flag);
  } catch (err) {
    logControllerError('featureFlag.update', err, req);
    res.status(500).json({ error: err.message });
  }
};

export default {
  previewEvaluation,
  getFlag,
  updateFlag,
};
