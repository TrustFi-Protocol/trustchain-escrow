/**
 * MFA Middleware — end-to-end integration test
 *
 * Exercises the full happy-path flow for a high-value operation: no MFA
 * session yet -> client presents a valid MFA token -> session established
 * and cached -> subsequent request reuses the cached session without
 * re-verifying the token.
 *
 * @module tests/mfaAuth.integration
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const mfaService = {
  requiresMfa: jest.fn(),
};

const cacheStore = new Map();
const cache = {
  get: jest.fn(async (key) => cacheStore.get(key)),
  set: jest.fn(async (key, value) => {
    cacheStore.set(key, value);
  }),
};

jest.unstable_mockModule('../services/mfaService.js', () => ({ default: mfaService }));
jest.unstable_mockModule('../lib/cache.js', () => ({ default: cache }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-mfa-secret';

const { requireMfaForHighValue, generateMfaToken } = await import(
  '../api/middleware/mfaAuth.js'
);

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('MFA middleware — full high-value release flow', () => {
  beforeEach(() => {
    cacheStore.clear();
    mfaService.requiresMfa.mockReset();
  });

  it('walks a user through MFA challenge, verification, and cached reuse', async () => {
    mfaService.requiresMfa.mockResolvedValue(true);

    const user = { userId: 42, id: 42, address: 'GTESTUSER', tenantId: 'tenant-1' };

    // 1. First high-value request with no MFA session or token -> challenged.
    const challengeReq = { user, tenant: { id: 'tenant-1' }, body: { amount: 25000 }, headers: {} };
    const challengeRes = makeRes();
    const challengeNext = jest.fn();

    await requireMfaForHighValue(challengeReq, challengeRes, challengeNext);

    expect(challengeRes.statusCode).toBe(403);
    expect(challengeRes.body.mfaRequired).toBe(true);
    expect(challengeNext).not.toHaveBeenCalled();

    // 2. Client verifies MFA out-of-band and obtains a token.
    const mfaToken = generateMfaToken(user.userId, user.tenantId, 'totp');

    // 3. Retries the high-value request with the MFA token attached.
    const verifiedReq = {
      user,
      tenant: { id: 'tenant-1' },
      body: { amount: 25000 },
      headers: { 'x-mfa-token': mfaToken },
    };
    const verifiedRes = makeRes();
    const verifiedNext = jest.fn();

    await requireMfaForHighValue(verifiedReq, verifiedRes, verifiedNext);

    expect(verifiedNext).toHaveBeenCalledTimes(1);
    expect(verifiedReq.mfaVerified).toBe(true);
    expect(cacheStore.get(`mfa:session:${user.userId}`)).toMatchObject({ verified: true });

    // 4. A subsequent high-value request reuses the cached session, no token needed.
    const cachedReq = { user, tenant: { id: 'tenant-1' }, body: { amount: 30000 }, headers: {} };
    const cachedRes = makeRes();
    const cachedNext = jest.fn();

    await requireMfaForHighValue(cachedReq, cachedRes, cachedNext);

    expect(cachedNext).toHaveBeenCalledTimes(1);
    expect(cachedRes.statusCode).toBeNull();
  });

  it('skips MFA entirely for amounts below the high-value threshold', async () => {
    mfaService.requiresMfa.mockResolvedValue(true);

    const req = {
      user: { userId: 7, id: 7, address: 'GLOWVALUE', tenantId: 'tenant-2' },
      body: { amount: 5 },
      headers: {},
    };
    const res = makeRes();
    const next = jest.fn();

    await requireMfaForHighValue(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mfaService.requiresMfa).not.toHaveBeenCalled();
  });
});
