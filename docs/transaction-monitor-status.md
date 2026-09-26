# Transaction Monitor Status Enum

`shared/transactionMonitorStatus.js` defines the canonical labels and status
groups for transaction monitoring across backend, frontend, and mobile clients.

| Status | Meaning | Retryable | Terminal |
| --- | --- | --- | --- |
| `queued` | Accepted locally but not submitted to Stellar yet | yes | no |
| `pending` | Submitted or waiting for the next monitor poll | yes | no |
| `submitted` | Broadcast to Stellar and awaiting final ledger result | no | no |
| `confirmed` | Final success result recorded | no | yes |
| `failed` | Final failure that should not auto-retry | no | yes |
| `retryable` | Failure condition can be retried after operator or policy checks | yes | no |
| `manual_review` | Requires operator review before another state change | no | no |
| `timeout` | Monitor exceeded the allowed confirmation window | yes | yes |
| `cancelled` | User or operator cancelled monitoring | no | yes |

## Usage

- Backend services should persist one of the enum values.
- Frontend and mobile should render labels from
  `TRANSACTION_MONITOR_STATUS_LABELS`.
- Retry buttons should use `RETRYABLE_TRANSACTION_MONITOR_STATUSES`.
- Archive and reconciliation jobs should use
  `TERMINAL_TRANSACTION_MONITOR_STATUSES`.
