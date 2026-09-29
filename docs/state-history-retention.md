# State History Retention and Querying

The escrow contract records each state transition in persistent Soroban storage under
`DataKey::StateHistory(escrow_id)`. Each `StateHistoryEntry` stores the escrow id,
previous status, new status, ledger timestamp, and caller.

## Querying

Use `get_state_history(escrow_id)` when the complete on-chain history for one escrow is
required. The current contract returns the full vector in chronological append order.
An unknown escrow/history returns an empty vector.

For large or frequently viewed histories, backend/indexer layers should cache or
materialize the history and paginate their own API responses rather than repeatedly
loading and rendering the entire on-chain vector.

## Retention

State history is stored in persistent contract storage. Both writes and successful reads
bump the persistent TTL for the escrow's history key. The module does not currently
delete individual entries, prune by age, or paginate the stored vector.

## Storage impact

Every transition appends another entry, so storage usage and serialization cost grow
with transition count rather than simply with escrow age.

- short-lived escrows with few transitions remain small;
- long-running or frequently transitioned escrows accumulate larger vectors;
- complete-history reads transfer every retained entry;
- indexers should paginate their own stored projections for large historical views.

## Pruning and pagination guidance

If bounded on-chain history becomes necessary, pruning or pagination should be introduced
as an additive, versioned API change rather than silently changing
`get_state_history(escrow_id)` semantics.

Recommended future behavior:

1. Add a paginated query such as `get_state_history_page(escrow_id, cursor, limit)`.
2. Preserve stable oldest-to-newest ordering.
3. Define a documented retention boundary before deleting or compacting entries.
4. Preserve indexed events or an archive path so pruned history remains reconstructable.
5. Document page-size limits and cursor semantics.
6. Keep the existing full-history method compatible until a versioned deprecation policy
   says otherwise.

## Compatibility expectations

Existing clients may rely on:

- chronological append order;
- original timestamps and caller addresses remaining unchanged;
- missing history returning an empty vector;
- successful reads extending the persistent TTL;
- `get_state_history` returning the complete retained vector.

Any future pruning policy should be announced as a compatibility change and explain how
clients retrieve archived entries that are no longer present in the live vector.
