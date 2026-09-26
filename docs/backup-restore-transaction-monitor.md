# Backup Restore Drill: Transaction Monitor Data

This drill verifies that transaction monitor, payment, and contract event tables
can be restored without double-processing payments.

## Scope

Include:

- transaction monitor records
- payment state records
- contract event cursor and deduplication keys
- webhook delivery history needed for replay safety

Exclude secrets and runtime credentials from the drill dataset.

## Restore Steps

1. Pause monitor, expiry, payment, and webhook workers.
2. Restore the database snapshot to an isolated environment.
3. Restore event cursor and idempotency tables before workers start.
4. Compare latest indexed ledger with the snapshot timestamp.
5. Start workers in dry-run or read-only mode when available.
6. Reconcile monitor records against Stellar transaction hashes.

## Double-Processing Guards

- Check unique idempotency keys for payment writes.
- Verify webhook delivery ids before replaying events.
- Confirm terminal monitor statuses remain terminal.
- Do not replay ledger ranges that already have event dedupe records.

## Success Criteria

- Restored counts match the backup manifest.
- No payment state regresses from terminal to pending.
- Worker dry run reports zero duplicate side effects.
- Operators can identify the safe replay cursor.
