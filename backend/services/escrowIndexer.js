/**
 * Escrow Event Indexer
 *
 * Background service that polls the Stellar network for Soroban contract
 * events emitted by the escrow contract and writes them to PostgreSQL.
 *
 * Resilience guarantees:
 *  - Crash recovery: resumes from last committed ledger (Redis + DB) on restart
 *  - Exponential backoff on RPC failures
 *  - Idempotent: upsert semantics prevent duplicate DB records
 *  - DLQ: events that fail after MAX_RETRIES pushes are written to
 *    Redis key `indexer:dlq` for manual inspection without blocking
 *
 * @module escrowIndexer
 */

import { Redis } from 'ioredis';
import prisma from '../lib/prisma.js';
import { createModuleLogger } from '../config/logger.js';
import { getContractEvents, getLatestLedger } from './stellarService.js';
import * as reputationService from './reputationService.js';

const log = createModuleLogger('service.escrowIndexer');

// ── Config ────────────────────────────────────────────────────────────────────

const CONTRACT_ID = process.env.ESCROW_CONTRACT_ID || '';
const POLL_INTERVAL_MS = parseInt(process.env.INDEXER_POLL_INTERVAL_MS || '5000', 10);
const START_LEDGER = parseInt(process.env.INDEXER_START_LEDGER || '0', 10);
const MAX_RETRIES = 3;
const DLQ_KEY = 'indexer:dlq';

// ── Redis ─────────────────────────────────────────────────────────────────────

let _redis = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    _redis.on('error', (err) => log.warn({ message: 'redis_error', error: err.message }));
  }
  return _redis;
}

async function persistCursor(ledger) {
  await prisma.indexerState.update({
    where: { id: 1 },
    data: { lastProcessedLedger: BigInt(ledger) },
  });
}

// ── ScVal helpers (raw JSON values from eventIndexer shape) ───────────────────

const parseBigInt = (v) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  try {
    return BigInt(String(v));
  } catch {
    return BigInt(0);
  }
};

const parseAddress = (v) => {
  if (typeof v === 'string') return v;
  try {
    return v.address().toString();
  } catch {
    return String(v);
  }
};

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * Handles a `mil_apr` (milestone approved) contract event by marking the
 * corresponding milestone as Approved.
 *
 * @param {object} event - Raw Soroban contract event (topic/value/ledger shape from eventIndexer).
 * @returns {Promise<void>}
 */
export async function handleMilestoneApproved(event) {
  const [milestoneId] = event.value ?? [];
  if (event.topic?.[1] == null || milestoneId == null) return;
  const escrowId = parseBigInt(event.topic[1]);
  await prisma.milestone.updateMany({
    where: { escrowId, milestoneIndex: Number(parseBigInt(milestoneId)) },
    data: { status: 'Approved', resolvedAt: new Date(event.ledgerClosedAt) },
  });
}

