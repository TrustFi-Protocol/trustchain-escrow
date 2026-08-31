/**
 * Auth Middleware Integration Tests (Issue #113)
 *
 * End-to-end coverage for backend/api/middleware/auth.js, mounted on a real
 * Express app and exercised via supertest instead of calling the middleware
 * function directly. Covers the happy path (valid bearer token + valid
 * session reaches the protected handler with req.user populated) plus the
 * documented failure branches, so a regression in the full request flow
 * (header parsing -> jwt.verify -> session-store check -> req.user
 * attachment) is caught by CI.
 *
 * @module tests/middleware/auth.integration
 */

import { jest } from '@jest/globals';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-auth-integration-secret';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.MFA_JWT_SECRET = process.env.MFA_JWT_SECRET || 'test-mfa-secret';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-secret';

const sessionServiceMock = {
  isSessionValid: jest.fn(),
};

jest.unstable_mockModule('../../services/sessionService.js', () => ({
  default: sessionServiceMock,
}));

const { default: authMiddleware } = await import('../../api/middleware/auth.js');
const { JWT_SECRET, JWT_ALGORITHM } = await import('../../config/secrets.js');

const ADDRESS = `G${'A'.repeat(55)}`;

function signToken(payload, options = {}) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: JWT_ALGORITHM, ...options });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/protected', authMiddleware, (req, res) => {
    res.status(200).json({ ok: true, user: req.user });
  });
  return app;
}

describe('authMiddleware integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('happy path: valid bearer token with a valid session reaches the handler with req.user attached', async () => {
    sessionServiceMock.isSessionValid.mockResolvedValue(true);
    const token = signToken({ address: ADDRESS, jti: 'session-123' });

    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({ ok: true, user: { address: ADDRESS, jti: 'session-123' } });
    expect(sessionServiceMock.isSessionValid).toHaveBeenCalledWith('session-123');
  });

  it('happy path: a token without a jti skips the session-store check entirely', async () => {
    const token = signToken({ address: ADDRESS });

    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.user).toEqual({ address: ADDRESS, jti: undefined });
    expect(sessionServiceMock.isSessionValid).not.toHaveBeenCalled();
  });

  it('rejects requests with no Authorization header', async () => {
    const res = await request(createApp()).get('/protected').expect(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(sessionServiceMock.isSessionValid).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('rejects a malformed/invalid token', async () => {
    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
    expect(res.body).toEqual({ error: 'Invalid token' });
  });

  it('rejects an expired token', async () => {
    const token = signToken({ address: ADDRESS }, { expiresIn: -10 });

    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body).toEqual({ error: 'Token expired' });
  });

  it('rejects a token whose session has been revoked or expired in the session store', async () => {
    sessionServiceMock.isSessionValid.mockResolvedValue(false);
    const token = signToken({ address: ADDRESS, jti: 'revoked-session' });

    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body).toEqual({ error: 'Session revoked or expired. Please log in again.' });
  });

  it('bypasses bearer-token validation entirely for admin-authenticated requests', async () => {
    const app = express();
    app.use(express.json());
    app.get(
      '/admin-protected',
      (req, _res, next) => {
        req.isAdmin = true;
        req.adminId = 'admin-42';
        next();
      },
      authMiddleware,
      (req, res) => res.status(200).json({ ok: true, user: req.user }),
    );

    const res = await request(app).get('/admin-protected').expect(200);
    expect(res.body).toEqual({ ok: true, user: { address: 'admin-42' } });
    expect(sessionServiceMock.isSessionValid).not.toHaveBeenCalled();
  });
});
