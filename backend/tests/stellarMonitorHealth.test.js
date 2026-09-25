/**
 * Stellar Monitor Health Tests
 *
 * Covers:
 *   - Health response shape (status, lag, last checked time)
 *   - Masking of sensitive account details
 *   - Unauthenticated access is rejected
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const prismaMock = {
  transactionMonitor: {
    findFirst: jest.fn(),
    count: jest.fn(),
  },
};

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  logControllerError: jest.fn(),
}));
jest.unstable_mockModule('../services/sessionService.js', () => ({
  default: { isSessionValid: jest.fn().mockResolvedValue(true) },
}));

const { getMonitorHealth, maskAccount } = await import('../services/stellarMonitorService.js');
const { default: stellarMonitorRoutes } = await import('../api/routes/stellarMonitorRoutes.js');

const SECRET_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

describe('stellar monitor health', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns status, lag and last checked time with masked accounts', async () => {
    const lastCheckedAt = new Date();
    prismaMock.transactionMonitor.findFirst
      .mockResolvedValueOnce({ lastCheckedAt })
      .mockResolvedValueOnce({ txHash: 'a'.repeat(64), fromAddress: SECRET_ADDRESS, createdAt: new Date(Date.now() - 1000) });

    const health = await getMonitorHealth();

    expect(health.status).toBe('stopped');
    expect(health.lagMs).toBeGreaterThanOrEqual(1000);
    expect(health.lastCheckedAt).toBe(lastCheckedAt.toISOString());
    expect(JSON.stringify(health)).not.toContain(SECRET_ADDRESS);
    expect(health.oldestPending.fromAddress).toBe(maskAccount(SECRET_ADDRESS));
  });

  it('reports zero lag and null last check when nothing is tracked', async () => {
    prismaMock.transactionMonitor.findFirst.mockResolvedValue(null);

    const health = await getMonitorHealth();

    expect(health).toMatchObject({ lagMs: 0, lastCheckedAt: null, oldestPending: null });
  });

  it('rejects unauthenticated access to the health endpoint', async () => {
    const app = express();
    app.use('/api/stellar-monitor', stellarMonitorRoutes);

    const res = await request(app).get('/api/stellar-monitor/health');

    expect(res.status).toBe(401);
    expect(prismaMock.transactionMonitor.findFirst).not.toHaveBeenCalled();
  });
});
