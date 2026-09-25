/**
 * Tests for Issue #204 — POST /api/escrows/templates/validate
 *
 * Validates the escrow template endpoint using supertest against a lightweight
 * Express app that wires up the same middleware stack used in production.
 *
 * Because validation is stateless (no DB / cache calls), Prisma and Redis are
 * mocked out so no real infrastructure is required.
 */

import { jest, describe, expect, it, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// ── Infrastructure mocks ──────────────────────────────────────────────────────
// The escrow controller imports Prisma and cache; we stub them so the module
// graph resolves cleanly without a running database or Redis instance.

const prismaMock = {
  escrow: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    upsert: jest.fn(),
  },
  milestone: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops)),
};

const cacheMock = {
  get: jest.fn().mockReturnValue(null),
  set: jest.fn(),
  setWithTags: jest.fn(),
  invalidate: jest.fn(),
  invalidateTags: jest.fn(),
  invalidatePrefix: jest.fn(),
  analytics: jest
    .fn()
    .mockReturnValue({
      backend: 'memory',
      hits: 0,
      misses: 0,
      hitRate: '0%',
      sets: 0,
      invalidations: 0,
    }),
};

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../lib/cache.js', () => ({ default: cacheMock }));

// Stub auth so we don't need real JWTs in tests
jest.unstable_mockModule('../api/middleware/auth.js', () => ({
  default: (req, _res, next) => {
    req.user = { userId: 1, tenantId: 'tenant_default', type: 'access' };
    next();
  },
}));

// Stub the Stellar SDK dependency pulled in by escrowController
jest.unstable_mockModule('@stellar/stellar-sdk', () => ({
  xdr: { ScVal: { fromXDR: jest.fn() } },
  scValToNative: jest.fn(),
}));

// Stub stellarService so broadcastCreateEscrow doesn't try to connect
jest.unstable_mockModule('../services/stellarService.js', () => ({
  submitTransaction: jest.fn(),
}));

// ── Dynamic imports (must come after unstable_mockModule calls) ───────────────
const { default: escrowRoutes } = await import('../api/routes/escrowRoutes.js');

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenant = { id: 'tenant_default' };
    next();
  });
  app.use('/api/escrows', escrowRoutes);
  return app;
}

// ── Test data helpers ─────────────────────────────────────────────────────────

/** A well-formed Stellar address (G + 55 uppercase base32 characters). */
const VALID_ADDRESS = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const VALID_ADDRESS_2 = 'GBVLHRAQPCTYXQDORJSWHFR2FXMQJXSYLJT2XHVG2EQKBDXQ3XFKJLB';
const VALID_ADDRESS_3 = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKJMQ7UJCJFXZLWLKPYFD';

const FUTURE_DATE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

