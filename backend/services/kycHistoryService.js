/**
 * KYC History Service — Timeline Tracking for Issue #229
 *
 * Maintains immutable audit trail of KYC status changes,
 * showing who changed the status, why, and when.
 * Respects user privacy: only admins see others' full history.
 */

import prisma from '../lib/prisma.js';

const KYC_STATUS_ENUM = ['Pending', 'Init', 'Processing', 'Approved', 'Declined'];

/** Record a KYC status change in the immutable history. */
async function recordStatusChange(tenantId, address, oldStatus, newStatus, actor, reason = '', metadata = {}) {
  if (!KYC_STATUS_ENUM.includes(oldStatus) || !KYC_STATUS_ENUM.includes(newStatus)) {
    throw new Error('Invalid KYC status');
  }

  return prisma.kycHistory.create({
    data: {
      tenantId,
      address,
      oldStatus,
      newStatus,
      actor,
      reason,
      metadata: metadata || {},
    },
  });
}

/** Get KYC history timeline for an address (paginated). */
async function getHistory(tenantId, address, { skip = 0, take = 20 } = {}) {
  const [events, total] = await prisma.$transaction([
    prisma.kycHistory.findMany({
      where: { tenantId, address },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.kycHistory.count({ where: { tenantId, address } }),
  ]);

  return { events, total };
}

/** Get all KYC status changes for admin review (paginated, tenant-scoped). */
async function getAllHistory(tenantId, { skip = 0, take = 50, address = null } = {}) {
  const where = { tenantId, ...(address ? { address } : {}) };

  const [events, total] = await prisma.$transaction([
    prisma.kycHistory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.kycHistory.count({ where }),
  ]);

  return { events, total };
}

/** Called whenever kycService.handleWebhook updates a KYC record. */
async function recordWebhookChange(tenantId, address, oldStatus, newStatus, sumsub_event) {
  const metadata = {
    eventType: sumsub_event.type,
    reviewResult: sumsub_event.reviewResult ?? null,
  };

  const reasonMap = {
    applicantCreated: 'Applicant created via Sumsub',
    applicantPending: 'Verification in progress',
    applicantReviewed:
      sumsub_event.reviewResult?.reviewAnswer === 'GREEN'
        ? 'Approved by Sumsub verification'
        : 'Declined by Sumsub verification',
  };

  const reason = reasonMap[sumsub_event.type] || 'Status changed via webhook';

  return recordStatusChange(tenantId, address, oldStatus, newStatus, 'system', reason, metadata);
}

export default {
  recordStatusChange,
  getHistory,
  getAllHistory,
  recordWebhookChange,
};
