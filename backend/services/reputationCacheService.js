/**
 * Redis Caching Layer for Reputation Score Queries
 * Reduces database load by caching frequently accessed reputation data
 */

import redis from 'redis';
import reputationService from './reputationService.js';

// Initialize Redis client for reputation caching
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

redisClient.on('error', (err) => {
  console.error('Redis reputation cache client error:', err);
});

redisClient.connect().catch(console.error);

// Cache TTL (time to live) in seconds
const CACHE_TTL = {
  reputation: 5 * 60, // 5 minutes for individual reputation
  leaderboard: 10 * 60, // 10 minutes for leaderboard
  percentile: 15 * 60, // 15 minutes for percentile ranks
};

// Cache key prefixes
const CACHE_KEYS = {
  reputation: (address) => `rep:score:${address}`,
  leaderboard: (page, limit) => `rep:leaderboard:${limit}:${page}`,
  percentile: (address) => `rep:percentile:${address}`,
};

/**
 * Get reputation score with caching
 * Checks cache first, falls back to database, then updates cache
 *
 * @param {string} address - Stellar address
 * @returns {Promise<object|null>} Reputation record or null
 */
export const getReputationByAddressCached = async (address) => {
  if (!address) return null;

  try {
    // Try to get from cache
    const cacheKey = CACHE_KEYS.reputation(address);
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      console.log(`[Cache HIT] Reputation for ${address}`);
      return JSON.parse(cached);
    }

    // Cache miss, fetch from database
    console.log(`[Cache MISS] Reputation for ${address}`);
    const record = await reputationService.getReputationByAddress(address);

    // Update cache if found
    if (record) {
      await redisClient.setEx(
        cacheKey,
        CACHE_TTL.reputation,
        JSON.stringify(record)
      );
    }

    return record;
  } catch (error) {
    console.error(`Error fetching reputation for ${address}:`, error);
    // Fall back to direct DB call on cache error
    return reputationService.getReputationByAddress(address);
  }
};

/**
 * Get leaderboard with caching
 *
 * @param {number} limit - Number of results
 * @param {number} page - Page number (1-indexed)
 * @returns {Promise<array>} Leaderboard entries
 */
export const getLeaderboardCached = async (limit = 20, page = 1) => {
  try {
    // Try to get from cache
    const cacheKey = CACHE_KEYS.leaderboard(page, limit);
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      console.log(`[Cache HIT] Leaderboard page ${page}`);
      return JSON.parse(cached);
    }

    // Cache miss, fetch from database
    console.log(`[Cache MISS] Leaderboard page ${page}`);
    const leaderboard = await reputationService.getLeaderboard(limit, page);

    // Update cache
    await redisClient.setEx(
      cacheKey,
      CACHE_TTL.leaderboard,
      JSON.stringify(leaderboard)
    );

    return leaderboard;
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    // Fall back to direct DB call on cache error
    return reputationService.getLeaderboard(limit, page);
  }
};

/**
 * Get percentile rank with caching
 *
 * @param {string} address - Stellar address
 * @returns {Promise<number>} Percentile rank (0-100)
 */
export const getPercentileRankCached = async (address) => {
  if (!address) return 0;

  try {
    // Try to get from cache
    const cacheKey = CACHE_KEYS.percentile(address);
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      console.log(`[Cache HIT] Percentile for ${address}`);
      return Number(cached);
    }

    // Cache miss, fetch from database
    console.log(`[Cache MISS] Percentile for ${address}`);
    const percentile = await reputationService.getPercentileRank(address);

    // Update cache
    await redisClient.setEx(
      cacheKey,
      CACHE_TTL.percentile,
      String(percentile)
    );

    return percentile;
  } catch (error) {
    console.error(`Error fetching percentile for ${address}:`, error);
    // Fall back to direct DB call on cache error
    return reputationService.getPercentileRank(address);
  }
};

/**
 * Invalidate cache for a specific address
 * Called after reputation updates
 *
 * @param {string} address - Stellar address
 */
export const invalidateAddressCache = async (address) => {
  if (!address) return;

  try {
    console.log(`[Cache INVALIDATE] Address: ${address}`);
    const keys = [
      CACHE_KEYS.reputation(address),
      CACHE_KEYS.percentile(address),
    ];

    for (const key of keys) {
      await redisClient.del(key);
    }
  } catch (error) {
    console.error(`Error invalidating cache for ${address}:`, error);
  }
};

/**
 * Invalidate all leaderboard cache entries
 * Called after significant reputation updates
 */
export const invalidateLeaderboardCache = async () => {
  try {
    console.log('[Cache INVALIDATE] All leaderboard entries');
    // Delete all leaderboard cache keys
    const keys = await redisClient.keys('rep:leaderboard:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (error) {
    console.error('Error invalidating leaderboard cache:', error);
  }
};

/**
 * Clear all reputation caches
 * Useful for full cache reset or debugging
 */
export const clearAllReputationCache = async () => {
  try {
    console.log('[Cache CLEAR] All reputation caches');
    const keys = await redisClient.keys('rep:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (error) {
    console.error('Error clearing reputation cache:', error);
  }
};

/**
 * Get cache statistics
 */
export const getCacheStats = async () => {
  try {
    const keys = await redisClient.keys('rep:*');
    return {
      totalEntries: keys.length,
      reputationScores: keys.filter(k => k.startsWith('rep:score:')).length,
      leaderboardEntries: keys.filter(k => k.startsWith('rep:leaderboard:')).length,
      percentileEntries: keys.filter(k => k.startsWith('rep:percentile:')).length,
    };
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return null;
  }
};

/**
 * Graceful shutdown for Redis client
 */
export const closeReputationCacheStore = async () => {
  if (redisClient.connected) {
    await redisClient.disconnect();
  }
};

export default {
  getReputationByAddressCached,
  getLeaderboardCached,
  getPercentileRankCached,
  invalidateAddressCache,
  invalidateLeaderboardCache,
  clearAllReputationCache,
  getCacheStats,
  closeReputationCacheStore,
};
