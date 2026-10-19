# Tenant-Scoped Cache Isolation Recovery

Operator procedures for incidents involving the HTTP response cache in
`backend/api/middleware/cache.js`. Every cache key is prefixed with
`t:<tenant-slug>:` (tenantless routes use `t:_global:`) and every invalidation
tag with `t:<tenant-id>:`. A failure in either scoping is a cross-tenant data
exposure and should be handled as a SEV1/SEV2 security incident.

## Detection

- **Cross-tenant responses:** a tenant reports data belonging to another tenant,
  or support sees the same `X-Cache-Key` header returned to two tenants.
- **Key shape drift:** `X-Cache-Key` values that do not start with `t:` indicate
  a route using a custom `keyFn` without tenant context.
- **Stale data after writes:** `X-Cache: HIT` with outdated content after a
  successful mutation points at a missing or unscoped `invalidateOn` tag.
- **Cache growth:** rising `cache_size` or Redis memory, or frequent
  `cache.retention_evict_failed` warnings in backend logs.
- **Hit-ratio anomalies:** sudden shifts in `cache_hits_total` /
  `cache_misses_total` after a deploy.

Do not paste raw cached bodies, tenant identifiers, or API keys into incident
channels; refer to tenants by ticket reference and to keys by route path.

## Mitigation

1. **Contain one tenant:** call `purgeTenantCache('<slug>')` from an operator
   shell. It only accepts slugs matching `[A-Za-z0-9_-]{1,64}` and removes
   `t:<slug>:*` entries, so it cannot widen to other tenants.
2. **Contain a route:** bypass caching for the affected route by adding
   `skip: () => true` to its `cacheResponse` options and redeploying, or remove
   the middleware from the route entirely.
3. **Contain everything:** set `CACHE_TTL_MAX=1` and restart the backend so all
   cached entries expire within a second; if exposure is confirmed, also call
   `cache.invalidatePrefix('t:')` (from `backend/lib/cache.js`) to remove every
   tenant-scoped response entry immediately.
4. **Bound growth:** lower `CACHE_TENANT_MAX_KEYS` or `CACHE_MAX_TRACKED_TENANTS`
   and restart; the oldest tracked keys are evicted first.

## Rollback

1. Revert the deploy that introduced the faulty `keyFn`, tag, or route change.
2. Purge each affected tenant with `purgeTenantCache` (or invalidate the `t:`
   prefix) so no
   entry written by the faulty build survives the rollback.
3. Restore `CACHE_TTL_MAX`, `CACHE_TENANT_MAX_KEYS`, and
   `CACHE_MAX_TRACKED_TENANTS` to their documented values in
   [configuration.md](../configuration.md#response-caching) and restart.
4. Never "fix" isolation by stripping tenant prefixes or sharing tags between
   tenants.

## Verification

1. Request the same cached route as two tenants; the first request for each must
   return `X-Cache: MISS` and the `X-Cache-Key` values must differ only in the
   `t:<slug>:` prefix.
2. Mutate a resource as tenant A and confirm tenant A's next read is a `MISS`
   while tenant B's cached entry is untouched.
3. Run `npm test -- cacheTenantIsolation cacheRetention cacheMiddleware` in
   `backend/`.
4. Confirm `cache.retention_evict_failed` warnings have stopped and cache memory
   is back within its normal range.
5. Record the timeline, affected tenants, and purge actions in the incident
   post-mortem.
