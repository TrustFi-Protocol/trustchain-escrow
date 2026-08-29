# escrowIndexer.js — JSDoc Coverage

## What was implemented

Added `@param`/`@returns` JSDoc blocks to every exported function in
`backend/services/escrowIndexer.js` that was missing one:
`handleMilestoneApproved`, `handleDisputeRaised`, `handleFundsReleased`,
`handleEscrowCancelled`, `handleEscrowCreated`, `handleMilestoneAdded`,
`handleMilestoneSubmitted`, `handleDisputeResolved`,
`handleReputationUpdated`, and `dispatchEvent`. Also completed the
`@returns` tag on `startIndexer`, which already had a partial block.

No behavior changes — comments only.

## Why

Issue: public functions exported from `escrowIndexer.js` lacked JSDoc
annotations, making IDE hover hints and generated docs incomplete.
