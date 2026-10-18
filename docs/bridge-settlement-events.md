# Bridge settlement confirmation events

`update_bridge_confirmation` emits a `brg_cnf` event after it persists the
confirmation record. The event topic remains `(brg_cnf, token)` and its data is
the tuple `(bridge, confirmations, is_finalized, updated_at)`.

The complete payload lets consumers reconstruct the stored bridge-finality
state deterministically without a follow-up contract read. `updated_at` is the
Stellar ledger timestamp in seconds; it is not a source-chain block time.

Consumers should treat `is_finalized` as the contract's authoritative finality
decision and retain the protocol and confirmation count for auditability.
