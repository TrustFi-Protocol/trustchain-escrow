/**
 * KYC Service — Sumsub integration
 *
 * Handles applicant creation, SDK token generation, and webhook signature verification.
 * Docs: https://developers.sumsub.com/api-reference/
 */

import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import auditService, { AuditCategory, AuditAction } from './auditService.js';

const {
  SUMSUB_APP_TOKEN,
  SUMSUB_SECRET_KEY,
  SUMSUB_BASE_URL = 'https://api.sumsub.com',
} = process.env;

const LEVEL_NAME = process.env.SUMSUB_LEVEL_NAME || 'basic-kyc-level';

/** Build a signed Sumsub request (HMAC-SHA256). */
function buildHeaders(method, path, body = '') {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = ts + method.toUpperCase() + path + (body ? body : '');
  const signature = crypto.createHmac('sha256', SUMSUB_SECRET_KEY).update(payload).digest('hex');

  return {
    'X-App-Token': SUMSUB_APP_TOKEN,
    'X-App-Access-Sig': signature,
    'X-App-Access-Ts': ts,
    'Content-Type': 'application/json',
  };
}

async function sumsubFetch(method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(`${SUMSUB_BASE_URL}${path}`, {
    method,
    headers: buildHeaders(method, path, bodyStr),
    body: bodyStr || undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sumsub ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/** Create or retrieve a Sumsub applicant for the given Stellar address. */
async function getOrCreateApplicant(address) {
  let record = await prisma.kycVerification.findUnique({ where: { address } });

  if (record?.applicantId) return record;

  const applicant = await sumsubFetch('POST', '/resources/applicants?levelName=' + LEVEL_NAME, {
    externalUserId: address,
  });

  record = await prisma.kycVerification.upsert({
    where: { address },
    update: { applicantId: applicant.id, status: 'Init' },
    create: { address, applicantId: applicant.id, status: 'Init' },
  });

  return record;
}

/**
 * Generate a short-lived SDK access token for the frontend widget.
 *
 * @param {string} address — Stellar public key of the applicant
 * @returns {Promise<{ token: string, applicantId: string }>}
 */
async function generateSdkToken(address) {
  const record = await getOrCreateApplicant(address);
  const data = await sumsubFetch(
    'POST',
    `/resources/accessTokens?userId=${record.applicantId}&levelName=${LEVEL_NAME}`,
  );
  return { token: data.token, applicantId: record.applicantId };
}

/**
 * Get current KYC status for an address (from DB, not Sumsub).
 *
 * @param {string} address — Stellar public key
 * @returns {Promise<object|null>} the KYC verification record, or null if none exists
 */
async function getStatus(address) {
  return prisma.kycVerification.findUnique({ where: { address } });
}

/**
 * Get all KYC records for admin review (paginated).
 *
 * @param {object} [options]
 * @param {number} [options.skip=0] — number of records to skip
 * @param {number} [options.take=20] — max number of records to return
 * @param {string} [options.status] — filter by KYC status
 * @returns {Promise<{ data: object[], total: number }>}
 */
async function listAll({ skip = 0, take = 20, status } = {}) {
  const where = status ? { status } : {};
  const [data, total] = await prisma.$transaction([
    prisma.kycVerification.findMany({ where, skip, take, orderBy: { updatedAt: 'desc' } }),
    prisma.kycVerification.count({ where }),
  ]);
  return { data, total };
}

/**
 * Process a Sumsub webhook event and update DB status.
 *
 * @param {object} payload — Sumsub webhook payload
 * @param {string} payload.externalUserId — Stellar address of the applicant
 * @param {string} payload.applicantId — Sumsub applicant ID
 * @param {string} payload.type — webhook event type
 * @param {object} [payload.reviewResult] — review outcome, present on `applicantReviewed`
 * @returns {Promise<object|null>} the updated record, or null for unhandled event types
 */
async function handleWebhook(payload) {
  const { externalUserId, applicantId, type, reviewResult } = payload;

  const statusMap = {
    applicantCreated: 'Init',
    applicantPending: 'Processing',
    applicantReviewed: reviewResult?.reviewAnswer === 'GREEN' ? 'Approved' : 'Declined',
  };

  const newStatus = statusMap[type];
  if (!newStatus) return null; // unhandled event type

  const record = await prisma.kycVerification.upsert({
    where: { address: externalUserId },
    update: {
      applicantId,
      status: newStatus,
      reviewResult: reviewResult?.reviewAnswer ?? null,
      rejectLabels: reviewResult?.rejectLabels ?? [],
    },
    create: {
      address: externalUserId,
      applicantId,
      status: newStatus,
      reviewResult: reviewResult?.reviewAnswer ?? null,
      rejectLabels: reviewResult?.rejectLabels ?? [],
    },
  });

  const actionMap = {
    applicantReviewed:
      reviewResult?.reviewAnswer === 'GREEN' ? AuditAction.KYC_APPROVED : AuditAction.KYC_DECLINED,
  };
  const auditAction = actionMap[type] ?? AuditAction.KYC_SUBMITTED;

  await auditService.log({
    category: AuditCategory.KYC,
    action: auditAction,
    actor: externalUserId,
    resourceId: applicantId,
    metadata: { type, reviewResult },
  });

  return record;
}

/**
 * Verify Sumsub webhook HMAC signature.
 *
 * @param {string} rawBody — raw request body used to compute the signature
 * @param {string} signature — signature received in the webhook headers
 * @returns {boolean} true if the signature is valid
 */
function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto.createHmac('sha256', SUMSUB_SECRET_KEY).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export default {
  generateSdkToken,
  getStatus,
  listAll,
  handleWebhook,
  verifyWebhookSignature,
};