/** Returns a minimal valid template payload. */
function validTemplate(overrides = {}) {
  return {
    clientAddress: VALID_ADDRESS,
    freelancerAddress: VALID_ADDRESS_2,
    tokenId: 'native',
    milestones: [
      { amount: 100, description: 'Design phase' },
      { amount: 200, description: 'Development phase' },
    ],
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/escrows/templates/validate', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 200 with valid: true and a summary for a complete valid template', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/escrows/templates/validate').send(validTemplate());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true,
      summary: {
        totalAmount: 300,
        milestoneCount: 2,
      },
    });
  });

  it('returns 200 and uses declared totalAmount in summary when it matches milestone sum', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ totalAmount: 300 }));

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.summary.totalAmount).toBe(300);
  });

  it('accepts an optional arbiterAddress when it is a valid Stellar address', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ arbiterAddress: VALID_ADDRESS_3 }));

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('accepts tokenAddress in place of tokenId', async () => {
    const app = buildApp();
    const payload = validTemplate();
    delete payload.tokenId;
    payload.tokenAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    const res = await request(app).post('/api/escrows/templates/validate').send(payload);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('accepts a valid future top-level deadline', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ deadline: FUTURE_DATE }));

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('accepts milestone-level deadlines that are before the escrow deadline', async () => {
    const app = buildApp();
    const escrowDeadline = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const milestoneDL = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          deadline: escrowDeadline,
          milestones: [{ amount: 100, description: 'First milestone', deadline: milestoneDL }],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('handles a single milestone correctly', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 500, description: 'Full project delivery' }],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalAmount: 500, milestoneCount: 1 });
  });

  it('accepts milestones with string numeric amounts', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: '150', description: 'Phase one' }],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.summary.totalAmount).toBe(150);
  });

  // ── Missing required address fields ────────────────────────────────────────

  it('returns 400 when clientAddress is missing', async () => {
    const app = buildApp();
    const payload = validTemplate();
    delete payload.clientAddress;

    const res = await request(app).post('/api/escrows/templates/validate').send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'clientAddress' })]),
    );
  });

  it('returns 400 when freelancerAddress is missing', async () => {
    const app = buildApp();
    const payload = validTemplate();
    delete payload.freelancerAddress;

    const res = await request(app).post('/api/escrows/templates/validate').send(payload);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'freelancerAddress' })]),
    );
  });

  // ── Invalid Stellar address formats ────────────────────────────────────────

  it('returns 400 when clientAddress has an invalid Stellar address format', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ clientAddress: 'not-a-stellar-address' }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'clientAddress' })]),
    );
  });

  it('returns 400 when clientAddress starts with wrong letter', async () => {
    const app = buildApp();
    // Valid base32 length but starts with S (secret key prefix, not public key)
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({ clientAddress: 'SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'clientAddress' })]),
    );
  });

  it('returns 400 when freelancerAddress is not a valid Stellar address', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ freelancerAddress: 'INVALID' }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'freelancerAddress' })]),
    );
  });

  it('returns 400 when arbiterAddress is present but invalid', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ arbiterAddress: 'bad-address' }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'arbiterAddress' })]),
    );
  });

  // ── Token identifier ────────────────────────────────────────────────────────

  it('returns 400 when neither tokenId nor tokenAddress is provided', async () => {
    const app = buildApp();
    const payload = validTemplate();
    delete payload.tokenId;

    const res = await request(app).post('/api/escrows/templates/validate').send(payload);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'tokenId' })]),
    );
  });

  // ── Deadline validations ────────────────────────────────────────────────────

  it('returns 400 when the top-level deadline is in the past', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ deadline: PAST_DATE }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'deadline' })]),
    );
  });

  it('returns 400 when the top-level deadline is not a valid ISO date', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ deadline: 'not-a-date' }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'deadline' })]),
    );
  });

  it('returns 400 when a milestone deadline is in the past', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 100, description: 'Late milestone', deadline: PAST_DATE }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: expect.stringMatching(/milestones\[\d+\]\.deadline|milestones\.\d+\.deadline/),
        }),
      ]),
    );
  });

  it('returns 400 when a milestone deadline is after the escrow deadline', async () => {
    const app = buildApp();
    const escrowDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const milestoneDL = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          deadline: escrowDeadline,
          milestones: [
            { amount: 100, description: 'Out-of-bounds milestone', deadline: milestoneDL },
          ],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  // ── Milestones array ────────────────────────────────────────────────────────

  it('returns 400 when milestones is an empty array', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ milestones: [] }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'milestones' })]),
    );
  });

  it('returns 400 when milestones is not an array', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ milestones: 'not-an-array' }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'milestones' })]),
    );
  });

  it('returns 400 when milestones is missing entirely', async () => {
    const app = buildApp();
    const payload = validTemplate();
    delete payload.milestones;

    const res = await request(app).post('/api/escrows/templates/validate').send(payload);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'milestones' })]),
    );
  });

  it('returns 400 when milestones exceeds 20 items', async () => {
    const app = buildApp();
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      amount: 10,
      description: `Milestone ${i + 1}`,
    }));

    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(validTemplate({ milestones: tooMany }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'milestones' })]),
    );
  });

  // ── Milestone amount validation ─────────────────────────────────────────────

  it('returns 400 when a milestone amount is 0', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 0, description: 'Zero amount milestone' }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  it('returns 400 when a milestone amount is negative', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: -50, description: 'Negative amount' }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  it('returns 400 when a milestone amount is a non-numeric string', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 'free', description: 'Non-numeric amount' }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  it('returns 400 when a milestone amount is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ description: 'No amount given' }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  // ── Milestone description validation ───────────────────────────────────────

  it('returns 400 when a milestone description is empty', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 100, description: '' }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  it('returns 400 when a milestone description exceeds 500 characters', async () => {
    const app = buildApp();
    const longDesc = 'x'.repeat(501);

    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 100, description: longDesc }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  it('accepts a milestone description that is exactly 500 characters', async () => {
    const app = buildApp();
    const maxDesc = 'a'.repeat(500);

    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 100, description: maxDesc }],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('returns 400 when a milestone description is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          milestones: [{ amount: 100 }],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/milestones/) }),
      ]),
    );
  });

  // ── totalAmount cross-field validation ──────────────────────────────────────

  it('returns 400 when declared totalAmount does not match the sum of milestone amounts', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send(
        validTemplate({
          totalAmount: 999, // actual sum is 300 (100 + 200)
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'totalAmount' })]),
    );
  });

  // ── Multiple errors reported at once ───────────────────────────────────────

  it('reports multiple field errors in a single 400 response', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/escrows/templates/validate')
      .send({
        // Both required address fields are invalid
        clientAddress: 'bad',
        freelancerAddress: 'also-bad',
        tokenId: 'native',
        milestones: [{ amount: 100, description: 'OK milestone' }],
      });

    expect(res.status).toBe(400);
    const fields = res.body.details.map((d) => d.field);
    expect(fields).toContain('clientAddress');
    expect(fields).toContain('freelancerAddress');
  });
});
