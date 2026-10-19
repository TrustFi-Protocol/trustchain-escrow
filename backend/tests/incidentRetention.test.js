/**
 * Tests for incident notification routing retention controls (Issue #381)
 */

import { jest } from '@jest/globals';
import incidentService, { Severity, Status } from '../services/incidentService.js';
import webhookService from '../services/webhookService.js';
import incidentController from '../api/controllers/incidentController.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function createResolvedIncident(title) {
  const incident = await incidentService.createIncident({
    title,
    description: 'retention fixture',
    severity: Severity.SEV4,
  });
  await incidentService.updateIncidentStatus(incident.id, Status.RESOLVED, { actor: 'test' });
  return incident;
}

describe('incident retention controls', () => {
  let webhookSpy;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    incidentService.__resetForTests();
    delete process.env.INCIDENT_RETENTION_DAYS;
    delete process.env.INCIDENT_MAX_RETAINED;
    delete process.env.INCIDENT_MAX_TIMELINE_ENTRIES;
    webhookSpy = jest.spyOn(webhookService, 'queueEventWebhooks').mockResolvedValue({ queued: 1 });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    webhookSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('exposes a bounded default retention policy', () => {
    const res = createRes();
    incidentController.getRetentionPolicy({}, res);
    expect(res.body).toEqual({
      retentionDays: 90,
      maxRetained: 1000,
      maxTimelineEntries: 200,
      prunableStatuses: [Status.RESOLVED, Status.CLOSED],
    });
  });

  test('prunes expired resolved incidents and never removes active incidents', async () => {
    const resolved = await createResolvedIncident('Resolved routing failure');
    const active = await incidentService.createIncident({
      title: 'Active routing failure',
      description: 'still open',
    });

    const res = createRes();
    incidentController.pruneIncidents({ body: { retentionDays: 30 } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.prunedIds).toEqual([]);

    const later = Date.now() + 31 * DAY_MS;
    const result = incidentService.pruneIncidents({ retentionDays: 30, now: later });
    expect(result).toMatchObject({ dryRun: false, evaluated: 2, retained: 1 });
    expect(result.prunedIds).toEqual([resolved.id]);
    expect(() => incidentService.getIncident(resolved.id)).toThrow('not found');
    expect(incidentService.getIncident(active.id).status).toBe(Status.OPEN);
  });

  test('dry run reports candidates without deleting them', async () => {
    const resolved = await createResolvedIncident('Dry run fixture');
    const result = incidentService.pruneIncidents({
      retentionDays: 1,
      dryRun: true,
      now: Date.now() + 2 * DAY_MS,
    });
    expect(result.prunedIds).toEqual([resolved.id]);
    expect(result.retained).toBe(0);
    expect(incidentService.getIncident(resolved.id).id).toBe(resolved.id);
  });

  test('enforces the max retained bound by evicting the oldest resolved incidents only', async () => {
    process.env.INCIDENT_MAX_RETAINED = '2';
    const oldest = await createResolvedIncident('first');
    incidentService.getIncident(oldest.id).resolvedAt = new Date(Date.now() - DAY_MS).toISOString();
    await createResolvedIncident('second');
    const open = await incidentService.createIncident({ title: 'third', description: 'open' });

    const ids = incidentService.listIncidents().map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(oldest.id);
    expect(ids).toContain(open.id);
  });

  test('caps timeline entries while keeping the creation entry', async () => {
    process.env.INCIDENT_MAX_TIMELINE_ENTRIES = '3';
    const incident = await incidentService.createIncident({ title: 'timeline', description: 'x' });
    for (let i = 0; i < 5; i += 1) {
      await incidentService.linkEscrowsToIncident(incident.id, [String(i)], { actor: 'test' });
    }
    const { timeline } = incidentService.getIncident(incident.id);
    expect(timeline).toHaveLength(3);
    expect(timeline[0].note).toBe('Incident created');
    expect(timeline[2].note).toBe('Linked escrows: 4');
  });

  test.each([
    [{ dryRun: 'yes' }, 'dryRun must be a boolean'],
    [{ retentionDays: '30' }, 'retentionDays must be an integer'],
    [{ retentionDays: 0 }, 'Invalid retention: retentionDays must be an integer between 1 and 3650'],
    [{ retentionDays: 5000 }, 'Invalid retention: retentionDays must be an integer between 1 and 3650'],
  ])('rejects invalid prune request %j with 400', (body, error) => {
    const res = createRes();
    incidentController.pruneIncidents({ body }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error });
  });

  test('falls back to defaults for invalid retention env values', () => {
    process.env.INCIDENT_RETENTION_DAYS = 'not-a-number';
    process.env.INCIDENT_MAX_RETAINED = '-5';
    expect(incidentService.getRetentionPolicy()).toMatchObject({
      retentionDays: 90,
      maxRetained: 1000,
    });
  });
});
