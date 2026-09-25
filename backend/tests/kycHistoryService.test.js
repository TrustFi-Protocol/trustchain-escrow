/**
 * Tests for KYC History Service (Issue #229)
 */

import kycHistoryService from '../services/kycHistoryService.js';
import prisma from '../lib/prisma.js';

describe('kycHistoryService', () => {
  const tenantId = 'test-tenant';
  const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';

  beforeEach(async () => {
    await prisma.kycHistory.deleteMany({ where: { tenantId } });
  });

  describe('recordStatusChange', () => {
    it('should record a KYC status change with reason and metadata', async () => {
      const event = await kycHistoryService.recordStatusChange(
        tenantId,
        address,
        'Pending',
        'Init',
        'system',
        'User started KYC verification',
        { source: 'sdk' },
      );

      expect(event).toBeDefined();
      expect(event.oldStatus).toBe('Pending');
      expect(event.newStatus).toBe('Init');
      expect(event.actor).toBe('system');
      expect(event.reason).toBe('User started KYC verification');
      expect(event.metadata.source).toBe('sdk');
    });

    it('should reject invalid status values', async () => {
      await expect(
        kycHistoryService.recordStatusChange(tenantId, address, 'InvalidStatus', 'Init', 'admin'),
      ).rejects.toThrow('Invalid KYC status');
    });
  });

  describe('getHistory', () => {
    it('should return paginated history for an address', async () => {
      // Create multiple status changes
      for (let i = 0; i < 5; i++) {
        await kycHistoryService.recordStatusChange(
          tenantId,
          address,
          'Pending',
          i % 2 === 0 ? 'Init' : 'Processing',
          'system',
        );
      }

      const { events, total } = await kycHistoryService.getHistory(tenantId, address, {
        skip: 0,
        take: 2,
      });

      expect(events).toHaveLength(2);
      expect(total).toBe(5);
      // Should be in descending order (newest first)
      expect(events[0].createdAt >= events[1].createdAt).toBe(true);
    });

    it('should return empty history for unknown address', async () => {
      const { events, total } = await kycHistoryService.getHistory(
        tenantId,
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW',
        { skip: 0, take: 20 },
      );

      expect(events).toHaveLength(0);
      expect(total).toBe(0);
    });
  });

  describe('getAllHistory', () => {
    it('should return paginated history for all users in tenant', async () => {
      const addr1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';
      const addr2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW';

      await kycHistoryService.recordStatusChange(tenantId, addr1, 'Pending', 'Init', 'system');
      await kycHistoryService.recordStatusChange(tenantId, addr2, 'Pending', 'Processing', 'admin');

      const { events, total } = await kycHistoryService.getAllHistory(tenantId, {
        skip: 0,
        take: 10,
      });

      expect(total).toBe(2);
    });

    it('should filter by address if provided', async () => {
      const addr1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';
      const addr2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW';

      await kycHistoryService.recordStatusChange(tenantId, addr1, 'Pending', 'Init', 'system');
      await kycHistoryService.recordStatusChange(tenantId, addr2, 'Pending', 'Processing', 'admin');

      const { events, total } = await kycHistoryService.getAllHistory(tenantId, {
        address: addr1,
      });

      expect(total).toBe(1);
      expect(events[0].address).toBe(addr1);
    });
  });

  describe('recordWebhookChange', () => {
    it('should record webhook-driven status change with event context', async () => {
      const sumsub_event = {
        type: 'applicantReviewed',
        reviewResult: {
          reviewAnswer: 'GREEN',
        },
      };

      const event = await kycHistoryService.recordWebhookChange(
        tenantId,
        address,
        'Processing',
        'Approved',
        sumsub_event,
      );

      expect(event.reason).toBe('Approved by Sumsub verification');
      expect(event.metadata.eventType).toBe('applicantReviewed');
      expect(event.metadata.reviewResult).toBeDefined();
    });
  });
});
