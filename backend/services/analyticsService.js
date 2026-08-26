/**
 * Analytics Service
 *
 * Provides comprehensive analytics and metrics for the escrow platform,
 * including usage metrics, performance data, and business intelligence.
 */

import prisma from '../lib/prisma.js';
import cacheService from './cacheService.js';

const ANALYTICS_CACHE_PREFIX = 'analytics:';
const ANALYTICS_CACHE_TTL = 3600; // 1 hour

class AnalyticsService {
  /**
   * Record an analytics event
   * @param {string} eventType - Type of event (e.g., 'escrow_created', 'payment_completed')
   * @param {Object} data - Event data
   * @returns {Promise<Object>} Recorded event
   */
  async recordEvent(eventType, data = {}) {
    try {
      const event = {
        type: eventType,
        ...data,
        timestamp: new Date().toISOString(),
      };

      // Store in cache for quick access
      await cacheService.set(
        `${ANALYTICS_CACHE_PREFIX}event:${Date.now()}:${Math.random()}`,
        event,
        ANALYTICS_CACHE_TTL,
      );

      return event;
    } catch (error) {
      console.error('[Analytics] Failed to record event:', error.message);
      throw error;
    }
  }

  /**
   * Get escrow statistics
   */
  async getEscrowStats(tenantId) {
    const cacheKey = `${ANALYTICS_CACHE_PREFIX}escrow_stats:${tenantId}`;

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);
      if (cached) return cached;

      // Build where clause
      const where = tenantId ? { tenantId } : {};

      const [total, completed, disputed, cancelled, expired] = await Promise.all([
        prisma.escrow.count({ where }),
        prisma.escrow.count({ where: { ...where, status: 'completed' } }),
        prisma.escrow.count({ where: { ...where, status: 'disputed' } }),
        prisma.escrow.count({ where: { ...where, status: 'cancelled' } }),
        prisma.escrow.count({ where: { ...where, status: 'expired' } }),
      ]);

      const stats = {
        total,
        completed,
        disputed,
        cancelled,
        expired,
        active: total - (completed + disputed + cancelled + expired),
        completionRate: total > 0 ? ((completed / total) * 100).toFixed(2) : 0,
      };

      // Cache the result
      await cacheService.set(cacheKey, stats, ANALYTICS_CACHE_TTL);

