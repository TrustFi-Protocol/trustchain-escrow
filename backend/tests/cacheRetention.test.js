/**
 * Tenant-scoped cache retention controls (#373).
 */

import { jest } from '@jest/globals';

process.env.CACHE_TTL_MAX = '120';
process.env.CACHE_TENANT_MAX_KEYS = '2';
process.env.CACHE_MAX_TRACKED_TENANTS = '2';

const mockCache = {
  get: jest.fn(async () => null),
  setWithTags: jest.fn(async () => {}),
  invalidate: jest.fn(async () => {}),
  invalidatePrefix: jest.fn(async () => {}),
  invalidateTags: jest.fn(async () => {}),
};
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../lib/cache.js', () => ({ default: mockCache }));
jest.unstable_mockModule('../config/logger.js', () => ({ createModuleLogger: () => mockLog }));

const { cacheResponse, boundTtl, getTrackedKeyCount, purgeTenantCache, RETENTION } = await import(
  '../api/middleware/cache.js'
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function store(slug, path, ttl = 30) {
  const req = { method: 'GET', path, query: {}, tenant: { id: `id-${slug}`, slug } };
  const res = { statusCode: 200, setHeader: jest.fn(), json: jest.fn(), on: jest.fn() };
  await cacheResponse({ ttl })(req, res, jest.fn());
  await res.json({ ok: true });
}

beforeEach(async () => {
  jest.clearAllMocks();
  for (const slug of ['alpha', 'beta', 'gamma']) await purgeTenantCache(slug);
  jest.clearAllMocks();
});

test('reads retention bounds from the environment', () => {
  expect(RETENTION).toEqual({ MAX_TTL: 120, MAX_KEYS_PER_TENANT: 2, MAX_TRACKED_TENANTS: 2 });
});

test('stores responses with a bounded TTL and tracks keys per tenant', async () => {
  await store('alpha', '/a', 30);
  await store('alpha', '/b', 9999);

  expect(mockCache.setWithTags.mock.calls.map(([, , ttl]) => ttl)).toEqual([30, 120]);
  expect(getTrackedKeyCount('alpha')).toBe(2);
  expect(getTrackedKeyCount('beta')).toBe(0);
});

test('boundTtl falls back to the default for invalid values', () => {
  expect(boundTtl(0)).toBe(60);
  expect(boundTtl(-5)).toBe(60);
  expect(boundTtl(Number.NaN)).toBe(60);
  expect(boundTtl(45.9)).toBe(45);
});

test('evicts the oldest key once a tenant exceeds its key limit', async () => {
  await store('alpha', '/a');
  await store('alpha', '/b');
  await store('alpha', '/c');
  await flush();

  expect(getTrackedKeyCount('alpha')).toBe(2);
  expect(mockCache.invalidate).toHaveBeenCalledTimes(1);
  expect(mockCache.invalidate).toHaveBeenCalledWith('t:alpha:http:GET:/a');
});

test('evicting a tenant tracker drops only that tenant\'s keys', async () => {
  await store('alpha', '/a');
  await store('beta', '/a');
  await store('gamma', '/a');
  await flush();

  expect(getTrackedKeyCount('alpha')).toBe(0);
  expect(mockCache.invalidate).toHaveBeenCalledWith('t:alpha:http:GET:/a');
  expect(mockCache.invalidate).not.toHaveBeenCalledWith('t:beta:http:GET:/a');
});

test('eviction failures are logged without the key and do not throw', async () => {
  mockCache.invalidate.mockRejectedValueOnce(new Error('redis down'));
  await store('alpha', '/a');
  await store('alpha', '/b');
  await store('alpha', '/c');
  await flush();

  expect(mockLog.warn).toHaveBeenCalledWith({
    message: 'cache.retention_evict_failed',
    error: 'redis down',
  });
});

test('purgeTenantCache removes only the tenant prefix', async () => {
  await store('alpha', '/a');
  await purgeTenantCache('alpha');

  expect(mockCache.invalidatePrefix).toHaveBeenCalledWith('t:alpha:');
  expect(getTrackedKeyCount('alpha')).toBe(0);
});

test.each(['', '*', 'alpha:*', 'a'.repeat(65), undefined])(
  'purgeTenantCache rejects unsafe slug %p',
  async (slug) => {
    await expect(purgeTenantCache(slug)).rejects.toThrow('requires a valid tenant slug');
    expect(mockCache.invalidatePrefix).not.toHaveBeenCalled();
  },
);
