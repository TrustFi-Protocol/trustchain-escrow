# EscrowTimeline — Test Coverage

## What was implemented

Added `frontend/tests/integration/EscrowTimeline.test.jsx`, an end-to-end
integration test for the escrow timeline UI
(`components/escrow/TransactionStatusTimeline.jsx` with its `ESCROW_STEPS`
preset). It exercises the full happy-path flow of an escrow moving through
its lifecycle:

- Renders every stage in `ESCROW_STEPS` and confirms completed/current step
  states are reflected in the DOM (`aria-current="step"`).
- Walks the timeline from `created` through `completed`, re-rendering at
  each stage and asserting prior + current stage labels are visible.
- Renders the error state on the current step and confirms the component
  does not crash and remains navigable.

## Why

Issue: the happy-path flow through the escrow timeline component had no
end-to-end test, so regressions could slip past CI undetected.

## Test runtime

Plain React Testing Library render/unmount cycles, no network or app
providers required — runs in well under 5s.
