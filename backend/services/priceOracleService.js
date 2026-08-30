/**
 * Price Oracle Service
 *
 * Fetches current asset prices from an external price oracle (CoinGecko by default).
 * Caches results to reduce upstream calls and returns a structured empty state
 * when the data source returns zero results.
 *
 * Public API:
 *   getPrices(assets, opts)   — fetch prices for one or more asset IDs
 *   getPrice(asset, opts)     — convenience wrapper for a single asset
 *   clearCache()              — invalidate all price cache entries (useful in tests)
 */

import cache from '../lib/cache.js';

// ── Configuration ─────────────────────────────────────────────────────────────

/** Base URL of the price oracle API. Override via PRICE_ORACLE_URL env var. */
const ORACLE_BASE_URL =
  process.env.PRICE_ORACLE_URL || 'https://api.coingecko.com/api/v3';

/** Currency prices are quoted in. Override via PRICE_ORACLE_CURRENCY env var. */
const QUOTE_CURRENCY = process.env.PRICE_ORACLE_CURRENCY || 'usd';

/** Cache TTL in seconds — price data refreshes every 5 minutes. */
const PRICE_CACHE_TTL_SECONDS = 300;

/** Cache key prefix used for all price oracle entries. */
const CACHE_PREFIX = 'price-oracle';

// ── Empty-state message ───────────────────────────────────────────────────────

/**
 * User-facing message returned when the oracle returns no price data.
 * Shown instead of a blank list so users know what happened and what to do.
 */
const EMPTY_STATE_MESSAGE =
  'No price data is currently available. Check back shortly or ensure your assets are supported.';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a deterministic cache key for a set of asset IDs.
 * Sorts IDs so that ['xlm','usdc'] and ['usdc','xlm'] share the same entry.
 *
 * @param {string[]} assetIds
 * @returns {string}
 */
function buildCacheKey(assetIds) {
  return `${CACHE_PREFIX}:${[...assetIds].sort().join(',')}:${QUOTE_CURRENCY}`;
}

// ── Core fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch raw price data from the oracle for the given asset IDs.
 * Returns null on any network or parse error (caller decides how to handle).
 *
 * @param {string[]} assetIds
 * @returns {Promise<Record<string, object>|null>}
 */
async function _fetchFromOracle(assetIds) {
  const ids = assetIds.join(',');
  const url = `${ORACLE_BASE_URL}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${QUOTE_CURRENCY}&include_24hr_change=true&include_last_updated_at=true`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(
        `[PriceOracle] Oracle responded with HTTP ${response.status} for assets: ${ids}`,
      );
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn('[PriceOracle] Failed to fetch prices from oracle:', err.message);
    return null;
  }
}

/**
 * Transform the raw oracle response map into the standard price record shape.
 *
 * @param {Record<string, object>} raw  — { 'stellar': { usd: 0.12, ... }, ... }
 * @param {string[]} requestedIds       — original requested IDs (preserves order)
 * @returns {Array<{ id: string, currency: string, price: number, change24h: number|null, updatedAt: string|null }>}
 */
function _normalise(raw, requestedIds) {
  return requestedIds.reduce((acc, id) => {
    const entry = raw[id];
    if (!entry) return acc; // oracle returned nothing for this ID — skip it
    acc.push({
      id,
      currency: QUOTE_CURRENCY,
      price: entry[QUOTE_CURRENCY] ?? null,
      change24h: entry[`${QUOTE_CURRENCY}_24h_change`] ?? null,
      updatedAt: entry.last_updated_at
        ? new Date(entry.last_updated_at * 1000).toISOString()
        : null,
    });
    return acc;
  }, []);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch prices for one or more assets.
 *
 * Returns a structured result object. When the oracle returns no data for any
 * of the requested assets the `prices` array will be empty and `message` will
 * contain a clear, actionable explanation for the caller / UI layer.
 *
 * @param {string|string[]} assets  — single asset ID or array of asset IDs
 *                                    (e.g. 'stellar', ['stellar', 'usd-coin'])
 * @param {object}  [opts]
 * @param {boolean} [opts.fresh=false]  — bypass cache and force an oracle fetch
 * @returns {Promise<{
 *   prices: Array<{ id: string, currency: string, price: number, change24h: number|null, updatedAt: string|null }>,
 *   total:  number,
 *   message: string|null
 * }>}
 */
export async function getPrices(assets, { fresh = false } = {}) {
  const assetIds = Array.isArray(assets) ? assets : [assets];

  if (assetIds.length === 0) {
    return { prices: [], total: 0, message: EMPTY_STATE_MESSAGE };
  }

  const cacheKey = buildCacheKey(assetIds);

  // ── Cache hit ───────────────────────────────────────────────────────────────
  if (!fresh) {
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  }

  // ── Oracle fetch ────────────────────────────────────────────────────────────
  const raw = await _fetchFromOracle(assetIds);

  // Fetch failed entirely — treat as empty so the UI always gets a consistent shape
  if (!raw) {
    const errorResult = { prices: [], total: 0, message: EMPTY_STATE_MESSAGE };
    return errorResult;
  }

  const prices = _normalise(raw, assetIds);

  // ── Empty state ─────────────────────────────────────────────────────────────
  // Oracle responded but contained no matching records for the requested assets.
  if (prices.length === 0) {
    const emptyResult = { prices: [], total: 0, message: EMPTY_STATE_MESSAGE };
    // Still cache the empty result briefly (60 s) to avoid hammering the oracle
    // for assets it definitely does not know about.
    await cache.set(cacheKey, emptyResult, 60);
    return emptyResult;
  }

  // ── Normal result ───────────────────────────────────────────────────────────
  const result = { prices, total: prices.length, message: null };
  await cache.set(cacheKey, result, PRICE_CACHE_TTL_SECONDS);
  return result;
}

/**
 * Convenience wrapper — fetch the price for a single asset.
 *
 * @param {string} asset    — asset ID (e.g. 'stellar')
 * @param {object} [opts]   — same options as getPrices
 * @returns {Promise<{
 *   prices: Array<{ id: string, currency: string, price: number, change24h: number|null, updatedAt: string|null }>,
 *   total:  number,
 *   message: string|null
 * }>}
 */
export async function getPrice(asset, opts) {
  return getPrices(asset, opts);
}

/**
 * Invalidate all cached price oracle entries.
 * Primarily useful in tests and manual cache-refresh operations.
 */
export async function clearCache() {
  await cache.invalidatePrefix(CACHE_PREFIX);
}

export { EMPTY_STATE_MESSAGE };
