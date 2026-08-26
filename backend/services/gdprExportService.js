/**
 * GDPR Export Service
 *
 * Handles data subject access requests (DSAR) and data portability
 * under GDPR and other privacy regulations.
 * Provides comprehensive export of all personal data associated with a user.
 */

import { createHash, randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { emailQueue } from '../queues/emailQueue.js';

function withTenant(where, tenantId) {
  return tenantId ? { ...where, tenantId } : where;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;
}

class GdprExportService {
  /**
   * Export all GDPR-related data for a user
   * @param {string} address - User's Stellar address
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Complete GDPR data export
   */
  async exportUserData(address, { tenantId } = {}) {
    const [
      escrows,
      payments,
      kyc,
      reputation,
      adminAuditLog,
      disputeMessages,
      userProfile,
    ] = await Promise.all([
      this.exportEscrowHistory(address, { tenantId }),
      this.exportPaymentHistory(address, { tenantId }),
      this.exportKycStatus(address, { tenantId }),
      this.exportReputation(address, { tenantId }),
      this.exportAdminAuditLog(address, { tenantId }),
      this.exportDisputeMessages(address),
      this.exportUserProfile(address, { tenantId }),
    ]);

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      userAddress: address,
      exportType: 'GDPR',
      data: {
        escrows,
        payments,
        kyc,
        reputation,
        adminAuditLog,
        disputeMessages,
        userProfile,
      },
    };
  }

  /**
   * Export escrow history
   */
  async exportEscrowHistory(address, { tenantId } = {}) {
    const escrows = await prisma.escrow.findMany({
      where: withTenant(
        {
          OR: [{ clientAddress: address }, { contractorAddress: address }],
        },
        tenantId,
      ),
      select: {
        id: true,
        clientAddress: true,
        contractorAddress: true,
        amount: true,
        status: true,
        createdAt: true,
        completedAt: true,
        description: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return escrows.map((e) => ({
      id: e.id,
      clientAddress: e.clientAddress,
      contractorAddress: e.contractorAddress,
      amount: e.amount.toString(),
      status: e.status,
      createdAt: toIso(e.createdAt),
      completedAt: toIso(e.completedAt),
      description: e.description,
    }));
  }

  /**
   * Export payment history
   */
  async exportPaymentHistory(address, { tenantId } = {}) {
    const payments = await prisma.payment.findMany({
      where: withTenant({ address }, tenantId),
      select: {
        id: true,
        address: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return payments.map((p) => ({
      id: p.id,
      address: p.address,
      amount: p.amount.toString(),
      currency: p.currency,
      status: p.status,
      createdAt: toIso(p.createdAt),
      updatedAt: toIso(p.updatedAt),
    }));
  }

  /**
   * Export KYC verification status
   */
  async exportKycStatus(address, { tenantId } = {}) {
    const kyc = await prisma.kycVerification.findFirst({
      where: withTenant({ userAddress: address }, tenantId),
      select: {
        status: true,
        verifiedAt: true,
        expiresAt: true,
        verificationLevel: true,
      },
    });

    return kyc
      ? {
          status: kyc.status,
          verifiedAt: toIso(kyc.verifiedAt),
          expiresAt: toIso(kyc.expiresAt),
          verificationLevel: kyc.verificationLevel,
        }
      : null;
  }

  /**
   * Export reputation records
   */
  async exportReputation(address, { tenantId } = {}) {
    const reputation = await prisma.reputationRecord.findFirst({
      where: withTenant({ userAddress: address }, tenantId),
      select: {
        score: true,
        totalEscrows: true,
        completedEscrows: true,
        disputesWon: true,
        disputesLost: true,
        lastUpdated: true,
      },
    });

    return reputation
      ? {
          score: reputation.score,
          totalEscrows: reputation.totalEscrows,
          completedEscrows: reputation.completedEscrows,
          disputesWon: reputation.disputesWon,
          disputesLost: reputation.disputesLost,
          lastUpdated: toIso(reputation.lastUpdated),
        }
      : null;
  }

  /**
   * Export admin audit log entries
   */
  async exportAdminAuditLog(address, { tenantId } = {}) {
    const logs = await prisma.adminAuditLog.findMany({
      where: withTenant({ targetAddress: address }, tenantId),
      select: {
        action: true,
        targetAddress: true,
        reason: true,
        performedAt: true,
      },
      orderBy: { performedAt: 'desc' },
    });

    // Sanitize sensitive admin info
    return logs.map((log) => ({
      action: log.action,
      targetAddress: log.targetAddress,
      timestamp: toIso(log.performedAt),
      outcome: log.reason,
    }));
  }

  /**
   * Export dispute messages
   */
  async exportDisputeMessages(address) {
    const chatRooms = await prisma.chatRoomKey.findMany({
      where: { roomId: { startsWith: 'dispute:' } },
    });

    const roomIds = chatRooms.map((r) => r.roomId);

    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [{ senderAddress: address }, { roomId: { in: roomIds } }],
      },
      select: {
        roomId: true,
        senderAddress: true,
        ciphertext: true,
        sentAt: true,
      },
      orderBy: { sentAt: 'desc' },
    });

    return messages.map((msg) => ({
      disputeId: msg.roomId.replace('dispute:', ''),
      senderAddress: msg.senderAddress,
      // Ciphertext is retained as-is; decryption key not provided in GDPR export
      sentAt: toIso(msg.sentAt),
    }));
  }

  /**
   * Export user profile data
   */
  async exportUserProfile(address, { tenantId } = {}) {
    const profile = await prisma.userProfile.findFirst({
      where: withTenant({ userAddress: address }, tenantId),
      select: {
        displayName: true,
        bio: true,
        avatar: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return profile
      ? {
          displayName: profile.displayName,
          bio: profile.bio,
          avatar: profile.avatar,
          createdAt: toIso(profile.createdAt),
          updatedAt: toIso(profile.updatedAt),
        }
      : null;
  }

  /**
   * Pseudonymize user data (for deletion with history retention)
   */
  async pseudonymizeUserData(address, { tenantId, performedBy } = {}) {
    const pseudonym = `anon_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`;

    const updated = await prisma.$transaction(async (tx) => {
      const [escrowsClient, escrowsContractor, payments, kyc, reputation, userProfile, user] =
        await Promise.all([
          tx.escrow.updateMany({
            where: withTenant({ clientAddress: address }, tenantId),
            data: { clientAddress: pseudonym },
          }),
          tx.escrow.updateMany({
            where: withTenant({ contractorAddress: address }, tenantId),
            data: { contractorAddress: pseudonym },
          }),
          tx.payment.updateMany({
            where: withTenant({ address }, tenantId),
            data: { address: pseudonym },
          }),
          tx.kycVerification.updateMany({
            where: withTenant({ userAddress: address }, tenantId),
            data: { userAddress: pseudonym },
          }),
          tx.reputationRecord.updateMany({
            where: withTenant({ userAddress: address }, tenantId),
            data: { userAddress: pseudonym },
          }),
          tx.userProfile.updateMany({
            where: withTenant({ userAddress: address }, tenantId),
            data: { userAddress: pseudonym },
          }),
          tx.user.updateMany({
            where: withTenant({ address }, tenantId),
            data: { address: pseudonym },
          }),
        ]);

      // Log pseudonymization
      await tx.adminAuditLog.create({
        data: {
          action: 'GDPR_DATA_PSEUDONYMIZE',
          targetAddress: pseudonym,
          reason: 'User data pseudonymized per GDPR deletion request',
          performedBy: performedBy || 'system',
          tenantId: tenantId || 'tenant_default',
        },
      });

      return {
        clientEscrows: escrowsClient.count,
        contractorEscrows: escrowsContractor.count,
        payments: payments.count,
        kyc: kyc.count,
        reputation: reputation.count,
        userProfile: userProfile.count,
        user: user.count,
      };
    });

    return {
      pseudonym,
      updated: {
        escrows: updated.clientEscrows + updated.contractorEscrows,
        payments: updated.payments,
        kyc: updated.kyc,
        reputation: updated.reputation,
        userProfile: updated.userProfile,
        user: updated.user,
      },
    };
  }

  /**
   * Request data export via email
   */
  async requestDataExportEmail(address, { tenantId } = {}) {
    const exportData = await this.exportUserData(address, { tenantId });
    const fileName = `gdpr-export-${address.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;

    await emailQueue.add('send-gdpr-export', {
      recipientAddress: address,
      fileName,
      dataSize: JSON.stringify(exportData).length,
      exportedAt: new Date().toISOString(),
    });

    return {
      success: true,
      message: 'Data export email queued',
      fileName,
    };
  }
}

export default new GdprExportService();
