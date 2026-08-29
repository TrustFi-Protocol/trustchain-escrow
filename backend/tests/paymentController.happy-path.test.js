/**
 * paymentController — Happy-Path Integration Tests
 *
 * `paymentController.authz.test.js` covers authorization edge cases via
 * direct controller invocation with mocked req/res, but never exercises the
 * successful flow through the real Express routes (auth, validation,
 * authorization, then the controller). This fills that gap: mounts the real
 * `paymentRoutes` on an Express app and hits it over HTTP via supertest,
 * mocking only the service layer (issue #104).
 *
 * @module tests/paymentController.happy-path
 */

import { jest } from '@jest/globals';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const ADDRESS = `G${'A'.repeat(55)}`;

const paymentServiceMock = {
  createCheckoutSession: jest.fn(),
  getBySessionId: jest.fn(),
  getByAddress: jest.fn(),
  getById: jest.fn(),
  refund: jest.fn(),
  handleWebhook: jest.fn(),
};

const kycServiceMock = {
  getStatus: jest.fn(),
};

jest.unstable_mockModule('../services/paymentService.js', () => ({
  default: paymentServiceMock,
}));

jest.unstable_mockModule('../services/kycService.js', () => ({
  default: kycServiceMock,
}));

const { JWT_SECRET, JWT_ALGORITHM } = await import('../config/secrets.js');
const { default: paymentRoutes } = await import('../api/routes/paymentRoutes.js');

function bearerToken(address = ADDRESS) {
  return `Bearer ${jwt.sign({ address }, JWT_SECRET, { algorithm: JWT_ALGORITHM })}`;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('paymentController happy path (integration)', () => {
  it('creates a checkout session for a KYC-approved wallet', async () => {
    kycServiceMock.getStatus.mockResolvedValue({ status: 'Approved' });
    paymentServiceMock.createCheckoutSession.mockResolvedValue({
      id: 'sess_1',
      url: 'https://checkout.example/sess_1',
    });

    const res = await request(createApp())
      .post('/api/payments/checkout')
      .set('Authorization', bearerToken())
      .send({ address: ADDRESS, amountUsd: 25 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'sess_1', url: 'https://checkout.example/sess_1' });
    expect(paymentServiceMock.createCheckoutSession).toHaveBeenCalledWith({
      address: ADDRESS,
      amountUsd: 25,
      escrowId: undefined,
    });
  });

  it('rejects checkout for a wallet without Approved KYC status', async () => {
    kycServiceMock.getStatus.mockResolvedValue({ status: 'Pending' });

    const res = await request(createApp())
      .post('/api/payments/checkout')
      .set('Authorization', bearerToken())
      .send({ address: ADDRESS, amountUsd: 25 });

    expect(res.status).toBe(403);
    expect(paymentServiceMock.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('gets payment status by Stripe session id for the owning wallet', async () => {
    paymentServiceMock.getBySessionId.mockResolvedValue({
      id: 'pay_1',
      address: ADDRESS,
      status: 'Completed',
    });

    const res = await request(createApp())
      .get('/api/payments/status/sess_1')
      .set('Authorization', bearerToken());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'pay_1', address: ADDRESS, status: 'Completed' });
  });

  it('lists payments for the owning wallet address', async () => {
    paymentServiceMock.getByAddress.mockResolvedValue([{ id: 'pay_1' }, { id: 'pay_2' }]);

    const res = await request(createApp())
      .get(`/api/payments/${ADDRESS}`)
      .set('Authorization', bearerToken());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'pay_1' }, { id: 'pay_2' }]);
  });

  it('refunds a completed payment owned by the caller', async () => {
    paymentServiceMock.getById.mockResolvedValue({
      id: 'pay_1',
      address: ADDRESS,
      status: 'Completed',
    });
    paymentServiceMock.refund.mockResolvedValue({ id: 'pay_1', status: 'Refunded' });

    const res = await request(createApp())
      .post('/api/payments/pay_1/refund')
      .set('Authorization', bearerToken());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'pay_1', status: 'Refunded' });
    expect(paymentServiceMock.refund).toHaveBeenCalledWith('pay_1');
  });

  it('accepts a valid Stripe webhook', async () => {
    paymentServiceMock.handleWebhook.mockResolvedValue(undefined);

    const res = await request(createApp())
      .post('/api/payments/webhook')
      .set('stripe-signature', 'sig_test')
      .send({ type: 'checkout.session.completed' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(paymentServiceMock.handleWebhook).toHaveBeenCalledWith(
      expect.any(String),
      'sig_test',
    );
  });

  it('rejects a webhook with no stripe-signature header', async () => {
    const res = await request(createApp()).post('/api/payments/webhook').send({});

    expect(res.status).toBe(400);
    expect(paymentServiceMock.handleWebhook).not.toHaveBeenCalled();
  });
});
