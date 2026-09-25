/**
 * Tests for tenant-level metrics access control
 * (backend/api/routes/metricsRoutes.js)
 *
 * Coverage:
 *   - System admin via METRICS_TOKEN Bearer → 200, Prometheus text
 *   - System admin via req.isAdmin (adminAuth) → 200, Prometheus text
 *   - Tenant admin user (role=admin + tenantId) → 200, JSON tenant scope
 *   - Tenant admin user (role=superadmin + tenantId) → 200, JSON tenant scope
 *   - Normal authenticated user (role=user) → 403
 *   - Unauthenticated request → 403
 *   - METRICS_TOKEN not set + req.isAdmin → 200 (still global via admin path)
 *   - Tenant admin without tenantId → 403
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Stable mock values ────────────────────────────────────────────────────────

const FAKE_METRICS_TEXT = '# HELP cache_size Current number\ncache_size 0\n';
const FAKE_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const mockMetrics = jest.fn(async () => FAKE_METRICS_TEXT);
const mockCacheSizeSet = jest.fn();
const mockCacheSize = jest.fn(() => 5);

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('../../lib/metrics.js', () => ({
  register: {
    metrics: mockMetrics,
    contentType: FAKE_CONTENT_TYPE,
    getMetricsAsJSON: jest.fn(async () => []),
  },
  cacheSize: { set: mockCacheSizeSet },
}));

jest.unstable_mockModule('../../lib/cache.js', () => ({
  default: { size: mockCacheSize },
}));

jest.unstable_mockModule('../../config/logger.js', () => ({
  createModuleLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// optionalAdminAuth: we control its behaviour per-test by setting env vars or
// by providing a test-side mock. We mock the whole module and expose a
// controllable implementation so we can simulate req.isAdmin being set.
const mockOptionalAdminAuth = jest.fn((req, _res, next) => next());

jest.unstable_mockModule('../../api/middleware/adminAuth.js', () => ({
  default: jest.fn((req, _res, next) => next()),
  optionalAdminAuth: mockOptionalAdminAuth,
  issueAdminToken: jest.fn(),
  verifyAdminToken: jest.fn(),
  ADMIN_TOKEN_TTL: '15m',
}));

// Mock jsonwebtoken used inside optionalAuth in the route.
const mockJwtVerify = jest.fn();

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    verify: mockJwtVerify,
    sign: jest.fn(),
  },
}));

// Mock secrets so the route module doesn't fail to import them.
jest.unstable_mockModule('../../config/secrets.js', () => ({
  JWT_SECRET: 'test-secret',
  JWT_ALGORITHM: 'HS256',
  ADMIN_JWT_SECRET: 'admin-secret',
}));

// ── Dynamic imports (after mocks) ─────────────────────────────────────────────

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: metricsRoutes } = await import('../../api/routes/metricsRoutes.js');

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/metrics', metricsRoutes);
  return app;
}

// ── Env helpers ───────────────────────────────────────────────────────────────

const METRICS_TOKEN = 'super-secret-metrics-token';

function setMetricsToken(token) {
  if (token) process.env.METRICS_TOKEN = token;
  else delete process.env.METRICS_TOKEN;
}

// ── Reset ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: optionalAdminAuth is a no-op (does NOT set req.isAdmin).
  mockOptionalAdminAuth.mockImplementation((_req, _res, next) => next());
  // Default: JWT verify throws (unauthenticated).
  mockJwtVerify.mockImplementation(() => {
    throw new Error('invalid token');
  });
  delete process.env.METRICS_TOKEN;
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /metrics — system admin via METRICS_TOKEN', () => {
  it('returns 200 with Prometheus text when Bearer matches METRICS_TOKEN', async () => {
    setMetricsToken(METRICS_TOKEN);

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe(FAKE_METRICS_TEXT);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('calls cacheSize.set when serving global metrics', async () => {
    setMetricsToken(METRICS_TOKEN);

    await request(buildApp()).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`);

    expect(mockCacheSizeSet).toHaveBeenCalledWith(5);
  });

  it('returns 403 when Bearer token does not match METRICS_TOKEN', async () => {
    setMetricsToken(METRICS_TOKEN);

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });
});

describe('GET /metrics — system admin via req.isAdmin (adminAuth)', () => {
  it('returns 200 with Prometheus text when req.isAdmin is true', async () => {
    // Simulate optionalAdminAuth setting req.isAdmin.
    mockOptionalAdminAuth.mockImplementation((req, _res, next) => {
      req.isAdmin = true;
      req.adminId = 'admin';
      next();
    });

    const res = await request(buildApp()).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toBe(FAKE_METRICS_TEXT);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('grants global scope even when METRICS_TOKEN is not set', async () => {
    delete process.env.METRICS_TOKEN;
    mockOptionalAdminAuth.mockImplementation((req, _res, next) => {
      req.isAdmin = true;
      next();
    });

    const res = await request(buildApp()).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toBe(FAKE_METRICS_TEXT);
  });
});

describe('GET /metrics — tenant admin user', () => {
  function mockTenantAdminJwt(role, tenantId = 'tenant_abc') {
    mockJwtVerify.mockReturnValue({
      address: 'GTENANTADMIN',
      jti: 'jti-123',
      role,
      tenantId,
    });
  }

  it('returns 200 with JSON tenant scope for role=admin', async () => {
    mockTenantAdminJwt('admin', 'tenant_xyz');

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer user-jwt-token');

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('tenant');
    expect(res.body.tenantId).toBe('tenant_xyz');
    expect(res.body.note).toBeDefined();
  });

  it('returns 200 with JSON tenant scope for role=superadmin', async () => {
    mockTenantAdminJwt('superadmin', 'tenant_super');

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer user-jwt-token');

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('tenant');
    expect(res.body.tenantId).toBe('tenant_super');
  });

  it('does NOT serve Prometheus text to tenant admin', async () => {
    mockTenantAdminJwt('admin', 'tenant_xyz');

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer user-jwt-token');

    expect(res.text).not.toBe(FAKE_METRICS_TEXT);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns 403 when tenant admin has no tenantId', async () => {
    // role is admin but tenantId is missing
    mockJwtVerify.mockReturnValue({
      address: 'GTENANTADMIN',
      role: 'admin',
      tenantId: undefined,
    });

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer user-jwt-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });
});

describe('GET /metrics — normal authenticated user', () => {
  it('returns 403 for role=user', async () => {
    mockJwtVerify.mockReturnValue({
      address: 'GNORMAL',
      jti: 'jti-456',
      role: 'user',
      tenantId: 'tenant_abc',
    });

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer user-jwt-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns 403 when role is missing', async () => {
    mockJwtVerify.mockReturnValue({
      address: 'GNORMAL',
      tenantId: 'tenant_abc',
    });

    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer user-jwt-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });
});

describe('GET /metrics — unauthenticated', () => {
  it('returns 403 when no Authorization header is sent', async () => {
    const res = await request(buildApp()).get('/metrics');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns 403 when Authorization header is malformed', async () => {
    const res = await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(res.status).toBe(403);
  });
});
