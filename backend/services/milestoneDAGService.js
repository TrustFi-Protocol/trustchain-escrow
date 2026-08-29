/**
 * milestoneDAGService.js
 *
 * Builds the dependency graph (DAG) of milestones for an escrow so the
 * frontend can render a milestone timeline/flow chart. Fetching the graph
 * can take a noticeable amount of time on escrows with many milestones,
 * and previously the API returned nothing until the whole graph was ready
 * — the UI just showed a blank panel that read as broken. This module now
 * exposes explicit status states (`loading`, `ready`, `error`) plus a
 * skeleton descriptor so the frontend can render a matching placeholder
 * (see frontend/components/ui/Skeleton.jsx) with no layout shift once the
 * real graph arrives.
 */

export const DAG_STATUS = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
});

/**
 * Shape of the skeleton placeholder the frontend should render while the
 * DAG is being computed, sized to match the eventual node/edge layout so
 * there is no layout shift once real data replaces it.
 *
 * @param {number} [milestoneCount=4] - Expected number of milestones, used to size the skeleton.
 * @returns {{status: string, nodeCount: number, edgeCount: number}}
 */
function buildLoadingSkeleton(milestoneCount = 4) {
  return {
    status: DAG_STATUS.LOADING,
    nodeCount: Math.max(milestoneCount, 1),
    edgeCount: Math.max(milestoneCount - 1, 0),
  };
}

/**
 * Fetches milestones for an escrow and assembles them into a DAG
 * (nodes + directed edges based on declared dependencies).
 *
 * @param {string} escrowId - The escrow whose milestone DAG should be built.
 * @param {object} deps - Injected dependencies.
 * @param {Function} deps.fetchMilestones - async (escrowId) => Array<milestone>.
 * @returns {Promise<{status: string, nodes: Array<object>, edges: Array<object>, error: (string|null)}>}
 */
async function getMilestoneDAG(escrowId, { fetchMilestones }) {
  try {
    const milestones = await fetchMilestones(escrowId);

    if (!Array.isArray(milestones) || milestones.length === 0) {
      return {
        status: DAG_STATUS.READY,
        nodes: [],
        edges: [],
        error: null,
      };
    }

    const nodes = milestones.map(toNode);
    const edges = buildEdges(milestones);

    return {
      status: DAG_STATUS.READY,
      nodes,
      edges,
      error: null,
    };
  } catch (err) {
    return {
      status: DAG_STATUS.ERROR,
      nodes: [],
      edges: [],
      error: err instanceof Error ? err.message : 'Failed to load milestone graph',
    };
  }
}

/**
 * Converts a raw milestone record into a DAG node.
 *
 * @param {object} milestone - Raw milestone record.
 * @returns {{id: string, label: string, state: string}}
 */
function toNode(milestone) {
  return {
    id: milestone.id,
    label: milestone.title ?? `Milestone ${milestone.index ?? ''}`.trim(),
    state: milestone.status ?? 'pending',
  };
}

/**
 * Derives directed edges from each milestone's declared dependency list.
 *
 * @param {Array<object>} milestones - Raw milestone records, each optionally
 *   carrying a `dependsOn` array of milestone ids.
 * @returns {Array<{from: string, to: string}>}
 */
function buildEdges(milestones) {
  const edges = [];
  for (const milestone of milestones) {
    const deps = Array.isArray(milestone.dependsOn) ? milestone.dependsOn : [];
    for (const depId of deps) {
      edges.push({ from: depId, to: milestone.id });
    }
  }
  return edges;
}

export { buildLoadingSkeleton, getMilestoneDAG, toNode, buildEdges };

export default { DAG_STATUS, buildLoadingSkeleton, getMilestoneDAG, toNode, buildEdges };
