/**
 * Comprehensive API Rate Limiting Middleware
 * Implements per-endpoint, per-user, and per-IP rate limiting with Redis caching
 */

import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from 'redis';

// Initialize Redis client for distributed rate limiting
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

redisClient.on('error', (err) => {
  console.error('Redis rate limit client error:', err);
});

redisClient.connect().catch(console.error);

// Rate limit configuration for different endpoint categories
export const ENDPOINT_LIMITS = {
  // Authentication endpoints - stricter limits
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 min
    message: 'Too many authentication attempts, please try again later.',
  },
  // Escrow creation - moderate limits
  escrow: {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 per minute
    message: 'Too many escrow operations, please try again later.',
  },
  // Public API - standard limits
  public: {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 per minute
    message: 'Too many requests, please try again later.',
  },
  // Reputation/Search - lower limits
  search: {
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 per minute
    message: 'Too many search requests, please try again later.',
  },
  // Webhook - relaxed limits
  webhook: {
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 per minute
    message: 'Webhook rate limit exceeded.',
  },
  // Admin endpoints - highest limits
  admin: {
    windowMs: 60 * 1000, // 1 minute
    max: 500, // 500 per minute
    message: 'Admin rate limit exceeded.',
  },
};

/**
 * Create a Redis-backed rate limiter for distributed systems
 */
function createRedisRateLimiter(category = 'public') {
  const config = ENDPOINT_LIMITS[category] || ENDPOINT_LIMITS.public;

  return rateLimit({
    store: new RedisStore({
      client: redisClient,
      prefix: `rl:${category}:`,
    }),
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Use user ID if available, otherwise fall back to IP
      return req.user?.id || req.user?.address || req.ip || 'unknown';
    },
    skip: (req) => {
      // Skip rate limiting for health checks and CSRF token endpoints
      return (
        req.path === '/health' ||
        req.path === '/api/csrf-token' ||
        (req.headers['x-api-key'] && req.headers['x-api-key'] === process.env.INTERNAL_API_KEY)
      );
    },
    handler: (req, res) => {
      const retryAfter = Math.ceil(
        (req.rateLimit?.resetTime?.getTime?.() - Date.now()) / 1000
      ) || 60;

      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: config.message,
          retryAfter,
          resetTime: req.rateLimit?.resetTime?.toISOString?.(),
        },
      });
    },
  });
}

/**
 * Memory-based fallback rate limiter (if Redis is unavailable)
 */
function createMemoryRateLimiter(category = 'public') {
  const config = ENDPOINT_LIMITS[category] || ENDPOINT_LIMITS.public;

  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      return req.user?.id || req.user?.address || req.ip || 'unknown';
    },
    skip: (req) => {
      return (
        req.path === '/health' ||
        req.path === '/api/csrf-token' ||
        (req.headers['x-api-key'] && req.headers['x-api-key'] === process.env.INTERNAL_API_KEY)
      );
    },
    handler: (req, res) => {
      const retryAfter = Math.ceil(
        (req.rateLimit?.resetTime?.getTime?.() - Date.now()) / 1000
      ) || 60;

      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: config.message,
          retryAfter,
        },
      });
    },
  });
}

// Export rate limiters for different endpoint categories
export const authRateLimit = createRedisRateLimiter('auth');
export const escrowRateLimit = createRedisRateLimiter('escrow');
export const publicRateLimit = createRedisRateLimiter('public');
export const searchRateLimit = createRedisRateLimiter('search');
export const webhookRateLimit = createRedisRateLimiter('webhook');
export const adminRateLimit = createRedisRateLimiter('admin');

// Fallback limiters using memory store
export const authRateLimitMemory = createMemoryRateLimiter('auth');
export const escrowRateLimitMemory = createMemoryRateLimiter('escrow');
export const publicRateLimitMemory = createMemoryRateLimiter('public');
export const searchRateLimitMemory = createMemoryRateLimiter('search');
export const webhookRateLimitMemory = createMemoryRateLimiter('webhook');
export const adminRateLimitMemory = createMemoryRateLimiter('admin');

/**
 * Combine Redis and memory rate limiters with fallback
 */
function createHybridRateLimiter(category = 'public') {
  const redisLimiter = createRedisRateLimiter(category);
  const memoryLimiter = createMemoryRateLimiter(category);

  return (req, res, next) => {
    // Try Redis first
    if (redisClient.connected) {
      redisLimiter(req, res, next);
    } else {
      // Fall back to memory if Redis is unavailable
      memoryLimiter(req, res, next);
    }
  };
}

export const hybridAuthRateLimit = createHybridRateLimiter('auth');
export const hybridEscrowRateLimit = createHybridRateLimiter('escrow');
export const hybridPublicRateLimit = createHybridRateLimiter('public');
export const hybridSearchRateLimit = createHybridRateLimiter('search');
export const hybridWebhookRateLimit = createHybridRateLimiter('webhook');
export const hybridAdminRateLimit = createHybridRateLimiter('admin');

/**
 * Graceful shutdown for Redis client
 */
export async function closeRateLimitStore() {
  if (redisClient.connected) {
    await redisClient.disconnect();
  }
}
