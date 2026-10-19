/**
 * Incident notification routing telemetry (#376).
 */

import { jest } from '@jest/globals';

const incidentServiceMock = {
  createIncident: jest.fn(),
  updateIncidentStatus: jest.fn(),
  linkEscrowsToIncident: jest.fn(),
};
const counter = { inc: jest.fn() };
const histogram = { observe: jest.fn() };
const mockLog = { info: jest.fn(), warn: jest.fn() };

jest.unstable_mockModule('../services/incidentService.js', () => ({
  default: incidentServiceMock,
  Severity: { SEV1: 'SEV1', SEV2: 'SEV2', SEV3: 'SEV3', SEV4: 'SEV4' },
}));
jest.unstable_mockModule('../lib/metrics.js', () => ({
  incidentNotificationRoutingTotal: counter,
  incidentNotificationRoutingDuration: histogram,
}));
jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: () => mockLog,
  getCorrelationId: () => 'corr-123',
}));

const { default: incidentController } = await import('../api/controllers/incidentController.js');

function createMockRes() {
  return {
    statusCode: 200,
    status: jest.fn().mockImplementation(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn().mockReturnThis(),
  };
}

const SECRET_VALUES = ['pd-routing-key', 'https://hooks.slack.com/secret', 'admin-api-key-123'];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PAGERDUTY_ROUTING_KEY = SECRET_VALUES[0];
  process.env.SLACK_INCIDENT_WEBHOOK = SECRET_VALUES[1];
});

function expectNoSecretsLogged() {
  const logged = JSON.stringify([...mockLog.info.mock.calls, ...mockLog.warn.mock.calls]);
  for (const secret of SECRET_VALUES) expect(logged).not.toContain(secret);
}

test('records success metrics and a correlated log when an incident is created', async () => {
  incidentServiceMock.createIncident.mockResolvedValue({ id: 'INC-1', severity: 'SEV2' });
  const res = createMockRes();

  await incidentController.createIncident(
    {
      body: { title: 't', description: 'd', severity: 'SEV2' },
      headers: { 'x-admin-api-key': SECRET_VALUES[2] },
    },
    res,
  );

  expect(res.status).toHaveBeenCalledWith(201);
  expect(counter.inc).toHaveBeenCalledWith({
    operation: 'create',
    severity: 'SEV2',
    outcome: 'success',
  });
  expect(histogram.observe).toHaveBeenCalledWith(
    { operation: 'create', outcome: 'success' },
    expect.any(Number),
  );
  expect(mockLog.info).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'incident.notification_routing',
      incidentId: 'INC-1',
      correlationId: 'corr-123',
    }),
  );
  expectNoSecretsLogged();
});

test('collapses unknown severities into a bounded label on rejected requests', async () => {
  const res = createMockRes();

  await incidentController.createIncident(
    { body: { severity: 'https://hooks.slack.com/secret' }, headers: {} },
    res,
  );

  expect(res.status).toHaveBeenCalledWith(400);
  expect(counter.inc).toHaveBeenCalledWith({
    operation: 'create',
    severity: 'unknown',
    outcome: 'rejected',
  });
  expect(incidentServiceMock.createIncident).not.toHaveBeenCalled();
  expectNoSecretsLogged();
});

test('records routing errors at warn level without echoing the error message', async () => {
  incidentServiceMock.updateIncidentStatus.mockRejectedValue(
    new Error(`PagerDuty failed for ${SECRET_VALUES[0]}`),
  );
  const res = createMockRes();

  await incidentController.updateStatus(
    { params: { id: 'INC-9' }, body: { status: 'resolved' }, headers: {} },
    res,
  );

  expect(res.status).toHaveBeenCalledWith(500);
  expect(counter.inc).toHaveBeenCalledWith({
    operation: 'update_status',
    severity: 'unknown',
    outcome: 'error',
  });
  expect(mockLog.warn).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'error', statusCode: 500, incidentId: undefined }),
  );
  expectNoSecretsLogged();
});

test('telemetry failures never break notification routing', async () => {
  counter.inc.mockImplementationOnce(() => {
    throw new Error('registry unavailable');
  });
  incidentServiceMock.linkEscrowsToIncident.mockResolvedValue({ id: 'INC-2', severity: 'SEV1' });
  const res = createMockRes();

  await expect(
    incidentController.linkEscrows(
      { params: { id: 'INC-2' }, body: { escrowIds: ['1'] }, headers: {} },
      res,
    ),
  ).resolves.toBeUndefined();

  expect(res.json).toHaveBeenCalledWith({ id: 'INC-2', severity: 'SEV1' });
});
