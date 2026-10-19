/**
 * Payment submission replay protection configuration (#375).
 */

import { jest } from '@jest/globals';

const ADDRESS = `G${'A'.repeat(55)}`;

const paymentServiceMock = { createCheckoutSession: jest.fn() };
const kycServiceMock = { getStatus: jest.fn() };

jest.unstable_mockModule('../services/paymentService.js', () => ({ default: paymentServiceMock }));
jest.unstable_mockModule('../services/kycService.js', () => ({ default: kycServiceMock }));

const {
  default: paymentController,
  loadReplayProtectionConfig,
  checkIdempotencyKey,
} = await import('../api/controllers/paymentController.js');

function createMockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => jest.clearAllMocks());

describe('loadReplayProtectionConfig', () => {
  it('returns safe defaults when nothing is configured', () => {
    expect(loadReplayProtectionConfig({})).toEqual({
      requireKey: false,
      minKeyLength: 1,
      maxKeyLength: 255,
    });
  });

  it('accepts a valid explicit configuration', () => {
    expect(
      loadReplayProtectionConfig({
        PAYMENT_REPLAY_REQUIRE_IDEMPOTENCY_KEY: 'true',
        PAYMENT_REPLAY_KEY_MIN_LENGTH: '16',
        PAYMENT_REPLAY_KEY_MAX_LENGTH: '64',
      }),
    ).toEqual({ requireKey: true, minKeyLength: 16, maxKeyLength: 64 });
  });

  it('rejects malformed values, naming the setting but not the value', () => {
    const run = () =>
      loadReplayProtectionConfig({
        PAYMENT_REPLAY_REQUIRE_IDEMPOTENCY_KEY: 'sk_live_secret',
        PAYMENT_REPLAY_KEY_MAX_LENGTH: '9999',
      });

    expect(run).toThrow(/PAYMENT_REPLAY_REQUIRE_IDEMPOTENCY_KEY must be "true" or "false"/);
    expect(run).toThrow(/PAYMENT_REPLAY_KEY_MAX_LENGTH must be an integer between 1 and 255/);
    expect(run).not.toThrow(/sk_live_secret|9999/);
  });

  it('rejects contradictory key length bounds', () => {
    expect(() =>
      loadReplayProtectionConfig({
        PAYMENT_REPLAY_KEY_MIN_LENGTH: '64',
        PAYMENT_REPLAY_KEY_MAX_LENGTH: '16',
      }),
    ).toThrow('PAYMENT_REPLAY_KEY_MIN_LENGTH must not exceed PAYMENT_REPLAY_KEY_MAX_LENGTH.');
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects out-of-range length %p', (value) => {
    expect(() => loadReplayProtectionConfig({ PAYMENT_REPLAY_KEY_MIN_LENGTH: value })).toThrow(
      /PAYMENT_REPLAY_KEY_MIN_LENGTH/,
    );
  });
});

describe('checkIdempotencyKey', () => {
  const strict = { requireKey: true, minKeyLength: 8, maxKeyLength: 16 };

  it('accepts a key within bounds', () => {
    expect(checkIdempotencyKey({ headers: { 'idempotency-key': 'abcdefgh' } }, strict)).toBeNull();
  });

  it('requires a key when configured', () => {
    expect(checkIdempotencyKey({ headers: {} }, strict)).toMatch(/is required/);
  });

  it('rejects keys outside the configured length bounds', () => {
    expect(checkIdempotencyKey({ headers: { 'idempotency-key': 'short' } }, strict)).toMatch(
      /between 8 and 16/,
    );
    expect(
      checkIdempotencyKey({ headers: { 'idempotency-key': 'x'.repeat(17) } }, strict),
    ).toMatch(/between 8 and 16/);
  });
});

describe('createCheckout with default replay configuration', () => {
  it('still accepts submissions without an Idempotency-Key', async () => {
    kycServiceMock.getStatus.mockResolvedValue({ status: 'Approved' });
    paymentServiceMock.createCheckoutSession.mockResolvedValue({ url: 'https://checkout' });
    const res = createMockRes();

    await paymentController.createCheckout(
      { headers: {}, body: { address: ADDRESS, amountUsd: 10 }, user: { address: ADDRESS } },
      res,
    );

    expect(res.json).toHaveBeenCalledWith({ url: 'https://checkout' });
  });

  it('rejects an oversized Idempotency-Key before calling the payment service', async () => {
    const res = createMockRes();

    await paymentController.createCheckout(
      {
        headers: { 'idempotency-key': 'k'.repeat(256) },
        body: { address: ADDRESS, amountUsd: 10 },
        user: { address: ADDRESS },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(paymentServiceMock.createCheckoutSession).not.toHaveBeenCalled();
  });
});
