# Frontend Admin Testing Matrix

Admin surfaces handle high-risk operational actions. Use this matrix when adding
or changing admin pages so coverage is consistent across incidents,
transactions, exports, webhooks, and feature flags.

| Surface | Required Coverage | Critical States |
| --- | --- | --- |
| Incidents | list rendering, severity filters, status transitions, post-mortem link | open, mitigated, resolved, missing owner |
| Transactions | monitor status display, retry action guardrails, manual review copy | pending, confirmed, failed, retryable, timeout |
| Exports | request flow, disabled state, download link, error banner | queued, processing, complete, failed |
| Webhooks | delivery history, pause/resume state, circuit breaker copy | active, paused, probing, disabled |
| Feature flags | read state, update confirmation, permission denied copy | enabled, disabled, stale config |

## Test Types

- Unit tests cover pure formatting, labels, and disabled-state decisions.
- Component tests cover table rows, empty states, loading states, and dialogs.
- E2E tests cover one successful path and one denied or failed path per surface.
- Accessibility tests should run against the first screen and any destructive
  confirmation dialog.

## Fixtures

Keep fixtures small and explicit. Every fixture should include a stable id,
status, timestamp, actor, and correlation id when the backend returns one.

## Review Checklist

- The page has a loading state that does not shift layout.
- Empty states explain the operational next step.
- Destructive actions require confirmation.
- Failed mutations surface the backend correlation id.
- Retryable operations explain why retry is allowed.
