/**
 * Metrics Route — Tiered Access Control
 *
 * Access tiers:
 *
 *   1. System admin — full global Prometheus exposition (text/plain)
 *      Granted when:
 *        a) METRICS_TOKEN env var is set and the request carries a matching
 *           `Authorization: Bearer <METRICS_TOKEN>` header, OR
 *        b) req.isAdmin is true (set by adminAuth / optionalAdminAuth middleware
 *           before this route is reached).
 *
 *   2. Tenant admin — scoped JSON summary (application/json)
 *      Granted when req.user is present (set by auth middleware) and
 *      req.user.role is 'admin' or 'superadmin', AND req.user.tenantId exists.
 *      Returns a structured JSON object scoped to their tenant.
 *      (Full per-metric tenant filtering is deferred until business metrics
 *      carry a tenant_id label; the route is already shaped for that future.)
 *
 *   3. Everyone else → 403 Forbidden.
 *
 * Middleware chain applied to GET /:
 *   optionalAdminAuth → optionalAuth → tenantMetricsAuth → handler
 *
 * optionalAdminAuth sets req.isAdmin without blocking.
 * optionalAuth populates req.user without blocking.
 * tenantMetricsAuth enforces the tiered policy.
 */

import express from 'express';
import { register, cacheSize } from '../../lib/metrics.js';
import cache from '../../lib/cache.js';
import { optionalAdminAuth } from '../middleware/adminAuth.js';
import { createModuleLogger } from '../../config/logger.js';

const log = createModuleLogger('metricsRoutes');

const router = express.Router();

// ── Optional user-auth ────────────────────────────────────────────────────────
// Populates req.user if a valid Bearer JWT is present; never blocks the request.

async function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();

  // If METRICS_TOKEN matches, optionalAdminAuth has not set req.isAdmin yet
  // for that case (it uses x-admin-api-key), so we handle it in
  // tenantMetricsAuth instead. Here we only try to decode a user JWT.
  try {
    // Lazy-import to avoid circular dependency issues at module load time.
    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET, JWT_ALGORITHM } = await import('../../config/secrets.js');

    const token = authHeader.slice(7);

    // Avoid treating the METRICS_TOKEN as a user JWT — if it matches, skip.
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken && token === metricsToken) return next();

    const payload = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    req.user = {
      address: payload.address,
      jti: payload.jti,
      role: payload.role,
      tenantId: payload.tenantId,
    };
  } catch {
    // Invalid / expired user JWT — silently ignore; tenantMetricsAuth will 403.
  }

  next();
}

// ── Tiered access-control middleware ─────────────────────────────────────────

function tenantMetricsAuth(req, res, next) {
  const metricsToken = process.env.METRICS_TOKEN;
  const authHeader = req.headers.authorization || '';

  // Tier 1a: matching static METRICS_TOKEN
  if (metricsToken && authHeader === `Bearer ${metricsToken}`) {
    req.metricsScope = 'global';
    log.info({ msg: 'metrics_access', scope: 'global', via: 'metrics_token' });
    return next();
  }

  // Tier 1b: req.isAdmin set by optionalAdminAuth (raw API key or admin JWT)
  if (req.isAdmin) {
    req.metricsScope = 'global';
    log.info({
      msg: 'metrics_access',
      scope: 'global',
      via: 'admin_auth',
      adminId: req.adminId,
    });
    return next();
  }

  // Tier 2: authenticated tenant admin
  if (req.user) {
    const { role, tenantId } = req.user;
    if ((role === 'admin' || role === 'superadmin') && tenantId) {
      req.metricsScope = 'tenant';
      req.metricsTenantId = tenantId;
      log.info({
        msg: 'metrics_access',
        scope: 'tenant',
        tenantId,
        role,
      });
      return next();
    }
  }

  // Tier 3: everyone else
  log.warn({
    msg: 'metrics_access_denied',
    ip: req.ip,
    path: req.originalUrl,
    hasUser: !!req.user,
    userRole: req.user?.role,
  });
  return res.status(403).json({ error: 'Forbidden' });
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/', optionalAdminAuth, optionalAuth, tenantMetricsAuth, async (req, res) => {
  try {
    if (req.metricsScope === 'global') {
      cacheSize.set(cache.size());
      res.set('Content-Type', register.contentType);
      return res.end(await register.metrics());
    }

    // Tenant-scoped response — JSON summary.
    // When business metrics carry a tenant_id label this block can be
    // extended to filter register.getMetricsAsJSON() by tenantId.
    return res.status(200).json({
      tenantId: req.metricsTenantId,
      scope: 'tenant',
      note: 'Tenant-scoped metrics are available. Use global admin access for full Prometheus exposition.',
    });
  } catch (err) {
    log.error({ msg: 'metrics_exposition_error', error: err.message });
    res.status(500).end(err.message);
  }
});

export default router;
