# Mobile Offline Behavior Guide

The mobile app should make offline state explicit and avoid presenting stale
data as live operational truth. This guide defines expected behavior for escrow
views, transaction queueing, KYC state, and dispute appeals.

## Escrow Views

- Cache escrow list and detail responses for read-only display.
- Show a stale-cache indicator when the last successful sync is older than the
  configured freshness window.
- Disable actions that require a fresh contract or backend state.
- Revalidate detail screens when connectivity is restored.

## Transaction Queue

- Store signed-but-unsubmitted transactions in secure local storage.
- Persist the transaction hash, submission intent, created time, retry count,
  and last error.
- Resume submission in FIFO order when the device is back online.
- Move transactions to manual review after the configured retry limit.

## KYC Status

- Display the last known KYC state with its sync timestamp.
- Allow manual refresh when the device is online.
- Do not unlock gated actions from cached `approved` status if the cache is
  older than the policy window.
- Show provider callback delays as `pending_review`, not as generic loading.

## Dispute Appeals

- Cache appeal deadline and eligibility copy with the dispute detail response.
- Show the closed-window state even while offline if the cached deadline has
  passed according to device time.
- Recheck eligibility before submitting evidence or appeal requests.

## Copy Requirements

Offline copy should explain whether the user can safely continue, needs to wait
for sync, or must contact support with a correlation id.
