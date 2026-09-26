# Contract Event to OpenAPI Mapping

This table maps contract lifecycle events to backend API fields and webhook
payloads so integrators can trace state from chain to API.

| Contract Event | API Resource | OpenAPI Field | Webhook Event |
| --- | --- | --- | --- |
| `escrow_created` | `Escrow` | `id`, `clientAddress`, `freelancerAddress`, `totalAmount`, `status` | `escrow.created` |
| `milestone_submitted` | `Milestone` | `status`, `submittedAt`, `milestoneIndex` | `milestone.submitted` |
| `milestone_approved` | `Milestone` | `status`, `resolvedAt` | `milestone.approved` |
| `escrow_released` | `Escrow` | `remainingBalance`, `status`, `updatedAt` | `escrow.released` |
| `dispute_opened` | `Dispute` | `escrowId`, `raisedByAddress`, `raisedAt` | `dispute.opened` |
| `dispute_resolved` | `Dispute` | `resolvedAt`, `resolution`, `clientAmount`, `freelancerAmount` | `dispute.resolved` |
| `escrow_cancelled` | `Escrow` | `status`, `updatedAt` | `escrow.cancelled` |
| `fee_collected` | `Payment` | `amount`, `assetCode`, `transactionHash` | `payment.fee_collected` |

## Mapping Rules

- Preserve the contract event id or ledger/hash pair in backend metadata.
- Do not rename webhook fields without an OpenAPI version note.
- Include `correlationId` when an API action triggered the contract event.
- Indexer replay must produce the same API-visible state for duplicate events.

## Review Checklist

- Contract event schema changed.
- Indexer mapper updated.
- OpenAPI schema updated.
- Webhook docs updated.
- Frontend/mobile client labels checked.
