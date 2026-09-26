import { jest } from '@jest/globals';
import cacheService from '../services/cacheService.js';

describe('Cache Stampede Protection (Single-Flight)', () => {
  beforeEach(async () => {
    await cacheService.invalidatePrefix('test:');
    await cacheService.invalidatePrefix('flight:');
  });

  describe('singleFlight', () => {
    it('invokes loader once for concurrent requests on the same key', async () => {
      let loaderCalls = 0;
      const loader = jest.fn(async () => {
        loaderCalls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { id: 101, status: 'Active', balance: 5000 };
      });

      const key = 'flight:escrow:101';
      const results = await Promise.all([
        cacheService.singleFlight(key, loader),
        cacheService.singleFlight(key, loader),
        cacheService.singleFlight(key, loader),
        cacheService.singleFlight(key, loader),
        cacheService.singleFlight(key, loader),
      ]);

      expect(loaderCalls).toBe(1);
      expect(loader).toHaveBeenCalledTimes(1);
      for (const res of results) {
        expect(res).toEqual({ id: 101, status: 'Active', balance: 5000 });
      }
    });

    it('does not poison cache or in-flight state when loader fails', async () => {
      let failCalls = 0;
      const failingLoader = jest.fn(async () => {
        failCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('Database connection failed');
      });

      const key = 'flight:escrow:err_key';

      // Concurrent calls should all reject with the same error
      await expect(
        Promise.all([
          cacheService.singleFlight(key, failingLoader),
          cacheService.singleFlight(key, failingLoader),
        ]),
      ).rejects.toThrow('Database connection failed');

      expect(failCalls).toBe(1);

      // Verify key is not poisoned in cache
      const cached = await cacheService.get(key);
      expect(cached).toBeNull();

      // Subsequent call can retry and succeed
      const succeedingLoader = jest.fn(async () => ({ id: 'recovered' }));
      const result = await cacheService.singleFlight(key, succeedingLoader);
      expect(result).toEqual({ id: 'recovered' });
      expect(succeedingLoader).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchWithSingleFlight', () => {
    it('coalesces concurrent cache misses and populates cache on success', async () => {
      let dbCalls = 0;
      const dbLoader = jest.fn(async () => {
        dbCalls++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { escrowId: 999, client: 'GB123', totalAmount: '1000' };
      });

      const key = 'test:escrow:999';

      // 5 concurrent requests on cold cache
      const parallelResults = await Promise.all([
        cacheService.fetchWithSingleFlight(key, dbLoader, 60, ['escrows', 'escrow:999']),
        cacheService.fetchWithSingleFlight(key, dbLoader, 60, ['escrows', 'escrow:999']),
        cacheService.fetchWithSingleFlight(key, dbLoader, 60, ['escrows', 'escrow:999']),
        cacheService.fetchWithSingleFlight(key, dbLoader, 60, ['escrows', 'escrow:999']),
        cacheService.fetchWithSingleFlight(key, dbLoader, 60, ['escrows', 'escrow:999']),
      ]);

      expect(dbCalls).toBe(1);
      expect(dbLoader).toHaveBeenCalledTimes(1);
      for (const res of parallelResults) {
        expect(res).toEqual({ escrowId: 999, client: 'GB123', totalAmount: '1000' });
      }

      // Subsequent request hits cache directly without invoking dbLoader
      const cachedResult = await cacheService.fetchWithSingleFlight(key, dbLoader, 60);
      expect(cachedResult).toEqual({ escrowId: 999, client: 'GB123', totalAmount: '1000' });
      expect(dbLoader).toHaveBeenCalledTimes(1);
    });

    it('does not cache error when loader fails during fetchWithSingleFlight', async () => {
      const failingLoader = jest.fn(async () => {
        throw new Error('Internal database query timeout');
      });

      const key = 'test:escrow:fail_stampede';

      await expect(
        Promise.all([
          cacheService.fetchWithSingleFlight(key, failingLoader, 60),
          cacheService.fetchWithSingleFlight(key, failingLoader, 60),
        ]),
      ).rejects.toThrow('Internal database query timeout');

      // Cache remains cold (null)
      const cached = await cacheService.get(key);
      expect(cached).toBeNull();
    });
  });
});
