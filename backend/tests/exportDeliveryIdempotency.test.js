/**
 * Tests for tenant audit export delivery idempotency safeguards (Issue #384)
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const ADDRESS = `G${'C'.repeat(55)}`;
const ROUTE_ADDRESS_A = `G${'D'.repeat(55)}`;
const ROUTE_ADDRESS_B = `G${'E'.repeat(55)}`;
const LARGE_FILE = 'x'.repeat(10 * 1024 * 1024 + 1);

process.env.JWT_SECRET = 'test-secret';

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: {
    user: { findFirst: jest.fn(async () => null) },
    adminAuditLog: { create: jest.fn() },
  },
}));

jest.unstable_mockModule('../queues/emailQueue.js', () => ({
  emailQueue: { add: jest.fn(async () => ({ id: 'email-1' })) },
}));

const { default: exportService } = await import('../services/exportService.js');
const { default: exportController, _resetExportDeliveryDedupe } = await import(
  '../api/controllers/exportController.js'
);
const { default: userRoutes } = await import('../api/routes/userRoutes.js');
const { _resetIdempotencyCache } = await import('../lib/idempotency.js');

function createRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function exportReq(tenantId = 'tenant_1') {
  return { params: { address: ADDRESS }, user: { address: ADDRESS }, tenant: { id: tenantId } };
}

function bearerToken(address) {
  return `Bearer ${jwt.sign({ address, type: 'access' }, process.env.JWT_SECRET)}`;
}

describe('large export delivery deduplication', () => {
  let queueSpy;

  beforeEach(() => {
    _resetExportDeliveryDedupe();
    jest.spyOn(exportService, 'exportUserData').mockResolvedValue({ data: {} });
    jest.spyOn(exportService, 'generateExportFile').mockReturnValue(LARGE_FILE);
    queueSpy = jest
      .spyOn(exportService, 'queueLargeExport')
      .mockResolvedValue({ jobId: 'job-1', downloadUrl: '/redacted' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queues the email delivery once when the request is retried', async () => {
    const first = createRes();
    const retry = createRes();

    await exportController.exportUserData(exportReq(), first);
    await exportController.downloadExportFile(exportReq(), retry);

    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(retry.body.jobId).toBe(first.body.jobId);
    expect(first.headers['Idempotent-Replayed']).toBeUndefined();
    expect(retry.headers['Idempotent-Replayed']).toBe('true');
  });

  it('coalesces concurrent requests into a single delivery', async () => {
    let release;
    queueSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ jobId: 'job-concurrent' });
        }),
    );
    const a = createRes();
    const b = createRes();

    const pending = Promise.all([
      exportController.exportUserData(exportReq(), a),
      exportController.exportUserData(exportReq(), b),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await pending;

    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(a.body.jobId).toBe('job-concurrent');
    expect(b.body.jobId).toBe('job-concurrent');
  });

  it('does not remember failed deliveries so a retry can succeed', async () => {
    queueSpy.mockRejectedValueOnce(new Error('queue unavailable'));
    const failed = createRes();
    const retry = createRes();

    await exportController.exportUserData(exportReq(), failed);
    await exportController.exportUserData(exportReq(), retry);

    expect(failed.statusCode).toBe(500);
    expect(retry.statusCode).toBe(202);
    expect(retry.headers['Idempotent-Replayed']).toBeUndefined();
    expect(queueSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps deliveries isolated per tenant', async () => {
    await exportController.exportUserData(exportReq('tenant_1'), createRes());
    await exportController.exportUserData(exportReq('tenant_2'), createRes());

    expect(queueSpy).toHaveBeenCalledTimes(2);
  });

  it('queues a new delivery once the dedupe window has elapsed', async () => {
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);
    await exportController.exportUserData(exportReq(), createRes());

    nowSpy.mockReturnValue(realNow + 15 * 60 * 1000 + 1);
    await exportController.exportUserData(exportReq(), createRes());

    expect(queueSpy).toHaveBeenCalledTimes(2);
  });
});

describe('export job creation idempotency', () => {
  let createSpy;

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/users', userRoutes);
    return app;
  }

  beforeEach(() => {
    _resetIdempotencyCache();
    createSpy = jest.spyOn(exportService, 'createExportJob');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('replays the original job for a retried Idempotency-Key', async () => {
    const app = createApp();
    const send = () =>
      request(app)
        .post(`/api/users/${ROUTE_ADDRESS_A}/export/jobs`)
        .set('Authorization', bearerToken(ROUTE_ADDRESS_A))
        .set('Idempotency-Key', 'export-job-1')
        .send({});

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.jobId).toBe(first.body.jobId);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an Idempotency-Key with a different payload', async () => {
    const app = createApp();
    const send = (body) =>
      request(app)
        .post(`/api/users/${ROUTE_ADDRESS_B}/export/jobs`)
        .set('Authorization', bearerToken(ROUTE_ADDRESS_B))
        .set('Idempotency-Key', 'export-job-2')
        .send(body);

    await send({}).expect(202);
    const conflict = await send({ format: 'csv' });

    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
