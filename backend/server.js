import { initTracing } from './lib/tracing.js';
// Tracing and Sentry must be initialised before other imports so instrumentation patches apply.
initTracing();
import './lib/sentry.js';
import * as Sentry from '@sentry/node';

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { initSecrets } from './lib/secrets.js';
import http from 'http';
import compressionMiddleware from './middleware/compression.js';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { requestLogger } from './lib/logger.js';

import cookieParser from 'cookie-parser';
import {
  sanitizeInputs,
  csrfProtection,
  generateCsrfToken,
  REQUEST_SIZE_LIMIT,
} from './middleware/validation.js';

import docsRouter from './docs/index.js';
import disputeRoutes from './api/routes/disputeRoutes.js';
import searchRoutes from './api/routes/searchRoutes.js';
import escrowRoutes from './api/routes/escrowRoutes.js';
import eventRoutes from './api/routes/eventRoutes.js';
import kycRoutes from './api/routes/kycRoutes.js';
import adminRoutes from './api/routes/adminRoutes.js';
import notificationRoutes from './api/routes/notificationRoutes.js';
import paymentRoutes from './api/routes/paymentRoutes.js';
import relayerRoutes from './api/routes/relayerRoutes.js';
import reputationRoutes from './api/routes/reputationRoutes.js';
import userRoutes from './api/routes/userRoutes.js';
import auditRoutes from './api/routes/auditRoutes.js';
import authRoutes from './api/routes/authRoutes.js';
import complianceRoutes from './api/routes/complianceRoutes.js';
import incidentRoutes from './api/routes/incidentRoutes.js';
import batchRoutes from './api/routes/batchRoutes.js';
import webhookRoutes from './api/routes/webhookRoutes.js';
import tenantMiddleware from './api/middleware/tenant.js';
import auditMiddleware from './api/middleware/audit.js';
import { createWebSocketServer, pool } from './api/websocket/handlers.js';
import cache from './lib/cache.js';
import { attachPrismaMetrics } from './lib/prismaMetrics.js';
import { attachPrismaTracing } from './lib/prismaTracing.js';
import healthRoutes from './api/routes/healthRoutes.js';
import tenantRoutes from './api/routes/tenantRoutes.js';
import wsHealthRoutes from './api/routes/wsHealth.js';
import prisma, { startConnectionMonitoring } from './lib/prisma.js';
import { errorsTotal } from './lib/metrics.js';
import { leaderboardRateLimit } from './middleware/rateLimit.js';
import metricsMiddleware from './middleware/metricsMiddleware.js';
import responseTime from './middleware/responseTime.js';
import tracingMiddleware from './middleware/tracingMiddleware.js';
import timeoutMiddleware from './middleware/timeout.js';
import logger, { getLogger } from './config/logger.js';
import emailService from './services/emailService.js';
import complianceService from './services/complianceService.js';
import { startIndexer } from './services/eventIndexer.js';
import { startRpcMonitor } from './monitoring/rpcMonitor.js';
import { createEventWorker, createDeadLetterWorker } from './services/eventWorker.js';
import { setupSwagger } from './api/docs/swagger.js';
import { getBackupStatus } from './services/backupMonitor.js';
import { syncFromPrisma, ensureIndex } from './services/reputationSearchService.js';
import { startExpiryJob } from './services/expiryService.js';
import { createGateway } from './gateway/index.js';
import queueDashboardRoutes from './api/routes/queueDashboardRoutes.js';
import chatRoutes from './api/routes/chatRoutes.js';
import expiryRoutes from './api/routes/expiryRoutes.js';

// Attach Prisma query instrumentation (metrics + traces)
attachPrismaMetrics(prisma);
attachPrismaTracing(prisma);

const PORT = process.env.PORT || 4000;
const app = express();
const sentryRequestHandler = Sentry.expressRequestHandler?.() ?? ((_req, _res, next) => next());
const sentryTracingHandler = Sentry.expressTracingHandler?.() ?? ((_req, _res, next) => next());
const sentryErrorHandler =
  Sentry.expressErrorHandler?.({
    shouldHandleError(err) {
      return !err.statusCode || err.statusCode >= 500;
    },
  }) ?? ((err, _req, _res, next) => next(err));