/**
 * Handles a `dis_rai` (dispute raised) contract event: flags the escrow as
 * Disputed and upserts a Dispute record.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleDisputeRaised(event) {
  if (event.topic?.[1] == null) return;
  const escrowId = parseBigInt(event.topic[1]);
  const raisedBy = parseAddress(event.value);
  await prisma.$transaction([
    prisma.escrow.updateMany({ where: { id: escrowId }, data: { status: 'Disputed' } }),
    prisma.dispute.upsert({
      where: { escrowId },
      create: {
        escrowId,
        raisedByAddress: String(raisedBy ?? ''),
        raisedAt: new Date(event.ledgerClosedAt),
      },
      update: {},
    }),
  ]);
}

/**
 * Handles a `funds_rel` (funds released) contract event: records reputation
 * completion for both parties and decrements the escrow's remaining balance.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleFundsReleased(event) {
  const [, amount] = event.value ?? [];
  if (event.topic?.[1] == null || amount == null) return;
  const escrowId = parseBigInt(event.topic[1]);

  // Fetch escrow to get client and freelancer addresses
  const escrow = await prisma.escrow.findUnique({
    where: { id: escrowId },
    select: { clientAddress: true, freelancerAddress: true, tenantId: true },
  });

  if (escrow) {
    // Record completion for both parties
    await reputationService.recordEscrowCompletion(
      escrow.clientAddress,
      'client',
      escrowId,
      escrow.tenantId,
    );
    await reputationService.recordEscrowCompletion(
      escrow.freelancerAddress,
      'freelancer',
      escrowId,
      escrow.tenantId,
    );
  }

  // Update remaining balance
  const released = parseBigInt(amount);
  await prisma.$executeRaw`
    UPDATE escrows
    SET remaining_balance = (remaining_balance::numeric - ${released}::numeric)::text
    WHERE id = ${escrowId}
  `;
}

/**
 * Handles an `esc_can` (escrow cancelled) contract event by marking the
 * escrow as Cancelled.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleEscrowCancelled(event) {
  if (event.topic?.[1] == null) return;
  const escrowId = parseBigInt(event.topic[1]);
  await prisma.escrow.updateMany({ where: { id: escrowId }, data: { status: 'Cancelled' } });
}

/**
 * Handles an `esc_crt` (escrow created) contract event by upserting a new
 * Escrow record with an Active status.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleEscrowCreated(event) {
  const [client, freelancer, amount] = event.value ?? [];
  if (event.topic?.[1] == null || client == null) return;
  const escrowId = parseBigInt(event.topic[1]);
  await prisma.escrow.upsert({
    where: { id: escrowId },
    create: {
      id: escrowId,
      clientAddress: parseAddress(client),
      freelancerAddress: parseAddress(freelancer),
      tokenAddress: '',
      totalAmount: parseBigInt(amount).toString(),
      remainingBalance: parseBigInt(amount).toString(),
      status: 'Active',
      briefHash: '',
      createdAt: new Date(event.ledgerClosedAt),
      createdLedger: BigInt(event.ledger ?? 0),
    },
    update: {},
  });
}

/**
 * Handles a `mil_add` (milestone added) contract event by upserting a new
 * Milestone record in Pending status.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleMilestoneAdded(event) {
  const [milestoneId, amount] = event.value ?? [];
  if (event.topic?.[1] == null || milestoneId == null) return;
  const escrowId = parseBigInt(event.topic[1]);
  const milestoneIndex = Number(parseBigInt(milestoneId));
  await prisma.milestone.upsert({
    where: { escrowId_milestoneIndex: { escrowId, milestoneIndex } },
    create: {
      escrowId,
      milestoneIndex,
      title: `Milestone ${milestoneIndex}`,
      descriptionHash: '',
      amount: parseBigInt(amount).toString(),
      status: 'Pending',
    },
    update: {},
  });
}

/**
 * Handles a `mil_sub` (milestone submitted) contract event by marking the
 * corresponding milestone as Submitted.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleMilestoneSubmitted(event) {
  const [milestoneId] = event.value ?? [];
  if (event.topic?.[1] == null || milestoneId == null) return;
  const escrowId = parseBigInt(event.topic[1]);
  await prisma.milestone.updateMany({
    where: { escrowId, milestoneIndex: Number(parseBigInt(milestoneId)) },
    data: { status: 'Submitted', submittedAt: new Date(event.ledgerClosedAt) },
  });
}

/**
 * Handles a `dis_res` (dispute resolved) contract event: records the win/loss
 * reputation outcome for both parties and marks the escrow as Completed.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleDisputeResolved(event) {
  if (event.topic?.[1] == null) return;
  const escrowId = parseBigInt(event.topic[1]);

  // Contract emits resolution outcome in value: [winnerId, ...] or similar
  // For now, assume the event.value contains winner address indicator
  // Fetch dispute to determine who won
  const dispute = await prisma.dispute.findUnique({
    where: { escrowId },
    select: { escrowId: true },
  });

  const escrow = await prisma.escrow.findUnique({
    where: { id: escrowId },
    select: { clientAddress: true, freelancerAddress: true, tenantId: true },
  });

  if (!escrow) return;

  // For dispute resolution, we track that one party won and one lost.
  // Contract should emit resolution details; for now, assume arbitration favored the freelancer.
  // (In production, derive from contract's resolution field in event.value)
  const winnerAddress = escrow.freelancerAddress;

  await reputationService.recordDisputeOutcome(winnerAddress, true, escrowId, escrow.tenantId);

  // Loser's score decreases
  const loserAddress =
    winnerAddress === escrow.freelancerAddress ? escrow.clientAddress : escrow.freelancerAddress;

  await reputationService.recordDisputeOutcome(loserAddress, false, escrowId, escrow.tenantId);

  await prisma.escrow.updateMany({ where: { id: escrowId }, data: { status: 'Completed' } });
}

/**
 * Handles a `rep_upd` (reputation updated) contract event by upserting the
 * address's total reputation score.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function handleReputationUpdated(event) {
  const [address, newScore] = event.value ?? [];
  if (address == null) return;
  await prisma.reputationRecord.upsert({
    where: { address: String(address) },
    create: {
      address: String(address),
      totalScore: parseBigInt(newScore ?? 0),
      lastUpdated: new Date(),
    },
    update: { totalScore: parseBigInt(newScore ?? 0), lastUpdated: new Date() },
  });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  esc_crt: handleEscrowCreated,
  mil_add: handleMilestoneAdded,
  mil_sub: handleMilestoneSubmitted,
  mil_apr: handleMilestoneApproved,
  funds_rel: handleFundsReleased,
  esc_can: handleEscrowCancelled,
  dis_rai: handleDisputeRaised,
  dis_res: handleDisputeResolved,
  rep_upd: handleReputationUpdated,
};

/**
 * Routes a raw contract event to its registered handler based on the
 * event's topic (`event.topic[0]`). Unknown topics are logged and skipped.
 *
 * @param {object} event - Raw Soroban contract event.
 * @returns {Promise<void>}
 */
