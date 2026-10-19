import { getLogger, logControllerError } from '../../config/logger.js';
import paymentService from '../../services/paymentService.js';
import kycService from '../../services/kycService.js';
import { getAuthenticatedWalletAddress } from '../middleware/authorization.js';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

// ── Replay protection configuration ───────────────────────────────────────────

const KEY_LENGTH_LIMIT = 255;

/**
 * Validates payment submission replay protection settings.
 * Throws one error listing every problem; messages name the setting, never its value.
 *
 *   PAYMENT_REPLAY_REQUIRE_IDEMPOTENCY_KEY  'true' | 'false' (default 'false')
 *   PAYMENT_REPLAY_KEY_MIN_LENGTH           integer 1–255 (default 1)
 *   PAYMENT_REPLAY_KEY_MAX_LENGTH           integer 1–255 (default 255)
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ requireKey: boolean, minKeyLength: number, maxKeyLength: number }}
 */
export function loadReplayProtectionConfig(env = process.env) {
  const errors = [];

  const readBool = (name) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return false;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    errors.push(`${name} must be "true" or "false".`);
    return false;
  };

  const readLength = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1 && value <= KEY_LENGTH_LIMIT) return value;
    errors.push(`${name} must be an integer between 1 and ${KEY_LENGTH_LIMIT}.`);
    return fallback;
  };

  const config = {
    requireKey: readBool('PAYMENT_REPLAY_REQUIRE_IDEMPOTENCY_KEY'),
    minKeyLength: readLength('PAYMENT_REPLAY_KEY_MIN_LENGTH', 1),
    maxKeyLength: readLength('PAYMENT_REPLAY_KEY_MAX_LENGTH', KEY_LENGTH_LIMIT),
  };

  if (config.minKeyLength > config.maxKeyLength) {
    errors.push(
      'PAYMENT_REPLAY_KEY_MIN_LENGTH must not exceed PAYMENT_REPLAY_KEY_MAX_LENGTH.',
    );
  }

  if (errors.length) {
    throw new Error(`Invalid payment replay protection configuration: ${errors.join(' ')}`);
  }
  return Object.freeze(config);
}

// Fail fast at startup rather than on the first payment submission.
const replayConfig = loadReplayProtectionConfig();

/** Returns an error message when the Idempotency-Key header violates the replay policy. */
export function checkIdempotencyKey(req, config = replayConfig) {
  const key = req.headers?.['idempotency-key'];
  if (key === undefined || key === '') {
    return config.requireKey ? 'Idempotency-Key header is required for payment submission' : null;
  }
  if (key.length < config.minKeyLength || key.length > config.maxKeyLength) {
    return `Idempotency-Key must be between ${config.minKeyLength} and ${config.maxKeyLength} characters`;
  }
  return null;
}

function requireOwnedWallet(req, res) {
  const walletAddress = getAuthenticatedWalletAddress(req);
  if (!walletAddress) {
    res.status(403).json({ error: 'Authenticated user is not linked to a wallet address.' });
    return null;
  }

  return walletAddress;
}

/** POST /api/payments/checkout — create a Stripe checkout session. */
const createCheckout = async (req, res) => {
  try {
    const { address, amountUsd, escrowId } = req.body;
    const walletAddress = requireOwnedWallet(req, res);
    if (!walletAddress) return;

    const replayError = checkIdempotencyKey(req);
    if (replayError) return res.status(400).json({ error: replayError });

    if (!address || !STELLAR_ADDRESS_RE.test(address)) {
      return res.status(400).json({ error: 'Valid Stellar address required' });
    }
    if (address !== walletAddress) {
      return res
        .status(403)
        .json({ error: 'Forbidden: cannot create checkout for another wallet.' });
    }
    if (!amountUsd || typeof amountUsd !== 'number' || amountUsd <= 0) {
      return res.status(400).json({ error: 'amountUsd must be a positive number' });
    }

    // KYC gate — require Approved status for fiat on-ramp
    const kyc = await kycService.getStatus(address);
    if (kyc?.status !== 'Approved') {
      return res.status(403).json({ error: 'KYC verification required before funding via fiat' });
    }

    const result = await paymentService.createCheckoutSession({ address, amountUsd, escrowId });
    res.json(result);
  } catch (err) {
    logControllerError('payment.createCheckout', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/payments/status/:sessionId — get payment status by Stripe session ID. */
const getStatus = async (req, res) => {
  try {
    const walletAddress = requireOwnedWallet(req, res);
    if (!walletAddress) return;

    const payment = await paymentService.getBySessionId(req.params.sessionId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.address !== walletAddress) {
      return res.status(403).json({ error: 'Forbidden: cannot access another wallet payment.' });
    }
    res.json(payment);
  } catch (err) {
    logControllerError('payment.getStatus', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/payments/:address — list payments for a Stellar address. */
const listByAddress = async (req, res) => {
  try {
    const { address } = req.params;
    const walletAddress = requireOwnedWallet(req, res);
    if (!walletAddress) return;

    if (!STELLAR_ADDRESS_RE.test(address)) {
      return res.status(400).json({ error: 'Invalid Stellar address' });
    }
    if (address !== walletAddress) {
      return res
        .status(403)
        .json({ error: 'Forbidden: cannot access another wallet payment history.' });
    }
    const payments = await paymentService.getByAddress(address);
    res.json(payments);
  } catch (err) {
    logControllerError('payment.listByAddress', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** POST /api/payments/:paymentId/refund — issue a full refund. */
const refund = async (req, res) => {
  try {
    const walletAddress = requireOwnedWallet(req, res);
    if (!walletAddress) return;

    const existingPayment = await paymentService.getById(req.params.paymentId);
    if (!existingPayment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (existingPayment.address !== walletAddress) {
      return res.status(403).json({ error: 'Forbidden: cannot refund another wallet payment.' });
    }

    const payment = await paymentService.refund(req.params.paymentId);
    res.json(payment);
  } catch (err) {
    const status = err.message.startsWith('Cannot refund') ? 400 : 500;
    if (status >= 500) logControllerError('payment.refund', err, req);
    res.status(status).json({ error: err.message });
  }
};

/** POST /api/payments/webhook — Stripe webhook receiver. */
const webhook = async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing stripe-signature header' });
    await paymentService.handleWebhook(req.rawBody, signature);
    res.json({ ok: true });
  } catch (err) {
    getLogger().warn({
      message: 'payment.webhook_rejected',
      error: err.message,
    });
    res.status(400).json({ error: err.message });
  }
};

export default { createCheckout, getStatus, listByAddress, refund, webhook };
