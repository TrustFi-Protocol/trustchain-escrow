import { jest } from '@jest/globals';

const prismaMock = {
  webhookSubscription: {
    findMany: jest.fn(),
  },
  webhookDelivery: {
    create: jest.fn(),
    update: jest.fn(),
  },
};

const queueMock = {
  enqueueWebhookDelivery: jest.fn(),
};

describe('webhook replay guard', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    jest.unstable_mockModule('../lib/prisma.js', () => ({
      default: prismaMock,
    }));

    jest.unstable_mockModule('../queues/webhookQueue.js', () => ({
      enqueueWebhookDelivery: queueMock.enqueueWebhookDelivery,
    }));
  });

  it('enforces the same event key once per subscription during replay', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      {
        id: 'sub_1',
        url: 'https://example.com/webhook',
        secret: 'secret123',
      },
    ]);

    prismaMock.webhookDelivery.create
      .mockResolvedValueOnce({ id: 'delivery_1' })
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        }),
      );

    prismaMock.webhookDelivery.update.mockResolvedValue({});
    queueMock.enqueueWebhookDelivery.mockResolvedValue({});

    const { default: webhookService } =
      await import('../services/webhookService.js');

    const payload = {
      eventKey: 'CONTRACT:TX_HASH:0',
      contractId: 'CONTRACT',
      txHash: 'TX_HASH',
      eventIndex: 0,
    };

    const first = await webhookService.queueEventWebhooks('esc_crt', payload);
    const replay = await webhookService.queueEventWebhooks('esc_crt', payload);

    expect(first.queued).toBe(1);
    expect(replay.queued).toBe(0);
    expect(queueMock.enqueueWebhookDelivery).toHaveBeenCalledTimes(1);

    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventKey: 'CONTRACT:TX_HASH:0',
        }),
      }),
    );
  });
});
