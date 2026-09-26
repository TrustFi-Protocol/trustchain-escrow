# Release Checklist: Expiry and Transaction Monitor Changes

Use this checklist for changes touching the expiry worker, transaction monitor,
Stellar RPC behavior, or payment state transitions.

## Before Merge

- Confirm migrations are backward compatible.
- Verify monitor status changes are reflected in OpenAPI docs and clients.
- Check expiry worker idempotency keys for changed action types.
- Document any new queue names, retry limits, or worker concurrency settings.

## Before Deploy

- Snapshot current transaction monitor backlog.
- Record latest indexed ledger and expiry worker checkpoint.
- Confirm RPC provider limits and fallback provider health.
- Compare runtime config checksum across backend instances.

## During Deploy

- Deploy API and worker code in the planned order.
- Keep old workers paused if payload schema changed.
- Watch failed monitor jobs, expiry action failures, and queue depth.
- Confirm payment state transitions are not double-written.

## After Deploy

- Run a small replay against a known safe ledger range.
- Check webhooks for duplicate lifecycle events.
- Confirm stale expiry backlog drains within SLO.
- Record release notes with rollback conditions.

## Rollback

Pause workers first, restore previous worker image, then resume from the saved
checkpoint only after verifying idempotency records.
