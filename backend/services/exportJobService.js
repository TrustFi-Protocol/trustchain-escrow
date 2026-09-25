/**
 * Export Job Service — Issue #230: Export Job Progress UI
 *
 * Manages long-running export jobs (GDPR exports, reports, etc.)
 * Tracks status: queued → running → completed|failed|cancelled
 * Provides progress updates and result download URLs.
 */

import { nanoid } from 'nanoid';
import prisma from '../lib/prisma.js';

export const ExportStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const ExportType = {
  GDPR_EXPORT: 'gdpr_export',
  ESCROW_REPORT: 'escrow_report',
  AUDIT_LOG_EXPORT: 'audit_log_export',
  DISPUTE_EXPORT: 'dispute_export',
};

/** Create a new export job. */
async function createJob(tenantId, requestBy, type, params = {}) {
  if (!Object.values(ExportType).includes(type)) {
    throw new Error(`Invalid export type: ${type}`);
  }

  return prisma.exportJob.create({
    data: {
      id: nanoid(),
      tenantId,
      requestBy,
      type,
      status: ExportStatus.QUEUED,
      params: params || {},
    },
  });
}

/** Get a job by ID (check tenant context before using). */
async function getJob(id) {
  return prisma.exportJob.findUnique({ where: { id } });
}

/** List jobs for a user or tenant (paginated). */
async function listJobs(tenantId, { requestBy = null, skip = 0, take = 20 } = {}) {
  const where = { tenantId, ...(requestBy ? { requestBy } : {}) };

  const [jobs, total] = await prisma.$transaction([
    prisma.exportJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.exportJob.count({ where }),
  ]);

  return { jobs, total };
}

/** Update job progress while running. */
async function updateProgress(jobId, progress, itemsProcessed, totalItems) {
  if (progress < 0 || progress > 100) {
    throw new Error('Progress must be 0-100');
  }

  return prisma.exportJob.update({
    where: { id: jobId },
    data: {
      progress,
      itemsProcessed,
      totalItems,
      updatedAt: new Date(),
    },
  });
}

/** Mark job as completed with download URL. */
async function markCompleted(jobId, fileUrl, fileKey) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7-day download window

  return prisma.exportJob.update({
    where: { id: jobId },
    data: {
      status: ExportStatus.COMPLETED,
      fileUrl,
      fileKey,
      expiresAt,
      updatedAt: new Date(),
    },
  });
}

/** Mark job as failed with error message. */
async function markFailed(jobId, errorMsg) {
  return prisma.exportJob.update({
    where: { id: jobId },
    data: {
      status: ExportStatus.FAILED,
      errorMsg,
      updatedAt: new Date(),
    },
  });
}

/** Mark job as cancelled. */
async function markCancelled(jobId) {
  return prisma.exportJob.update({
    where: { id: jobId },
    data: {
      status: ExportStatus.CANCELLED,
      updatedAt: new Date(),
    },
  });
}

/** Set job status to running. */
async function markRunning(jobId) {
  return prisma.exportJob.update({
    where: { id: jobId },
    data: {
      status: ExportStatus.RUNNING,
      updatedAt: new Date(),
    },
  });
}

/** Clean up expired download links (called by background job). */
async function cleanupExpired() {
  return prisma.exportJob.deleteMany({
    where: {
      AND: [
        { status: ExportStatus.COMPLETED },
        { expiresAt: { lt: new Date() } },
      ],
    },
  });
}

export default {
  createJob,
  getJob,
  listJobs,
  updateProgress,
  markCompleted,
  markFailed,
  markCancelled,
  markRunning,
  cleanupExpired,
  ExportStatus,
  ExportType,
};
