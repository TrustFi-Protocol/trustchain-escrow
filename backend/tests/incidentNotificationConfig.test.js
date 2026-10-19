/**
 * Configuration validation for incident notification routing (Issue #380).
 *
 * Invalid or contradictory runtime settings must fail fast with actionable
 * messages that name the setting but never echo secret values.
 */

import { validateIncidentNotificationConfig } from '../services/incidentService.js';

const PD_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const expectInvalid = (env) => {
  try {
    validateIncidentNotificationConfig(env);
  } catch (err) {
    expect(err.code).toBe('INCIDENT_CONFIG_INVALID');
    return err;
  }
  throw new Error('expected validation to fail');
};

describe('validateIncidentNotificationConfig', () => {
  test('accepts empty config and returns defaults', () => {
    expect(validateIncidentNotificationConfig({})).toEqual({
      pagerDutyEnabled: false,
      slackEnabled: false,
      timeoutMs: 5000,
      onCallEntries: 0,
    });
  });

  test('accepts a fully valid config', () => {
    const config = validateIncidentNotificationConfig({
      PAGERDUTY_ROUTING_KEY: PD_KEY,
      SLACK_INCIDENT_WEBHOOK: 'https://hooks.slack.com/services/T/B/X',
      INCIDENT_ALERT_EMAIL: 'oncall@example.com',
      INCIDENT_NOTIFY_TIMEOUT_MS: '2500',
      RUNBOOK_BASE_URL: 'https://docs.example.com/runbooks',
      ONCALL_SCHEDULE: JSON.stringify([
        {
          name: 'Alice',
          email: 'alice@example.com',
          startUtc: '2026-01-01T00:00:00Z',
          endUtc: '2026-01-08T00:00:00Z',
        },
      ]),
    });
    expect(config).toEqual({
      pagerDutyEnabled: true,
      slackEnabled: true,
      timeoutMs: 2500,
      onCallEntries: 1,
    });
  });

  test('rejects malformed channel settings without leaking their values', () => {
    const err = expectInvalid({
      PAGERDUTY_ROUTING_KEY: 'bad key with spaces',
      SLACK_INCIDENT_WEBHOOK: 'http://insecure.example/SECRET-TOKEN',
      INCIDENT_ALERT_EMAIL: 'not-an-email',
    });
    expect(err.errors).toEqual([
      'PAGERDUTY_ROUTING_KEY must be a 20-64 character alphanumeric Events API v2 integration key, or unset to disable PagerDuty',
      'SLACK_INCIDENT_WEBHOOK must be an https:// URL, or unset to disable Slack',
      'INCIDENT_ALERT_EMAIL must be a valid email address, or unset',
    ]);
    expect(err.message).not.toContain('SECRET-TOKEN');
    expect(err.message).not.toContain('bad key');
  });

  test.each(['0', '99', '60001', '1.5', 'abc'])('rejects out-of-range timeout %s', (value) => {
    const err = expectInvalid({ INCIDENT_NOTIFY_TIMEOUT_MS: value });
    expect(err.errors).toEqual([
      'INCIDENT_NOTIFY_TIMEOUT_MS must be an integer between 100 and 60000',
    ]);
  });

  test('rejects unparsable and contradictory on-call schedules', () => {
    expect(expectInvalid({ ONCALL_SCHEDULE: '{not json' }).errors).toEqual([
      'ONCALL_SCHEDULE must be valid JSON',
    ]);
    expect(expectInvalid({ ONCALL_SCHEDULE: '{}' }).errors).toEqual([
      'ONCALL_SCHEDULE must be a JSON array of { name, email, startUtc, endUtc }',
    ]);

    const err = expectInvalid({
      ONCALL_SCHEDULE: JSON.stringify([
        { name: 'Bob', email: 'bob@example.com', startUtc: '2026-01-08T00:00:00Z', endUtc: '2026-01-01T00:00:00Z' },
        { name: '', email: 'nope', startUtc: 'soon', endUtc: 'later' },
      ]),
    });
    expect(err.errors).toEqual([
      'ONCALL_SCHEDULE[0] endUtc must be after startUtc',
      'ONCALL_SCHEDULE[1] requires a name and a valid email',
      'ONCALL_SCHEDULE[1] startUtc and endUtc must be ISO-8601 timestamps',
    ]);
    expect(err.message).toMatch(/^Invalid incident notification configuration:\n - /);
  });
});
