/**
 * Fee Estimation Service — end-to-end integration test
 *
 * Exercises the full happy-path flow: request a fee quote for an escrow
 * with milestones, through to the itemized breakdown and USD conversion.
 *
 * @module tests/feeEstimationService
 */

import { jest } from '@jest/globals';

const stellarServiceMock = {
  getLatestLedger: jest.fn().mockResolvedValue(123456),
  getContractEvents: jest.fn(),
  submitTransaction: jest.fn(),
};

jest.unstable_mockModule('../services/stellarService.js', () => stellarServiceMock);

const { estimateEscrowCreationFee, computeFeeBreakdown } = await import(
  '../services/feeEstimationService.js'
);

describe('feeEstimationService — end-to-end', () => {
  it('estimates the full escrow creation fee, itemized and converted to USD', async () => {
    const result = await estimateEscrowCreationFee({
      milestoneCount: 3,
      baseFeeStroops: 100,
      xlmUsdRate: 0.12,
    });

    expect(result.ledger).toBe(123456);
    expect(result.breakdown.items).toEqual([
      { label: 'Create escrow', operations: 1, feeStroops: 100 },
      { label: 'Fund escrow', operations: 1, feeStroops: 100 },
      { label: 'Add milestones', operations: 3, feeStroops: 300 },
    ]);
    expect(result.breakdown.totalOperations).toBe(5);
    expect(result.breakdown.totalStroops).toBe(500);
    expect(result.breakdown.totalXlm).toBeCloseTo(0.00005, 8);
    expect(result.totalUsd).toBeCloseTo(0.00005 * 0.12, 10);
  });

  it('omits USD conversion when no exchange rate is supplied', async () => {
    const result = await estimateEscrowCreationFee({ milestoneCount: 0 });

    expect(result.totalUsd).toBeNull();
    expect(result.breakdown.totalOperations).toBe(2);
  });

  it('computes an itemized breakdown for arbitrary operations directly', () => {
    const breakdown = computeFeeBreakdown(
      [{ label: 'Create escrow' }, { label: 'Milestone', operations: 2 }],
      50,
    );

    expect(breakdown.totalStroops).toBe(150);
    expect(breakdown.totalOperations).toBe(3);
  });
});
