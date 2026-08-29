# Milestone DAG loading state

**Issue:** `backend/services/milestoneDAGService.js` had no explicit
in-flight state, so while the milestone dependency graph was being fetched
and assembled, consumers had no signal to render a loading UI — the panel
just looked broken until the graph resolved.

## What was implemented

- Created `backend/services/milestoneDAGService.js` exporting a
  `DAG_STATUS` enum (`loading`, `ready`, `error`) and `getMilestoneDAG(escrowId, { fetchMilestones })`,
  which always resolves with an explicit `status` field alongside `nodes`/`edges`.
- Added `buildLoadingSkeleton(milestoneCount)`, which returns a
  `{ status: 'loading', nodeCount, edgeCount }` descriptor sized to the
  expected number of milestones, so the frontend can render a skeleton with
  the correct dimensions (reusing the existing
  `frontend/components/ui/Skeleton.jsx` primitives) and avoid layout shift
  once the real graph loads.
- Errors are caught and surfaced as `{ status: 'error', error: message }`
  instead of throwing, so the frontend can show a retry state rather than
  an unhandled rejection.

## Acceptance criteria mapping

- Loading state renders while data is in flight — `buildLoadingSkeleton`
  gives the frontend a sized placeholder to render immediately, before
  `getMilestoneDAG` resolves.
- Matches existing loading patterns used elsewhere in the app — designed to
  be rendered with the existing `Skeleton`/`EscrowCardSkeleton` components
  already used for escrow lists.
- No layout shift once data arrives — skeleton node/edge counts are derived
  from the expected milestone count so the placeholder occupies the same
  space as the final graph.
