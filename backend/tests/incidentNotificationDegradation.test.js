/**
 * Graceful degradation for incident notification routing (Issue #379).
 *
 * When optional infrastructure (PagerDuty, Slack, webhook queue) is
 * unavailable the incident must still be recorded and the API must return a
 * stable degraded response without leaking secrets.
 */

import express from 'express';
import request from 'supertest';
import incidentService, { ChannelStatus } from '../services/incidentService.js';
import webhookService from '../services/webhookService.js';
import incidentController from '../api/controllers/incidentController.js';

const SLACK_URL = 'https://hooks.slack.test/services/SECRET-TOKEN';
const PD_KEY = 'pd-secret-routing-key';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.post('/api/incidents', incidentController.createIncident);
  return app;
};

const params = { title: 'Queue outage', description: 'Redis unreachable', severity: 'SEV1' };

describe('incident notification routing graceful degradation', () => {
  const originalFetch = global.fetch;
  let webhookSpy;

  beforeEach(() => {
    incidentService.__resetForTests();
    process.env.PAGERDUTY_ROUTING_KEY = PD_KEY;
    process.env.SLACK_INCIDENT_WEBHOOK = SLACK_URL;
    webhookSpy = jest.spyOn(webhookService, 'queueEventWebhooks').mockResolvedValue({ queued: 1 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    webhookSpy.mockRestore();
    delete process.env.PAGERDUTY_ROUTING_KEY;
    delete process.env.SLACK_INCIDENT_WEBHOOK;
  });

  test('all channels healthy returns an ok notification summary', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    const res = await request(buildApp()).post('/api/incidents').send(params);

    expect(res.status).toBe(201);
    expect(res.body.notifications).toEqual({
      eventType: 'incident.opened',
      status: 'ok',
      channels: { pagerduty: 'sent', slack: 'sent', webhook: 'sent' },
    });
  });

  test('network failure on PagerDuty and Slack yields a stable degraded response', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError(`fetch failed ${SLACK_URL}`));

    const res = await request(buildApp()).post('/api/incidents').send(params);

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^INC-/);
    expect(res.body.notifications).toEqual({
      eventType: 'incident.opened',
      status: 'degraded',
      channels: { pagerduty: 'failed', slack: 'failed', webhook: 'sent' },
      message: 'Incident recorded; one or more notification channels are unavailable',
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(res.body)).not.toContain(PD_KEY);
    expect(incidentService.listIncidents()).toHaveLength(1);
  });

  test('webhook queue outage and non-2xx responses degrade without failing the request', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    webhookSpy.mockRejectedValue(new Error('redis down'));

    const incident = await incidentService.createIncident(params);

    expect(incidentService.getNotificationStatus(incident.id)).toMatchObject({
      status: 'degraded',
      channels: { pagerduty: 'failed', slack: 'failed', webhook: 'failed' },
    });
  });

  test('unconfigured optional channels are skipped, not degraded', async () => {
    delete process.env.PAGERDUTY_ROUTING_KEY;
    delete process.env.SLACK_INCIDENT_WEBHOOK;
    global.fetch = jest.fn();

    const incident = await incidentService.createIncident(params);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(incidentService.getNotificationStatus(incident.id)).toEqual({
      eventType: 'incident.opened',
      status: 'ok',
      channels: {
        pagerduty: ChannelStatus.SKIPPED,
        slack: ChannelStatus.SKIPPED,
        webhook: ChannelStatus.SENT,
      },
    });
  });
});
