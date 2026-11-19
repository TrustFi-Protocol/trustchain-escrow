'use strict';

/**
 * Admin credential middleware for privileged queue dashboard routes.
 *
 * Accepts the existing admin credential via either:
 *   - `Authorization: Bearer <ADMIN_API_KEY>`
 *   - `x-admin-key: <ADMIN_API_KEY>`
 *
 * Returns 401 when the credential is missing or invalid so that mutating
 * BullMQ operations (pause, retry, clean, ...) are never invoked.
 */
function getConfiguredAdminKey() {
  return process.env.ADMIN_API_KEY || process.env.ADMIN_TOKEN || '';
}

function extractProvidedKey(req) {
  const header = req.headers || {};
  const authHeader = header.authorization || header.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const adminHeader = header['x-admin-key'];
  if (typeof adminHeader === 'string') {
    return adminHeader.trim();
  }
  return '';
}

function requireAdmin(req, res, next) {
  const configured = getConfiguredAdminKey();
  const provided = extractProvidedKey(req);

  if (!configured || !provided || provided !== configured) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = { requireAdmin };
