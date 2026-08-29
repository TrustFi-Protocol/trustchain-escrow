import express from 'express';
import escrowController, {
  validateBroadcast,
  validateEscrowId,
  validatePagination,
} from '../controllers/escrowController.js';
import { cacheResponse, invalidateOn, TTL } from '../middleware/cache.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

/**
 * @route  GET /api/escrows
 * @desc   Lists escrows visible to the authenticated caller, paginated and cached.
 * @param  {import('express').Request} req - Express request; `req.query.page` sets the cache tag.
 * @param  {import('express').Response} res - Express response used to send the paginated escrow list.
 * @returns {void} Sends a JSON page of escrow summaries.
 */
router.get(
  '/',
  validatePagination,
  cacheResponse({
    ttl: TTL.LIST,
    tags: (req) => ['escrows', `escrow:list:${req.query.page || '1'}`],
  }),
  escrowController.listEscrows,
);

/**
 * @route  GET /api/v1/escrows/search
 * @desc   Full-text and filter-based escrow search.
 * @query  q           free-text search term (matched against addresses)
 * @query  status      single or comma-separated: Active,Completed,Disputed,Cancelled
 * @query  creator     exact client Stellar address
 * @query  arbitrator  exact arbitrator Stellar address
 * @query  dateFrom    ISO date — createdAt >= dateFrom
 * @query  dateTo      ISO date — createdAt <= dateTo
 * @query  minAmount   minimum totalAmount
 * @query  maxAmount   maximum totalAmount
 * @query  sortBy      createdAt | totalAmount | status  (default: createdAt)
 * @query  sortOrder   asc | desc  (default: desc)
 * @query  page        default 1
 * @query  limit       default 20, max 100
 * @param  {import('express').Request} req - Express request carrying the search query params above.
 * @param  {import('express').Response} res - Express response used to send matching escrows.
 * @returns {void} Sends a JSON page of escrows matching the search criteria.
 */
router.get('/search', validatePagination, escrowController.searchEscrowsV1);

/**
 * @route  POST /api/escrows/broadcast
 * @desc   Validates and broadcasts a signed "create escrow" transaction, then
 *         invalidates cached escrow list entries so new escrows show up immediately.
 * @param  {import('express').Request} req - Express request containing the signed transaction envelope in `req.body`.
 * @param  {import('express').Response} res - Express response used to send the broadcast result.
 * @returns {void} Sends the broadcast/transaction result as JSON.
 */
router.post(
  '/broadcast',
  validateBroadcast,
  invalidateOn({ tags: ['escrows'] }),
  escrowController.broadcastCreateEscrow,
);

/**
 * @route  GET /api/escrows/:id/milestones
 * @desc   Lists the milestones belonging to a single escrow, paginated and cached.
 * @param  {import('express').Request} req - Express request; `req.params.id` identifies the escrow.
 * @param  {import('express').Response} res - Express response used to send the paginated milestone list.
 * @returns {void} Sends a JSON page of milestones for the given escrow.
 */
router.get(
  '/:id/milestones',
  validateEscrowId,
  validatePagination,
  cacheResponse({
    ttl: TTL.DETAIL,
    tags: (req) => [`escrow:${req.params.id}`, 'milestones'],
  }),
  escrowController.getMilestones,
);

/**
 * @route  GET /api/escrows/:id/milestones/:milestoneId
 * @desc   Fetches a single milestone within an escrow.
 * @param  {import('express').Request} req - Express request; `req.params.id` and `req.params.milestoneId` identify the resource.
 * @param  {import('express').Response} res - Express response used to send the milestone.
 * @returns {void} Sends the requested milestone as JSON.
 */
router.get(
  '/:id/milestones/:milestoneId',
  validateEscrowId,
  cacheResponse({
    ttl: TTL.DETAIL,
    tags: (req) => [
      `escrow:${req.params.id}`,
      `milestone:${req.params.id}:${req.params.milestoneId}`,
    ],
  }),
  escrowController.getMilestone,
);

/**
 * @route  GET /api/escrows/:id
 * @desc   Fetches a single escrow by id.
 * @param  {import('express').Request} req - Express request; `req.params.id` identifies the escrow.
 * @param  {import('express').Response} res - Express response used to send the escrow.
 * @returns {void} Sends the requested escrow as JSON.
 */
router.get(
  '/:id',
  validateEscrowId,
  cacheResponse({
    ttl: TTL.DETAIL,
    tags: (req) => ['escrows', `escrow:${req.params.id}`],
  }),
  escrowController.getEscrow,
);

/**
 * Express router exposing the `/api/escrows` resource endpoints.
 * @returns {import('express').Router} Configured escrow routes.
 */
export default router;
