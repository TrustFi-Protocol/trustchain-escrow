'use strict';

const mockSendAlert = jest.fn();

jest.mock('../services/emailService', () => ({
  sendAlert: (...args) => mockSendAlert(...args),
}));

const alertService = require('../services/alertService');

describe('alertService.emailAlert', () => {
  const originalRecipients = process.env.ALERT_EMAIL_RECIPIENTS;

  beforeEach(() => {
    mockSendAlert.mockReset();
    delete process.env.ALERT_EMAIL_RECIPIENTS;
  });

  afterAll(() => {
    if (originalRecipients === undefined) {
      delete process.env.ALERT_EMAIL_RECIPIENTS;
    } else {
      process.env.ALERT_EMAIL_RECIPIENTS = originalRecipients;
    }
  });

  it('sends one message whose subject contains the alert severity and type', async () => {
    process.env.ALERT_EMAIL_RECIPIENTS = 'ops@example.com,oncall@example.com';
    mockSendAlert.mockResolvedValue({ ok: true });

    const alert = {
      severity: 'critical',
      type: 'contract_pause',
      message: 'Contract paused unexpectedly',
    };

    await alertService.emailAlert(alert);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    const payload = mockSendAlert.mock.calls[0][0];
    expect(payload.subject).toContain('critical');
    expect(payload.subject).toContain('contract_pause');
    expect(payload.to).toEqual(['ops@example.com', 'oncall@example.com']);
  });

  it('does not call the sender when the recipient list is empty', async () => {
    process.env.ALERT_EMAIL_RECIPIENTS = '';

    await expect(
      alertService.emailAlert({ severity: 'warning', type: 'low_balance', message: 'Low balance' })
    ).resolves.not.toThrow();

    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('rejects when the sender fails', async () => {
    process.env.ALERT_EMAIL_RECIPIENTS = 'ops@example.com';
    mockSendAlert.mockRejectedValue(new Error('provider down'));

    await expect(
      alertService.emailAlert({ severity: 'critical', type: 'contract_pause', message: 'Paused' })
    ).rejects.toThrow('provider down');
  });
});
