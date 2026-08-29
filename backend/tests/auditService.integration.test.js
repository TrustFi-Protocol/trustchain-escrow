/**
 * auditService — Integration Tests
 *
 * No dedicated test exists for this file today (auditLogger.test.js covers
 * a different module, backend/api/services/auditLogger.js; the only other
 * reference is a fully-mocked import in complianceService.test.js). This
 * exercises the real service functions — log, search, exportCsv,
 * purgeOldRecords — against the in-memory Prisma mock this repo's jest
 * config already wires up for @prisma/client, so the happy path runs
 * through real Prisma query shapes rather than hand-mocked responses
 * (issue #95).
 *
 * @module tests/auditService.integration
 */

process.env.TRACING_ENABLED = 'false';

import auditService, { AuditCategory, AuditAction } from '../services/auditService.js';
import prisma from '../lib/prisma.js';

describe('auditService (integration)', () => {
  it('log() writes a record that search() can find', async () => {
    await auditService.log({
      category: AuditCategory.ESCROW,
      action: AuditAction.CREATE_ESCROW,
      actor: 'GTESTACTOR',
      resourceId: 'escrow-1',
    });

    const result = await auditService.search({ category: AuditCategory.ESCROW });

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.data.some((r) => r.resourceId === 'escrow-1')).toBe(true);
  });

  it('search() filters by category and action together', async () => {
    await auditService.log({
      category: AuditCategory.DISPUTE,
      action: AuditAction.RAISE_DISPUTE,
      actor: 'GDISPUTEACTOR',
      resourceId: 'dispute-search-1',
    });
    await auditService.log({
      category: AuditCategory.DISPUTE,
      action: AuditAction.RESOLVE_DISPUTE,
      actor: 'GDISPUTEACTOR',
      resourceId: 'dispute-search-1',
    });

    const raised = await auditService.search({
      category: AuditCategory.DISPUTE,
      action: AuditAction.RAISE_DISPUTE,
    });

    expect(raised.data.every((r) => r.action === AuditAction.RAISE_DISPUTE)).toBe(true);
    expect(raised.data.some((r) => r.resourceId === 'dispute-search-1')).toBe(true);
  });

  it('search() returns an empty page for a category with no matching records', async () => {
    const result = await auditService.search({ category: 'NO_SUCH_CATEGORY' });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pages).toBe(0);
  });

  it('search() paginates using page/limit and reports the correct page count', async () => {
    for (let i = 0; i < 5; i++) {
      await auditService.log({
        category: AuditCategory.ADMIN,
        action: AuditAction.UPDATE_SETTINGS,
        actor: 'admin',
        resourceId: `settings-${i}`,
      });
    }

    const firstPage = await auditService.search({
      category: AuditCategory.ADMIN,
      action: AuditAction.UPDATE_SETTINGS,
      page: 1,
      limit: 2,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.total).toBeGreaterThanOrEqual(5);
    expect(firstPage.pages).toBeGreaterThanOrEqual(3);
  });

  it('log() never throws even when the underlying write fails (unhappy path)', async () => {
    jest.spyOn(prisma.auditLog, 'create').mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      auditService.log({
        category: AuditCategory.AUTH,
        action: AuditAction.LOGIN,
        actor: 'GFAILWRITE',
      }),
    ).resolves.toBeUndefined();
  });

  it('exportCsv() produces a CSV header and one row per matching record', async () => {
    await auditService.log({
      category: AuditCategory.KYC,
      action: AuditAction.KYC_APPROVED,
      actor: 'GKYCACTOR',
      resourceId: 'kyc-export-1',
      statusCode: 200,
    });

    const csv = await auditService.exportCsv({ category: AuditCategory.KYC });

    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,category,action,actor,resourceId,statusCode,ipAddress,createdAt');
    expect(csv).toContain('kyc-export-1');
  });

  it('purgeOldRecords() deletes only records older than the retention window', async () => {
    const old = await prisma.auditLog.create({
      data: {
        category: AuditCategory.REPORTING,
        action: AuditAction.REPORT_GENERATED,
        actor: 'system',
        resourceId: 'old-record',
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000), // 400 days ago
      },
    });
    await auditService.log({
      category: AuditCategory.REPORTING,
      action: AuditAction.REPORT_GENERATED,
      actor: 'system',
      resourceId: 'recent-record',
    });

    const deletedCount = await auditService.purgeOldRecords(365);

    expect(deletedCount).toBeGreaterThanOrEqual(1);
    const stillThere = await prisma.auditLog.findUnique({ where: { id: old.id } });
    expect(stillThere).toBeNull();
  });
});
