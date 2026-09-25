/**
 * Incident Controller — Issue #231: Add Incident Impact Links to Escrows
 *
 * Routes:
 * POST   /api/admin/incidents              — Create incident
 * GET    /api/admin/incidents              — List incidents
 * GET    /api/admin/incidents/:id          — Get incident detail
 * PATCH  /api/admin/incidents/:id          — Update incident status
 * POST   /api/admin/incidents/:id/escrows  — Link escrow to incident
 * DELETE /api/admin/incidents/:id/escrows  — Unlink escrow from incident
 * GET    /api/admin/incidents/:id/escrows  — List affected escrows
 */

import incidentService from '../../services/incidentService.js';
import { logControllerError } from '../../config/logger.js';
import { buildPaginatedResponse, parsePagination } from '../../lib/pagination.js';

/** POST /api/admin/incidents — Create a new incident. */
const createIncident = async (req, res) => {
  try {
    const { title, description, severity } = req.body;

    if (!title || !severity) {
      return res.status(400).json({ error: 'Title and severity required' });
    }

    const tenantId = req.tenant?.id || 'default';
    const createdBy = req.user?.address || 'system';

    const incident = await incidentService.createIncident(
      tenantId,
      title,
      description || '',
      severity,
      createdBy,
    );

    res.status(201).json(incident);
  } catch (err) {
    logControllerError('incident.create', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/admin/incidents — List incidents (paginated, tenant-scoped). */
const listIncidents = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { status } = req.query;
    const tenantId = req.tenant?.id || 'default';

    const { incidents, total } = await incidentService.listIncidents(tenantId, {
      status,
      skip,
      take: limit,
    });

    res.json(buildPaginatedResponse(incidents, { total, page, limit }));
  } catch (err) {
    logControllerError('incident.list', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/admin/incidents/:id — Get incident detail with affected escrows count. */
const getIncident = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant?.id || 'default';

    const incident = await incidentService.getIncident(id, tenantId);

    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    res.json(incident);
  } catch (err) {
    logControllerError('incident.get', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** PATCH /api/admin/incidents/:id — Update incident status. */
const updateIncident = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const tenantId = req.tenant?.id || 'default';

    if (!status) {
      return res.status(400).json({ error: 'Status required' });
    }

    // Verify incident exists in tenant
    const incident = await incidentService.getIncident(id, tenantId);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    const updated = await incidentService.updateStatus(id, tenantId, status);
    res.json(updated);
  } catch (err) {
    logControllerError('incident.update', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** POST /api/admin/incidents/:id/escrows — Link an escrow to an incident. */
const addEscrow = async (req, res) => {
  try {
    const { id } = req.params;
    const { escrowId, reason } = req.body;
    const tenantId = req.tenant?.id || 'default';

    if (!escrowId) {
      return res.status(400).json({ error: 'Escrow ID required' });
    }

    // Verify incident exists
    const incident = await incidentService.getIncident(id, tenantId);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    const link = await incidentService.addEscrow(id, tenantId, BigInt(escrowId), reason || '');
    res.status(201).json(link);
  } catch (err) {
    logControllerError('incident.addEscrow', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** DELETE /api/admin/incidents/:id/escrows/:escrowId — Unlink an escrow. */
const removeEscrow = async (req, res) => {
  try {
    const { id, escrowId } = req.params;
    const tenantId = req.tenant?.id || 'default';

    // Verify incident exists
    const incident = await incidentService.getIncident(id, tenantId);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    await incidentService.removeEscrow(id, BigInt(escrowId));
    res.json({ ok: true });
  } catch (err) {
    logControllerError('incident.removeEscrow', err, req);
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/admin/incidents/:id/escrows — List affected escrows (paginated). */
const getAffectedEscrows = async (req, res) => {
  try {
    const { id } = req.params;
    const { page, limit, skip } = parsePagination(req.query);
    const tenantId = req.tenant?.id || 'default';

    // Verify incident exists
    const incident = await incidentService.getIncident(id, tenantId);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    const { escrows, total } = await incidentService.getAffectedEscrows(id, tenantId, {
      skip,
      take: limit,
    });

    res.json(buildPaginatedResponse(escrows, { total, page, limit }));
  } catch (err) {
    logControllerError('incident.getAffectedEscrows', err, req);
    res.status(500).json({ error: err.message });
  }
};

export default {
  createIncident,
  listIncidents,
  getIncident,
  updateIncident,
  addEscrow,
  removeEscrow,
  getAffectedEscrows,
};
