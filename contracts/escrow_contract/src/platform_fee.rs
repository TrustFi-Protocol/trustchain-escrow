#![allow(dead_code)]
//! Platform fee collection mechanism.
//!
//! Deducts the configured fee from an escrow's remaining balance and
//! transfers it to the platform treasury.
//!
//! Closes #95

use soroban_sdk::{token, Env};

use crate::errors::EscrowError;
use crate::events;
use crate::types::{EscrowFeeSnapshot, EscrowStatus};
use crate::ContractStorage;
use crate::DataKey;

/// Calculate the fee amount for an escrow based on configured tiers.
pub fn calculate_fee(env: &Env, total_amount: i128) -> (u32, i128) {
    let tiers: soroban_sdk::Vec<crate::types::FeeTier> = env
        .storage()
        .instance()
        .get(&DataKey::PlatformFeeTiers)
        .unwrap_or_else(|| soroban_sdk::Vec::new(env));

    let mut applicable_bps: u32 = 0;
    for i in 0..tiers.len() {
        let tier = tiers.get(i).unwrap();
        if total_amount >= tier.min_total_amount {
            applicable_bps = tier.fee_bps;
        }
    }

    // `total * bps / 10_000` overflows i128 for large totals. Splitting the
    // total into whole and remainder parts of 10_000 gives the same result
    // without the intermediate product (both parts share the total's sign).
    let fee_amount = if applicable_bps > 0 {
        let bps = applicable_bps as i128;
        let whole = total_amount / 10_000;
        let rem = total_amount % 10_000;
        whole
            .saturating_mul(bps)
            .saturating_add(rem * bps / 10_000)
    } else {
        0
    };

    (applicable_bps, fee_amount)
}

