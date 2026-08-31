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
 * POST /api/payments/checkout — create a Stripe checkout session for
 * funding an escrow via fiat on-ramp.
 *
 * Requires the authenticated wallet to match the `address` in the request
 * body, and requires that address to have an `Approved` KYC status.
 *
 * @param {import('express').Request} req - Express request. Expects
 *   `req.body.address` (Stellar address), `req.body.amountUsd` (positive
 *   number), and optional `req.body.escrowId`.
 * @param {import('express').Response} res - Express response. Responds
 *   with the created checkout session on success (200), or a 400/403/500
 *   error body.
 * @returns {Promise<void>} Resolves once the response has been sent.
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
 * GET /api/payments/status/:sessionId — get payment status by Stripe
 * checkout session ID.
 *
 * Only the wallet that owns the payment may look it up.
 *
 * @param {import('express').Request} req - Express request. Expects
 *   `req.params.sessionId` (Stripe checkout session ID).
 * @param {import('express').Response} res - Express response. Responds
 *   with the payment record (200), or a 403/404/500 error body.
 * @returns {Promise<void>} Resolves once the response has been sent.
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
 *
 * The requested address must match the authenticated wallet's address.
 *
 * @param {import('express').Request} req - Express request. Expects
 *   `req.params.address` (Stellar address).
 * @param {import('express').Response} res - Express response. Responds
 *   with an array of payment records (200), or a 400/403/500 error body.
 * @returns {Promise<void>} Resolves once the response has been sent.
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
 * POST /api/payments/:paymentId/refund — issue a full refund for a
 * payment owned by the authenticated wallet.
 *
 * @param {import('express').Request} req - Express request. Expects
 *   `req.params.paymentId`.
 * @param {import('express').Response} res - Express response. Responds
 *   with the updated payment record (200), or a 400/403/404/500 error
 *   body (a 400 is used when the underlying refund is rejected as
 *   unrefundable, e.g. "Cannot refund ...").
 * @returns {Promise<void>} Resolves once the response has been sent.
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
 * POST /api/payments/webhook — Stripe webhook receiver.
 *
 * Verifies the `stripe-signature` header against the raw request body
 * before dispatching to `paymentService.handleWebhook`. Unauthenticated
 * (called directly by Stripe, not a logged-in wallet).
 *
 * @param {import('express').Request} req - Express request. Expects the
 *   `stripe-signature` header and a raw (unparsed) `req.rawBody`.
 * @param {import('express').Response} res - Express response. Responds
 *   `{ ok: true }` (200) on success, or a 400 error body if signature
 *   verification or event handling fails.
 * @returns {Promise<void>} Resolves once the response has been sent.
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
