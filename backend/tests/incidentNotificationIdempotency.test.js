/**
 * Idempotency safeguards for incident notification routing (Issue #377).
 *
 * Retried or concurrent requests carrying the same idempotency key must not
 * create duplicate incidents or route the same notification twice.
 */

import express from 'express';
import request from 'supertest';
import incidentService, { Status } from '../services/incidentService.js';
import webhookService from '../services/webhookService.js';
import incidentController from '../api/controllers/incidentController.js';
import { idempotencyMiddleware, _resetIdempotencyCache } from '../lib/idempotency.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.post('/api/incidents', idempotencyMiddleware, incidentController.createIncident);
  app.patch('/api/incidents/:id/status', idempotencyMiddleware, incidentController.updateStatus);
  return app;
};

const params = { title: 'Horizon outage', description: 'RPC 504s', severity: 'SEV2' };

describe('incident notification routing idempotency', () => {
  let webhookSpy;

  beforeEach(() => {
    incidentService.__resetForTests();
    _resetIdempotencyCache();
    webhookSpy = jest.spyOn(webhookService, 'queueEventWebhooks').mockResolvedValue({ queued: 1 });
  });

  afterEach(() => webhookSpy.mockRestore());

  test('retried create with the same key returns the original incident and notifies once', async () => {
    const first = await incidentService.createIncident({ ...params, idempotencyKey: 'key-1' });
    const retry = await incidentService.createIncident({ ...params, idempotencyKey: 'key-1' });

    expect(retry.id).toBe(first.id);
    expect(incidentService.listIncidents()).toHaveLength(1);
    expect(webhookSpy).toHaveBeenCalledTimes(1);
  });

  test('concurrent creates with the same key coalesce into one incident', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        incidentService.createIncident({ ...params, idempotencyKey: 'key-2' }),
      ),
    );

    expect(new Set(results.map((i) => i.id)).size).toBe(1);
    expect(webhookSpy).toHaveBeenCalledTimes(1);
  });

  test('creates without a key or with distinct keys are not deduplicated', async () => {
    await incidentService.createIncident(params);
    await incidentService.createIncident({ ...params, idempotencyKey: '  ' });
    await incidentService.createIncident({ ...params, idempotencyKey: 'a' });
    await incidentService.createIncident({ ...params, idempotencyKey: 'b' });

    expect(incidentService.listIncidents()).toHaveLength(4);
  });

  test('re-linking already linked escrows does not re-notify', async () => {
    const incident = await incidentService.createIncident(params);
    await incidentService.linkEscrowsToIncident(incident.id, ['1', '2']);
    const timelineLength = incident.timeline.length;
    webhookSpy.mockClear();

    await incidentService.linkEscrowsToIncident(incident.id, ['2', '1']);

    expect(webhookSpy).not.toHaveBeenCalled();
    expect(incident.timeline).toHaveLength(timelineLength);
  });

  test('HTTP retry replays the cached response; payload mismatch is rejected', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/incidents').set('Idempotency-Key', 'http-1').send(params);
    const retry = await request(app).post('/api/incidents').set('Idempotency-Key', 'http-1').send(params);
    const conflict = await request(app)
      .post('/api/incidents')
      .set('Idempotency-Key', 'http-1')
      .send({ ...params, title: 'different' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(conflict.status).toBe(422);
    expect(incidentService.listIncidents()).toHaveLength(1);
  });

  test('a repeated status transition is rejected instead of re-notifying', async () => {
    const app = buildApp();
    const incident = await incidentService.createIncident(params);
    webhookSpy.mockClear();

    const ok = await request(app)
      .patch(`/api/incidents/${incident.id}/status`)
      .send({ status: Status.ACKNOWLEDGED });
    const again = await request(app)
      .patch(`/api/incidents/${incident.id}/status`)
      .send({ status: Status.ACKNOWLEDGED });

    expect(ok.status).toBe(200);
    expect(again.status).toBe(422);
    expect(webhookSpy).toHaveBeenCalledTimes(1);
  });
});
