import { jest } from '@jest/globals';
import {
  enqueuePreferenceAwareNotification,
  isNotificationEnabled,
} from '../services/notificationPreferenceService.js';

describe('notification preference enforcement', () => {
  it('treats missing preferences as enabled for compatibility', () => {
    expect(isNotificationEnabled(undefined, 'escrow_expired')).toBe(true);
    expect(isNotificationEnabled({}, 'transaction_failed')).toBe(true);
  });

  it('does not enqueue a disabled expiry notification', async () => {
    const notify = jest.fn();
    const client = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          preferences: {
            notifications: {
              escrow_expired: { email: false },
            },
          },
        }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ email: 'user@example.com' }),
      },
    };

    const result = await enqueuePreferenceAwareNotification({
      eventKey: 'escrow_expired',
      addresses: ['GUSER'],
      payload: { escrowId: '42', status: 'Cancelled' },
      notify,
      client,
    });

    expect(result.queued).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { address: 'GUSER', reason: 'preference_disabled' },
    ]);
  });

  it('enqueues an enabled transaction failure notification', async () => {
    const notify = jest.fn().mockResolvedValue({
      queued: 1,
      accepted: [{ id: 'job-1' }],
      skipped: [],
    });
    const client = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          preferences: {
            notifications: {
              transaction_failed: { email: true },
            },
          },
        }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ email: 'user@example.com' }),
      },
    };

    const result = await enqueuePreferenceAwareNotification({
      eventKey: 'transaction_failed',
      addresses: ['GUSER'],
      payload: { escrowId: '42', status: 'Transaction Failed' },
      notify,
      client,
    });

    expect(result.queued).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [{ address: 'GUSER', email: 'user@example.com' }],
      }),
    );
  });
});
