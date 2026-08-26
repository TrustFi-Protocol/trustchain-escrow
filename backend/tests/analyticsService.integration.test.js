import { jest } from '@jest/globals';

const TENANT_ID = 'tenant_default';
const ADDRESS_A = `G${'A'.repeat(55)}`;
const ADDRESS_B = `G${'B'.repeat(55)}`;

const prismaMock = {
  escrow: {
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  payment: {
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  user: {
    count: jest.fn(),
  },
};

const cacheServiceMock = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  default: cacheServiceMock,
}));

const { default: analyticsService } = await import('../services/analyticsService.js');

describe('AnalyticsService Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheServiceMock.get.mockResolvedValue(null);
    cacheServiceMock.set.mockResolvedValue(true);
  });

  describe('Happy Path: recordEvent', () => {
    it('records an analytics event successfully', async () => {
      const result = await analyticsService.recordEvent('escrow_created', {
        escrowId: 'esc123',
        amount: 1000,
      });

      expect(result).toMatchObject({
        type: 'escrow_created',
        escrowId: 'esc123',
        amount: 1000,
      });

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).toBeLessThanOrEqual(Date.now());

      expect(cacheServiceMock.set).toHaveBeenCalled();
    });

    it('records payment completed event', async () => {
      const result = await analyticsService.recordEvent('payment_completed', {
        paymentId: 'pay456',
        amount: 500,
        currency: 'USD',
      });

      expect(result.type).toBe('payment_completed');
      expect(result.paymentId).toBe('pay456');
      expect(result.currency).toBe('USD');
    });
  });

  describe('Happy Path: getEscrowStats', () => {
    it('returns escrow statistics from database', async () => {
      prismaMock.escrow.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(80) // completed
        .mockResolvedValueOnce(10) // disputed
        .mockResolvedValueOnce(5) // cancelled
        .mockResolvedValueOnce(3); // expired

      const result = await analyticsService.getEscrowStats(TENANT_ID);

      expect(result).toMatchObject({
        total: 100,
        completed: 80,
        disputed: 10,
        cancelled: 5,
        expired: 3,
        active: 2,
        completionRate: '80.00',
      });

      expect(cacheServiceMock.set).toHaveBeenCalled();
    });

    it('returns cached stats if available', async () => {
      const cachedStats = { total: 50, completed: 40, completionRate: '80.00' };
      cacheServiceMock.get.mockResolvedValue(cachedStats);

      const result = await analyticsService.getEscrowStats(TENANT_ID);

      expect(result).toEqual(cachedStats);
      expect(prismaMock.escrow.count).not.toHaveBeenCalled();
    });

    it('calculates completion rate correctly when total is 0', async () => {
      prismaMock.escrow.count.mockResolvedValue(0);

      const result = await analyticsService.getEscrowStats(TENANT_ID);

      expect(result.completionRate).toBe(0);
    });
  });

  describe('Happy Path: getPaymentAnalytics', () => {
    it('returns payment analytics with volume by currency', async () => {
      prismaMock.payment.count
        .mockResolvedValueOnce(200) // total
        .mockResolvedValueOnce(180) // completed
        .mockResolvedValueOnce(15) // pending
        .mockResolvedValueOnce(5); // failed

      prismaMock.payment.groupBy.mockResolvedValue([
        {
          currency: 'USD',
          _count: 150,
          _sum: { amount: BigInt(150000) },
        },
        {
          currency: 'EUR',
          _count: 50,
          _sum: { amount: BigInt(50000) },
        },
      ]);

      const result = await analyticsService.getPaymentAnalytics(TENANT_ID);

      expect(result).toMatchObject({
        total: 200,
        completed: 180,
        pending: 15,
        failed: 5,
        successRate: '90.00',
      });

      expect(result.volumeByCurrency).toHaveProperty('USD');
      expect(result.volumeByCurrency.USD).toMatchObject({
        count: 150,
        volume: '150000',
      });

      expect(result.volumeByCurrency).toHaveProperty('EUR');
    });

    it('handles null sum amounts', async () => {
      prismaMock.payment.count.mockResolvedValue(10);
      prismaMock.payment.groupBy.mockResolvedValue([
        {
          currency: 'XLM',
          _count: 10,
          _sum: { amount: null },
        },
      ]);

      const result = await analyticsService.getPaymentAnalytics(TENANT_ID);

      expect(result.volumeByCurrency.XLM.volume).toBe('0');
    });
  });

  describe('Happy Path: getUserGrowthMetrics', () => {
    it('returns user growth metrics for last 30 and 60 days', async () => {
      prismaMock.user.count
        .mockResolvedValueOnce(500) // total
        .mockResolvedValueOnce(100) // last 30 days
        .mockResolvedValueOnce(80); // last 60 days (30-60 day range)

      const result = await analyticsService.getUserGrowthMetrics(TENANT_ID);

      expect(result).toMatchObject({
        total: 500,
        last30Days: 100,
        last60Days: 80,
      });

      expect(result.monthlyGrowthRate).toBe('25.00');
    });

    it('handles zero users in 60-day range', async () => {
      prismaMock.user.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(50) // last 30 days
        .mockResolvedValueOnce(0); // last 60 days

      const result = await analyticsService.getUserGrowthMetrics(TENANT_ID);

      expect(result.monthlyGrowthRate).toBe(0);
    });
  });

  describe('Happy Path: getDisputeStats', () => {
    it('returns dispute resolution statistics', async () => {
      prismaMock.escrow.count
        .mockResolvedValueOnce(30) // total disputes
        .mockResolvedValueOnce(20); // resolved disputes

      const result = await analyticsService.getDisputeStats(TENANT_ID);

      expect(result).toMatchObject({
        total: 30,
        resolved: 20,
        pending: 10,
        resolutionRate: '66.67',
      });
    });

    it('handles zero disputes', async () => {
      prismaMock.escrow.count.mockResolvedValue(0);

      const result = await analyticsService.getDisputeStats(TENANT_ID);

      expect(result.resolutionRate).toBe(0);
    });
  });

  describe('Happy Path: getDashboardMetrics', () => {
    it('returns comprehensive dashboard metrics', async () => {
      // Mock all the individual stat methods
      prismaMock.escrow.count
        .mockResolvedValueOnce(100) // escrow total
        .mockResolvedValueOnce(80) // escrow completed
        .mockResolvedValueOnce(10) // escrow disputed
        .mockResolvedValueOnce(5) // escrow cancelled
        .mockResolvedValueOnce(3) // escrow expired
        .mockResolvedValueOnce(30) // dispute total
        .mockResolvedValueOnce(20); // dispute resolved

      prismaMock.payment.count
        .mockResolvedValueOnce(200) // total
        .mockResolvedValueOnce(180) // completed
        .mockResolvedValueOnce(15) // pending
        .mockResolvedValueOnce(5); // failed

      prismaMock.payment.groupBy.mockResolvedValue([]);

      prismaMock.user.count
        .mockResolvedValueOnce(500) // total
        .mockResolvedValueOnce(100) // last 30
        .mockResolvedValueOnce(80); // last 60

      const result = await analyticsService.getDashboardMetrics(TENANT_ID);

      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('escrows');
      expect(result).toHaveProperty('payments');
      expect(result).toHaveProperty('users');
      expect(result).toHaveProperty('disputes');

      expect(result.escrows.total).toBe(100);
      expect(result.payments.total).toBe(200);
      expect(result.users.total).toBe(500);
      expect(result.disputes.total).toBe(30);
    });

    it('completes dashboard metrics fetch within 5 seconds', async () => {
      prismaMock.escrow.count.mockResolvedValue(0);
      prismaMock.payment.count.mockResolvedValue(0);
      prismaMock.payment.groupBy.mockResolvedValue([]);
      prismaMock.user.count.mockResolvedValue(0);

      const startTime = Date.now();
      await analyticsService.getDashboardMetrics(TENANT_ID);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Happy Path: getTopUsersByVolume', () => {
    it('returns top users sorted by escrow volume', async () => {
      prismaMock.escrow.groupBy.mockResolvedValue([
        {
          clientAddress: ADDRESS_A,
          _count: { id: 50 },
          _sum: { amount: BigInt(500000) },
        },
        {
          clientAddress: ADDRESS_B,
          _count: { id: 30 },
          _sum: { amount: BigInt(300000) },
        },
      ]);

      const result = await analyticsService.getTopUsersByVolume(10, TENANT_ID);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        address: ADDRESS_A,
        escrowCount: 50,
        volume: '500000',
      });
    });

    it('handles null sum amounts in top users', async () => {
      prismaMock.escrow.groupBy.mockResolvedValue([
        {
          clientAddress: ADDRESS_A,
          _count: { id: 1 },
          _sum: { amount: null },
        },
      ]);

      const result = await analyticsService.getTopUsersByVolume(10, TENANT_ID);

      expect(result[0].volume).toBe('0');
    });
  });

  describe('Edge Cases', () => {
    it('handles database errors gracefully', async () => {
      prismaMock.escrow.count.mockRejectedValue(new Error('Database connection failed'));

      await expect(analyticsService.getEscrowStats(TENANT_ID)).rejects.toThrow(
        'Database connection failed',
      );
    });

    it('handles cache errors gracefully', async () => {
      cacheServiceMock.set.mockRejectedValue(new Error('Cache unavailable'));

      await expect(
        analyticsService.recordEvent('test_event', {}),
      ).rejects.toThrow('Cache unavailable');
    });

    it('works without tenant ID for global metrics', async () => {
      prismaMock.escrow.count
        .mockResolvedValueOnce(1000) // total
        .mockResolvedValueOnce(800) // completed
        .mockResolvedValueOnce(100) // disputed
        .mockResolvedValueOnce(50) // cancelled
        .mockResolvedValueOnce(30); // expired

      const result = await analyticsService.getEscrowStats(undefined);

      expect(result.total).toBe(1000);
    });
  });
});
