/**
 * Escrow Service
 *
 * All multi-table write operations wrapped in Prisma transactions
 * with deadlock retry via withTransaction().
 */

import { withTransaction } from '../lib/transaction.js';
import prisma from '../lib/prisma.js';

// Issue #109: each write below repeated the same "escrow must be in state X
// or throw a 409" check and the same admin-audit-log entry shape. Extracted
// into shared helpers so both only exist in one place.

/** Throws a 409 error unless `escrow.status` is exactly `expectedStatus`. */
function assertEscrowStatus(escrow, expectedStatus, message) {
  if (escrow.status !== expectedStatus) {
    throw Object.assign(new Error(message), { statusCode: 409 });
  }
}

/** Builds an `adminAuditLog.create` call with `performedAt` filled in. */
function auditLogEntry(tx, { action, targetAddress, reason, performedBy }) {
  return tx.adminAuditLog.create({
    data: {
      action,
      targetAddress,
      reason,
      performedBy,
      performedAt: new Date(),
    },
  });
}

/// Create and persist a funded escrow record.
export async function fundEscrow(data) {
  return withTransaction(
    async (tx) => {
      const escrow = await tx.escrow.create({
        data: {
          id: BigInt(data.id),
          clientAddress: data.clientAddress,
          freelancerAddress: data.freelancerAddress,
          arbiterAddress: data.arbiterAddress ?? null,
          tokenAddress: data.tokenAddress,
          totalAmount: String(data.totalAmount),
          remainingBalance: String(data.totalAmount),
          status: 'Active',
          briefHash: data.briefHash,
          deadline: data.deadline ?? null,
          createdAt: new Date(),
          createdLedger: BigInt(data.createdLedger ?? 0),
        },
      });

      await auditLogEntry(tx, {
        action: 'ESCROW_FUNDED',
        targetAddress: data.clientAddress,
        reason: `Escrow ${escrow.id} funded with ${data.totalAmount}`,
        performedBy: data.clientAddress,
      });

      return escrow;
    },
    { isolationLevel: 'Serializable' },
  );
}

/// Approve a milestone release and update the escrow balance atomically.
export async function releaseMilestone({ escrowId, milestoneIndex, amount, callerAddress }) {
  return withTransaction(async (tx) => {
    const escrow = await tx.escrow.findUniqueOrThrow({
      where: { id: BigInt(escrowId) },
      select: { remainingBalance: true, status: true },
    });

    assertEscrowStatus(escrow, 'Active', 'Escrow is not active');

    const newBalance = BigInt(escrow.remainingBalance) - BigInt(amount);
    if (newBalance < 0n) {
      throw Object.assign(new Error('Insufficient escrow balance'), { statusCode: 422 });
    }

    const [milestone, updatedEscrow] = await Promise.all([
      tx.milestone.update({
        where: { escrowId_milestoneIndex: { escrowId: BigInt(escrowId), milestoneIndex } },
        data: { status: 'Approved', resolvedAt: new Date() },
      }),
      tx.escrow.update({
        where: { id: BigInt(escrowId) },
        data: {
          remainingBalance: String(newBalance),
          ...(newBalance === 0n ? { status: 'Completed' } : {}),
        },
      }),
      auditLogEntry(tx, {
        action: 'MILESTONE_RELEASED',
        targetAddress: callerAddress,
        reason: `Milestone ${milestoneIndex} of escrow ${escrowId} released`,
        performedBy: callerAddress,
      }),
    ]);

    return { milestone, escrow: updatedEscrow };
  });
}

/// Mark an escrow as disputed and record the dispute atomically.
export async function raiseDispute({ escrowId, raisedByAddress, milestoneIndex }) {
  return withTransaction(
    async (tx) => {
      const escrow = await tx.escrow.findUniqueOrThrow({
        where: { id: BigInt(escrowId) },
        select: { status: true },
      });

      assertEscrowStatus(escrow, 'Active', 'Escrow must be Active to raise a dispute');

      const ops = [
        tx.escrow.update({ where: { id: BigInt(escrowId) }, data: { status: 'Disputed' } }),
        tx.dispute.create({
          data: { escrowId: BigInt(escrowId), raisedByAddress, raisedAt: new Date() },
        }),
        auditLogEntry(tx, {
          action: 'DISPUTE_RAISED',
          targetAddress: raisedByAddress,
          reason: `Dispute raised on escrow ${escrowId}`,
          performedBy: raisedByAddress,
        }),
      ];

      if (milestoneIndex !== undefined) {
        ops.push(
          tx.milestone.updateMany({
            where: { escrowId: BigInt(escrowId), milestoneIndex },
            data: { status: 'Rejected' },
          }),
        );
      }

      const [updatedEscrow, dispute] = await Promise.all(ops);
      return { dispute, escrow: updatedEscrow };
    },
    { isolationLevel: 'Serializable' },
  );
}

/// Resolve a dispute, settle balances, and persist the outcome atomically.
export async function resolveDispute({
  escrowId,
  clientAmount,
  freelancerAmount,
  resolvedBy,
  resolution,
}) {
  return withTransaction(
    async (tx) => {
      const escrow = await tx.escrow.findUniqueOrThrow({
        where: { id: BigInt(escrowId) },
        select: { status: true, remainingBalance: true },
      });

      assertEscrowStatus(escrow, 'Disputed', 'Escrow is not in Disputed state');

      const total = BigInt(clientAmount) + BigInt(freelancerAmount);
      if (total !== BigInt(escrow.remainingBalance)) {
        throw Object.assign(new Error('Amounts must sum to remaining balance'), {
          statusCode: 422,
        });
      }

      const [updatedEscrow, dispute] = await Promise.all([
        tx.escrow.update({
          where: { id: BigInt(escrowId) },
          data: { status: 'Completed', remainingBalance: '0' },
        }),
        tx.dispute.update({
          where: { escrowId: BigInt(escrowId) },
          data: {
            resolvedAt: new Date(),
            clientAmount: String(clientAmount),
            freelancerAmount: String(freelancerAmount),
            resolvedBy,
            resolution,
          },
        }),
        auditLogEntry(tx, {
          action: 'DISPUTE_RESOLVED',
          targetAddress: resolvedBy,
          reason: resolution ?? `Dispute on escrow ${escrowId} resolved`,
          performedBy: resolvedBy,
        }),
      ]);

      return { dispute, escrow: updatedEscrow };
    },
    { isolationLevel: 'Serializable' },
  );
}

export default { fundEscrow, releaseMilestone, raiseDispute, resolveDispute };
