# Indexer Lag Troubleshooting

Indexer lag affects dashboards, webhooks, compliance exports, and transaction
monitoring. Use this guide to isolate the cause before replaying events.

## Initial Checks

- Compare latest indexed ledger with network latest ledger.
- Check RPC provider latency and error rate.
- Inspect queue depth and oldest pending job age.
- Confirm database write latency and lock waits.

## Common Causes

| Cause | Signal | Action |
| --- | --- | --- |
| RPC degradation | high timeout rate | switch provider or reduce batch size |
| Lock contention | database wait events | pause heavy exports and retry smaller batches |
| Replay backlog | old cursor timestamp | increase workers after confirming idempotency |
| Schema mismatch | repeated parser failures | deploy mapper fix before replay |
| Webhook pressure | delivery queue growth | isolate webhook jobs from indexer writes |

## Replay Procedure

1. Pause non-critical consumers if backlog is severe.
2. Snapshot current cursor and failed event ids.
3. Replay in bounded ledger ranges.
4. Verify idempotent writes by checking duplicate event keys.
5. Resume consumers after lag and error rate return to baseline.

## Escalation

Escalate when lag exceeds the customer-facing SLO, payment state is ambiguous,
or replay would cross a contract upgrade boundary.
