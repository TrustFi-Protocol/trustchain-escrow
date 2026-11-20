#![allow(dead_code)]
//! Freelancer Performance Staking
//!
//! Enables freelancers to deposit a configurable stake that can be slashed
//! if disputes are resolved against them.

use soroban_sdk::{token, Address, Env};

use crate::{ContractStorage, EscrowError};

/// Deposit the required freelancer stake and activate the escrow.
///
/// The freelancer must transfer the required stake amount before calling this.
/// Upon success, the escrow transitions from Pending to Active.
pub fn deposit_stake_and_activate(
    env: &Env,
    escrow_id: u64,
    freelancer: &Address,
) -> Result<(), EscrowError> {
    freelancer.require_auth();
    let mut meta = ContractStorage::load_escrow_meta_with_rent(env, escrow_id)?;

    // Validate the freelancer
    if *freelancer != meta.freelancer {
        return Err(EscrowError::E3);
    }

    // Check if stake is already deposited
    let stake_key = crate::DataKey::FreelancerStake(escrow_id);
    let already_deposited: bool = env
        .storage()
        .persistent()
        .get(&stake_key)
        .unwrap_or(false);

    if already_deposited {
        return Err(EscrowError::E19); // Reuse existing error for "stake already deposited"
    }

    // Load the required stake amount; a negative stake is rejected rather
    // than handed to the token contract (which would panic).
    let stake_amount = meta.required_freelancer_stake;
    if stake_amount < 0 {
        return Err(EscrowError::E19);
    }

    // Transfer stake from freelancer to contract
    if stake_amount > 0 {
        token::Client::new(env, &meta.token).transfer(
            freelancer,
            &env.current_contract_address(),
            &stake_amount,
        );
    }

    // Mark stake as deposited
    env.storage().persistent().set(&stake_key, &true);

    // Transition to Active status
    meta.stake_deposited = true;
    ContractStorage::save_escrow_meta(env, &meta);

    Ok(())
}

/// Return the full stake to the freelancer on escrow completion.
pub fn return_stake_on_completion(
    env: &Env,
    meta: &crate::EscrowMeta,
) -> Result<(), EscrowError> {
    if meta.required_freelancer_stake == 0 {
        return Ok(());
    }

    // Transfer stake back to freelancer
    token::Client::new(env, &meta.token).transfer(
        &env.current_contract_address(),
        &meta.freelancer,
        &meta.required_freelancer_stake,
    );

    Ok(())
}

