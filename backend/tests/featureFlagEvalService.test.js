/**
 * Tests for Feature Flag Evaluation Service (Issue #232)
 */

import featureFlagEvalService from '../services/featureFlagEvalService.js';
import prisma from '../lib/prisma.js';

describe('featureFlagEvalService', () => {
  const testFlag = 'test_feature_flag';

  beforeEach(async () => {
    await prisma.featureFlag.deleteMany({ where: { key: { startsWith: 'test_' } } });
  });

  describe('previewEvaluation', () => {
    it('should return flag_disabled when flag is not enabled', async () => {
      await featureFlagEvalService.saveFlag(testFlag, { isEnabled: false });

      const result = await featureFlagEvalService.previewEvaluation(testFlag, {
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A',
      });

      expect(result.applies).toBe(false);
      expect(result.rule).toBe('flag_disabled');
    });

    it('should return flag_not_found when flag does not exist', async () => {
      const result = await featureFlagEvalService.previewEvaluation('nonexistent_flag', {
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A',
      });

      expect(result.applies).toBe(false);
      expect(result.rule).toBe('flag_not_found');
    });

    it('should apply to users in target list', async () => {
      const addr1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';
      const addr2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW';

      await featureFlagEvalService.saveFlag(testFlag, {
        isEnabled: true,
        targetUsers: [addr1],
      });

      const result1 = await featureFlagEvalService.previewEvaluation(testFlag, {
        address: addr1,
      });
      const result2 = await featureFlagEvalService.previewEvaluation(testFlag, {
        address: addr2,
      });

      expect(result1.applies).toBe(true);
      expect(result1.rule).toBe('target_user');

      expect(result2.applies).toBe(false);
      expect(result2.rule).toBe('not_in_target_list');
    });

    it('should handle percentage-based rollout deterministically', async () => {
      await featureFlagEvalService.saveFlag(testFlag, {
        isEnabled: true,
        percentage: 50,
      });

      const addr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';

      // Same address should always get same result (deterministic)
      const result1 = await featureFlagEvalService.previewEvaluation(testFlag, { address: addr });
      const result2 = await featureFlagEvalService.previewEvaluation(testFlag, { address: addr });

      expect(result1.applies).toBe(result2.applies);
      expect(result1.percentageValue).toBe(result2.percentageValue);
    });

    it('should apply to all users when percentage is 100', async () => {
      await featureFlagEvalService.saveFlag(testFlag, {
        isEnabled: true,
        percentage: 100,
      });

      const addr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A';

      const result = await featureFlagEvalService.previewEvaluation(testFlag, { address: addr });

      expect(result.applies).toBe(true);
      expect(result.rule).toBe('globally_enabled');
    });

    it('should return globals_enabled when flag is enabled with no targeting', async () => {
      await featureFlagEvalService.saveFlag(testFlag, {
        isEnabled: true,
        percentage: 100,
      });

      const result = await featureFlagEvalService.previewEvaluation(testFlag);

      expect(result.applies).toBe(true);
      expect(result.rule).toBe('globally_enabled');
    });
  });

  describe('saveFlag', () => {
    it('should create a new flag', async () => {
      const flag = await featureFlagEvalService.saveFlag(testFlag, {
        description: 'Test feature',
        isEnabled: true,
        percentage: 25,
        targetUsers: [],
      });

      expect(flag.key).toBe(testFlag);
      expect(flag.description).toBe('Test feature');
      expect(flag.isEnabled).toBe(true);
      expect(flag.percentage).toBe(25);
    });

    it('should update existing flag', async () => {
      await featureFlagEvalService.saveFlag(testFlag, { isEnabled: false, percentage: 0 });

      const updated = await featureFlagEvalService.saveFlag(testFlag, {
        isEnabled: true,
        percentage: 50,
      });

      expect(updated.isEnabled).toBe(true);
      expect(updated.percentage).toBe(50);
    });

    it('should reject percentage outside 0-100', async () => {
      await expect(
        featureFlagEvalService.saveFlag(testFlag, { percentage: 150 }),
      ).rejects.toThrow('Percentage must be 0-100');

      await expect(
        featureFlagEvalService.saveFlag(testFlag, { percentage: -10 }),
      ).rejects.toThrow('Percentage must be 0-100');
    });

    it('should store target users list', async () => {
      const users = [
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH5C4A',
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQW',
      ];

      const flag = await featureFlagEvalService.saveFlag(testFlag, {
        targetUsers: users,
      });

      expect(flag.targetUsers).toEqual(users);
    });
  });

  describe('getFlag', () => {
    it('should retrieve saved flag', async () => {
      const saved = await featureFlagEvalService.saveFlag(testFlag, {
        isEnabled: true,
        percentage: 75,
      });

      const retrieved = await featureFlagEvalService.getFlag(testFlag);

      expect(retrieved.key).toBe(testFlag);
      expect(retrieved.isEnabled).toBe(true);
      expect(retrieved.percentage).toBe(75);
    });

    it('should return null for non-existent flag', async () => {
      const flag = await featureFlagEvalService.getFlag('nonexistent');
      expect(flag).toBeNull();
    });
  });

  describe('listFlags', () => {
    it('should return all flags', async () => {
      await featureFlagEvalService.saveFlag('test_flag_1', { isEnabled: true });
      await featureFlagEvalService.saveFlag('test_flag_2', { isEnabled: false });

      const flags = await featureFlagEvalService.listFlags();

      expect(flags.length).toBeGreaterThanOrEqual(2);
      expect(flags.some((f) => f.key === 'test_flag_1')).toBe(true);
      expect(flags.some((f) => f.key === 'test_flag_2')).toBe(true);
    });
  });

  describe('deleteFlag', () => {
    it('should delete an existing flag', async () => {
      await featureFlagEvalService.saveFlag(testFlag, { isEnabled: true });

      await featureFlagEvalService.deleteFlag(testFlag);

      const retrieved = await featureFlagEvalService.getFlag(testFlag);
      expect(retrieved).toBeNull();
    });
  });
});
