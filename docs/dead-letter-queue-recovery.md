# Queue Dead-Letter Recovery Runbook

Dead-letter queues hold jobs that failed after retry exhaustion. Recovery should
be deliberate so replay does not duplicate payments, webhooks, or contract
state transitions.

## Inspect

- Identify queue name, job id, tenant id, and correlation id.
- Review final error and retry history.
- Check whether the side effect already completed.
- Confirm current code can process the payload schema.

## Replay

Replay only when the job is idempotent or the side effect is confirmed absent.
Use small batches and watch worker error rate.

Recommended order:

1. Replay read-only or notification jobs.
2. Replay webhook jobs with delivery de-duplication enabled.
3. Replay payment or contract jobs one at a time.

## Discard

Permanently discard a job when:

- payload references deleted test data
- schema is unsupported and no migration exists
- side effect completed through a manual fix
- tenant or user was removed under compliance policy

## Audit Trail

Record operator, queue, job ids, action, reason, before/after status, and
correlation id for every replay or discard.