/// Slash a portion of the stake and transfer it to the client.
/// Used when a dispute is resolved in favor of the client.
///
/// The slash amount is typically a percentage of the required stake.
#[deny(clippy::arithmetic_side_effects)]
pub fn slash_stake_to_client(
    env: &Env,
    meta: &crate::EscrowMeta,
    slash_percentage: u32, // 0-100
) -> Result<(), EscrowError> {
    if meta.required_freelancer_stake == 0 || !meta.stake_deposited {
        return Ok(());
    }

    if slash_percentage == 0 {
        return Ok(());
    }

    if slash_percentage > 100 {
        return Err(EscrowError::E19);
    }

    // A negative stake cannot be slashed; `as u128` would wrap it into a
    // huge positive amount, so convert with a check instead.
    let stake = u128::try_from(meta.required_freelancer_stake).map_err(|_| EscrowError::E28)?;
    let slash_amount_u128 = stake
        .checked_mul(u128::from(slash_percentage))
        .and_then(|v| v.checked_div(100))
        .ok_or(EscrowError::E28)?;
    let slash_amount =
        i128::try_from(slash_amount_u128).map_err(|_| EscrowError::E28)?;

    if slash_amount > 0 {
        token::Client::new(env, &meta.token).transfer(
            &env.current_contract_address(),
            &meta.client,
            &slash_amount,
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EscrowContract, EscrowContractClient, EscrowMeta, MultisigConfig};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{BytesN, Vec};

    struct Setup {
        env: Env,
        client: EscrowContractClient<'static>,
        token: Address,
        depositor: Address,
        freelancer: Address,
        escrow_id: u64,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let client = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));
        client.initialize(&admin);
        let depositor = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let amount: i128 = 10_000;
        token::StellarAssetClient::new(&env, &token).mint(&depositor, &(amount + 1_000));
        let escrow_id = client.create_escrow(
            &depositor,
            &freelancer,
            &token,
            &amount,
            &BytesN::from_array(&env, &[1; 32]),
            &None::<Address>,
            &None::<u64>,
            &None::<u64>,
            &None,
            &MultisigConfig {
                approvers: Vec::new(&env),
                weights: Vec::new(&env),
                threshold: 0,
            },
            &None,
        );
        Setup {
            env,
            client,
            token,
            depositor,
            freelancer,
            escrow_id,
        }
    }

    fn meta(t: &Setup) -> EscrowMeta {
        t.env.as_contract(&t.client.address, || {
            ContractStorage::load_escrow_meta(&t.env, t.escrow_id).unwrap()
        })
    }

    fn set_stake(t: &Setup, stake: i128, deposited: bool) {
        t.env.as_contract(&t.client.address, || {
            let mut m = ContractStorage::load_escrow_meta(&t.env, t.escrow_id).unwrap();
            m.required_freelancer_stake = stake;
            m.stake_deposited = deposited;
            ContractStorage::save_escrow_meta(&t.env, &m);
        });
    }

    fn deposit(t: &Setup, escrow_id: u64, freelancer: &Address) -> Result<(), EscrowError> {
        t.env.as_contract(&t.client.address, || {
            deposit_stake_and_activate(&t.env, escrow_id, freelancer)
        })
    }

    fn balance(t: &Setup, who: &Address) -> i128 {
        token::Client::new(&t.env, &t.token).balance(who)
    }

    /// #672: only the escrow's freelancer may deposit; unknown escrow ids
    /// (0, u64::MAX), a second deposit and a negative stake return errors.
    #[test]
    fn test_deposit_stake_and_activate_caller_and_bounds() {
        let t = setup();
        let stranger = Address::generate(&t.env);

        assert_eq!(deposit(&t, 0, &t.freelancer), Err(EscrowError::E8));
        assert_eq!(deposit(&t, u64::MAX, &t.freelancer), Err(EscrowError::E8));
        assert_eq!(deposit(&t, t.escrow_id, &stranger), Err(EscrowError::E3));
        assert_eq!(deposit(&t, t.escrow_id, &t.depositor), Err(EscrowError::E3));

        set_stake(&t, -1, false);
        assert_eq!(deposit(&t, t.escrow_id, &t.freelancer), Err(EscrowError::E19));

        set_stake(&t, 500, false);
        token::StellarAssetClient::new(&t.env, &t.token).mint(&t.freelancer, &500);
        let contract_before = balance(&t, &t.client.address);
        assert_eq!(deposit(&t, t.escrow_id, &t.freelancer), Ok(()));
        assert!(meta(&t).stake_deposited);
        assert_eq!(balance(&t, &t.freelancer), 0);
        assert_eq!(balance(&t, &t.client.address), contract_before + 500);

        // Only once per escrow.
        assert_eq!(deposit(&t, t.escrow_id, &t.freelancer), Err(EscrowError::E19));
    }

    /// #672: a zero required stake moves no tokens.
    #[test]
    fn test_deposit_stake_and_activate_zero_stake() {
        let t = setup();
        let contract_before = balance(&t, &t.client.address);
        assert_eq!(deposit(&t, t.escrow_id, &t.freelancer), Ok(()));
        assert!(meta(&t).stake_deposited);
        assert_eq!(balance(&t, &t.client.address), contract_before);
    }

    fn slash(t: &Setup, pct: u32) -> Result<(), EscrowError> {
        let m = meta(t);
        t.env
            .as_contract(&t.client.address, || slash_stake_to_client(&t.env, &m, pct))
    }

    /// #674: percentages above 100 (including u32::MAX) and stakes that do not
    /// fit the arithmetic return the crate's errors; 0 and no stake are no-ops.
    #[test]
    fn test_slash_stake_to_client_caller_and_bounds() {
        let t = setup();
        let client_before = balance(&t, &t.depositor);

        // No stake configured / not deposited: nothing happens.
        assert_eq!(slash(&t, 100), Ok(()));
        set_stake(&t, 1_000, false);
        assert_eq!(slash(&t, 100), Ok(()));
        assert_eq!(balance(&t, &t.depositor), client_before);

        set_stake(&t, 1_000, true);
        token::StellarAssetClient::new(&t.env, &t.token).mint(&t.client.address, &1_000);
        assert_eq!(slash(&t, 0), Ok(()));
        assert_eq!(slash(&t, 101), Err(EscrowError::E19));
        assert_eq!(slash(&t, u32::MAX), Err(EscrowError::E19));
        assert_eq!(balance(&t, &t.depositor), client_before);

        // The slashed share goes to the escrow's client, never another address.
        assert_eq!(slash(&t, 25), Ok(()));
        assert_eq!(balance(&t, &t.depositor), client_before + 250);
        assert_eq!(balance(&t, &t.freelancer), 0);

        // A corrupt negative stake fails the checked arithmetic instead of
        // panicking or paying out.
        set_stake(&t, -1, true);
        assert_eq!(slash(&t, 1), Err(EscrowError::E28));
        assert_eq!(slash(&t, 100), Err(EscrowError::E28));
        assert_eq!(balance(&t, &t.depositor), client_before + 250);
    }

    /// #674: the maximum stake slashed at 100% does not overflow.
    #[test]
    fn test_slash_stake_to_client_max_stake() {
        let t = setup();
        let client_before = balance(&t, &t.depositor);
        let room = i128::MAX - client_before;
        set_stake(&t, room, true);
        // Top the contract up to exactly `room` so the mint cannot overflow.
        let held = balance(&t, &t.client.address);
        token::StellarAssetClient::new(&t.env, &t.token).mint(&t.client.address, &(room - held));
        assert_eq!(slash(&t, 100), Ok(()));
        assert_eq!(balance(&t, &t.depositor), i128::MAX);
    }
}
