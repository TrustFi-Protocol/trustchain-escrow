/**
 * Tests for the queue dashboard `/stats` endpoint.
 *
 * The queue layer (BullMQ + Redis) is mocked so these tests stay hermetic and
 * fast — the existing `queueTests.test.js` needs a real Redis and is excluded
 * from the default jest run via `testPathIgnorePatterns`.
 *
 * The point of this file is to lock the response *shape* that the admin health
 * card consumes, so a rename or a dropped field breaks here rather than
 * rendering an empty card in the dashboard.
 */
import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';

// ── Mock functions ────────────────────────────────────────────────────────────

const mockMainGetJobCounts = jest.fn();
const mockMainGetWaiting = jest.fn();
const mockMainGetActive = jest.fn();
const mockMainGetCompleted = jest.fn();
const mockMainGetFailed = jest.fn();

const mockDlqGetJobCounts = jest.fn();
const mockDlqGetWaiting = jest.fn();
const mockDlqGetActive = jest.fn();

const mockConnectionInfo = jest.fn();
const mockGetFailureRate = jest.fn();
const mockGetSuccessRate = jest.fn();
const mockGetProcessingTime = jest.fn();

// ── Module mocks (must come before any dynamic import of the SUT) ─────────────

jest.unstable_mockModule('../lib/queueConfig.js', () => ({
  stellarEventsQueue: {
    getJobCounts: (...a) => mockMainGetJobCounts(...a),
    getWaiting: (...a) => mockMainGetWaiting(...a),
    getActive: (...a) => mockMainGetActive(...a),
    getCompleted: (...a) => mockMainGetCompleted(...a),
    getFailed: (...a) => mockMainGetFailed(...a),
  },
  deadLetterQueue: {
    getJobCounts: (...a) => mockDlqGetJobCounts(...a),
    getWaiting: (...a) => mockDlqGetWaiting(...a),
    getActive: (...a) => mockDlqGetActive(...a),
  },
  queueMetrics: {
    totalJobs: 120,
    completedJobs: 100,
    failedJobs: 5,
    retryCount: 3,
    deadLetterCount: 2,
    getFailureRate: (...a) => mockGetFailureRate(...a),
    getSuccessRate: (...a) => mockGetSuccessRate(...a),
    getProcessingTime: (...a) => mockGetProcessingTime(...a),
  },
  connection: {
    status: 'ready',
    info: (...a) => mockConnectionInfo(...a),
  },
}));

// ── Import the module under test after mocks are registered ──────────────────

const { default: queueDashboardRoutes } = await import(
  '../api/routes/queueDashboardRoutes.js'
);
const { default: express } = await import('express');
const { default: request } = await import('supertest');

// ── Test app ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use('/admin/queues', queueDashboardRoutes);
  return app;
}

