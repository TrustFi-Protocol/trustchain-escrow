/**
 * Tests for Export Job Service (Issue #230)
 */

import exportJobService from '../services/exportJobService.js';
import prisma from '../lib/prisma.js';

describe('exportJobService', () => {
  const tenantId = 'test-tenant';
  const requestBy = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';

  beforeEach(async () => {
    await prisma.exportJob.deleteMany({ where: { tenantId } });
  });

  describe('createJob', () => {
    it('should create a new export job with queued status', async () => {
      const job = await exportJobService.createJob(
        tenantId,
        requestBy,
        exportJobService.ExportType.GDPR_EXPORT,
        { filters: { status: 'completed' } },
      );

      expect(job).toBeDefined();
      expect(job.tenantId).toBe(tenantId);
      expect(job.requestBy).toBe(requestBy);
      expect(job.status).toBe(exportJobService.ExportStatus.QUEUED);
      expect(job.progress).toBe(0);
    });

    it('should reject invalid export type', async () => {
      await expect(
        exportJobService.createJob(tenantId, requestBy, 'invalid_type'),
      ).rejects.toThrow('Invalid export type');
    });
  });

  describe('updateProgress', () => {
    it('should update job progress and item counts', async () => {
      const job = await exportJobService.createJob(
        tenantId,
        requestBy,
        exportJobService.ExportType.ESCROW_REPORT,
      );

      await exportJobService.markRunning(job.id);

      const updated = await exportJobService.updateProgress(job.id, 50, 50, 100);

      expect(updated.progress).toBe(50);
      expect(updated.itemsProcessed).toBe(50);
      expect(updated.totalItems).toBe(100);
    });

    it('should reject progress outside 0-100 range', async () => {
      const job = await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.AUDIT_LOG_EXPORT);

      await expect(exportJobService.updateProgress(job.id, 150, 0, 0)).rejects.toThrow(
        'Progress must be 0-100',
      );
    });
  });

  describe('markCompleted', () => {
    it('should mark job as completed with download URL and expiry', async () => {
      const job = await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.GDPR_EXPORT);

      const completed = await exportJobService.markCompleted(
        job.id,
        'https://s3.example.com/exports/abc123.zip',
        'exports/abc123.zip',
      );

      expect(completed.status).toBe(exportJobService.ExportStatus.COMPLETED);
      expect(completed.fileUrl).toBe('https://s3.example.com/exports/abc123.zip');
      expect(completed.expiresAt).toBeDefined();
    });
  });

  describe('markFailed', () => {
    it('should mark job as failed with error message', async () => {
      const job = await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.ESCROW_REPORT);

      const failed = await exportJobService.markFailed(job.id, 'Database connection timeout');

      expect(failed.status).toBe(exportJobService.ExportStatus.FAILED);
      expect(failed.errorMsg).toBe('Database connection timeout');
    });
  });

  describe('markCancelled', () => {
    it('should mark job as cancelled', async () => {
      const job = await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.AUDIT_LOG_EXPORT);

      const cancelled = await exportJobService.markCancelled(job.id);

      expect(cancelled.status).toBe(exportJobService.ExportStatus.CANCELLED);
    });
  });

  describe('listJobs', () => {
    it('should list jobs for a tenant paginated', async () => {
      await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.GDPR_EXPORT);
      await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.ESCROW_REPORT);
      await exportJobService.createJob(
        'other-tenant',
        requestBy,
        exportJobService.ExportType.AUDIT_LOG_EXPORT,
      );

      const { jobs, total } = await exportJobService.listJobs(tenantId, { skip: 0, take: 10 });

      expect(total).toBe(2);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.tenantId === tenantId)).toBe(true);
    });

    it('should filter by requestBy if provided', async () => {
      const other = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW';
      await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.GDPR_EXPORT);
      await exportJobService.createJob(tenantId, other, exportJobService.ExportType.ESCROW_REPORT);

      const { jobs, total } = await exportJobService.listJobs(tenantId, {
        requestBy,
        skip: 0,
        take: 10,
      });

      expect(total).toBe(1);
      expect(jobs[0].requestBy).toBe(requestBy);
    });
  });

  describe('getJob', () => {
    it('should retrieve a job by ID', async () => {
      const created = await exportJobService.createJob(
        tenantId,
        requestBy,
        exportJobService.ExportType.GDPR_EXPORT,
      );

      const retrieved = await exportJobService.getJob(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.tenantId).toBe(tenantId);
    });

    it('should return null for non-existent job', async () => {
      const job = await exportJobService.getJob('nonexistent');
      expect(job).toBeNull();
    });
  });

  describe('cleanupExpired', () => {
    it('should delete completed jobs past expiry date', async () => {
      const job = await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.GDPR_EXPORT);

      const completed = await exportJobService.markCompleted(
        job.id,
        'https://example.com/file.zip',
        'file.zip',
      );

      // Manually set expiry to past date
      await prisma.exportJob.update({
        where: { id: job.id },
        data: { expiresAt: new Date(Date.now() - 1000 * 60 * 60) }, // 1 hour ago
      });

      await exportJobService.cleanupExpired();

      const remains = await exportJobService.getJob(job.id);
      expect(remains).toBeNull();
    });

    it('should not delete completed jobs not yet expired', async () => {
      const job = await exportJobService.createJob(tenantId, requestBy, exportJobService.ExportType.ESCROW_REPORT);

      await exportJobService.markCompleted(job.id, 'https://example.com/file.zip', 'file.zip');

      // expiresAt is set to 7 days in future by default
      await exportJobService.cleanupExpired();

      const remains = await exportJobService.getJob(job.id);
      expect(remains).toBeDefined();
      expect(remains.status).toBe(exportJobService.ExportStatus.COMPLETED);
    });
  });
});
