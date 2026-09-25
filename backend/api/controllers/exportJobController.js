/**
 * Export Job Controller — Issue #230: Export Job Progress UI
 *
 * Routes:
 * POST   /api/admin/exports          — Create export job
 * GET    /api/admin/exports          — List export jobs
 * GET    /api/admin/exports/:id      — Get job detail & progress
 * DELETE /api/admin/exports/:id      — Cancel export job
 */

import exportJobService from '../../services/exportJobService.js';
import { logControllerError } from '../../config/logger.js';
import { buildPaginatedResponse, parsePagination } from '../../lib/pagination.js';

/** POST /api/admin/exports — Create a new export job. */
const createExport = async (req, res) => {
  try {
    const { type, params } = req.body;
    if (!type) {
      return res.status(400).json({ error: 'Export type required' });
    }

    const tenantId = req.tenant?.id || 'default';
    const requestBy = req.user?.address || 'system';

    const job = await exportJobService.createJob(tenantId, requestBy, type, params);
    res.status(201).json(job);
  } catch (err) {
    logControllerError('export.create', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/admin/exports — List export jobs for current user or tenant. */
const listExports = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const tenantId = req.tenant?.id || 'default';
    const requestBy = req.query.requestBy === 'me' ? req.user?.address : null;

    const { jobs, total } = await exportJobService.listJobs(tenantId, {
      requestBy,
      skip,
      take: limit,
    });

    res.json(buildPaginatedResponse(jobs, { total, page, limit }));
  } catch (err) {
    logControllerError('export.list', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/admin/exports/:id — Get export job detail and progress. */
const getExport = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await exportJobService.getJob(id);

    if (!job) {
      return res.status(404).json({ error: 'Export job not found' });
    }

    // Check tenant access
    if (job.tenantId !== (req.tenant?.id || 'default')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(job);
  } catch (err) {
    logControllerError('export.get', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** DELETE /api/admin/exports/:id — Cancel an export job. */
const cancelExport = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await exportJobService.getJob(id);

    if (!job) {
      return res.status(404).json({ error: 'Export job not found' });
    }

    if (job.tenantId !== (req.tenant?.id || 'default')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Only allow cancellation if not already completed or failed
    if (
      job.status === exportJobService.ExportStatus.COMPLETED ||
      job.status === exportJobService.ExportStatus.FAILED
    ) {
      return res.status(400).json({ error: 'Cannot cancel job in this state' });
    }

    const updated = await exportJobService.markCancelled(id);
    res.json(updated);
  } catch (err) {
    logControllerError('export.cancel', err, req);
    res.status(500).json({ error: err.message });
  }
};

export default { createExport, listExports, getExport, cancelExport };
