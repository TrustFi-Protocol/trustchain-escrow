/**
 * Tests for issue #203 — async webhook delivery status query.
 *
 * Covers:
 *  - Correct response shape with summary counts
 *  - Failed/success/pending status counts
 *  - Tenant isolation (other user's subscription returns empty)
 *  - Input validation: invalid page/limit → 400
 *  - Default pagination (page=1, limit=30)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks must be declared before any dynamic imports ────────────────────────

const prismaMock = {
  webhookDelivery: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
};

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

// The tenantContext helper is required by webhookService; stub it out.
jest.unstable_mockModule('../lib/tenantContext.js', () => ({
  withTenantScopeBypassed: jest.fn(async (fn) => fn()),
}));

// The queue module is imported transitively but not exercised here.
jest.unstable_mockModule('../queues/webhookQueue.js', () => ({
  enqueueWebhookDelivery: jest.fn(),
}));

// ── Dynamic imports (after unstable_mockModule declarations) ─────────────────

const { default: webhookService } = await import('../services/webhookService.js');
const { default: webhookController } = await import('../api/controllers/webhookController.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock Express response object. */
function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn().mockImplementation(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn().mockImplementation(function (payload) {
      this.body = payload;
      return this;
    }),
  };
  return res;
}

/** Build a minimal mock Express request object. */
function createReq({ params = {}, query = {}, user = { address: 'GCLIENT' } } = {}) {
  return { params, query, user };
}

/**
 * Build a fake delivery record.
 * @param {string} status  'success' | 'failed' | 'pending'
 */
function makeDelivery(status, id = Math.random().toString(36).slice(2)) {
  return {
    id,
    eventType: 'esc_crt',
    status,
    attempts: status === 'pending' ? 0 : 1,
    responseCode: status === 'success' ? 200 : null,
    errorMessage: status === 'failed' ? 'timeout' : null,
    lastAttemptAt: status === 'pending' ? null : new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// ── Service-level tests ───────────────────────────────────────────────────────

describe('webhookService.getDeliveryHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns correct shape with summary counts from current page', async () => {
    const deliveries = [
      makeDelivery('success', 'd1'),
      makeDelivery('success', 'd2'),
      makeDelivery('failed', 'd3'),
      makeDelivery('pending', 'd4'),
    ];
    prismaMock.webhookDelivery.findMany.mockResolvedValue(deliveries);
    prismaMock.webhookDelivery.count.mockResolvedValue(4);

    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: 'GCLIENT',
      page: 1,
      limit: 30,
    });

    expect(result).toMatchObject({
      page: 1,
      limit: 30,
      total: 4,
      deliveries,
      summary: {
        total: 4,
        successful: 2,
        failed: 1,
        pending: 1,
      },
    });
  });

  it('counts only failed deliveries correctly when all deliveries failed', async () => {
    const deliveries = [makeDelivery('failed', 'f1'), makeDelivery('failed', 'f2')];
    prismaMock.webhookDelivery.findMany.mockResolvedValue(deliveries);
    prismaMock.webhookDelivery.count.mockResolvedValue(2);

    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: 'GCLIENT',
      page: 1,
      limit: 30,
    });

    expect(result.summary).toEqual({
      total: 2,
      successful: 0,
      failed: 2,
      pending: 0,
    });
  });

  it('returns empty deliveries and zero summary when subscription belongs to another user', async () => {
    // Prisma WHERE clause includes createdBy — different user gets no rows.
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_other',
      createdBy: 'GDIFFERENT',
      page: 1,
      limit: 30,
    });

    expect(result.deliveries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.summary).toEqual({
      total: 0,
      successful: 0,
      failed: 0,
      pending: 0,
    });
  });

  it('uses page and limit defaults when not supplied', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: 'GCLIENT',
    });

    expect(result.page).toBe(1);
    expect(result.limit).toBe(30);

    // Verify skip=0 was used (page 1 default)
    expect(prismaMock.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 30 }),
    );
  });

  it('paginates: passes correct skip value for page 2', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(50);

    await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: 'GCLIENT',
      page: 2,
      limit: 10,
    });

    expect(prismaMock.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('queries with the correct subscription/createdBy scope for tenant isolation', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_abc',
      createdBy: 'GCLIENT_XYZ',
      page: 1,
      limit: 5,
    });

    const expectedWhere = { subscription: { id: 'sub_abc', createdBy: 'GCLIENT_XYZ' } };
    expect(prismaMock.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(prismaMock.webhookDelivery.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
  });
});

// ── Controller-level tests ────────────────────────────────────────────────────

