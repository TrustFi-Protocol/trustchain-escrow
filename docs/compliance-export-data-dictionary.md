# Compliance Export Data Dictionary

Compliance exports must be predictable and traceable to source systems. Use this
dictionary when adding export fields or reviewing regulator-facing files.

| Field | Source | Description |
| --- | --- | --- |
| `tenant_id` | tenant service | Tenant that owns the exported record. |
| `user_id` | users table | Internal user identifier. |
| `wallet_address` | wallet profile | Primary Stellar address associated with the user. |
| `kyc_status` | KYC service | Current verification status at export time. |
| `kyc_provider_ref` | KYC provider mapping | Provider reference when available. |
| `escrow_id` | escrow table | Escrow identifier tied to the activity. |
| `counterparty_address` | escrow participants | Other party in the escrow. |
| `transaction_hash` | transaction monitor | Stellar transaction hash when available. |
| `amount` | payment or escrow record | Amount in smallest supported unit. |
| `asset_code` | asset metadata | Asset code used for the payment or escrow. |
| `asset_issuer` | asset metadata | Issuer address for non-native assets. |
| `event_type` | audit/event log | Compliance-relevant lifecycle event. |
| `event_time` | audit/event log | Timestamp the event was recorded. |
| `ip_address` | request audit log | Request IP when collected under policy. |
| `correlation_id` | request context | Trace id for support and audit lookup. |

## Handling Rules

- Exports should include generated time and requesting admin id.
- Sensitive fields should be redacted unless the export purpose requires them.
- Every added field must document its source service or table.
- Deleted users should follow retention policy before appearing in exports.
