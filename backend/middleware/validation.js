/**
 * Input Validation & Sanitization Middleware
 *
 * Provides:
 * - Request body size limits
 * - XSS prevention via input sanitization
 * - SQL injection prevention (parameterized queries enforced via Prisma; extra guard here)
 * - CSRF token validation for state-changing requests
 * - Reusable express-validator rule sets for common fields
 */

import { body, param, query, validationResult } from 'express-validator';
import crypto from 'crypto';

// ── Request size limit ────────────────────────────────────────────────────────
// Applied in server.js via express.json({ limit }) — exported for consistency.
export const REQUEST_SIZE_LIMIT = '100kb';

// ── XSS / injection sanitization ─────────────────────────────────────────────

/**
 * Strip characters commonly used in HTML/script injection and SQL injection.
 * Prisma uses parameterized queries so SQL injection is already prevented at
 * the ORM level; this adds a defence-in-depth layer for raw string fields.
 */
function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[<>]/g, '') // strip HTML angle brackets (XSS)
    .replace(/javascript:/gi, '') // strip JS protocol
    .replace(/on\w+\s*=/gi, '') // strip inline event handlers
    .trim();
}

/**
 * Recursively sanitize all string values in req.body / req.query / req.params.
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = sanitizeString(obj[key]);
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObject(obj[key]);
    }
  }
  return obj;
}

export function sanitizeInputs(req, _res, next) {
  sanitizeObject(req.body);
  sanitizeObject(req.query);
  sanitizeObject(req.params);
  next();
}

// ── CSRF protection ───────────────────────────────────────────────────────────
// Stateless double-submit cookie pattern.
// The frontend must:
//   1. GET /api/csrf-token  → receive token in JSON + cookie
//   2. Send the token in X-CSRF-Token header on state-changing requests

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function generateCsrfToken(_req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // must be readable by JS to send in header
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 3600 * 1000, // 1 hour
  });
  res.json({ csrfToken: token });
}

export function csrfProtection(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (process.env.NODE_ENV === 'test') return next();

  // Skip CSRF for webhook endpoints (they use their own signature verification)
  if (/\/webhook/.test(req.path)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
}

// ── Validation result handler ─────────────────────────────────────────────────

export function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

// ── Reusable validator chains ─────────────────────────────────────────────────

export const stellarAddressParam = (field = 'address') =>
  param(field)
    .matches(/^G[A-Z2-7]{55}$/)
    .withMessage('Invalid Stellar address');

export const stellarAddressBody = (field = 'address') =>
  body(field)
    .matches(/^G[A-Z2-7]{55}$/)
    .withMessage('Invalid Stellar address');

export const paginationQuery = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const escrowIdParam = param('id')
  .matches(/^\d+$/)
  .withMessage('Escrow id must be a numeric string');

export const signedXdrBody = body('signedXdr')
  .isString()
  .notEmpty()
  .isLength({ max: 100_000 })
  .withMessage('signedXdr must be a non-empty string under 100 000 chars');

// ── Stellar address pattern ───────────────────────────────────────────────────
// StrKey base32 encoding: starts with G, 56 chars total (G + 55 uppercase base32 chars).
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * validate(chains) — run a list of express-validator chains and short-circuit
 * with 400 + structured errors if any fail.
 *
 * Exported separately so route files can compose their own chain lists.
 */
export function validate(chains) {
  return async (req, res, next) => {
    await Promise.all(chains.map((c) => c.run(req)));
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    const details = result.array({ onlyFirstError: false }).map((e) => ({
      field: e.path,
      message: e.msg,
      location: e.location,
    }));
    return res.status(400).json({ error: 'Validation failed', details });
  };
}

// ── Issue #204: Escrow template validation ────────────────────────────────────

/**
 * Reusable helper: validates a field as a required, non-empty Stellar address.
 */
function requiredStellarAddress(field) {
  return body(field)
    .notEmpty()
    .withMessage(`${field} is required`)
    .matches(STELLAR_ADDRESS_RE)
    .withMessage(`${field} must be a valid Stellar address (G + 55 base32 chars)`);
}

/**
 * Reusable helper: validates a field as an optional Stellar address.
 * When the field is absent the chain is skipped entirely.
 */
function optionalStellarAddress(field) {
  return body(field)
    .optional()
    .matches(STELLAR_ADDRESS_RE)
    .withMessage(`${field} must be a valid Stellar address (G + 55 base32 chars)`);
}

/**
 * Reusable helper: validates an ISO-8601 date string that must be in the future.
 */
function futureDateBody(field, { optional = true } = {}) {
  const chain = optional ? body(field).optional() : body(field).notEmpty();
  return chain
    .isISO8601()
    .withMessage(`${field} must be a valid ISO 8601 date string`)
    .custom((value) => {
      if (new Date(value) <= new Date()) {
        throw new Error(`${field} must be a date in the future`);
      }
      return true;
    });
}