/// Collect the platform fee for a completed or cancelled escrow.
///
/// Transfers the fee from the contract to the treasury. Can only be called
/// once per escrow (tracked via `EscrowFeeSnapshot.collected`).
pub fn collect_fee(
    env: &Env,
    caller: &soroban_sdk::Address,
    escrow_id: u64,
) -> Result<i128, EscrowError> {
    caller.require_auth();
    ContractStorage::require_not_paused(env)?;

    let meta = ContractStorage::load_escrow_meta(env, escrow_id)?;

    // Only admin or client may collect fees
    ContractStorage::require_admin(env, caller).or_else(|_| {
        if caller == &meta.client {
            Ok(())
        } else {
            Err(EscrowError::E3)
        }
    })?;

    // Only collect from completed or cancelled escrows
    if meta.status != EscrowStatus::Completed && meta.status != EscrowStatus::Cancelled {
        return Err(EscrowError::E9);
    }

    ContractStorage::with_reentrancy_guard(env, || {
        // Check if fee already collected
        let mut snapshot: EscrowFeeSnapshot = env
            .storage()
            .persistent()
            .get(&DataKey::PlatformFeeSnapshot(escrow_id))
            .unwrap_or(EscrowFeeSnapshot {
                fee_bps: 0,
                fee_amount: 0,
                collected: false,
            });

        if snapshot.collected {
            return Err(EscrowError::E9);
        }

        // Calculate fee if not pre-computed
        if snapshot.fee_amount == 0 {
            let (bps, amount) = calculate_fee(env, meta.total_amount);
            snapshot.fee_bps = bps;
            snapshot.fee_amount = amount;
        }

        if snapshot.fee_amount == 0 {
            snapshot.collected = true;
            env.storage()
                .persistent()
                .set(&DataKey::PlatformFeeSnapshot(escrow_id), &snapshot);
            return Ok(0);
        }

        // Get treasury
        let treasury: soroban_sdk::Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(EscrowError::E2)?;

        // Transfer fee to treasury
        token::Client::new(env, &meta.token).transfer(
            &env.current_contract_address(),
            &treasury,
            &snapshot.fee_amount,
        );

        snapshot.collected = true;
        env.storage()
            .persistent()
            .set(&DataKey::PlatformFeeSnapshot(escrow_id), &snapshot);

        events::emit_referral_payout(env, escrow_id, &treasury, snapshot.fee_amount);

        Ok(snapshot.fee_amount)
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn test_calculate_fee_math() {
        // 100 bps = 1% of 1_000_000 = 10_000
        let amount: i128 = 1_000_000;
        let bps: u32 = 100;
        let fee = amount * (bps as i128) / 10_000;
        assert_eq!(fee, 10_000);

        // 0 bps = no fee
        let zero_fee = amount * 0_i128 / 10_000;
        assert_eq!(zero_fee, 0);
    }

    #[test]
    fn test_calculate_fee_basic_math() {
        // 100 bps = 1% of 1_000_000 = 10_000
        let fee = 1_000_000_i128 * 100 / 10_000;
        assert_eq!(fee, 10_000);
    }

    // ── Caller and bound checks (#669, #670) ─────────────────────────────────

    use super::calculate_fee;
    use crate::{
        DataKey, EscrowContract, EscrowContractClient, EscrowError, FeeTier, MultisigConfig,
    };
    use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::{token, Address, BytesN, Env, IntoVal, Vec};

    fn tiers(env: &Env, fee_bps: u32) -> Vec<FeeTier> {
        let mut tiers = Vec::new(env);
        tiers.push_back(FeeTier {
            min_total_amount: 0,
            fee_bps,
        });
        tiers
    }

    /// #669: `calculate_fee` takes no caller; 0, negative and `i128::MAX`
    /// totals return a fee without overflowing.
    #[test]
    fn test_calculate_fee_caller_and_bounds() {
        let env = Env::default();
        let id = env.register_contract(None, EscrowContract);
        env.as_contract(&id, || {
            // No tiers configured: no fee.
            assert_eq!(calculate_fee(&env, i128::MAX), (0, 0));

            env.storage()
                .instance()
                .set(&DataKey::PlatformFeeTiers, &tiers(&env, 250));
            assert_eq!(calculate_fee(&env, 0), (250, 0));
            assert_eq!(calculate_fee(&env, 1_000_000), (250, 25_000));
            assert_eq!(calculate_fee(&env, 10_001), (250, 250));
            // Below the first tier's minimum: no tier applies.
            assert_eq!(calculate_fee(&env, i128::MIN), (0, 0));
            assert_eq!(
                calculate_fee(&env, i128::MAX),
                (250, i128::MAX / 10_000 * 250 + (i128::MAX % 10_000) * 250 / 10_000)
            );

            env.storage()
                .instance()
                .set(&DataKey::PlatformFeeTiers, &tiers(&env, 10_000));
            assert_eq!(calculate_fee(&env, i128::MAX), (10_000, i128::MAX));
        });
        assert!(env.auths().is_empty());
    }

    fn setup() -> (Env, Address, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let client = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));
        client.initialize(&admin);
        client.set_platform_treasury(&admin, &Address::generate(&env));
        client.set_platform_fee_tiers(&admin, &tiers(&env, 0));
        (env, admin, token, client)
    }

    fn create_escrow(
        env: &Env,
        client: &EscrowContractClient,
        token: &Address,
        depositor: &Address,
    ) -> u64 {
        let amount: i128 = 10_000;
        token::StellarAssetClient::new(env, token).mint(depositor, &(amount + 1_000));
        client.create_escrow(
            depositor,
            &Address::generate(env),
            token,
            &amount,
            &BytesN::from_array(env, &[1; 32]),
            &None::<Address>,
            &None::<u64>,
            &None::<u64>,
            &None,
            &MultisigConfig {
                approvers: Vec::new(env),
                weights: Vec::new(env),
                threshold: 0,
            },
            &None,
        )
    }

    /// #670: `collect_fee` only accepts the admin or the escrow's client,
    /// rejects 0 / `u64::MAX` escrow ids and active or already-collected
    /// escrows with the crate's errors instead of panicking.
    #[test]
    fn test_collect_fee_caller_and_bounds() {
        let (env, admin, token, client) = setup();
        let depositor = Address::generate(&env);
        let stranger = Address::generate(&env);

        assert_eq!(
            client.try_collect_escrow_fee(&admin, &0),
            Err(Ok(EscrowError::E8))
        );
        assert_eq!(
            client.try_collect_escrow_fee(&admin, &u64::MAX),
            Err(Ok(EscrowError::E8))
        );

        let escrow_id = create_escrow(&env, &client, &token, &depositor);
        assert_eq!(
            client.try_collect_escrow_fee(&stranger, &escrow_id),
            Err(Ok(EscrowError::E3))
        );
        // Still active: nothing to collect yet.
        assert_eq!(
            client.try_collect_escrow_fee(&depositor, &escrow_id),
            Err(Ok(EscrowError::E9))
        );

        client.cancel_escrow(&depositor, &escrow_id);
        assert_eq!(client.collect_escrow_fee(&depositor, &escrow_id), 0);
        // Only once per escrow.
        assert_eq!(
            client.try_collect_escrow_fee(&admin, &escrow_id),
            Err(Ok(EscrowError::E9))
        );
    }

    /// #670: another address cannot authorize a collection for `caller`.
    #[test]
    fn test_collect_fee_rejects_other_signer() {
        let (env, _admin, token, client) = setup();
        let depositor = Address::generate(&env);
        let stranger = Address::generate(&env);
        let escrow_id = create_escrow(&env, &client, &token, &depositor);
        client.cancel_escrow(&depositor, &escrow_id);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "collect_escrow_fee",
                args: (depositor.clone(), escrow_id).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        assert!(client.try_collect_escrow_fee(&depositor, &escrow_id).is_err());
    }
}
