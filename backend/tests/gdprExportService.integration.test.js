import { jest } from '@jest/globals';

const ADDRESS_A = `G${'A'.repeat(55)}`;
const TENANT_ID = 'tenant_default';

const prismaMock = {
  escrow: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  payment: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  kycVerification: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  reputationRecord: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  adminAuditLog: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
  chatRoomKey: {
    findMany: jest.fn(),
  },
  chatMessage: {
    findMany: jest.fn(),
  },
  user: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  userProfile: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const emailQueueMock = {
  add: jest.fn(async () => ({ id: 'email-1' })),
};

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../queues/emailQueue.js', () => ({
  emailQueue: emailQueueMock,
}));

const { default: gdprExportService } = await import('../services/gdprExportService.js');

describe('GdprExportService Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default mock responses
    prismaMock.escrow.findMany.mockResolvedValue([]);
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.kycVerification.findFirst.mockResolvedValue(null);
    prismaMock.reputationRecord.findFirst.mockResolvedValue(null);
    prismaMock.adminAuditLog.findMany.mockResolvedValue([]);
    prismaMock.chatRoomKey.findMany.mockResolvedValue([]);
    prismaMock.chatMessage.findMany.mockResolvedValue([]);
    prismaMock.userProfile.findFirst.mockResolvedValue(null);
  });

  describe('Happy Path: exportUserData', () => {
    it('exports complete GDPR data for a user', async () => {
      const mockEscrows = [
        {
          id: 'esc1',
          clientAddress: ADDRESS_A,
          contractorAddress: `G${'B'.repeat(55)}`,
          amount: BigInt('1000000'),
          status: 'completed',
          createdAt: new Date('2026-01-01'),
          completedAt: new Date('2026-02-01'),
          description: 'Test escrow',
        },
      ];

      const mockPayments = [
        {
          id: 'pay1',
          address: ADDRESS_A,
          amount: BigInt('500000'),
          currency: 'USD',
          status: 'completed',
          createdAt: new Date('2026-01-15'),
          updatedAt: new Date('2026-01-16'),
        },
      ];

      const mockKyc = {
        status: 'Approved',
        verifiedAt: new Date('2026-01-10'),
        expiresAt: new Date('2027-01-10'),
        verificationLevel: 2,
      };

      const mockReputation = {
        score: 95,
        totalEscrows: 5,
        completedEscrows: 4,
        disputesWon: 1,
        disputesLost: 0,
        lastUpdated: new Date('2026-02-01'),
      };

      prismaMock.escrow.findMany.mockResolvedValue(mockEscrows);
      prismaMock.payment.findMany.mockResolvedValue(mockPayments);
      prismaMock.kycVerification.findFirst.mockResolvedValue(mockKyc);
      prismaMock.reputationRecord.findFirst.mockResolvedValue(mockReputation);
      prismaMock.userProfile.findFirst.mockResolvedValue({
        displayName: 'Alice',
        bio: 'Escrow user',
        avatar: 'https://example.com/avatar.png',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-15'),
      });

      const result = await gdprExportService.exportUserData(ADDRESS_A, { tenantId: TENANT_ID });

      expect(result).toMatchObject({
        version: '1.0',
        exportType: 'GDPR',
        userAddress: ADDRESS_A,
      });

      expect(result.data.escrows).toHaveLength(1);
      expect(result.data.escrows[0]).toMatchObject({
        id: 'esc1',
        status: 'completed',
      });

      expect(result.data.payments).toHaveLength(1);
      expect(result.data.payments[0].amount).toBe('500000');

      expect(result.data.kyc).toMatchObject({
        status: 'Approved',
        verificationLevel: 2,
      });

      expect(result.data.reputation).toMatchObject({
        score: 95,
        completedEscrows: 4,
      });

      expect(result.exportedAt).toBeDefined();
      expect(new Date(result.exportedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('completes export within 5 seconds', async () => {
      const startTime = Date.now();
      await gdprExportService.exportUserData(ADDRESS_A, { tenantId: TENANT_ID });
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Happy Path: pseudonymizeUserData', () => {
    it('pseudonymizes all references to a user address', async () => {
      const mockTxCallback = jest.fn(async (tx) => {
        await tx.adminAuditLog.create({
          data: {
            action: 'GDPR_DATA_PSEUDONYMIZE',
            targetAddress: 'anon_abc123',
            reason: 'User deletion',
            performedBy: 'admin',
            tenantId: TENANT_ID,
          },
        });
        return {
          clientEscrows: { count: 2 },
          contractorEscrows: { count: 1 },
          payments: { count: 3 },
          kyc: { count: 1 },
          reputation: { count: 1 },
          userProfile: { count: 1 },
          user: { count: 1 },
        };
      });

      prismaMock.$transaction.mockImplementation(mockTxCallback);

      const result = await gdprExportService.pseudonymizeUserData(ADDRESS_A, {
        tenantId: TENANT_ID,
        performedBy: 'admin',
      });

      expect(result.pseudonym).toMatch(/^anon_[a-f0-9]{32}$/);
      expect(result.updated).toMatchObject({
        escrows: 3,
        payments: 3,
        kyc: 1,
        reputation: 1,
      });

      expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'GDPR_DATA_PSEUDONYMIZE',
          }),
        }),
      );
    });

    it('fails gracefully if transaction fails', async () => {
      prismaMock.$transaction.mockRejectedValue(new Error('Database error'));

      await expect(
        gdprExportService.pseudonymizeUserData(ADDRESS_A, {
          tenantId: TENANT_ID,
        }),
      ).rejects.toThrow('Database error');
    });
  });

  describe('Happy Path: requestDataExportEmail', () => {
    it('queues data export email successfully', async () => {
      const result = await gdprExportService.requestDataExportEmail(ADDRESS_A, {
        tenantId: TENANT_ID,
      });

      expect(result).toMatchObject({
        success: true,
        message: 'Data export email queued',
      });

      expect(emailQueueMock.add).toHaveBeenCalledWith(
        'send-gdpr-export',
        expect.objectContaining({
          recipientAddress: ADDRESS_A,
          dataSize: expect.any(Number),
        }),
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles null/missing kyc verification', async () => {
      prismaMock.kycVerification.findFirst.mockResolvedValue(null);

      const result = await gdprExportService.exportUserData(ADDRESS_A, {
        tenantId: TENANT_ID,
      });

      expect(result.data.kyc).toBeNull();
    });

    it('handles user with no payment history', async () => {
      prismaMock.payment.findMany.mockResolvedValue([]);

      const result = await gdprExportService.exportUserData(ADDRESS_A, {
        tenantId: TENANT_ID,
      });

      expect(result.data.payments).toEqual([]);
    });

    it('exports audit log with sanitized admin info', async () => {
      prismaMock.adminAuditLog.findMany.mockResolvedValue([
        {
          action: 'SUSPEND_USER',
          targetAddress: ADDRESS_A,
          reason: 'Suspicious activity',
          performedAt: new Date('2026-01-01'),
        },
      ]);

      const result = await gdprExportService.exportUserData(ADDRESS_A, {
        tenantId: TENANT_ID,
      });

      expect(result.data.adminAuditLog).toHaveLength(1);
      expect(result.data.adminAuditLog[0]).toMatchObject({
        action: 'SUSPEND_USER',
        outcome: 'Suspicious activity',
      });
      expect(result.data.adminAuditLog[0]).not.toHaveProperty('performedBy');
    });

    it('converts Date objects to ISO strings', async () => {
      prismaMock.kycVerification.findFirst.mockResolvedValue({
        status: 'Approved',
        verifiedAt: new Date('2026-01-01T10:00:00Z'),
        expiresAt: null,
        verificationLevel: 2,
      });

      const result = await gdprExportService.exportUserData(ADDRESS_A, {
        tenantId: TENANT_ID,
      });

      expect(result.data.kyc.verifiedAt).toBe('2026-01-01T10:00:00.000Z');
      expect(result.data.kyc.expiresAt).toBeNull();
    });
  });
});
