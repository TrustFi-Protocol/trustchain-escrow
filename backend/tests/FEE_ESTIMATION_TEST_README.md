# Fee Estimation Service — Test Coverage

## What was implemented

- Added `backend/services/feeEstimationService.js`, the server-side
  counterpart to the frontend `TransactionFeeEstimator`, exposing
  `computeFeeBreakdown()` (pure itemized fee calculation) and
  `estimateEscrowCreationFee()` (full happy-path: builds the operation list
  for an escrow + N milestones, computes the fee breakdown, converts to USD
  when a rate is supplied, and tags the quote with the latest ledger).
- Added `backend/tests/feeEstimationService.test.js`, an integration test
  that exercises `estimateEscrowCreationFee()` end-to-end (mocking only the
  network boundary, `stellarService.getLatestLedger`) and asserts on the
  itemized breakdown, totals, and USD conversion.

## Why

Issue: the happy-path flow through the fee estimation service had no
end-to-end test, so regressions could slip past CI undetected.

## Test runtime

Pure in-memory computation with a single mocked network call — runs in
well under 5s.
