import { getLogger, logControllerError } from '../../config/logger.js';
import escrowService from '../../services/escrowService.js';
import { getAuthenticatedWalletAddress } from '../middleware/authorization.js';

/**
 * Stream Escrow Events Controller
 *
 * Handles server-sent events (SSE) for real-time escrow updates
 * with loading state management to prevent blank UI during initial fetch
 */

/** GET /api/stream/escrows/:id — stream real-time updates for an escrow */
const streamEscrowUpdates = async (req, res) => {
  try {
    const walletAddress = getAuthenticatedWalletAddress(req);
    if (!walletAddress) {
      res.status(403).json({ error: 'Authenticated user is not linked to a wallet address.' });
      return;
    }

    const { id: escrowId } = req.params;

    // Verify escrow exists and user has access
    const escrow = await escrowService.getEscrowById(escrowId);
    if (!escrow) {
      return res.status(404).json({ error: 'Escrow not found' });
    }

    if (escrow.clientAddress !== walletAddress && escrow.contractorAddress !== walletAddress) {
      return res.status(403).json({ error: 'Forbidden: cannot access this escrow.' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial loading state
    res.write('data: {"type":"loading","message":"Fetching escrow updates..."}\n\n');

    // Simulate fetching related data with loading states
    const events = await escrowService.getEscrowEvents(escrowId);

    // Send loaded state with data
    res.write(`data: ${JSON.stringify({ type: 'loaded', data: { events } })}\n\n`);

    // Keep connection open for real-time updates
    const interval = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });
  } catch (err) {
    logControllerError('stream.escrowUpdates', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/stream/payments — stream payment status updates with loading state */
const streamPaymentUpdates = async (req, res) => {
  try {
    const walletAddress = getAuthenticatedWalletAddress(req);
    if (!walletAddress) {
      res.status(403).json({ error: 'Authenticated user is not linked to a wallet address.' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial loading state skeleton
    res.write(
      'data: {"type":"loading","skeleton":true,"message":"Loading payment history..."}\n\n',
    );

    // Fetch payment data
    const payments = await Promise.resolve([]);

    // Send loaded state
    res.write(`data: ${JSON.stringify({ type: 'loaded', data: { payments } })}\n\n`);

    // Keep connection alive
    const interval = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });
  } catch (err) {
    logControllerError('stream.paymentUpdates', err, req);
    res.status(500).json({ error: err.message });
  }
};

export default { streamEscrowUpdates, streamPaymentUpdates };
