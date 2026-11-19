/**
 * Incident Response Service
 *
 * Manages the full incident lifecycle:
 *   - Incident creation, status transitions, and resolution
 *   - Alerting via PagerDuty Events API v2, Slack webhooks, and email
 *   - On-call rotation scheduling
 *   - Post-mortem tracking
 *   - Audit trail for every state change
 *
 * ## Severity levels
 *
 *   SEV1 — Critical: full outage, data loss risk, security breach
 *   SEV2 — High: major feature broken, significant user impact
 *   SEV3 — Medium: degraded performance, partial feature failure
 *   SEV4 — Low: minor issue, cosmetic bug, no user impact
 *
 * ## Environment variables
 *
 *   PAGERDUTY_ROUTING_KEY   — PagerDuty Events API v2 integration key
 *   SLACK_INCIDENT_WEBHOOK  — Slack incoming webhook URL
 *   ONCALL_SCHEDULE         — JSON array of on-call entries (see below)
 *   INCIDENT_ALERT_EMAIL    — email address for incident notifications
 *   RUNBOOK_BASE_URL        — override for the runbook base URL
 *
 * @module incidentService
 */

import crypto from 'crypto';
import webhookService from './webhookService.js';

// ── Types / constants ─────────────────────────────────────────────────────────

export const Severity = Object.freeze({
  SEV1: 'SEV1',
  SEV2: 'SEV2',
  SEV3: 'SEV3',
  SEV4: 'SEV4',
});

export const Status = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  INVESTIGATING: 'investigating',
  MITIGATED: 'mitigated',
  RESOLVED: 'resolved',
  POST_MORTEM: 'post_mortem',
  CLOSED: 'closed',
});

// Valid status transitions
const TRANSITIONS = {
  [Status.OPEN]: [Status.ACKNOWLEDGED, Status.INVESTIGATING, Status.RESOLVED],
  [Status.ACKNOWLEDGED]: [Status.INVESTIGATING, Status.RESOLVED],
  [Status.INVESTIGATING]: [Status.MITIGATED, Status.RESOLVED],
  [Status.MITIGATED]: [Status.RESOLVED],
  [Status.RESOLVED]: [Status.POST_MORTEM, Status.CLOSED],
  [Status.POST_MORTEM]: [Status.CLOSED],
  [Status.CLOSED]: [],
};

// ── Runbook URLs ──────────────────────────────────────────────────────────────

const DEFAULT_RUNBOOK_BASE_URL =
  'https://github.com/TrustFi-Protocol/trustchain-escrow/blob/main/docs/incidents/runbooks';

const RUNBOOK_FILENAMES = Object.freeze({
  [Severity.SEV1]: 'sev1-critical-outage.md',
  [Severity.SEV2]: 'sev2-major-degradation.md',
  [Severity.SEV3]: 'sev3-partial-failure.md',
  [Severity.SEV4]: 'sev4-minor-issue.md',
});

/**
 * Resolves the runbook URL for a given severity.
 * `RUNBOOK_BASE_URL` overrides the default base URL.
 *
 * @param {string} severity
 * @returns {string}
 */
export function resolvedRunbookUrl(severity) {
  const base = (process.env.RUNBOOK_BASE_URL || DEFAULT_RUNBOOK_BASE_URL).replace(/\/+$/, '');
  const filename = RUNBOOK_FILENAMES[severity] ?? RUNBOOK_FILENAMES[Severity.SEV3];
  return `${base}/${filename}`;
}

// ── In-memory store (replace with DB persistence in production) ───────────────

/** @type {Map<string, Incident>} */
const incidents = new Map();

// ── On-call rotation ──────────────────────────────────────────────────────────

/**
 * Parses the ONCALL_SCHEDULE env var.
 * Format: JSON array of { name, email, phone?, startUtc, endUtc }
 *
 * Example:
 *   [
 *     { "name": "Alice", "email": "alice@example.com", "startUtc": "2026-01-01T00:00:00Z", "endUtc": "2026-01-08T00:00:00Z" },
 *     { "name": "Bob",   "email": "bob@example.com",   "startUtc": "2026-01-08T00:00:00Z", "endUtc": "2026-01-15T00:00:00Z" }
 *   ]
 */
function parseOnCallSchedule() {
  try {
    return JSON.parse(process.env.ONCALL_SCHEDULE || '[]');
  } catch {
    return [];
  }
}

/**
 * Returns the currently on-call engineer, or null if no schedule is configured.
 * @returns {{ name: string, email: string, phone?: string } | null}
 */