const NOW = 1_700_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  mockMainGetJobCounts.mockResolvedValue({ waiting: 4, active: 1, completed: 90, failed: 5 });
  mockMainGetWaiting.mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]);
  mockMainGetActive.mockResolvedValue([{ id: '9' }]);
  mockMainGetCompleted.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}` })));
  mockMainGetFailed.mockResolvedValue([{ id: 'f1', failedReason: 'boom' }]);

  mockDlqGetJobCounts.mockResolvedValue({ waiting: 2, active: 0, completed: 0, failed: 0 });
  mockDlqGetWaiting.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
  mockDlqGetActive.mockResolvedValue([]);

  mockConnectionInfo.mockResolvedValue({
    redis_version: '7.2.4',
    used_memory_human: '12.5M',
    connected_clients: 4,
  });

  mockGetFailureRate.mockReturnValue(4.16);
  mockGetSuccessRate.mockReturnValue(83.33);
  mockGetProcessingTime.mockReturnValue(3_600_000);
});

afterEach(() => {
  jest.useRealTimers();
});

const getStats = () => request(buildApp()).get('/admin/queues/stats');

describe('GET /admin/queues/stats — shape', () => {
  it('returns 200 with the top-level fields the health card reads', async () => {
    const res = await getStats();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        metrics: expect.any(Object),
        mainQueue: expect.any(Object),
        deadLetterQueue: expect.any(Object),
        redis: expect.any(Object),
        alerts: expect.any(Object),
        oldestJobAgeMs: expect.any(Number),
      }),
    );
  });

  it('reports an ISO-8601 timestamp that matches the request time', async () => {
    const res = await getStats();

    expect(res.body.timestamp).toBe(new Date(NOW).toISOString());
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });

  it('reports queue depth for the main queue', async () => {
    const res = await getStats();

    expect(res.body.mainQueue.waitingJobs).toBe(4);
    expect(res.body.mainQueue.activeJobs).toBe(1);
    // The raw BullMQ counts are spread through untouched.
    expect(res.body.mainQueue.failed).toBe(5);
    expect(res.body.mainQueue.completed).toBe(90);
  });

  it('reports failed-job counts and rate', async () => {
    const res = await getStats();

    expect(res.body.mainQueue.failed).toBe(5);
    expect(res.body.metrics.failedJobs).toBe(5);
    expect(res.body.metrics.failureRate).toBe(4.16);
    expect(res.body.alerts.highFailureRate).toBe(false);
  });

  it('flags a high failure rate at the documented 5% threshold', async () => {
    mockGetFailureRate.mockReturnValue(12.5);
    const res = await getStats();

    expect(res.body.alerts.highFailureRate).toBe(true);
  });

  it('reports dead-letter depth and count', async () => {
    const res = await getStats();

    expect(res.body.deadLetterQueue.waitingJobs).toBe(2);
    expect(res.body.deadLetterQueue.activeJobs).toBe(0);
    expect(res.body.metrics.deadLetterCount).toBe(2);
  });

  it('caps recentFailed / recentCompleted at the last 10 entries', async () => {
    const res = await getStats();

    // 12 completed jobs are seeded, so only the last 10 are returned.
    expect(res.body.mainQueue.recentCompleted).toHaveLength(10);
    expect(res.body.mainQueue.recentCompleted.at(-1).id).toBe('c11');
    expect(res.body.mainQueue.recentFailed).toHaveLength(1);
  });
});

describe('GET /admin/queues/stats — oldest job age', () => {
  it('is null when nothing is waiting in either queue', async () => {
    mockMainGetWaiting.mockResolvedValue([]);
    mockDlqGetWaiting.mockResolvedValue([]);

    const res = await getStats();

    expect(res.body.oldestJobAgeMs).toBeNull();
    expect(res.body.mainQueue.oldestWaitingJobAgeMs).toBeNull();
    expect(res.body.deadLetterQueue.oldestWaitingJobAgeMs).toBeNull();
  });

  it('is the age of the oldest waiting job on the main queue', async () => {
    mockMainGetWaiting.mockResolvedValue([
      { id: 'newest', timestamp: NOW - 1_000 },
      { id: 'oldest', timestamp: NOW - 300_000 },
      { id: 'middle', timestamp: NOW - 30_000 },
    ]);

    const res = await getStats();

    expect(res.body.mainQueue.oldestWaitingJobAgeMs).toBe(300_000);
    expect(res.body.oldestJobAgeMs).toBe(300_000);
  });

  it('takes the worst case across both queues for the top-level field', async () => {
    mockMainGetWaiting.mockResolvedValue([{ id: 'm1', timestamp: NOW - 5_000 }]);
    mockDlqGetWaiting.mockResolvedValue([{ id: 'd1', timestamp: NOW - 900_000 }]);

    const res = await getStats();

    // Per-queue values stay distinct...
    expect(res.body.mainQueue.oldestWaitingJobAgeMs).toBe(5_000);
    expect(res.body.deadLetterQueue.oldestWaitingJobAgeMs).toBe(900_000);
    // ...but the headline number is the one that matters, the deeper backlog.
    expect(res.body.oldestJobAgeMs).toBe(900_000);
  });

  it('never reports a negative age when a job timestamp is in the future', async () => {
    mockMainGetWaiting.mockResolvedValue([{ id: 'skewed', timestamp: NOW + 60_000 }]);

    const res = await getStats();

    expect(res.body.mainQueue.oldestWaitingJobAgeMs).toBe(0);
    expect(res.body.oldestJobAgeMs).toBe(0);
  });

  it('treats a job with no timestamp as brand new rather than epoch-old', async () => {
    mockMainGetWaiting.mockResolvedValue([{ id: 'no-ts' }, { id: 'old', timestamp: NOW - 1_000 }]);

    const res = await getStats();

    // 1000ms, not ~1.7e12ms: an untimestamped job must not dominate the result.
    expect(res.body.mainQueue.oldestWaitingJobAgeMs).toBe(1_000);
  });
});

describe('GET /admin/queues/stats — alerts and failure handling', () => {
  it('reports redis connectivity from the connection status', async () => {
    const res = await getStats();

    expect(res.body.redis.connected).toBe(true);
    expect(res.body.alerts.redisConnected).toBe(true);
    expect(res.body.redis.version).toBe('7.2.4');
    expect(res.body.redis.connectedClients).toBe(4);
  });

  it('flags a disconnected redis', async () => {
    const queueConfig = await import('../lib/queueConfig.js');
    queueConfig.connection.status = 'end';
    try {
      const res = await getStats();
      expect(res.body.redis.connected).toBe(false);
      expect(res.body.alerts.redisConnected).toBe(false);
    } finally {
      queueConfig.connection.status = 'ready';
    }
  });

  it('flags waiting jobs with no active processing', async () => {
    mockMainGetActive.mockResolvedValue([]);

    const res = await getStats();

    expect(res.body.mainQueue.waitingJobs).toBe(4);
    expect(res.body.alerts.queueProcessingActive).toBe(false);
  });

  it('returns 500 with a stable error body when the queue layer rejects', async () => {
    mockMainGetJobCounts.mockRejectedValue(new Error('redis down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await getStats();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch queue statistics' });
    consoleSpy.mockRestore();
  });
});