      return stats;
    } catch (error) {
      console.error('[Analytics] Failed to get escrow stats:', error.message);
      throw error;
    }
  }

  /**
   * Get payment analytics
   */
  async getPaymentAnalytics(tenantId) {
    const cacheKey = `${ANALYTICS_CACHE_PREFIX}payment_analytics:${tenantId}`;

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);
      if (cached) return cached;

      const where = tenantId ? { tenantId } : {};

      const [total, completed, pending, failed] = await Promise.all([
        prisma.payment.count({ where }),
        prisma.payment.count({ where: { ...where, status: 'completed' } }),
        prisma.payment.count({ where: { ...where, status: 'pending' } }),
        prisma.payment.count({ where: { ...where, status: 'failed' } }),
      ]);

      // Get volume by currency
      const payments = await prisma.payment.groupBy({
        by: ['currency'],
        where,
        _sum: { amount: true },
        _count: true,
      });

      const volumeByCurrency = {};
      payments.forEach((p) => {
        volumeByCurrency[p.currency] = {
          count: p._count,
          volume: p._sum.amount ? p._sum.amount.toString() : '0',
        };
      });

      const analytics = {
        total,
        completed,
        pending,
        failed,
        successRate: total > 0 ? ((completed / total) * 100).toFixed(2) : 0,
        volumeByCurrency,
      };

      await cacheService.set(cacheKey, analytics, ANALYTICS_CACHE_TTL);

      return analytics;
    } catch (error) {
      console.error('[Analytics] Failed to get payment analytics:', error.message);
      throw error;
    }
  }

  /**
   * Get user growth metrics
   */
  async getUserGrowthMetrics(tenantId) {
    const cacheKey = `${ANALYTICS_CACHE_PREFIX}user_growth:${tenantId}`;

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);
      if (cached) return cached;

      const where = tenantId ? { tenantId } : {};

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      const [total, last30Days, last60Days] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.count({
          where: {
            ...where,
            createdAt: { gte: thirtyDaysAgo },
          },
        }),
        prisma.user.count({
          where: {
            ...where,
            createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
          },
        }),
      ]);

      const growth = {
        total,
        last30Days,
        last60Days,
        monthlyGrowthRate: last60Days > 0 ? ((last30Days / last60Days - 1) * 100).toFixed(2) : 0,
      };

      await cacheService.set(cacheKey, growth, ANALYTICS_CACHE_TTL);

      return growth;
    } catch (error) {
      console.error('[Analytics] Failed to get user growth metrics:', error.message);
      throw error;
    }
  }

  /**
   * Get dispute statistics
   */
  async getDisputeStats(tenantId) {
    const cacheKey = `${ANALYTICS_CACHE_PREFIX}dispute_stats:${tenantId}`;

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);
      if (cached) return cached;

      const where = tenantId ? { tenantId } : {};

      // Since disputes are part of escrow, we'll count based on status
      const [totalDisputes, resolvedDisputes] = await Promise.all([
        prisma.escrow.count({ where: { ...where, status: 'disputed' } }),
        prisma.escrow.count({ where: { ...where, status: 'disputed', completedAt: { not: null } } }),
      ]);

      const stats = {
        total: totalDisputes,
        resolved: resolvedDisputes,
        pending: totalDisputes - resolvedDisputes,
        resolutionRate: totalDisputes > 0 ? ((resolvedDisputes / totalDisputes) * 100).toFixed(2) : 0,
      };

      await cacheService.set(cacheKey, stats, ANALYTICS_CACHE_TTL);

      return stats;
    } catch (error) {
      console.error('[Analytics] Failed to get dispute stats:', error.message);
      throw error;
    }
  }

  /**
   * Get comprehensive platform dashboard metrics
   */
  async getDashboardMetrics(tenantId) {
    try {
      const [escrowStats, paymentAnalytics, userGrowth, disputeStats] = await Promise.all([
        this.getEscrowStats(tenantId),
        this.getPaymentAnalytics(tenantId),
        this.getUserGrowthMetrics(tenantId),
        this.getDisputeStats(tenantId),
      ]);

      return {
        timestamp: new Date().toISOString(),
        escrows: escrowStats,
        payments: paymentAnalytics,
        users: userGrowth,
        disputes: disputeStats,
      };
    } catch (error) {
      console.error('[Analytics] Failed to get dashboard metrics:', error.message);
      throw error;
    }
  }

  /**
   * Get top users by escrow volume
   */
  async getTopUsersByVolume(limit = 10, tenantId) {
    try {
      const where = tenantId ? { tenantId } : {};

      const users = await prisma.escrow.groupBy({
        by: ['clientAddress'],
        where,
        _count: { id: true },
        _sum: { amount: true },
        orderBy: {
          _sum: { amount: 'desc' },
        },
        take: limit,
      });

      return users.map((u) => ({
        address: u.clientAddress,
        escrowCount: u._count.id,
        totalVolume: u._sum.amount ? u._sum.amount.toString() : '0',
      }));
    } catch (error) {
      console.error('[Analytics] Failed to get top users:', error.message);
      throw error;
    }
  }

  /**
   * Clear analytics cache
   */
  async clearCache(tenantId) {
    try {
      // This would ideally use Redis SCAN to clear all matching keys
      // For now, we'll just document the approach
      const pattern = tenantId ? `${ANALYTICS_CACHE_PREFIX}*:${tenantId}` : `${ANALYTICS_CACHE_PREFIX}*`;
      console.log(`[Analytics] Cache clear requested for pattern: ${pattern}`);
      return { message: 'Cache clear initiated', pattern };
    } catch (error) {
      console.error('[Analytics] Failed to clear cache:', error.message);
      throw error;
    }
  }
}

export default new AnalyticsService();
