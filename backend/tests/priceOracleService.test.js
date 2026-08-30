/**
 * Tests for priceOracleService
 *
 * Covers:
 *  - Empty input → empty state
 *  - Oracle failure (network error) → empty state
 *  - Oracle returns no matching records → empty state
 *  - Normal result with one or more assets
 *  - Results are cached; subsequent calls skip the oracle
 *  - clearCache() invalidates cached entries
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Cache mock ────────────────────────────────────────────────────────────────
// Provide a simple in-memory cache so the service logic runs without Redis.

const _cacheStore = new Map();

jest.unstable_mockModule('../lib/cache.js', () => ({
  default: {
    get: jest.fn(async (key) => _cacheStore.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      _cacheStore.set(key, value);
    }),
    invalidatePrefix: jest.fn(async (prefix) => {
      for (const key of _cacheStore.keys()) {
        if (key.startsWith(prefix)) _cacheStore.delete(key);
      }
    }),
  },
}));

// ── fetch mock ────────────────────────────────────────────────────────────────

const _fetchMock = jest.fn();
global.fetch = _fetchMock;

// ── Module under test (imported after mocks are registered) ───────────────────

const { getPrices, getPrice, clearCache, EMPTY_STATE_MESSAGE } = await import(
  '../services/priceOracleService.js'
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockOracleResponse(data, status = 200) {
  _fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

function mockOracleFailure(message = 'Network error') {
  _fetchMock.mockRejectedValueOnce(new Error(message));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _cacheStore.clear();
  _fetchMock.mockClear();
});

describe('getPrices — empty state', () => {
  it('returns empty state when called with an empty array', async () => {
    const result = await getPrices([]);
    expect(result.prices).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.message).toBe(EMPTY_STATE_MESSAGE);
    // No network call should have been made
    expect(_fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty state when the oracle fetch throws a network error', async () => {
    mockOracleFailure('connect ECONNREFUSED');
    const result = await getPrices(['stellar'], { fresh: true });
    expect(result.prices).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.message).toBe(EMPTY_STATE_MESSAGE);
  });

  it('returns empty state when the oracle returns HTTP 5xx', async () => {
    mockOracleResponse({}, 503);
    const result = await getPrices(['stellar'], { fresh: true });
    expect(result.prices).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.message).toBe(EMPTY_STATE_MESSAGE);
  });

  it('returns empty state when the oracle responds with no matching records', async () => {
    // Oracle returns an empty object — none of the requested IDs had data
    mockOracleResponse({});
    const result = await getPrices(['totally-unknown-token'], { fresh: true });
    expect(result.prices).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.message).toBe(EMPTY_STATE_MESSAGE);
  });
});

describe('getPrices — normal results', () => {
  const singleAssetOracle = {
    stellar: {
      usd: 0.12,
      usd_24h_change: 1.5,
      last_updated_at: 1700000000,
    },
  };

  it('returns normalised price records for a single asset', async () => {
    mockOracleResponse(singleAssetOracle);
    const result = await getPrices(['stellar'], { fresh: true });
    expect(result.total).toBe(1);
    expect(result.message).toBeNull();
    expect(result.prices[0]).toMatchObject({
      id: 'stellar',
      currency: 'usd',
      price: 0.12,
      change24h: 1.5,
    });
    expect(result.prices[0].updatedAt).toBeTruthy();
  });

  it('returns multiple price records when multiple assets are requested', async () => {
    mockOracleResponse({
      stellar: { usd: 0.12, usd_24h_change: 1.5, last_updated_at: 1700000000 },
      'usd-coin': { usd: 1.0, usd_24h_change: 0.01, last_updated_at: 1700000000 },
    });
    const result = await getPrices(['stellar', 'usd-coin'], { fresh: true });
    expect(result.total).toBe(2);
    expect(result.prices.map((p) => p.id)).toEqual(
      expect.arrayContaining(['stellar', 'usd-coin']),
    );
  });

  it('omits unknown assets from the results (partial response from oracle)', async () => {
    // oracle knows 'stellar' but not 'unknown-token'
    mockOracleResponse({
      stellar: { usd: 0.12, usd_24h_change: 0, last_updated_at: 1700000000 },
    });
    const result = await getPrices(['stellar', 'unknown-token'], { fresh: true });
    expect(result.total).toBe(1);
    expect(result.prices[0].id).toBe('stellar');
  });
});

describe('getPrices — caching', () => {
  it('returns cached data without calling the oracle again', async () => {
    mockOracleResponse({
      stellar: { usd: 0.12, usd_24h_change: 1.5, last_updated_at: 1700000000 },
    });
    // First call — hits oracle and caches
    await getPrices(['stellar'], { fresh: true });
    expect(_fetchMock).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    _fetchMock.mockClear();
    const cached = await getPrices(['stellar']);
    expect(_fetchMock).not.toHaveBeenCalled();
    expect(cached.total).toBe(1);
  });

  it('bypasses cache when fresh: true is passed', async () => {
    mockOracleResponse({
      stellar: { usd: 0.12, usd_24h_change: 1.5, last_updated_at: 1700000000 },
    });
    await getPrices(['stellar'], { fresh: true });

    mockOracleResponse({
      stellar: { usd: 0.13, usd_24h_change: 2.0, last_updated_at: 1700000001 },
    });
    const refreshed = await getPrices(['stellar'], { fresh: true });
    expect(_fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.prices[0].price).toBe(0.13);
  });
});

describe('getPrice (single-asset convenience)', () => {
  it('returns the same shape as getPrices for one asset', async () => {
    mockOracleResponse({
      stellar: { usd: 0.12, usd_24h_change: 1.5, last_updated_at: 1700000000 },
    });
    const result = await getPrice('stellar', { fresh: true });
    expect(result.total).toBe(1);
    expect(result.prices[0].id).toBe('stellar');
  });
});

describe('clearCache', () => {
  it('invalidates cached price entries so the next call hits the oracle', async () => {
    mockOracleResponse({
      stellar: { usd: 0.12, usd_24h_change: 1.5, last_updated_at: 1700000000 },
    });
    await getPrices(['stellar'], { fresh: true });

    await clearCache();

    mockOracleResponse({
      stellar: { usd: 0.15, usd_24h_change: 3.0, last_updated_at: 1700000002 },
    });
    const result = await getPrices(['stellar']);
    expect(_fetchMock).toHaveBeenCalledTimes(2);
    expect(result.prices[0].price).toBe(0.15);
  });
});
