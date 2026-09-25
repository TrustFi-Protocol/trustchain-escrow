import { Worker, DelayedError } from 'bullmq';
import prisma from '../lib/prisma.js';
import { connection } from '../queues/index.js';
import { getBreaker, CircuitOpenError } from '../lib/circuitBreaker.js';

// Per-endpoint circuit: repeated failures pause deliveries to that endpoint,
// and a single successful probe after the cool-down closes it again.
const CIRCUIT_OPTIONS = {
  failureThreshold: parseInt(process.env.WEBHOOK_CIRCUIT_FAILURE_THRESHOLD ?? '5', 10),
  successThreshold: 1,
  timeout: parseInt(process.env.WEBHOOK_CIRCUIT_COOLDOWN_MS ?? '60000', 10),
  windowSize: parseInt(process.env.WEBHOOK_CIRCUIT_WINDOW_MS ?? '300000', 10),
};

export function getEndpointBreaker(url) {
  let endpoint = url;
  try {
    endpoint = new URL(url).origin;
  } catch {
    // fall back to the raw URL
  }
  return getBreaker(`webhook:${endpoint}`, CIRCUIT_OPTIONS);
}

export async function processWebhookJob(job, token) {
  const { url, payload, headers = {}, deliveryId } = job.data;
  const attempts = job.attemptsMade + 1;

  try {
    const response = await getEndpointBreaker(url).execute(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Webhook failed: ${res.status} ${errorText}`);
      }
      return res;
    });

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'success',
        responseCode: response.status,
        attempts,
        lastAttemptAt: new Date(),
      },
    });

    console.log(`[WebhookWorker] Delivered to ${url}: ${response.status}`);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      // Paused: reschedule without consuming a retry attempt.
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'pending', errorMessage: err.message },
      });
      if (token && typeof job.moveToDelayed === 'function') {
        await job.moveToDelayed(err.nextAttemptAt, token);
        throw new DelayedError();
      }
      throw err;
    }

    const isTerminal = attempts >= (job.opts.attempts ?? 1);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: isTerminal ? 'failed' : 'pending',
        errorMessage: err.message,
        attempts,
        lastAttemptAt: new Date(),
      },
    });
    throw err;
  }
}

const webhookWorker =
  process.env.NODE_ENV === 'test'
    ? null
    : new Worker('webhook', processWebhookJob, {
        connection,
      });

export default webhookWorker;