// ── Sentry request handler — must be first middleware ─────────────────────────
// Attaches trace context and request data to every event captured downstream.
app.use(sentryRequestHandler);

app.use(helmet());
app.use(compressionMiddleware);
app.use(timeoutMiddleware);
app.use(metricsMiddleware);
app.use(responseTime);
app.use(tracingMiddleware);
app.use(requestLogger);
app.use((req, res, next) => {
  const requestId =
    req.id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:3000',
    credentials: true,
  }),
);
app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_SIZE_LIMIT }));
app.use(cookieParser());
app.use(sanitizeInputs);
app.use(csrfProtection);
app.use('/uploads', express.static('uploads'));
app.use(auditMiddleware);

// ── Sentry tracing handler — after body parsers, before routes ────────────────
app.use(sentryTracingHandler);

// ── API Gateway — centralized auth, rate limiting, logging, metrics ───────────
app.use('/api', ...createGateway());

// Leaderboard gets a tighter dedicated limit on top of the gateway limit
app.use('/api/reputation/leaderboard', leaderboardRateLimit);

app.get('/health', async (_req, res) => {
  let dbStatus = 'ok';
  let dbLatencyMs = null;
  let dbPoolInfo = null;

  try {
    const t0 = Date.now();
    // Test basic connectivity
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t0;

    // Get basic pool info if available
    try {
      // This is a simplified check - in production with direct pg access,
      // you could get detailed pool stats
      const poolCheck = await prisma.$queryRaw`
        SELECT
          count(*) as connection_count,
          now() as current_time
        FROM pg_stat_activity
        WHERE datname = current_database()
      `;
      dbPoolInfo = {
        activeConnections: parseInt(poolCheck[0].connection_count),
        timestamp: poolCheck[0].current_time,
      };
    } catch (poolError) {
      getLogger().warn({
        message: 'health_db_pool_info_unavailable',
        error: poolError.message,
      });
    }
  } catch (error) {
    dbStatus = 'error';
    getLogger().error({
      message: 'health_database_check_failed',
      error: error.message,
      stack: error.stack,
    });
  }

  const backupStatus = await getBackupStatus();
  const status = dbStatus === 'ok' ? 'ok' : 'degraded';
  res.status(dbStatus === 'ok' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cache: cache.analytics(),
    websocket: pool.getMetrics(),
    db: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
      pool: dbPoolInfo,
    },
    backup: backupStatus,
  });
});

app.get('/api/csrf-token', generateCsrfToken);

// ── API Routes ────────────────────────────────────────────────────────────────
// Auth is handled by the gateway above — no per-route authMiddleware needed.
app.use('/api/health', healthRoutes);
app.use('/ws/health', wsHealthRoutes);
app.use('/api', tenantMiddleware);
app.use('/api/auth', authRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/escrows', escrowRoutes);

// ── API Documentation ─────────────────────────────────────────────────────────
setupSwagger(app);
app.use('/api/users', userRoutes);
app.use('/api/reputation', reputationRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/relayer', relayerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/batch', batchRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/expiry', expiryRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/docs', docsRouter);

// ── Queue Dashboard ───────────────────────────────────────────────────────────
// Mounted outside /api, so it must enforce its own admin auth (see route module).
app.use('/admin/queues', queueDashboardRoutes);

// ── Error Handling ────────────────────────────────────────────────────────────
app.use(sentryErrorHandler);
app.use((err, _req, res, _next) => {
  errorsTotal.inc({ type: err.name || 'Error' });
  getLogger().error({
    message: 'unhandled_error',
    error: err.message,
    stack: err.stack,
  });
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
  });
});

const server = http.createServer(app);
createWebSocketServer(server);

async function start() {
  await initSecrets();
  await startConnectionMonitoring();
  await ensureIndex();
  await syncFromPrisma();
  startIndexer();
  startRpcMonitor();
  createEventWorker();
  createDeadLetterWorker();
  startExpiryJob();

  server.listen(PORT, () => {
    logger.info({ message: 'server_started', port: PORT });
  });
}

start().catch((error) => {
  logger.error({ message: 'server_start_failed', error: error.message, stack: error.stack });
  process.exit(1);
});

export { app, server };
