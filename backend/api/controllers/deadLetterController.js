/**
 * Dead-Letter Controller
 *
 * Admin-only endpoints to preview and replay dead-lettered jobs.
 */

import { logControllerError } from '../../config/logger.js';
import { previewDeadLetters, replayDeadLetters } from '../../services/deadLetterService.js';

const parseLimit = (value) => Math.min(Math.max(parseInt(value, 10) || 50, 1), 500);

/**
 * GET /api/admin/dead-letters/:queue
 */
const preview = async (req, res) => {
  try {
    const jobs = await previewDeadLetters(req.params.queue, { limit: parseLimit(req.query.limit) });
    res.json({ data: jobs });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logControllerError('deadLetter.preview', err, req);
    res.status(500).json({ error: 'Failed to load dead-lettered jobs' });
  }
};

/**
 * POST /api/admin/dead-letters/:queue/replay
 * Body: { jobIds?: string[], limit?: number }
 */
const replay = async (req, res) => {
  try {
    const { jobIds, limit } = req.body ?? {};
    if (jobIds !== undefined && !Array.isArray(jobIds)) {
      return res.status(400).json({ error: 'jobIds must be an array' });
    }
    const result = await replayDeadLetters(req.params.queue, {
      jobIds: jobIds?.map(String),
      limit: parseLimit(limit),
      performedBy: req.adminId ?? 'admin',
    });
    res.json({ data: result });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logControllerError('deadLetter.replay', err, req);
    res.status(500).json({ error: 'Failed to replay dead-lettered jobs' });
  }
};

export default { preview, replay };
