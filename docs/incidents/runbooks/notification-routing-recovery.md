# Incident Notification Routing Recovery

Recovery procedures for the incident notification path: `incidentController` →
`incidentService` → PagerDuty Events API v2, the Slack incident webhook, and outbound
incident webhooks (`incident.opened`, `incident.updated`, `incident.resolved`,
`incident.escrows_linked`) queued through `webhookService`.

All endpoints below require admin authentication (`x-admin-api-key`). Never paste the
admin key, `PAGERDUTY_ROUTING_KEY`, or `SLACK_INCIDENT_WEBHOOK` into tickets, chat, or
incident timelines.

## Detection

- **Missing pages or Slack posts**: an incident exists in `GET /api/incidents` but no
  PagerDuty alert or Slack message was received.
- **Log signatures** (deterministic prefixes emitted by `incidentService`):
  - `[Incident] PagerDuty alert failed: <status>` / `[Incident] PagerDuty request error:`
  - `[Incident] Slack alert failed: <status>` / `[Incident] Slack request error:`
  - `[Incident] Failed to emit webhook <eventType>:`
- **Silent routing**: alert dispatch is skipped without an error when
  `PAGERDUTY_ROUTING_KEY` or `SLACK_INCIDENT_WEBHOOK` is unset. Confirm both are present
  in the running environment (check presence only, do not print values).
- **Wrong responder**: `GET /api/incidents/oncall` returns `current: null` or an
  unexpected engineer. This means `ONCALL_SCHEDULE` is empty, malformed JSON (parsed as
  `[]`), or has no entry covering the current UTC time.
- **Unbounded growth**: `GET /api/incidents/retention` shows the effective policy;
  compare `maxRetained` with the count from `GET /api/incidents`.

## Mitigation

1. **Page manually first.** If an active SEV1/SEV2 incident did not page, page the
   on-call engineer directly using `docs/incidents/on-call-guide.md`. Do not wait for
   routing to recover.
2. **Provider rejects requests (4xx)**: rotate or re-issue the PagerDuty routing key or
   Slack webhook in the secret store, update the environment, and restart the API.
   Alert dispatch is not retried automatically.
3. **Provider unavailable (5xx / network errors)**: alerts are dispatched with
   `Promise.allSettled`, so one failing channel does not block the others or the API
   response. Use the healthy channel and re-send by transitioning the incident
   (`PATCH /api/incidents/:id/status`) once the provider recovers; PagerDuty
   deduplicates on the incident ID (`dedup_key`), so re-triggers do not open duplicate
   pages.
4. **Wrong on-call responder**: correct `ONCALL_SCHEDULE` (JSON array of
   `{ name, email, startUtc, endUtc }` with non-overlapping UTC windows) and restart.
   Reassign the commander on affected incidents in the incident timeline note.
5. **Webhook subscribers not notified**: check the webhook delivery queue
   (`backend/docs/webhook-delivery.md`). Incident state is still recorded even when
   webhook emission fails.
6. **Store growth**: preview cleanup with
   `POST /api/incidents/retention/prune` and body `{ "dryRun": true }`, review
   `prunedIds`, then run again with `{ "dryRun": false }`. Only `resolved` and `closed`
   incidents are eligible; active incidents are never pruned.

## Rollback

- **Configuration change**: restore the previous `PAGERDUTY_ROUTING_KEY`,
  `SLACK_INCIDENT_WEBHOOK`, `ONCALL_SCHEDULE`, or `RUNBOOK_BASE_URL` values from the
  secret store history and restart the API.
- **Retention change**: restore previous `INCIDENT_RETENTION_DAYS`,
  `INCIDENT_MAX_RETAINED`, and `INCIDENT_MAX_TIMELINE_ENTRIES` values. Pruned incidents
  are not recoverable from the API, so always run a dry run first and export the
  incident list (`GET /api/incidents`) before a non-dry-run prune.
- **Deployment regression**: redeploy the previous backend release following
  `docs/production-deployment-guide.md`. Incidents are held in process memory, so record
  open incident IDs, status, and commander before redeploying and recreate them if
  needed.

## Verification

1. `GET /api/incidents/oncall` returns the expected current engineer.
2. Create a SEV4 test incident with `POST /api/incidents` and confirm:
   - a PagerDuty event and a Slack message arrive with the incident ID;
   - the `incident.opened` webhook is queued for subscribers;
   - none of the failure log signatures above are emitted.
3. Resolve the test incident with `PATCH /api/incidents/:id/status`
   (`{ "status": "resolved" }`) and confirm the PagerDuty alert resolves and an
   `incident.resolved` webhook is queued.
4. `GET /api/incidents/retention` reports the intended policy, and a dry-run prune
   returns only resolved/closed incident IDs.
5. Record the recovery in the incident timeline and, for SEV1/SEV2, in the post-mortem
   (`docs/incidents/templates/post-mortem.md`).