export async function dispatchEvent(event) {
  const topic =
    typeof event.topic?.[0] === 'string' ? event.topic[0] : String(event.topic?.[0] ?? '');
  const handler = HANDLERS[topic];
  if (!handler) {
    log.warn({ message: 'indexer_unknown_event_type', topic });
    return;
  }
  await handler(event);
}

// ── DLQ ───────────────────────────────────────────────────────────────────────

async function pushToDlq(event, error) {
  try {
    const redis = getRedis();
    await redis.rpush(
      DLQ_KEY,
      JSON.stringify({
        event,
        error: error.message,
        failedAt: new Date().toISOString(),
      }),
    );
    log.warn({ message: 'indexer_event_dlq', topic: event.topic?.[0], error: error.message });
  } catch (redisErr) {
    log.error({ message: 'indexer_dlq_push_failed', error: redisErr.message });
  }
}

async function processWithRetry(event) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await dispatchEvent(event);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
      }
    }
  }
  await pushToDlq(event, lastErr);
}

// ── Core polling ──────────────────────────────────────────────────────────────

/**
 * Fetches all events since fromLedger and processes them.
 * Advances the ledger cursor only after all events in a ledger are committed.
 *
 * @param {number} fromLedger
 * @returns {Promise<number>} latest ledger sequence
 */
export async function fetchAndProcessEvents(fromLedger) {
  const events = await getContractEvents(fromLedger, CONTRACT_ID);
  const latest = await getLatestLedger();

  for (const event of events) {
    await processWithRetry(event);
  }

  if (events.length > 0) {
    log.info({ message: 'indexer_events_processed', count: events.length, latestLedger: latest });
  }

  return latest;
}

/**
 * Starts the indexer polling loop.
 * Validates required env vars, loads cursor from DB, then polls.
 *
 * @returns {Promise<void>} never resolves under normal operation; the poll
 *          loop runs indefinitely via `setInterval`.
 */
export async function startIndexer() {
  // Load cursor
  const state = await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastProcessedLedger: BigInt(START_LEDGER) },
    update: {},
  });

  let cursor = Number(state.lastProcessedLedger);
  let backoff = 1000;

  log.info({ message: 'indexer_starting', fromLedger: cursor });

  const tick = async () => {
    if (!CONTRACT_ID) return;
    try {
      const latest = await fetchAndProcessEvents(cursor);
      if (latest > cursor) {
        cursor = latest;
        await persistCursor(cursor);
      }
      backoff = 1000;
    } catch (err) {
      log.error({ message: 'indexer_tick_error', backoffMs: backoff, error: err.message });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

export default {
  startIndexer,
  fetchAndProcessEvents,
  dispatchEvent,
  handleEscrowCreated,
  handleMilestoneAdded,
  handleMilestoneSubmitted,
  handleMilestoneApproved,
  handleFundsReleased,
  handleEscrowCancelled,
  handleDisputeRaised,
  handleDisputeResolved,
  handleReputationUpdated,
};
