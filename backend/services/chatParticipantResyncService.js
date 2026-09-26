/**
 * Chat Room Participant Resync Service
 *
 * Synchronizes chat room participants (ChatRoomKey entries) from escrow participants
 * whenever ownership, dispute, or role changes occur.
 *
 * Policies:
 * - Adds missing authorized participants (client, freelancer, arbiter).
 * - Removes unauthorized participants when ownership or roles change (if policy requires).
 * - Notifies/disconnects connected Socket.IO sockets if unauthorized.
 *
 * @module services/chatParticipantResyncService
 */

import prisma from '../lib/prisma.js';
import { createModuleLogger } from '../config/logger.js';

const log = createModuleLogger('chatParticipantResync');

/**
 * Extracts authorized dispute/chat participant addresses from an escrow record.
 *
 * @param {object} escrow
 * @returns {string[]} Normalized list of unique authorized addresses
 */
export function getAuthorizedEscrowParticipants(escrow) {
  if (!escrow) return [];
  const candidates = [
    escrow.clientAddress,
    escrow.freelancerAddress,
    escrow.arbiterAddress,
  ];

  const unique = new Set();
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim()) {
      unique.add(c.trim());
    }
  }
  return [...unique];
}

/**
 * Evicts unauthorized sockets from the dispute room namespace if Socket.IO is provided.
 *
 * @param {object} io - Socket.IO server or namespace instance
 * @param {string|number|bigint} escrowId
 * @param {string[]} unauthorizedAddresses
 */
export function evictUnauthorizedSockets(io, escrowId, unauthorizedAddresses) {
  if (!io || !unauthorizedAddresses || unauthorizedAddresses.length === 0) return;

  const nspName = `/dispute/${escrowId}`;
  const nsp = io.of ? io.of(nspName) : io;
  if (!nsp || !nsp.sockets) return;

  const unauthorizedSet = new Set(unauthorizedAddresses);

  for (const [, socket] of nsp.sockets) {
    const address = socket.handshake?.auth?.address || socket.user?.address;
    if (address && unauthorizedSet.has(address)) {
      log.info({
        message: 'evicting_unauthorized_chat_socket',
        escrowId: escrowId.toString(),
        address,
        socketId: socket.id,
      });
      socket.emit('participant:removed', {
        reason: 'Role or ownership changed. You are no longer an authorized participant.',
      });
      socket.disconnect(true);
    }
  }
}

/**
 * Resyncs chat room participants from the current escrow state.
 *
 * @param {string|number|bigint} escrowId
 * @param {object} [options]
 * @param {string} [options.tenantId]
 * @param {boolean} [options.removeUnauthorized=true] - Whether to delete keys of removed participants
 * @param {string} [options.defaultEncryptedKey='PENDING_KEY_EXCHANGE']
 * @param {object} [options.io] - Optional Socket.IO server instance to evict connected sockets
 * @param {object} [options.tx] - Optional Prisma transaction client
 * @returns {Promise<{
 *   escrowId: string,
 *   roomId: string,
 *   authorized: string[],
 *   added: string[],
 *   removed: string[],
 *   totalParticipants: number
 * }>}
 */
export async function resyncChatParticipants(escrowId, options = {}) {
  const {
    tenantId,
    removeUnauthorized = true,
    defaultEncryptedKey = 'PENDING_KEY_EXCHANGE',
    io = null,
    tx = null,
  } = options;

  const db = tx || prisma;
  const id = BigInt(escrowId);

  // Load escrow record
  const escrowWhere = { id };
  if (tenantId) {
    escrowWhere.tenantId = tenantId;
  }

  const escrow = await db.escrow.findFirst({
    where: escrowWhere,
    select: {
      id: true,
      clientAddress: true,
      freelancerAddress: true,
      arbiterAddress: true,
      status: true,
      tenantId: true,
    },
  });

  if (!escrow) {
    const err = new Error('Escrow not found');
    err.statusCode = 404;
    throw err;
  }

  const authorized = getAuthorizedEscrowParticipants(escrow);
  const roomId = `dispute:${escrow.id.toString()}`;

  // Fetch current participants in chat_room_keys
  const existingKeys = await db.chatRoomKey.findMany({
    where: {
      roomId,
      tenantId: escrow.tenantId,
    },
  });

  const existingAddressMap = new Map(existingKeys.map((k) => [k.address, k]));

  // Identify missing and unauthorized
  const missing = authorized.filter((addr) => !existingAddressMap.has(addr));
  const unauthorized = existingKeys.filter((k) => !authorized.includes(k.address));

  const added = [];
  const removed = [];

  // Add missing participants
  for (const address of missing) {
    await db.chatRoomKey.create({
      data: {
        roomId,
        address,
        encryptedKey: defaultEncryptedKey,
        tenantId: escrow.tenantId,
      },
    });
    added.push(address);
  }

  // Remove unauthorized participants if policy requires
  if (removeUnauthorized && unauthorized.length > 0) {
    const unauthorizedAddresses = unauthorized.map((u) => u.address);
    await db.chatRoomKey.deleteMany({
      where: {
        roomId,
        address: { in: unauthorizedAddresses },
        tenantId: escrow.tenantId,
      },
    });
    removed.push(...unauthorizedAddresses);

    // Evict any active socket connections for removed users
    if (io) {
      evictUnauthorizedSockets(io, escrow.id.toString(), unauthorizedAddresses);
    }
  }

  log.info({
    message: 'chat_participants_resynced',
    escrowId: escrow.id.toString(),
    roomId,
    addedCount: added.length,
    removedCount: removed.length,
    authorizedCount: authorized.length,
  });

  return {
    escrowId: escrow.id.toString(),
    roomId,
    authorized,
    added,
    removed,
    totalParticipants: authorized.length,
  };
}

/**
 * Convenience helper to resync participants after a role or ownership change.
 *
 * @param {string|number|bigint} escrowId
 * @param {object} roleChange - Description of role changes (e.g. { oldArbiter, newArbiter })
 * @param {object} [options]
 */
export async function syncOnRoleChange(escrowId, roleChange = {}, options = {}) {
  log.info({
    message: 'role_change_resync_triggered',
    escrowId: escrowId.toString(),
    roleChange,
  });
  return resyncChatParticipants(escrowId, options);
}

export default {
  getAuthorizedEscrowParticipants,
  resyncChatParticipants,
  syncOnRoleChange,
  evictUnauthorizedSockets,
};