export function getCurrentOnCall() {
  const schedule = parseOnCallSchedule();
  const now = new Date();
  return (
    schedule.find((entry) => {
      const start = new Date(entry.startUtc);
      const end = new Date(entry.endUtc);
      return now >= start && now < end;
    }) ??
    schedule[0] ??
    null
  );
}

/**
 * Returns the full on-call schedule.
 */
export function getOnCallSchedule() {
  return parseOnCallSchedule();
}

// ── Alert dispatchers ─────────────────────────────────────────────────────────

/**
 * Sends a PagerDuty alert via Events API v2.
 * https://developer.pagerduty.com/docs/events-api-v2/trigger-events/
 *
 * @param {'trigger'|'acknowledge'|'resolve'} action
 * @param {Incident} incident
 */
async function alertPagerDuty(action, incident) {
  const key = process.env.PAGERDUTY_ROUTING_KEY;
  if (!key) return;

  const payload = {
    routing_key: key,
    event_action: action,
    dedup_key: incident.id,
    payload: {
      summary: `[${incident.severity}] ${incident.title}`,
      source: 'stellar-trust-escrow',
      severity:
        incident.severity === Severity.SEV1
          ? 'critical'
          : incident.severity === Severity.SEV2
            ? 'error'
            : incident.severity === Severity.SEV3
              ? 'warning'
              : 'info',
      timestamp: new Date().toISOString(),
      custom_details: {
        id: incident.id,
        status: incident.status,
        description: incident.description,
        affectedServices: incident.affectedServices.join(', '),
        runbook: incident.runbookUrl,
      },
    },
  };

  try {
    const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[Incident] PagerDuty alert failed: ${res.status}`);
    }
  } catch (err) {
    console.error('[Incident] PagerDuty request error:', err.message);
  }
}

/**
 * Posts an incident notification to a Slack webhook.
 *
 * @param {Incident} incident
 * @param {string} [message]
 */
async function alertSlack(incident, message) {
  const webhookUrl = process.env.SLACK_INCIDENT_WEBHOOK;
  if (!webhookUrl) return;

  const severityEmoji =
    {
      SEV1: '🔴',
      SEV2: '🟠',
      SEV3: '🟡',
      SEV4: '🔵',
    }[incident.severity] ?? '⚪';

  const body = {
    text: message ?? `${severityEmoji} *[${incident.severity}] ${incident.title}*`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji} ${incident.severity}: ${incident.title}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Status:*\n${incident.status}` },
          { type: 'mrkdwn', text: `*ID:*\n${incident.id}` },
          {
            type: 'mrkdwn',
            text: `*Services:*\n${incident.affectedServices.join(', ') || 'unknown'}`,
          },
          { type: 'mrkdwn', text: `*Commander:*\n${incident.commander || 'unassigned'}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Description:*\n${incident.description}` },
      },
      ...(incident.runbookUrl
        ? [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Runbook:* <${incident.runbookUrl}|View runbook>` },
            },
          ]
        : []),
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`[Incident] Slack alert failed: ${res.status}`);
  } catch (err) {
    console.error('[Incident] Slack request error:', err.message);
  }
}

/**
 * Dispatches all configured alert channels for an incident event.
 *
 * @param {'trigger'|'acknowledge'|'resolve'|'update'} action
 * @param {Incident} incident
 * @param {string} [message]
 */
async function dispatchAlerts(action, incident, message) {
  const pdAction =
    action === 'trigger'
      ? 'trigger'
      : action === 'acknowledge'
        ? 'acknowledge'
        : action === 'resolve'
          ? 'resolve'
          : 'trigger'; // updates re-trigger to keep PD in sync

  await Promise.allSettled([alertPagerDuty(pdAction, incident), alertSlack(incident, message)]);
}

// ── Webhook Emission ─────────────────────────────────────────────────────────

/**
 * Builds standard webhook payload for incident events
 */
export function buildIncidentWebhookPayload(eventType, incident, extra = {}) {
  const affectedEscrows = incident.affectedEscrowIds ?? [];
  const affectedServices = incident.affectedServices ?? [];

  return {
    eventType,
    incidentId: incident.id,
    id: incident.id,
    status: incident.status,
    severity: incident.severity,
    affectedScope: {
      services: affectedServices,
      escrows: affectedEscrows,
      escrowIds: affectedEscrows,
    },
    affectedServices,
    affectedEscrowIds: affectedEscrows,
    title: incident.title,
    description: incident.description,
    commander: incident.commander,
    timestamp: new Date

/* … truncated 8089 chars — edit only what you need near the top … */
