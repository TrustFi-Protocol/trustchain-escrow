/**
 * HTTP Response Cache Middleware
 *
 * Drop-in Express middleware that caches GET responses and handles
 * cache invalidation for mutating requests.
 *
 * ## Usage
 *
 * ### Cache a route
 *
 *   import { cacheResponse } from '../middleware/cache.js';
 *
 *   router.get('/', cacheResponse({ ttl: 30, tags: ['escrows'] }), controller.list);
 *   router.get('/:id', cacheResponse({ ttl: 60, tags: req => [`escrow:${req.params.id}`] }), controller.get);
 *
 * ### Invalidate on mutation
 *
 *   import { invalidateOn } from '../middleware/cache.js';
 *
 *   router.post('/', invalidateOn({ tags: ['escrows'] }), controller.create);
 *   router.patch('/:id', invalidateOn({ tags: req => [`escrow:${req.params.id}`, 'escrows'] }), controller.update);
 *
 * ## Cache key
 *
 * Default: `t:<tenant-slug>:http:<method>:<path>:<sha256-query-16chars>`
 * Public (tenantless) routes fall back to `t:_global:...`.
 * Override with the `keyFn` option — custom keyFn MUST include tenant context
 * to avoid cross-tenant collisions.
 *
 * ## TTL configuration
 *
 * Per-route TTL via the `ttl` option (seconds).
 * Global defaults via environment variables:
 *
 *   CACHE_TTL_DEFAULT=60
 *   CACHE_TTL_LIST=15
 *   CACHE_TTL_DETAIL=30
 *   CACHE_TTL_LEADERBOARD=300
 *   CACHE_TTL_EVENTS=15
 *
 * ## Retention bounds
 *
 *   CACHE_TTL_MAX=3600              — upper bound applied to every per-route TTL
 *   CACHE_TENANT_MAX_KEYS=1000      — tracked keys per tenant; oldest is evicted
 *   CACHE_MAX_TRACKED_TENANTS=500   — tracked tenants; oldest tenant's keys are evicted
 *
 * `purgeTenantCache(slug)` removes every `t:<slug>:` entry for safe cleanup.
 *
 * ## Recovery
 *
 * Detection, mitigation, rollback, and verification steps for isolation
 * incidents: docs/runbooks/tenant-cache-isolation-recovery.md
 *
 * @module middleware/cache
 */

import { createHash } from 'crypto';
import cache from '../../lib/cache.js';
import { createModuleLogger } from '../../config/logger.js';
import { BoundedRetentionStore } from '../../lib/operationalControls.js';

const log = createModuleLogger('middleware.cache');

// ── TTL presets (overridable via env) ─────────────────────────────────────────

export const TTL = {
  DEFAULT: parseInt(process.env.CACHE_TTL_DEFAULT || '60', 10),
  LIST: parseInt(process.env.CACHE_TTL_LIST || '15', 10),
  DETAIL: parseInt(process.env.CACHE_TTL_DETAIL || '30', 10),
  LEADERBOARD: parseInt(process.env.CACHE_TTL_LEADERBOARD || '300', 10),
  EVENTS: parseInt(process.env.CACHE_TTL_EVENTS || '15', 10),
  REPUTATION: parseInt(process.env.CACHE_TTL_REPUTATION || '60', 10),
  STATIC: parseInt(process.env.CACHE_TTL_STATIC || '600', 10),
};

// ── Retention controls ────────────────────────────────────────────────────────

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const RETENTION = Object.freeze({
  MAX_TTL: positiveInt(process.env.CACHE_TTL_MAX, 3600),
  MAX_KEYS_PER_TENANT: positiveInt(process.env.CACHE_TENANT_MAX_KEYS, 1000),
  MAX_TRACKED_TENANTS: positiveInt(process.env.CACHE_MAX_TRACKED_TENANTS, 500),
});

const TENANT_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

function dropKey(key) {
  Promise.resolve()
    .then(() => cache.invalidate(key))
    .catch((err) => log.warn({ message: 'cache.retention_evict_failed', error: err.message }));
}

/** slug → BoundedRetentionStore of cache keys written for that tenant. */
const tenantKeys = new BoundedRetentionStore(RETENTION.MAX_TRACKED_TENANTS, {
  onEvict: (_slug, keys) => {
    for (const key of keys.entries.keys()) dropKey(key);
  },
});

function trackKey(slug, key) {
  let keys = tenantKeys.get(slug);
  if (!keys) {
    keys = new BoundedRetentionStore(RETENTION.MAX_KEYS_PER_TENANT, { onEvict: dropKey });
  }
  keys.set(key, true);
  tenantKeys.set(slug, keys);
}

/**
 * Clamps a TTL into `[1, RETENTION.MAX_TTL]`; invalid values fall back to TTL.DEFAULT.
 *
 * @param {number} ttl
 * @returns {number}
 */
export function boundTtl(ttl) {
  const value = Number.isFinite(ttl) && ttl >= 1 ? Math.floor(ttl) : positiveInt(TTL.DEFAULT, 60);
  return Math.min(value, RETENTION.MAX_TTL);
}

/** Number of cache keys currently tracked for a tenant slug. */
export function getTrackedKeyCount(slug) {
  return tenantKeys.get(slug)?.size ?? 0;
}

/**
 * Removes every cached entry scoped to one tenant (`t:<slug>:*`).
 * Rejects malformed slugs so a bad input can never widen the purge.
 *
 * @param {string} slug
 * @returns {Promise<void>}
 */
export async function purgeTenantCache(slug) {
  if (typeof slug !== 'string' || !TENANT_SLUG_RE.test(slug)) {
    throw new TypeError('purgeTenantCache requires a valid tenant slug');
  }
  await cache.invalidatePrefix(`t:${slug}:`);
  tenantKeys.delete(slug);
  log.info({ message: 'cache.tenant_purged' });
}

