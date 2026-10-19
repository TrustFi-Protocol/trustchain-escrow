/**
 * Incident Controller
 *
 * REST API for incident lifecycle management.
 * All routes require admin authentication.
 */

import incidentService, { Severity } from '../../services/incidentService.js';
import { createModuleLogger, getCorrelationId } from '../../config/logger.js';
import {
  incidentNotificationRoutingTotal,
  incidentNotificationRoutingDuration,
} from '../../lib/metrics.js';

const log = createModuleLogger('controllers.incident');
const KNOWN_SEVERITIES = new Set(Object.values(Severity));

function outcomeFor(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'rejected';
  return 'success';
}

/**
 * Records bounded metrics and a correlated log line for an operation that
 * routes incident notifications (PagerDuty, Slack, webhooks). Labels come from
 * fixed sets only, and nothing from the request body, headers, or alert
 * configuration (routing keys, webhook URLs, tokens) is logged. Telemetry
 * failures are swallowed so they can never break routing.
 */
export function recordRoutingTelemetry(operation, { startedAt, statusCode, severity, incidentId }) {
  try {
    const outcome = outcomeFor(statusCode);
    const severityLabel = KNOWN_SEVERITIES.has(severity) ? severity : 'unknown';
    incidentNotificationRoutingTotal.inc({ operation, severity: severityLabel, outcome });
    incidentNotificationRoutingDuration.observe(
      { operation, outcome },
      (Date.now() - startedAt) / 1000,
    );
    log[outcome === 'error' ? 'warn' : 'info']({
      message: 'incident.notification_routing',
      operation,
      severity: severityLabel,
      outcome,
      statusCode,
      incidentId: outcome === 'success' ? incidentId : undefined,
      correlationId: getCorrelationId(),
    });
  } catch {
    // Telemetry is best-effort.
  }
}

/** Wraps a handler so every response emits routing telemetry. */
function withRoutingTelemetry(operation, handler) {
  return async (req, res) => {
    const startedAt = Date.now();
    const ctx = {};
    await handler(req, res, ctx);
    recordRoutingTelemetry(operation, {
      startedAt,
      statusCode: res.statusCode ?? 200,
      severity: ctx.incident?.severity ?? ctx.severity,
      incidentId: ctx.incident?.id,
    });
  };
}

const createIncident = withRoutingTelemetry('create', async (req, res, ctx) => {
  try {
    const { title, description, severity, affectedServices, commander, runbookUrl } = req.body;
    ctx.severity = severity;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    const incident = await incidentService.createIncident({
      title,
      description,
      severity,
      affectedServices: affectedServices ?? [],
      commander,
      runbookUrl,
      createdBy: req.user?.address ?? req.headers['x-admin-api-key']?.slice(0, 8) ?? 'admin',
    });
    ctx.incident = incident;
    res.status(201).json(incident);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const listIncidents = (req, res) => {
  try {
    const { status, severity } = req.query;
    res.json(incidentService.listIncidents({ status, severity }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getIncident = (req, res) => {
  try {
    res.json(incidentService.getIncident(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

const updateStatus = withRoutingTelemetry('update_status', async (req, res, ctx) => {
  try {
    const { status, note } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const actor = req.user?.address ?? 'admin';
    const incident = await incidentService.updateIncidentStatus(req.params.id, status, {
      actor,
      note,
    });
    ctx.incident = incident;
    res.json(incident);
  } catch (err) {
    const code = err.message.includes('not found')
      ? 404
      : err.message.includes('Invalid transition')
        ? 422
        : 500;
    res.status(code).json({ error: err.message });
  }
});

const attachPostMortem = (req, res) => {
  try {
    const incident = incidentService.attachPostMortem(req.params.id, req.body);
    res.json(incident);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 422;
    res.status(code).json({ error: err.message });
  }
};

const linkEscrows = withRoutingTelemetry('link_escrows', async (req, res, ctx) => {
  try {
    const { escrowIds, note } = req.body;
    if (!escrowIds) {
      return res.status(400).json({ error: 'escrowIds is required' });
    }
    const actor = req.user?.address ?? req.headers['x-admin-api-key']?.slice(0, 8) ?? 'admin';
    const incident = await incidentService.linkEscrowsToIncident(req.params.id, escrowIds, {
      actor,
      note,
    });
    ctx.incident = incident;
    return res.json(incident);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 500;
    return res.status(code).json({ error: err.message });
  }
});

const getOnCall = (_req, res) => {
  res.json({
    current: incidentService.getCurrentOnCall(),
    schedule: incidentService.getOnCallSchedule(),
  });
};

export default {
  createIncident,
  listIncidents,
  getIncident,
  updateStatus,
  attachPostMortem,
  linkEscrows,
  getOnCall,
};
