/**
 * Concurrency coverage for incident notification routing (Issue #378).
 *
 * Exercises overlapping workers/requests against the incident service and
 * asserts outcomes are deterministic regardless of interleaving.
 */

import incidentService, { Status } from '../services/incidentService.js';
import webhookService from '../services/webhookService.js';

const base = { title: 'Indexer lag', description: 'Ledger ingestion behind', severity: 'SEV3' };

/** Delays each webhook so overlapping callers genuinely interleave. */
const slowQueue = () =>
  jest
    .spyOn(webhookService, 'queueEventWebhooks')
    .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ queued: 1 }), 5)));

describe('incident notification routing concurrency', () => {
  let webhookSpy;

  beforeEach(() => {
    incidentService.__resetForTests();
    webhookSpy = slowQueue();
  });

  afterEach(() => webhookSpy.mockRestore());

  test('overlapping workers creating with one key produce one incident and one notification', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        incidentService.createIncident({ ...base, idempotencyKey: 'worker-key' }),
      ),
    );

    expect(new Set(results.map((i) => i.id)).size).toBe(1);
    expect(incidentService.listIncidents()).toHaveLength(1);
    expect(webhookSpy.mock.calls.filter(([type]) => type === 'incident.opened')).toHaveLength(1);
  });

  test('overlapping workers with distinct keys each create exactly one incident', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'a', 'b', 'c'].map((key) =>
        incidentService.createIncident({ ...base, idempotencyKey: `k-${key}` }),
      ),
    );

    expect(new Set(results.map((i) => i.id)).size).toBe(3);
    expect(results[0].id).toBe(results[3].id);
    expect(webhookSpy).toHaveBeenCalledTimes(3);
  });

  test('concurrent identical status transitions: exactly one wins, the rest fail deterministically', async () => {
    const incident = await incidentService.createIncident(base);
    webhookSpy.mockClear();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        incidentService.updateIncidentStatus(incident.id, Status.ACKNOWLEDGED, { actor: 'w' }),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason.message).toBe(
        'Invalid transition: acknowledged → acknowledged. Allowed: investigating, resolved',
      );
    }
    expect(incident.timeline.map((t) => t.status)).toEqual([Status.OPEN, Status.ACKNOWLEDGED]);
    expect(webhookSpy).toHaveBeenCalledTimes(1);
  });

  test('overlapping escrow links converge on the same union and report each escrow once', async () => {
    const incident = await incidentService.createIncident(base);
    webhookSpy.mockClear();

    const batches = [['1', '2'], ['2', '3'], ['3', '1'], ['1', '2', '3']];
    await Promise.all(batches.map((ids) => incidentService.linkEscrowsToIncident(incident.id, ids)));

    expect([...incident.affectedEscrowIds].sort()).toEqual(['1', '2', '3']);
    const newlyLinked = webhookSpy.mock.calls.flatMap(([, payload]) => payload.newlyLinked);
    expect(newlyLinked.sort()).toEqual(['1', '2', '3']);
  });

  test('overlapping operations on an unknown incident all fail with a stable error', async () => {
    const outcomes = await Promise.allSettled([
      incidentService.updateIncidentStatus('INC-missing', Status.RESOLVED),
      incidentService.linkEscrowsToIncident('INC-missing', ['1']),
    ]);

    expect(outcomes.map((o) => o.reason?.message)).toEqual([
      'Incident INC-missing not found',
      'Incident INC-missing not found',
    ]);
    expect(webhookSpy).not.toHaveBeenCalled();
  });
});
