/**
 * Queue health reporting: #448, #449, #450 and #451.
 * Uses the repository's existing Jest + Supertest packages; no live Redis needed.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mocks = {
  mainCounts: jest.fn(),
  deadCounts: jest.fn(),
  waiting: jest.fn(),
  active: jest.fn(),
  completed: jest.fn(),
  failed: jest.fn(),
  deadWaiting: jest.fn(),
  deadActive: jest.fn(),
  info: jest.fn(),
};
let redisStatus = 'ready';

jest.unstable_mockModule('../lib/queueConfig.js', () => ({
  stellarEventsQueue: {
    getJobCounts: mocks.mainCounts,
    getWaiting: mocks.waiting,
    getActive: mocks.active,
    getCompleted: mocks.completed,
    getFailed: mocks.failed,
  },
  deadLetterQueue: {
    getJobCounts: mocks.deadCounts,
    getWaiting: mocks.deadWaiting,
    getActive: mocks.deadActive,
  },
  connection: { get status() { return redisStatus; }, info: mocks.info },
  queueMetrics: {
    totalJobs: 10,
    completedJobs: 8,
    failedJobs: 2,
    retryCount: 1,
    deadLetterCount: 0,
    getFailureRate: () => 20,
    getSuccessRate: () => 80,
    getProcessingTime: () => 5000,
  },
}));

const { default: router, validateQueueHealthConfig } = await import('../api/routes/queueDashboardRoutes.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const app = express();
app.use('/admin/queues', router);

beforeEach(() => {
  jest.clearAllMocks();
  redisStatus = 'ready';
  mocks.mainCounts.mockResolvedValue({ waiting: 2, active: 1, completed: 8, failed: 2 });
  mocks.deadCounts.mockResolvedValue({ waiting: 0, active: 0 });
  mocks.waiting.mockResolvedValue([{ id: '1' }, { id: '2' }]);
  mocks.active.mockResolvedValue([{ id: '3' }]);
  mocks.completed.mockResolvedValue([]);
  mocks.failed.mockResolvedValue([]);
  mocks.deadWaiting.mockResolvedValue([]);
  mocks.deadActive.mockResolvedValue([]);
  mocks.info.mockResolvedValue('# Server\nredis_version:7.2.0\nused_memory_human:1M\nconnected_clients:2\n');
});

describe('queue dashboard /stats', () => {
  it('reports a healthy snapshot without changing existing metric keys', async () => {
    const response = await request(app).get('/admin/queues/stats');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.mainQueue.waitingJobs).toBe(2);
    expect(response.body.metrics.failureRate).toBe(20);
    expect(response.body.redis.connected).toBe(true);
    expect(response.body.alerts.highFailureRate).toBe(true);
  });

  it('degrades when optional Redis inspection fails without exposing secrets', async () => {
    mocks.info.mockRejectedValue(new Error('redis://user:secret@private-host:6379'));
    const response = await request(app).get('/admin/queues/stats');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.degradedComponents).toContain('redis');
    expect(response.body.redis.connected).toBe(false);
    expect(response.body.mainQueue.waitingJobs).toBe(2);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('returns a degraded snapshot on failed queue counts and refreshes on retry', async () => {
    mocks.mainCounts.mockRejectedValueOnce(new Error('private connection string'));
    const failed = await request(app).get('/admin/queues/stats');
    const recovered = await request(app).get('/admin/queues/stats');
    expect(failed.body.status).toBe('degraded');
    expect(failed.body.degradedComponents).toContain('mainQueue.counts');
    expect(JSON.stringify(failed.body)).not.toContain('private');
    expect(recovered.body.status).toBe('ok');
    expect(mocks.mainCounts).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping requests into one read with equal response snapshots', async () => {
    mocks.mainCounts.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve({ waiting: 2, active: 1 }), 60)),
    );
    const [first, second] = await Promise.all([
      request(app).get('/admin/queues/stats'),
      request(app).get('/admin/queues/stats'),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual(second.body);
    expect(mocks.mainCounts).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });
});

describe('queue health configuration', () => {
  it('accepts valid settings and defaults', () => {
    const config = validateQueueHealthConfig({});
    expect(config.failureRateThreshold).toBe(5);
    expect(config.timeoutMs).toBe(2000);
    expect(config.allowDegraded).toBe(true);
  });

  it('fails fast for invalid and contradictory settings with named guidance', () => {
    expect(() => validateQueueHealthConfig({ QUEUE_HEALTH_TIMEOUT_MS: 'abc' }))
      .toThrow('QUEUE_HEALTH_TIMEOUT_MS');
    expect(() => validateQueueHealthConfig({ QUEUE_HEALTH_FAILURE_RATE_THRESHOLD: '101' }))
      .toThrow('QUEUE_HEALTH_FAILURE_RATE_THRESHOLD');
    expect(() => validateQueueHealthConfig({ QUEUE_HEALTH_REDIS_REQUIRED: 'true' }))
      .toThrow('QUEUE_HEALTH_ALLOW_DEGRADED=false');
    expect(() => validateQueueHealthConfig({ QUEUE_HEALTH_ALLOW_DEGRADED: 'yes' }))
      .toThrow('QUEUE_HEALTH_ALLOW_DEGRADED');
  });
});
