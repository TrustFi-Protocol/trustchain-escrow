/**
 * Dead-Letter Replay Tests
 *
 * Covers:
 *   - Permission denial for non-admin callers
 *   - Preview of dead-lettered jobs
 *   - Replay success with audit logging
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ADMIN_API_KEY = 'test-admin-key';
process.env.ADMIN_API_KEY = ADMIN_API_KEY;

const prismaMock = { adminAuditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) } };

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

const { default: adminAuth } = await import('../api/middleware/adminAuth.js');
const { default: deadLetterController } = await import('../api/controllers/deadLetterController.js');
const { registerDeadLetterQueue } = await import('../services/deadLetterService.js');

const makeJob = (id) => ({
  id,
  name: 'webhook',
  data: { deliveryId: id },
  failedReason: 'timeout',
  attemptsMade: 5,
  finishedOn: Date.now(),
  retry: jest.fn().mockResolvedValue(undefined),
});

const app = express();
app.use(express.json());
app.use(adminAuth);
app.get('/dead-letters/:queue', deadLetterController.preview);
app.post('/dead-letters/:queue/replay', deadLetterController.replay);

describe('admin dead-letter replay', () => {
  let jobs;

  beforeEach(() => {
    jest.clearAllMocks();
    jobs = [makeJob('1'), makeJob('2')];
    registerDeadLetterQueue('webhook', async () => ({ getFailed: jest.fn().mockResolvedValue(jobs) }));
  });

  it('denies access without admin credentials', async () => {
    const res = await request(app).post('/dead-letters/webhook/replay').send({});
    expect(res.status).toBe(401);
    expect(jobs[0].retry).not.toHaveBeenCalled();
    expect(prismaMock.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('denies access with an invalid admin key', async () => {
    const res = await request(app).get('/dead-letters/webhook').set('x-admin-api-key', 'wrong');
    expect(res.status).toBe(403);
  });

  it('previews dead-lettered jobs without replaying them', async () => {
    const res = await request(app).get('/dead-letters/webhook').set('x-admin-api-key', ADMIN_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.map((j) => j.id)).toEqual(['1', '2']);
    expect(res.body.data[0]).toMatchObject({ failedReason: 'timeout', attemptsMade: 5 });
    expect(jobs[0].retry).not.toHaveBeenCalled();
  });

  it('replays selected jobs and records an audit log', async () => {
    const res = await request(app)
      .post('/dead-letters/webhook/replay')
      .set('x-admin-api-key', ADMIN_API_KEY)
      .send({ jobIds: ['2'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ queue: 'webhook', replayed: ['2'], errors: [] });
    expect(jobs[0].retry).not.toHaveBeenCalled();
    expect(jobs[1].retry).toHaveBeenCalledTimes(1);
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DEAD_LETTER_REPLAY', targetAddress: 'queue:webhook', performedBy: 'admin' }),
    });
  });

  it('rejects unknown queues', async () => {
    const res = await request(app).get('/dead-letters/nope').set('x-admin-api-key', ADMIN_API_KEY);
    expect(res.status).toBe(400);
  });
});