describe('webhookController.getDeliveries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wraps service result in { data: { ... } } envelope', async () => {
    const deliveries = [makeDelivery('success', 'd1'), makeDelivery('failed', 'd2')];
    prismaMock.webhookDelivery.findMany.mockResolvedValue(deliveries);
    prismaMock.webhookDelivery.count.mockResolvedValue(2);

    const req = createReq({ params: { id: 'sub_1' }, query: { page: '1', limit: '10' } });
    const res = createRes();

    await webhookController.getDeliveries(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toMatchObject({
      page: 1,
      limit: 10,
      total: 2,
      deliveries,
      summary: { total: 2, successful: 1, failed: 1, pending: 0 },
    });
  });

  it('uses default pagination (page=1, limit=30) when query params are absent', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    const req = createReq({ params: { id: 'sub_1' }, query: {} });
    const res = createRes();

    await webhookController.getDeliveries(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 30 });
  });

  it('returns 400 when page is invalid (non-integer string)', async () => {
    // Simulate what the validate(deliveriesQueryRules) middleware would inject.
    // We replicate by using a req that has already had errors attached via
    // express-validator's run() method, then calling the controller directly.
    //
    // Because the controller checks validationResult(req), we must inject
    // errors the same way express-validator does: via req[Symbol] internals.
    // The simplest approach is to mount the actual middleware in a mini-app.

    const { default: express } = await import('express');
    const { deliveriesQueryRules } = await import('../api/controllers/webhookController.js');
    const { validate } = await import('../api/middleware/validation.js');

    const app = express();
    app.use(express.json());
    app.get(
      '/webhooks/:id/deliveries',
      validate(deliveriesQueryRules),
      webhookController.getDeliveries,
    );

    const { default: supertest } = await import('supertest');
    const response = await supertest(app).get('/webhooks/sub_1/deliveries').query({ page: 'abc' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Validation failed',
      details: expect.arrayContaining([expect.objectContaining({ field: 'page' })]),
    });
  });

  it('returns 400 when limit exceeds 100', async () => {
    const { default: express } = await import('express');
    const { deliveriesQueryRules } = await import('../api/controllers/webhookController.js');
    const { validate } = await import('../api/middleware/validation.js');

    const app = express();
    app.use(express.json());
    app.get(
      '/webhooks/:id/deliveries',
      validate(deliveriesQueryRules),
      webhookController.getDeliveries,
    );

    const { default: supertest } = await import('supertest');
    const response = await supertest(app).get('/webhooks/sub_1/deliveries').query({ limit: '500' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Validation failed',
      details: expect.arrayContaining([expect.objectContaining({ field: 'limit' })]),
    });
  });

  it('returns 400 when page is 0 (< 1)', async () => {
    const { default: express } = await import('express');
    const { deliveriesQueryRules } = await import('../api/controllers/webhookController.js');
    const { validate } = await import('../api/middleware/validation.js');

    const app = express();
    app.use(express.json());
    app.get(
      '/webhooks/:id/deliveries',
      validate(deliveriesQueryRules),
      webhookController.getDeliveries,
    );

    const { default: supertest } = await import('supertest');
    const response = await supertest(app).get('/webhooks/sub_1/deliveries').query({ page: '0' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Validation failed',
      details: expect.arrayContaining([expect.objectContaining({ field: 'page' })]),
    });
  });

  it('returns 400 when limit is 0 (< 1)', async () => {
    const { default: express } = await import('express');
    const { deliveriesQueryRules } = await import('../api/controllers/webhookController.js');
    const { validate } = await import('../api/middleware/validation.js');

    const app = express();
    app.use(express.json());
    app.get(
      '/webhooks/:id/deliveries',
      validate(deliveriesQueryRules),
      webhookController.getDeliveries,
    );

    const { default: supertest } = await import('supertest');
    const response = await supertest(app).get('/webhooks/sub_1/deliveries').query({ limit: '0' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Validation failed',
      details: expect.arrayContaining([expect.objectContaining({ field: 'limit' })]),
    });
  });

  it('passes user address to service for tenant isolation', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    const req = createReq({
      params: { id: 'sub_xyz' },
      query: {},
      user: { address: 'GTENANT_ADDR' },
    });
    const res = createRes();

    await webhookController.getDeliveries(req, res);

    expect(prismaMock.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscription: { id: 'sub_xyz', createdBy: 'GTENANT_ADDR' } },
      }),
    );
  });

  it('returns 500 on unexpected service error', async () => {
    prismaMock.webhookDelivery.findMany.mockRejectedValue(new Error('DB connection lost'));
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    const req = createReq({ params: { id: 'sub_1' }, query: {} });
    const res = createRes();

    await webhookController.getDeliveries(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'DB connection lost' });
  });
});
