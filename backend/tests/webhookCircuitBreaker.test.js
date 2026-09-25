/**
 * Webhook Delivery Circuit Breaker Tests
 *
 * Covers:
 *   - Failure threshold opens the circuit for an endpoint
 *   - Paused deliveries skip the network and are rescheduled
 *   - A successful probe closes the circuit
 */

import { jest } from '@jest/globals';

process.env.WEBHOOK_CIRCUIT_FAILURE_THRESHOLD = '2';
process.env.WEBHOOK_CIRCUIT_COOLDOWN_MS = '50';

const prismaMock = { webhookDelivery: { update: jest.fn().mockResolvedValue({}) } };
jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

const { processWebhookJob, getEndpointBreaker } = await import('../workers/webhookWorker.js');
const { STATES, clearRegistry, CircuitOpenError } = await import('../lib/circuitBreaker.js');

const URL_BAD = 'https://bad.example.com/hook';

const makeJob = (overrides = {}) => ({
  data: { deliveryId: 'd1', url: URL_BAD, payload: { eventType: 'esc_crt' } },
  attemptsMade: 0,
  opts: { attempts: 5 },
  ...overrides,
});

describe('webhook delivery circuit breaker', () => {
  beforeEach(() => {
    clearRegistry();
    jest.clearAllMocks();
  });

  it('opens after the failure threshold and pauses delivery', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    await expect(processWebhookJob(makeJob())).rejects.toThrow('network error');
    await expect(processWebhookJob(makeJob())).rejects.toThrow('network error');
    expect(getEndpointBreaker(URL_BAD).state).toBe(STATES.OPEN);

    await expect(processWebhookJob(makeJob())).rejects.toBeInstanceOf(CircuitOpenError);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(prismaMock.webhookDelivery.update).toHaveBeenLastCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'pending' }),
    });
  });

  it('reschedules paused jobs without consuming an attempt', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    await expect(processWebhookJob(makeJob())).rejects.toThrow();
    await expect(processWebhookJob(makeJob())).rejects.toThrow();

    const job = makeJob({ moveToDelayed: jest.fn().mockResolvedValue(undefined) });
    await expect(processWebhookJob(job, 'token')).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
  });

  it('does not pause deliveries to other endpoints', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    await expect(processWebhookJob(makeJob())).rejects.toThrow();
    await expect(processWebhookJob(makeJob())).rejects.toThrow();

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: jest.fn() });
    const other = makeJob({ data: { deliveryId: 'd2', url: 'https://good.example.com/hook', payload: {} } });
    await expect(processWebhookJob(other)).resolves.toBeUndefined();
  });

  it('closes the circuit after a successful probe', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    await expect(processWebhookJob(makeJob())).rejects.toThrow();
    await expect(processWebhookJob(makeJob())).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 60));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: jest.fn() });

    await expect(processWebhookJob(makeJob())).resolves.toBeUndefined();
    expect(getEndpointBreaker(URL_BAD).state).toBe(STATES.CLOSED);
  });
});
