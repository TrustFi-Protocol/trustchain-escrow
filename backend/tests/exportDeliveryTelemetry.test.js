/**
 * Tests for tenant audit export delivery telemetry (Issue #383)
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ADDRESS = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;

const logMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const exportServiceMock = {
  exportUserData: jest.fn(),
  generateExportFile: jest.fn(),
  logAdminExport: jest.fn(),
  queueLargeExport: jest.fn(),
  createExportJob: jest.fn(),
};

jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: () => logMock,
}));

jest.unstable_mockModule('../services/exportService.js', () => ({
  default: exportServiceMock,
}));

const { default: exportController, subjectRef } = await import(
  '../api/controllers/exportController.js'
);
const { exportDeliveriesTotal } = await import('../lib/metrics.js');

function createRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function deliveryCount(operation, outcome) {
  const { values } = await exportDeliveriesTotal.get();
  const match = values.find(
    (v) => v.labels.operation === operation && v.labels.outcome === outcome,
  );
  return match ? match.value : 0;
}

function lastLogPayload(level) {
  const calls = logMock[level].mock.calls;
  return calls[calls.length - 1][0];
}

describe('export delivery telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    exportServiceMock.exportUserData.mockResolvedValue({ data: { escrows: [] } });
    exportServiceMock.generateExportFile.mockReturnValue('{"data":{}}');
  });

  it('records a delivered export with correlated logs and no raw address', async () => {
    const before = await deliveryCount('export', 'delivered');
    const req = {
      params: { address: ADDRESS },
      user: { address: ADDRESS },
      tenant: { id: 'tenant_1' },
      correlationId: 'corr-123',
    };
    const res = createRes();

    await exportController.exportUserData(req, res);

    expect(res.statusCode).toBe(200);
    expect(await deliveryCount('export', 'delivered')).toBe(before + 1);
    const payload = lastLogPayload('info');
    expect(payload).toMatchObject({
      message: 'export.delivery',
      operation: 'export',
      outcome: 'delivered',
      correlationId: 'corr-123',
      tenantId: 'tenant_1',
      subjectRef: subjectRef(ADDRESS),
      actor: 'self',
    });
    expect(typeof payload.durationMs).toBe('number');
    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain(ADDRESS);
  });

  it('records queued large exports without logging the download URL', async () => {
    exportServiceMock.generateExportFile.mockReturnValue('x'.repeat(10 * 1024 * 1024 + 1));
    exportServiceMock.queueLargeExport.mockResolvedValue({
      jobId: 'email-1',
      downloadUrl: `/api/users/${ADDRESS}/export/file?token=secret-token`,
    });
    const before = await deliveryCount('download', 'queued');
    const res = createRes();

    await exportController.downloadExportFile(
      { params: { address: ADDRESS }, user: { address: ADDRESS } },
      res,
    );

    expect(res.statusCode).toBe(202);
    expect(await deliveryCount('download', 'queued')).toBe(before + 1);
    expect(lastLogPayload('info')).toMatchObject({ outcome: 'queued', jobId: 'email-1' });
    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain('secret-token');
  });

  it('records forbidden and invalid requests as warnings', async () => {
    const forbiddenBefore = await deliveryCount('job', 'forbidden');
    const invalidBefore = await deliveryCount('job', 'invalid');

    const forbidden = createRes();
    await exportController.createExportJob(
      { params: { address: OTHER }, user: { address: ADDRESS } },
      forbidden,
    );
    const invalid = createRes();
    await exportController.createExportJob(
      { params: { address: 'not-an-address' }, user: { address: ADDRESS } },
      invalid,
    );

    expect(forbidden.statusCode).toBe(403);
    expect(invalid.statusCode).toBe(400);
    expect(await deliveryCount('job', 'forbidden')).toBe(forbiddenBefore + 1);
    expect(await deliveryCount('job', 'invalid')).toBe(invalidBefore + 1);
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    expect(exportServiceMock.createExportJob).not.toHaveBeenCalled();
  });

  it('records failures with an error code but never the error message', async () => {
    const failure = Object.assign(new Error(`db exploded for ${ADDRESS} password=hunter2`), {
      code: 'P1001',
    });
    exportServiceMock.exportUserData.mockRejectedValue(failure);
    const before = await deliveryCount('export', 'failed');
    const res = createRes();

    await exportController.exportUserData(
      { params: { address: ADDRESS }, user: { address: ADDRESS }, id: 'req-9' },
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to export user data' });
    expect(await deliveryCount('export', 'failed')).toBe(before + 1);
    expect(lastLogPayload('error')).toMatchObject({
      outcome: 'failed',
      errorCode: 'P1001',
      correlationId: 'req-9',
    });
    const logged = JSON.stringify(logMock.error.mock.calls);
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain(ADDRESS);
  });

  it('keeps response behavior intact when the logger throws', async () => {
    logMock.info.mockImplementationOnce(() => {
      throw new Error('transport down');
    });
    const res = createRes();

    await exportController.exportUserData(
      { params: { address: ADDRESS }, user: { address: ADDRESS } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: { escrows: [] } });
  });
});
