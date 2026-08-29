import { getLogger, logControllerError } from '../../config/logger.js';
import paymentService from '../../services/paymentService.js';
import kycService from '../../services/kycService.js';
import { getAuthenticatedWalletAddress } from '../middleware/authorization.js';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function requireOwnedWallet(req, res) {
  const walletAddress = getAuthenticatedWalletAddress(req);
  if (!walletAddress) {
    res.status(403).json({ error: 'Authenticated user is not linked to a wallet address.' });
    return null;
  }

  return walletAddress;
}

/**
 * POST /api/payments/checkout — create a Stripe checkout session for funding
 * an escrow via fiat on-ramp. Requires the caller's authenticated wallet to
 * match the requested Stellar address and to have Approved KYC status.
 *
 * @param {import('express').Request} req - Express request; body must include
 *   `address` (Stellar G-address), `amountUsd` (positive number), and
 *   `escrowId`.
 * @param {import('express').Response} res - Express response. Responds with
 *   the created checkout session on success, or a 4xx/5xx error otherwise.
 * @returns {Promise<void>}
 */
const createCheckout = async (req, res) => {
  try {
    const { address, amountUsd, escrowId } = req.body;
    const walletAddress = requireOwnedWallet(req, res);
    if (!walletAddress) return;

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

/**
 * GET /api/payments/status/:sessionId — fetch a payment by its Stripe
 * checkout session ID. Only the wallet that owns the payment may access it.
 *
 * @param {import('express').Request} req - Express request; `req.params.sessionId`
 *   is the Stripe checkout session ID to look up.
 * @param {import('express').Response} res - Express response. Responds with
 *   the payment record on success, 404 if not found, or 403 if the
 *   authenticated wallet doesn't own it.
 * @returns {Promise<void>}
 */
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

/**
 * GET /api/payments/:address — list all payments for a Stellar address.
 * The requesting wallet may only list its own payment history.
 *
 * @param {import('express').Request} req - Express request; `req.params.address`
 *   is the Stellar G-address to list payments for.
 * @param {import('express').Response} res - Express response. Responds with
 *   an array of payments, or a 400/403 error.
 * @returns {Promise<void>}
 */
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

/**
 * POST /api/payments/:paymentId/refund — issue a full refund for a payment.
 * Only the wallet that owns the payment may refund it.
 *
 * @param {import('express').Request} req - Express request; `req.params.paymentId`
 *   is the ID of the payment to refund.
 * @param {import('express').Response} res - Express response. Responds with
 *   the refunded payment record, 404 if not found, 403 if not owned by the
 *   caller, or 400 if the payment can't be refunded.
 * @returns {Promise<void>}
 */
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

/**
 * POST /api/payments/webhook — Stripe webhook receiver. Verifies the
 * `Stripe-Signature` header against the raw request body before delegating
 * to `paymentService.handleWebhook`.
 *
 * @param {import('express').Request} req - Express request; expects a
 *   `stripe-signature` header and `req.rawBody` set by upstream middleware.
 * @param {import('express').Response} res - Express response. Responds with
 *   `{ ok: true }` on success, or 400 if the signature/body is invalid.
 * @returns {Promise<void>}
 */
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
