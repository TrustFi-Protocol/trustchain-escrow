import { validationResult, query, param, body } from 'express-validator';

/** Maximum unsigned 64-bit integer (inclusive) for on-chain / DB escrow identifiers. */
const U64_MAX = 18446744073709551615n;

/**
 * Runs express-validator chains and, on failure, responds with HTTP 400 and a stable JSON body.
 *
 * Response shape:
 * `{ error: 'Validation failed', details: [{ field, message, location }] }`
 *
 * @param {import('express-validator').ValidationChain[]} chains
 * @returns {import('express').RequestHandler}
 */
export function validate(chains) {
  return async (req, res, next) => {
    await Promise.all(chains.map((c) => c.run(req)));
    const result = validationResult(req);
    if (result.isEmpty()) {
      return next();
    }
    const details = result.array({ onlyFirstError: false }).map((e) => ({
      field: e.path,
      message: e.msg,
      location: e.location,
    }));
    return res.status(400).json({
      error: 'Validation failed',
      details,
    });
  };
}

// ── Dispute API schemas (express-validator chains) ───────────────────────────
// Issue #101: named the previously-inline bounds below (disputeRoutes.js
// consumes these rule chains, so its numeric literals actually live here).

/** Upper bound on `page` for GET /api/disputes — keeps offset-based pagination bounded. */
const DISPUTE_LIST_MAX_PAGE = 1_000_000;
/** Upper bound on `limit` for GET /api/disputes — caps result-set size per request. */
const DISPUTE_LIST_MAX_LIMIT = 100;
/** Max digit-length for a decimal `escrowId` route param (u64 max is 20 digits). */
const DISPUTE_ESCROW_ID_MAX_LENGTH = 20;

/**
 * GET /api/disputes — query parameters
 *
 * | Field  | Required | Type    | Rules                          |
 * |--------|----------|---------|--------------------------------|
 * | page   | no       | integer | 1 ≤ page ≤ DISPUTE_LIST_MAX_PAGE  |
 * | limit  | no       | integer | 1 ≤ limit ≤ DISPUTE_LIST_MAX_LIMIT |
 *
 * Omitted or empty (falsy) values fall through to controller defaults.
 */
export const disputeListQueryRules = [
  query('page')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: DISPUTE_LIST_MAX_PAGE })
    .withMessage(`page must be an integer between 1 and ${DISPUTE_LIST_MAX_PAGE}`),
  query('limit')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: DISPUTE_LIST_MAX_LIMIT })
    .withMessage(`limit must be an integer between 1 and ${DISPUTE_LIST_MAX_LIMIT}`),
];

/**
 * GET /api/disputes/:escrowId — route parameter
 *
 * | Field     | Required | Type   | Rules                                                |
 * |-----------|----------|--------|------------------------------------------------------|
 * | escrowId  | yes      | string | Decimal digits only, 1 ≤ value ≤ 2^64−1, length ≤ DISPUTE_ESCROW_ID_MAX_LENGTH |
 */
export const disputeEscrowIdParamRules = [
  param('escrowId')
    .trim()
    .notEmpty()
    .withMessage('escrowId is required')
    .matches(/^[0-9]+$/)
    .withMessage('escrowId must be a non-negative decimal string')
    .isLength({ min: 1, max: DISPUTE_ESCROW_ID_MAX_LENGTH })
    .withMessage(`escrowId must be between 1 and ${DISPUTE_ESCROW_ID_MAX_LENGTH} digits`)
    .custom((value) => {
      try {
        const n = BigInt(value);
        if (n < 1n || n > U64_MAX) {
          throw new Error('out of range');
        }
        return true;
      } catch {
        throw new Error('escrowId must be a valid escrow identifier');
      }
    }),
];

// ── Search API schemas ────────────────────────────────────────────────────────

const SEARCH_MAX_Q_LENGTH = 200;

/**
 * GET /api/search — query parameters
 *
 * | Field  | Required | Type    | Rules                             |
 * |--------|----------|---------|-----------------------------------|
 * | q      | no       | string  | max 200 chars, stripped of control chars |
 * | limit  | no       | integer | 1 ≤ limit ≤ 100                   |
 * | from   | no       | integer | 0 ≤ from                          |
 */
export const searchQueryRules = [
  query('q')
    .optional({ values: 'falsy' })
    .isString()
    .withMessage('q must be a string')
    .isLength({ max: SEARCH_MAX_Q_LENGTH })
    .withMessage(`q must not exceed ${SEARCH_MAX_Q_LENGTH} characters`)
    // Strip ASCII control characters (U+0000–U+001F and DEL) that could
    // pollute log output or corrupt Elasticsearch query strings.
    // eslint-disable-next-line no-control-regex
    .customSanitizer((v) => v.replace(/[\x00-\x1F\x7F]/g, '')),
  query('limit')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be an integer between 1 and 100'),
  query('from')
    .optional({ values: 'falsy' })
    .isInt({ min: 0 })
    .withMessage('from must be a non-negative integer'),
];

// ── Webhook API schemas ───────────────────────────────────────────────────────

/**
 * POST /api/webhooks/subscribe — request body
 *
 * | Field      | Required | Type     | Rules                         |
 * |------------|----------|----------|-------------------------------|
 * | url        | yes      | string   | valid HTTPS URL               |
 * | eventTypes | yes      | string[] | non-empty, max 20 items       |
 */
export const webhookSubscribeRules = [
  body('url')
    .notEmpty()
    .withMessage('url is required')
    .isURL({ protocols: ['https'], require_protocol: true })
    .withMessage('url must be a valid HTTPS URL'),
  body('eventTypes')
    .isArray({ min: 1, max: 20 })
    .withMessage('eventTypes must be a non-empty array with at most 20 entries'),
  body('eventTypes.*').isString().withMessage('each eventType must be a string'),
];
