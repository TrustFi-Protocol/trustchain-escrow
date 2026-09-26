import { jest } from '@jest/globals';

const prismaMock = {
  escrow: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  chatRoomKey: {
    findMany: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
  },
};

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

const {
  getAuthorizedEscrowParticipants,
  resyncChatParticipants,
  syncOnRoleChange,
  evictUnauthorizedSockets,
} = await import('../services/chatParticipantResyncService.js');

describe('Chat Room Participant Resync Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAuthorizedEscrowParticipants', () => {
    it('extracts client, freelancer, and arbiter addresses', () => {
      const escrow = {
        clientAddress: 'G_CLIENT',
        freelancerAddress: 'G_FREELANCER',
        arbiterAddress: 'G_ARBITER',
      };
      const participants = getAuthorizedEscrowParticipants(escrow);
      expect(participants).toEqual(['G_CLIENT', 'G_FREELANCER', 'G_ARBITER']);
    });

    it('filters out null, undefined, or empty arbiter addresses', () => {
      const escrow = {
        clientAddress: 'G_CLIENT',
        freelancerAddress: 'G_FREELANCER',
        arbiterAddress: null,
      };
      const participants = getAuthorizedEscrowParticipants(escrow);
      expect(participants).toEqual(['G_CLIENT', 'G_FREELANCER']);
    });

    it('deduplicates addresses if any overlap', () => {
      const escrow = {
        clientAddress: 'G_SAME',
        freelancerAddress: 'G_FREELANCER',
        arbiterAddress: 'G_SAME',
      };
      const participants = getAuthorizedEscrowParticipants(escrow);
      expect(participants).toEqual(['G_SAME', 'G_FREELANCER']);
    });
  });

  describe('resyncChatParticipants', () => {
    const mockEscrow = {
      id: 42n,
      clientAddress: 'G_CLIENT',
      freelancerAddress: 'G_FREELANCER',
      arbiterAddress: 'G_ARBITER',
      status: 'Disputed',
      tenantId: 'tenant-1',
    };

    it('adds missing participants to the chat room', async () => {
      prismaMock.escrow.findFirst.mockResolvedValue(mockEscrow);
      // Currently only client has room key
      prismaMock.chatRoomKey.findMany.mockResolvedValue([
        { id: 'k1', roomId: 'dispute:42', address: 'G_CLIENT', tenantId: 'tenant-1' },
      ]);
      prismaMock.chatRoomKey.create.mockImplementation(async ({ data }) => ({
        id: `k_${data.address}`,
        ...data,
      }));

      const result = await resyncChatParticipants(42);

      expect(result.authorized).toEqual(['G_CLIENT', 'G_FREELANCER', 'G_ARBITER']);
      expect(result.added).toEqual(['G_FREELANCER', 'G_ARBITER']);
      expect(result.removed).toEqual([]);

      expect(prismaMock.chatRoomKey.create).toHaveBeenCalledTimes(2);
      expect(prismaMock.chatRoomKey.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          roomId: 'dispute:42',
          address: 'G_FREELANCER',
          tenantId: 'tenant-1',
        }),
      });
      expect(prismaMock.chatRoomKey.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          roomId: 'dispute:42',
          address: 'G_ARBITER',
          tenantId: 'tenant-1',
        }),
      });
    });

    it('removes unauthorized participants when policy requires', async () => {
      prismaMock.escrow.findFirst.mockResolvedValue(mockEscrow);
      // Existing keys include an unauthorized third party
      prismaMock.chatRoomKey.findMany.mockResolvedValue([
        { id: 'k1', roomId: 'dispute:42', address: 'G_CLIENT', tenantId: 'tenant-1' },
        { id: 'k2', roomId: 'dispute:42', address: 'G_FREELANCER', tenantId: 'tenant-1' },
        { id: 'k3', roomId: 'dispute:42', address: 'G_ARBITER', tenantId: 'tenant-1' },
        { id: 'k4', roomId: 'dispute:42', address: 'G_UNAUTHORIZED_STRANGER', tenantId: 'tenant-1' },
      ]);
      prismaMock.chatRoomKey.deleteMany.mockResolvedValue({ count: 1 });

      const result = await resyncChatParticipants(42, { removeUnauthorized: true });

      expect(result.removed).toEqual(['G_UNAUTHORIZED_STRANGER']);
      expect(result.added).toEqual([]);
      expect(prismaMock.chatRoomKey.deleteMany).toHaveBeenCalledWith({
        where: {
          roomId: 'dispute:42',
          address: { in: ['G_UNAUTHORIZED_STRANGER'] },
          tenantId: 'tenant-1',
        },
      });
    });

    it('preserves unauthorized participants if policy specifies removeUnauthorized: false', async () => {
      prismaMock.escrow.findFirst.mockResolvedValue(mockEscrow);
      prismaMock.chatRoomKey.findMany.mockResolvedValue([
        { id: 'k1', roomId: 'dispute:42', address: 'G_CLIENT', tenantId: 'tenant-1' },
        { id: 'k2', roomId: 'dispute:42', address: 'G_FREELANCER', tenantId: 'tenant-1' },
        { id: 'k3', roomId: 'dispute:42', address: 'G_ARBITER', tenantId: 'tenant-1' },
        { id: 'k4', roomId: 'dispute:42', address: 'G_OLD_PARTICIPANT', tenantId: 'tenant-1' },
      ]);

      const result = await resyncChatParticipants(42, { removeUnauthorized: false });

      expect(result.removed).toEqual([]);
      expect(prismaMock.chatRoomKey.deleteMany).not.toHaveBeenCalled();
    });

    it('throws 404 when escrow does not exist', async () => {
      prismaMock.escrow.findFirst.mockResolvedValue(null);

      await expect(resyncChatParticipants(9999)).rejects.toMatchObject({
        message: 'Escrow not found',
        statusCode: 404,
      });
    });
  });

  describe('Role and ownership change tests', () => {
    it('handles arbiter reassignment role change: removes old arbiter and adds new arbiter', async () => {
      const escrowAfterArbiterChange = {
        id: 77n,
        clientAddress: 'G_CLIENT',
        freelancerAddress: 'G_FREELANCER',
        arbiterAddress: 'G_NEW_ARBITER',
        status: 'Disputed',
        tenantId: 'tenant-1',
      };

      prismaMock.escrow.findFirst.mockResolvedValue(escrowAfterArbiterChange);
      // Existing room had client, freelancer, and the OLD arbiter
      prismaMock.chatRoomKey.findMany.mockResolvedValue([
        { id: 'k1', roomId: 'dispute:77', address: 'G_CLIENT', tenantId: 'tenant-1' },
        { id: 'k2', roomId: 'dispute:77', address: 'G_FREELANCER', tenantId: 'tenant-1' },
        { id: 'k3', roomId: 'dispute:77', address: 'G_OLD_ARBITER', tenantId: 'tenant-1' },
      ]);
      prismaMock.chatRoomKey.create.mockResolvedValue({});
      prismaMock.chatRoomKey.deleteMany.mockResolvedValue({ count: 1 });

      const result = await syncOnRoleChange(77, {
        type: 'ARBITER_REASSIGNED',
        oldArbiter: 'G_OLD_ARBITER',
        newArbiter: 'G_NEW_ARBITER',
      });

      expect(result.added).toEqual(['G_NEW_ARBITER']);
      expect(result.removed).toEqual(['G_OLD_ARBITER']);
      expect(result.authorized).toEqual(['G_CLIENT', 'G_FREELANCER', 'G_NEW_ARBITER']);

      expect(prismaMock.chatRoomKey.deleteMany).toHaveBeenCalledWith({
        where: {
          roomId: 'dispute:77',
          address: { in: ['G_OLD_ARBITER'] },
          tenantId: 'tenant-1',
        },
      });
      expect(prismaMock.chatRoomKey.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          roomId: 'dispute:77',
          address: 'G_NEW_ARBITER',
        }),
      });
    });

    it('handles client ownership transfer: replaces old client with new client', async () => {
      const escrowAfterClientTransfer = {
        id: 88n,
        clientAddress: 'G_NEW_CLIENT',
        freelancerAddress: 'G_FREELANCER',
        arbiterAddress: 'G_ARBITER',
        status: 'Active',
        tenantId: 'tenant-1',
      };

      prismaMock.escrow.findFirst.mockResolvedValue(escrowAfterClientTransfer);
      // Old client still has room key
      prismaMock.chatRoomKey.findMany.mockResolvedValue([
        { id: 'k1', roomId: 'dispute:88', address: 'G_OLD_CLIENT', tenantId: 'tenant-1' },
        { id: 'k2', roomId: 'dispute:88', address: 'G_FREELANCER', tenantId: 'tenant-1' },
        { id: 'k3', roomId: 'dispute:88', address: 'G_ARBITER', tenantId: 'tenant-1' },
      ]);
      prismaMock.chatRoomKey.create.mockResolvedValue({});
      prismaMock.chatRoomKey.deleteMany.mockResolvedValue({ count: 1 });

      const result = await resyncChatParticipants(88);

      expect(result.added).toEqual(['G_NEW_CLIENT']);
      expect(result.removed).toEqual(['G_OLD_CLIENT']);
      expect(result.authorized).toEqual(['G_NEW_CLIENT', 'G_FREELANCER', 'G_ARBITER']);
    });
  });

  describe('evictUnauthorizedSockets', () => {
    it('notifies and disconnects sockets whose address became unauthorized', () => {
      const mockSocket1 = {
        id: 'sock-1',
        handshake: { auth: { address: 'G_UNAUTHORIZED' } },
        emit: jest.fn(),
        disconnect: jest.fn(),
      };
      const mockSocket2 = {
        id: 'sock-2',
        handshake: { auth: { address: 'G_AUTHORIZED' } },
        emit: jest.fn(),
        disconnect: jest.fn(),
      };

      const socketsMap = new Map([
        ['sock-1', mockSocket1],
        ['sock-2', mockSocket2],
      ]);

      const mockIo = {
        of: jest.fn(() => ({
          sockets: socketsMap,
        })),
      };

      evictUnauthorizedSockets(mockIo, 42, ['G_UNAUTHORIZED']);

      expect(mockIo.of).toHaveBeenCalledWith('/dispute/42');
      expect(mockSocket1.emit).toHaveBeenCalledWith('participant:removed', expect.any(Object));
      expect(mockSocket1.disconnect).toHaveBeenCalledWith(true);

      expect(mockSocket2.emit).not.toHaveBeenCalled();
      expect(mockSocket2.disconnect).not.toHaveBeenCalled();
    });
  });
});
