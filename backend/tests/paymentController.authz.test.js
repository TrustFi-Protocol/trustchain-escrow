import { jest } from '@jest/globals';

const ADDRESS_A = `G${'A'.repeat(55)}`;
const ADDRESS_B = `G${'B'.repeat(55)}`;

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

const loggerMock = {
  getLogger: jest.fn(() => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() })),
  logControllerError: jest.fn(),
};

jest.unstable_mockModule('../services/paymentService.js', () => ({
  default: paymentServiceMock,
}));

jest.unstable_mockModule('../services/kycService.js', () => ({
  default: kycServiceMock,
}));

jest.unstable_mockModule('../config/logger.js', () => loggerMock);

const { default: paymentController } = await import('../api/controllers/paymentController.js');

function createMockRes() {
  return {
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
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('paymentController authorization', () => {
  it('creates a checkout normally when replay protection is available', async () => {
    const req = {
      body: { address: ADDRESS_A, amountUsd: 10, escrowId: 'escrow-1' },
      user: { address: ADDRESS_A },
    };
    const res = createMockRes();
    const checkout = { id: 'cs_123', url: 'https://checkout.example/session' };

    kycServiceMock.getStatus.mockResolvedValue({ status: 'Approved' });
    paymentServiceMock.createCheckoutSession.mockResolvedValue(checkout);

    await paymentController.createCheckout(req, res);

    expect(paymentServiceMock.createCheckoutSession).toHaveBeenCalledWith({
      address: ADDRESS_A,
      amountUsd: 10,
      escrowId: 'escrow-1',
    });
    expect(res.body).toEqual(checkout);
  });

  it('returns a stable retryable response when replay protection is unavailable', async () => {
    const req = {
      body: { address: ADDRESS_A, amountUsd: 10 },
      user: { address: ADDRESS_A },
      requestId: 'request-123',
    };
    const res = createMockRes();

    kycServiceMock.getStatus.mockResolvedValue({ status: 'Approved' });
    paymentServiceMock.createCheckoutSession.mockRejectedValue(
      Object.assign(new Error('cache connection refused: secret=do-not-log'), {
        code: 'REDIS_UNAVAILABLE',
      }),
    );

    await paymentController.createCheckout(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toEqual({
      error: 'Payment submission is temporarily unavailable. Retry with the same Idempotency-Key.',
      code: 'PAYMENT_REPLAY_PROTECTION_DEGRADED',
      retryable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('do-not-log');
    expect(loggerMock.getLogger().mock.results[0].value.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'payment.replay_protection_degraded',
        code: 'REDIS_UNAVAILABLE',
        requestId: 'request-123',
      }),
    );
  });

  it('supports an explicit degraded signal from the replay protection adapter', async () => {
    const req = {
      body: { address: ADDRESS_A, amountUsd: 10 },
      user: { address: ADDRESS_A },
    };
    const res = createMockRes();

    kycServiceMock.getStatus.mockResolvedValue({ status: 'Approved' });
    paymentServiceMock.createCheckoutSession.mockRejectedValue(
      Object.assign(new Error('optional dependency unavailable'), {
        replayProtectionUnavailable: true,
      }),
    );

    await paymentController.createCheckout(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body.code).toBe('PAYMENT_REPLAY_PROTECTION_DEGRADED');
  });

  it('preserves the existing response for a non-replay payment failure', async () => {
    const req = {
      body: { address: ADDRESS_A, amountUsd: 10 },
      user: { address: ADDRESS_A },
    };
    const res = createMockRes();

    kycServiceMock.getStatus.mockResolvedValue({ status: 'Approved' });
    paymentServiceMock.createCheckoutSession.mockRejectedValue(new Error('Stripe rejected the request'));

    await paymentController.createCheckout(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ error: 'Stripe rejected the request' });
  });

  it('rejects checkout when the requested wallet does not match the JWT wallet', async () => {
    const req = {
      body: { address: ADDRESS_A, amountUsd: 10 },
      user: { address: ADDRESS_B },
    };
    const res = createMockRes();

    await paymentController.createCheckout(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(paymentServiceMock.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects payment status lookup for another wallet', async () => {
    const req = {
      params: { sessionId: 'sess_123' },
      user: { address: ADDRESS_A },
    };
    const res = createMockRes();

    paymentServiceMock.getBySessionId.mockResolvedValue({
      id: 'pay_123',
      address: ADDRESS_B,
      status: 'Completed',
    });

    await paymentController.getStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects refunds for payments owned by another wallet', async () => {
    const req = {
      params: { paymentId: 'pay_123' },
      user: { address: ADDRESS_A },
    };
    const res = createMockRes();

    paymentServiceMock.getById.mockResolvedValue({
      id: 'pay_123',
      address: ADDRESS_B,
      status: 'Completed',
    });

    await paymentController.refund(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(paymentServiceMock.refund).not.toHaveBeenCalled();
  });

  it('returns 404 when refund target payment does not exist', async () => {
    const req = {
      params: { paymentId: 'pay_missing' },
      user: { address: ADDRESS_A },
    };
    const res = createMockRes();

    paymentServiceMock.getById.mockResolvedValue(null);

    await paymentController.refund(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(paymentServiceMock.refund).not.toHaveBeenCalled();
  });
});
