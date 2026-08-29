/**
 * Fee Estimation Service
 *
 * Server-side counterpart to the frontend TransactionFeeEstimator — computes
 * an itemized Stellar network fee breakdown for a multi-operation escrow
 * transaction (create + fund + N milestone operations) so the API can return
 * a fee quote alongside escrow creation responses.
 *
 * @module feeEstimationService
 */

import { getLatestLedger } from './stellarService.js';

const STROOPS_PER_XLM = 10_000_000;
const DEFAULT_BASE_FEE_STROOPS = 100;

function stroopsToXlm(stroops) {
  return stroops / STROOPS_PER_XLM;
}

/**
 * Computes the itemized fee breakdown for a list of operations.
 *
 * @param {Array<{label: string, operations?: number}>} operations
 * @param {number} [baseFeeStroops=100] per-operation base fee, in stroops
 * @returns {{items: Array<object>, totalStroops: number, totalOperations: number, totalXlm: number}}
 */
export function computeFeeBreakdown(operations = [], baseFeeStroops = DEFAULT_BASE_FEE_STROOPS) {
  const items = operations.map((op) => {
    const count = op.operations ?? 1;
    const feeStroops = count * baseFeeStroops;
    return { ...op, operations: count, feeStroops };
  });
  const totalStroops = items.reduce((sum, item) => sum + item.feeStroops, 0);
  const totalOperations = items.reduce((sum, item) => sum + item.operations, 0);
  return { items, totalStroops, totalOperations, totalXlm: stroopsToXlm(totalStroops) };
}

/**
 * Estimates the network fee for creating an escrow with the given number
 * of milestones, optionally converting the total to USD.
 *
 * @param {object} params
 * @param {number} params.milestoneCount
 * @param {number} [params.baseFeeStroops]
 * @param {number} [params.xlmUsdRate]
 * @returns {Promise<{breakdown: object, totalUsd: number|null, ledger: number}>}
 */
export async function estimateEscrowCreationFee({
  milestoneCount = 0,
  baseFeeStroops = DEFAULT_BASE_FEE_STROOPS,
  xlmUsdRate,
} = {}) {
  const operations = [
    { label: 'Create escrow', operations: 1 },
    { label: 'Fund escrow', operations: 1 },
  ];
  if (milestoneCount > 0) {
    operations.push({ label: 'Add milestones', operations: milestoneCount });
  }

  const breakdown = computeFeeBreakdown(operations, baseFeeStroops);
  const totalUsd = xlmUsdRate != null ? breakdown.totalXlm * xlmUsdRate : null;
  const ledger = await getLatestLedger();

  return { breakdown, totalUsd, ledger };
}

export default {
  computeFeeBreakdown,
  estimateEscrowCreationFee,
};
