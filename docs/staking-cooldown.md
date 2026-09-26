# Staking Cooldown

Staking withdrawals use a cooldown period to protect reward accounting and give
the protocol time to settle pending slashing or governance actions.

## Withdrawal Flow

1. User requests withdrawal.
2. Contract records requested amount and cooldown start time.
3. Rewards continue according to the configured policy until the cutoff ledger.
4. User can claim after cooldown expiry.
5. Completed withdrawal clears the pending request.

## Pending Rewards

Pending rewards should be shown separately from withdrawable principal. If a
withdrawal is cancelled or restaked, reward accounting must keep the original
earning period visible for audit purposes.

## Restaking

Restaking during cooldown should either:

- cancel the withdrawal request and restore active stake, or
- create a new active position while preserving the pending withdrawal.

The selected behavior must be explicit in UI copy and API responses.

## Edge Cases

- Partial withdrawals require independent cooldown records.
- Slashed positions should update pending withdrawal amount before claim.
- Expired cooldowns should remain claimable until the user withdraws.
- Admin pause should block new requests but should not hide existing pending
  withdrawals.

## Client Display

Clients should show amount, request time, claimable time, pending rewards,
restake availability, and any blocking pause or slash state.
