/**
 * Dead-Letter Service
 *
 * Admin helpers to preview and replay jobs that exhausted their retries on the
 * email, webhook, indexer and expiry queues.
 */

import prisma from '../lib/prisma.js';
import { emailQueue, webhookQueue, expiryQueue } from '../queues/index.js';
import { createModuleLogger } from '../config/logger.js';

const log = createModuleLogger('deadLetterService');

const queueLoaders = {
  email: async () => emailQueue,
  webhook: async () => webhookQueue,
  // Loaded lazily: importing eventQueue starts BullMQ workers.
  indexer: async () => (await import('../queues/eventQueue.js')).default.eventQueue,
  expiry: async () => expiryQueue,
};

export const DEAD_LETTER_QUEUES = Object.keys(queueLoaders);

/**
 * Override a queue loader (used by tests and alternate queue backends).
 */
export function registerDeadLetterQueue(name, loader) {
  queueLoaders[name] = loader;
}

async function resolveQueue(name) {
  const loader = queueLoaders[name];
  if (!loader) {
    const err = new Error(`Unknown queue: ${name}`);
    err.status = 400;
    throw err;
  }
  return loader();
}

function summarize(job) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    failedReason: job.failedReason ?? null,
    attemptsMade: job.attemptsMade ?? 0,
    failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

/**
 * List dead-lettered jobs for a queue without changing them.
 */
export async function previewDeadLetters(queueName, { limit = 50 } = {}) {
  const queue = await resolveQueue(queueName);
  const jobs = await queue.getFailed(0, Math.max(0, limit - 1));
  return jobs.map(summarize);
}

/**
 * Replay dead-lettered jobs and record an admin audit log entry.
 *
 * @param {string} queueName
 * @param {object} opts
 * @param {string[]} [opts.jobIds] — specific jobs to replay; all failed jobs when omitted
 * @param {string} opts.performedBy — admin identifier
 */
export async function replayDeadLetters(queueName, { jobIds, performedBy, limit = 50 } = {}) {
  const queue = await resolveQueue(queueName);
  const failed = await queue.getFailed(0, Math.max(0, limit - 1));
  const selected = jobIds?.length ? failed.filter((job) => jobIds.includes(String(job.id))) : failed;

  const replayed = [];
  const errors = [];
  for (const job of selected) {
    try {
      await job.retry();
      replayed.push(String(job.id));
    } catch (err) {
      errors.push({ id: String(job.id), error: err.message });
    }
  }

  await prisma.adminAuditLog.create({
    data: {
      action: 'DEAD_LETTER_REPLAY',
      targetAddress: `queue:${queueName}`,
      reason: `Replayed ${replayed.length} job(s): ${replayed.join(', ') || 'none'}`,
      performedBy,
      performedAt: new Date(),
    },
  });

  log.info({ message: 'dead_letter_replay', queue: queueName, replayed: replayed.length, failed: errors.length });

  return { queue: queueName, replayed, errors };
}

export default {
  DEAD_LETTER_QUEUES,
  registerDeadLetterQueue,
  previewDeadLetters,
  replayDeadLetters,
};
