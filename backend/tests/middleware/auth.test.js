/**
 * Auth Middleware — Integration Tests
 *
 * Exercises the real `authMiddleware` (backend/api/middleware/auth.js)
 * mounted on a real Express app and hit with real HTTP requests via
 * supertest, using the real `sessionService` (backed by the in-memory
 * Prisma mock wired up in jest.config.js). Covers the happy path plus
 * the rejection branches so a regression here fails CI instead of
 * slipping through (issue #113).
 *
 * @module tests/middleware/auth
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const { JWT_SECRET, JWT_ALGORITHM } = await import('../../config/secrets.js');
const { default: authMiddleware } = await import('../../api/middleware/auth.js');
const { createSession, revokeSession } = await import('../../services/sessionService.js');

function signToken(payload, options = {}) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: JWT_ALGORITHM, ...options });
}

function createApp() {
  const app = express();
  app.use((req, _res, next) => {
    // Simulates the admin-bypass middleware that may run before authMiddleware
    // in the real app; left off by default so most tests exercise the JWT path.
    next();
  });
  app.use(authMiddleware);
  app.get('/protected', (req, res) => res.json({ ok: true, user: req.user }));
  return app;
}

describe('authMiddleware (integration)', () => {
  it('rejects requests with no Authorization header', async () => {
    const app = createApp();

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('rejects an Authorization header that is not a Bearer token', async () => {
    const app = createApp();

    const res = await request(app).get('/protected').set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('rejects a token with an invalid signature', async () => {
    const app = createApp();
    const badToken = jwt.sign({ address: 'GTEST' }, 'wrong-secret', { algorithm: 'HS256' });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${badToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid token' });
  });

  it('rejects an expired token', async () => {
    const app = createApp();
    const expiredToken = signToken({ address: 'GTEST' }, { expiresIn: '-1h' });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Token expired' });
  });

  it('allows a valid token with no jti (happy path, session check skipped)', async () => {
    const app = createApp();
    const token = signToken({ address: 'GTEST123' });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, user: { address: 'GTEST123', jti: undefined } });
  });

  it('allows a valid token whose jti has an active session (happy path, session check passes)', async () => {
    const app = createApp();
    const jti = await createSession({ address: 'GTEST123' });
    const token = signToken({ address: 'GTEST123', jti });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, user: { address: 'GTEST123', jti } });
  });

  it('rejects a valid token whose session has been revoked', async () => {
    const app = createApp();
    const jti = await createSession({ address: 'GTEST123' });
    await revokeSession(jti);
    const token = signToken({ address: 'GTEST123', jti });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Session revoked or expired. Please log in again.' });
  });

  it('rejects a valid token whose jti has no matching session', async () => {
    const app = createApp();
    const token = signToken({ address: 'GTEST123', jti: 'never-created' });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Session revoked or expired. Please log in again.' });
  });

  it('bypasses JWT verification when req.isAdmin is set upstream', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.isAdmin = true;
      req.adminId = 'admin-42';
      next();
    });
    app.use(authMiddleware);
    app.get('/protected', (req, res) => res.json({ ok: true, user: req.user }));

    const res = await request(app).get('/protected');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, user: { address: 'admin-42' } });
  });
});