// ── Key builder ───────────────────────────────────────────────────────────────

/**
 * Builds a deterministic cache key from the request, scoped by tenant slug.
 *
 * Keys are prefixed with `t:<slug>:` so two tenants requesting the same path
 * never collide. The `_global` sentinel is used for requests that have no
 * tenant (health checks, public metrics).
 *
 * Query params are sorted and SHA-256 hashed (first 16 hex chars) to keep
 * long query strings from bloating Redis key storage.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function buildCacheKey(req) {

  const tenantSlug = req.tenant?.slug ?? '_global';
  const sortedQuery = Object.keys(req.query)
    .sort()
    .map((k) => `${k}=${req.query[k]}`)
    .join('&');
  const queryPart = sortedQuery
    ? ':' + createHash('sha256').update(sortedQuery).digest('hex').slice(0, 16)
    : '';
  return `t:${tenantSlug}:http:${req.method}:${req.path}${queryPart}`;
}

/**
 * Prefixes a tag with the request's tenant id so Tenant A's tag invalidation
 * never touches Tenant B's cached entries.
 * Falls back to the bare tag for tenantless (public) routes.
 *
 * @param {string} tag
 * @param {import('express').Request} req
 * @returns {string}
 */
function tenantTag(tag, req) {
  const tenantId = req.tenant?.id;
  return tenantId ? `t:${tenantId}:${tag}` : tag;
}

// ── Cache response middleware ─────────────────────────────────────────────────

/**
 * @typedef {Object} CacheOptions
 * @property {number}                          [ttl]    — TTL in seconds (default: TTL.DEFAULT)
 * @property {string[]|(req)=>string[]}        [tags]   — invalidation tags
 * @property {(req)=>string}                   [keyFn]  — custom key builder
 * @property {(req,res)=>boolean}              [skip]   — return true to bypass cache
 */

/**
 * Middleware that serves cached responses for GET requests and stores
 * fresh responses in the cache after the controller runs.
 *
 * @param {CacheOptions} [options]
 * @returns {import('express').RequestHandler}
 */
export function cacheResponse(options = {}) {
  const { tags = [], keyFn = buildCacheKey, skip } = options;
  const ttl = boundTtl(options.ttl ?? TTL.DEFAULT);

  return async (req, res, next) => {
    // Only cache GET / HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // Allow per-request bypass (e.g. authenticated writes, admin routes)
    if (skip && skip(req, res)) return next();

    const key = keyFn(req);

    // ── Cache hit ─────────────────────────────────────────────────────────────
    const cached = await cache.get(key);
    if (cached !== null) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', key);
      return res.json(cached);
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Cache-Key', key);

    // ── Intercept res.json to store the response ──────────────────────────────
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const resolvedTags = (typeof tags === 'function' ? tags(req) : tags).map((t) =>
          tenantTag(t, req),
        );
        await cache.setWithTags(key, body, ttl, resolvedTags);
        trackKey(req.tenant?.slug ?? '_global', key);
      }
      return originalJson(body);
    };

    next();
  };
}

// ── Invalidation middleware ───────────────────────────────────────────────────

/**
 * @typedef {Object} InvalidateOptions
 * @property {string[]|(req)=>string[]}  [tags]     — tags to invalidate
 * @property {string[]|(req)=>string[]}  [keys]     — exact keys to invalidate
 * @property {string[]|(req)=>string[]}  [prefixes] — prefix patterns to invalidate
 * @property {'before'|'after'}          [when]     — 'before' (default) or 'after' the handler
 */

/**
 * Middleware that invalidates cache entries before or after a mutating request.
 *
 * @param {InvalidateOptions} [options]
 * @returns {import('express').RequestHandler}
 */
export function invalidateOn(options = {}) {
  const { tags = [], keys = [], prefixes = [], when = 'after' } = options;

  const doInvalidate = async (req) => {
    const resolvedTags = (typeof tags === 'function' ? tags(req) : tags).map((t) =>
      tenantTag(t, req),
    );
    const resolvedKeys = typeof keys === 'function' ? keys(req) : keys;
    const resolvedPrefixes = typeof prefixes === 'function' ? prefixes(req) : prefixes;

    await Promise.all([
      resolvedTags.length ? cache.invalidateTags(resolvedTags) : Promise.resolve(),
      ...resolvedKeys.map((k) => cache.invalidate(k)),
      ...resolvedPrefixes.map((p) => cache.invalidatePrefix(p)),
    ]);
  };

  if (when === 'before') {
    return async (req, _res, next) => {
      await doInvalidate(req);
      next();
    };
  }

  // 'after' — invalidate once the response has been sent
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        doInvalidate(req).catch((err) =>
          console.error('[Cache] Post-response invalidation failed:', err.message),
        );
      }
    });
    next();
  };
}

// ── Convenience factories ─────────────────────────────────────────────────────

/** Cache a list endpoint (short TTL, tagged with a collection name). */
export const cacheList = (collection, ttl = TTL.LIST) => cacheResponse({ ttl, tags: [collection] });

/** Cache a detail endpoint (medium TTL, tagged with item + collection). */
export const cacheDetail = (collection, idFn, ttl = TTL.DETAIL) =>
  cacheResponse({
    ttl,
    tags: (req) => [collection, `${collection}:${idFn(req)}`],
  });

/** Invalidate a collection and optionally a specific item. */
export const invalidateCollection = (collection, idFn = null) =>
  invalidateOn({
    tags: (req) => [collection, ...(idFn ? [`${collection}:${idFn(req)}`] : [])],
  });