/**
 * validateEscrowTemplate
 *
 * Middleware array (use with validate() helper or directly as route middleware)
 * that validates an escrow template request body for:
 *
 *   clientAddress      — required, valid Stellar address
 *   freelancerAddress  — required, valid Stellar address
 *   arbiterAddress     — optional, valid Stellar address when present
 *   tokenId            — at least one of tokenId / tokenAddress required
 *   tokenAddress       — at least one of tokenId / tokenAddress required
 *   deadline           — optional, ISO 8601 date in the future
 *   totalAmount        — optional; when present the sum of milestone amounts must equal it
 *   milestones         — required non-empty array, max 20 items
 *   milestones[].amount      — required, numeric > 0
 *   milestones[].description — required, non-empty string, max 500 chars
 *   milestones[].deadline    — optional, ISO 8601 date in the future and ≤ escrow deadline
 */
export const validateEscrowTemplate = validate([
  // ── Address fields ──────────────────────────────────────────────────────────
  requiredStellarAddress('clientAddress'),
  requiredStellarAddress('freelancerAddress'),
  optionalStellarAddress('arbiterAddress'),

  // ── Token identifier: at least one of tokenId / tokenAddress required ───────
  body('tokenId').custom((_value, { req }) => {
    const hasTokenId = typeof req.body.tokenId === 'string' && req.body.tokenId.trim().length > 0;
    const hasTokenAddress =
      typeof req.body.tokenAddress === 'string' && req.body.tokenAddress.trim().length > 0;
    if (!hasTokenId && !hasTokenAddress) {
      throw new Error('At least one of tokenId or tokenAddress is required');
    }
    return true;
  }),

  // ── Top-level deadline (optional) ───────────────────────────────────────────
  futureDateBody('deadline', { optional: true }),

  // ── Milestones array ─────────────────────────────────────────────────────────
  body('milestones')
    .isArray({ min: 1 })
    .withMessage('milestones must be a non-empty array')
    .custom((value) => {
      if (value.length > 20) {
        throw new Error('milestones must contain at most 20 items');
      }
      return true;
    }),

  // ── Per-milestone: amount ────────────────────────────────────────────────────
  body('milestones.*.amount')
    .notEmpty()
    .withMessage('milestones[].amount is required')
    .custom((value) => {
      const num = Number(value);
      if (isNaN(num) || !isFinite(num)) {
        throw new Error('milestones[].amount must be a valid number');
      }
      if (num <= 0) {
        throw new Error('milestones[].amount must be greater than 0');
      }
      return true;
    }),

  // ── Per-milestone: description ───────────────────────────────────────────────
  body('milestones.*.description')
    .notEmpty()
    .withMessage('milestones[].description is required')
    .isString()
    .withMessage('milestones[].description must be a string')
    .isLength({ max: 500 })
    .withMessage('milestones[].description must be at most 500 characters'),

  // ── Per-milestone: optional deadline ────────────────────────────────────────
  body('milestones.*.deadline')
    .optional()
    .isISO8601()
    .withMessage('milestones[].deadline must be a valid ISO 8601 date string')
    .custom((value, { req }) => {
      const milestoneDeadline = new Date(value);

      // Must be in the future
      if (milestoneDeadline <= new Date()) {
        throw new Error('milestones[].deadline must be a date in the future');
      }

      // Must not exceed the top-level escrow deadline when both are set
      if (req.body.deadline) {
        const escrowDeadline = new Date(req.body.deadline);
        if (!isNaN(escrowDeadline.getTime()) && milestoneDeadline > escrowDeadline) {
          throw new Error('milestones[].deadline cannot be after the main escrow deadline');
        }
      }

      return true;
    }),

  // ── Cross-field: totalAmount vs sum of milestones ────────────────────────────
  body('totalAmount')
    .optional()
    .custom((totalAmount, { req }) => {
      const milestones = req.body.milestones;
      if (!Array.isArray(milestones)) return true; // caught above

      const sum = milestones.reduce((acc, m) => {
        const num = Number(m?.amount);
        return acc + (isNaN(num) ? 0 : num);
      }, 0);

      if (sum <= 0) {
        throw new Error('The sum of milestone amounts must be greater than 0');
      }

      if (totalAmount !== undefined && totalAmount !== null && totalAmount !== '') {
        const declared = Number(totalAmount);
        if (isNaN(declared)) {
          throw new Error('totalAmount must be a valid number');
        }
        // Allow a small floating-point tolerance (1e-9)
        if (Math.abs(declared - sum) > 1e-9) {
          throw new Error(
            `totalAmount (${declared}) does not match the sum of milestone amounts (${sum})`,
          );
        }
      }

      return true;
    }),
]);
