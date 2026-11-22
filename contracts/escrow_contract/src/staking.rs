#![allow(dead_code)]
//! Freelancer Performance Staking
//!
//! Enables freelancers to deposit a configurable stake that can be slashed
//! if disputes are resolved against them.
//!
//! The required stake and the deposit flag are stored under their own
//! `StakeKey` entries (keyed by escrow id) so staking does not change the
//! stored `EscrowMeta` layout.

use soroban_sdk::{contracttype, token, Address, Env};

use crate::{ContractStorage, EscrowError, EscrowMeta};

/// Storage keys for per-escrow staking state.
#[contracttype]
#[derive(Clone)]
pub enum StakeKey {
    /// Required freelancer stake for escrow_id — value: i128
    Required(u64),
    /// Whether the freelancer stake has been deposited for escrow_id — value: bool
    Deposited(u64),
}

/// Configure the stake the freelancer must deposit for `escrow_id`.
/// Negative amounts are rejected with `E19`; unknown escrows with `E8`.
pub fn set_required_stake(env: &Env, escrow_id: u64, amount: i128) -> Result<(), EscrowError> {
    if amount < 0 {
        return Err(EscrowError::E19);
    }
    ContractStorage::load_escrow_meta(env, escrow_id)?;
    env.storage()
        .persistent()
        .set(&StakeKey::Required(escrow_id), &amount);
    Ok(())
}

/// The stake required from the freelancer for `escrow_id` (0 when unset).
pub fn required_stake(env: &Env, escrow_id: u64) -> i128 {
    env.storage()
        .persistent()
        .get(&StakeKey::Required(escrow_id))
        .unwrap_or(0)
}

/// Whether the freelancer stake has been deposited for `escrow_id`.
pub fn is_stake_deposited(env: &Env, escrow_id: u64) -> bool {
    env.storage()
        .persistent()
        .get(&StakeKey::Deposited(escrow_id))
        .unwrap_or(false)
}

/// Reject a caller-supplied `meta` whose parties do not match the stored
/// escrow, so stake can only move between the escrow's real client and
/// freelancer.
fn require_stored_parties(env: &Env, meta: &EscrowMeta) -> Result<(), EscrowError> {
    let stored = ContractStorage::load_escrow_meta(env, meta.escrow_id)?;
    if stored.client != meta.client || stored.freelancer != meta.freelancer || stored.token != meta.token {
        return Err(EscrowError::E3);
    }
    Ok(())
}

/// Return `E19` instead of letting the token transfer trap on an
/// insufficient balance.
fn require_balance(env: &Env, token: &Address, holder: &Address, amount: i128) -> Result<(), EscrowError> {
    if token::Client::new(env, token).balance(holder) < amount {
        return Err(EscrowError::E19);
    }
    Ok(())
}

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
    let meta = ContractStorage::load_escrow_meta_with_rent(env, escrow_id)?;

    // Validate the freelancer
    if *freelancer != meta.freelancer {
        return Err(EscrowError::E3);
    }

    // Check if stake is already deposited
    if is_stake_deposited(env, escrow_id) {
        return Err(EscrowError::E19); // Reuse existing error for "stake already deposited"
    }

    // Load the required stake amount
    let stake_amount = required_stake(env, escrow_id);
    if stake_amount < 0 {
        return Err(EscrowError::E19);
    }
    require_balance(env, &meta.token, freelancer, stake_amount)?;

    // Transfer stake from freelancer to contract
    if stake_amount > 0 {
        token::Client::new(env, &meta.token).transfer(
            freelancer,
            &env.current_contract_address(),
            &stake_amount,
        );
    }

    // Mark stake as deposited
    env.storage()
        .persistent()
        .set(&StakeKey::Deposited(escrow_id), &true);

    Ok(())
}

/// Return the full stake to the freelancer on escrow completion.
pub fn return_stake_on_completion(
    env: &Env,
    meta: &crate::EscrowMeta,
) -> Result<(), EscrowError> {
    require_stored_parties(env, meta)?;

    let stake_amount = required_stake(env, meta.escrow_id);
    if stake_amount == 0 || !is_stake_deposited(env, meta.escrow_id) {
        return Ok(());
    }
    if stake_amount < 0 {
        return Err(EscrowError::E19);
    }
    require_balance(env, &meta.token, &env.current_contract_address(), stake_amount)?;

    // Transfer stake back to freelancer
    token::Client::new(env, &meta.token).transfer(
        &env.current_contract_address(),
        &meta.freelancer,
        &stake_amount,
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
    if slash_percentage > 100 {
        return Err(EscrowError::E19);
    }

    require_stored_parties(env, meta)?;

    let stake_amount = required_stake(env, meta.escrow_id);
    if stake_amount == 0 || !is_stake_deposited(env, meta.escrow_id) {
        return Ok(());
    }
    if stake_amount < 0 {
        return Err(EscrowError::E19);
    }

    if slash_percentage == 0 {
        return Ok(());
    }

    let slash_amount_u128 = (stake_amount as u128)
        .checked_mul(slash_percentage as u128)
        .and_then(|v| v.checked_div(100))
        .ok_or(EscrowError::E28)?;
    let slash_amount =
        i128::try_from(slash_amount_u128).map_err(|_| EscrowError::E28)?;

    if slash_amount > 0 {
        require_balance(env, &meta.token, &env.current_contract_address(), slash_amount)?;
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
    use crate::{EscrowContract, EscrowContractClient, MultisigConfig};
    use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, BytesN};

    const STAKE: i128 = 100;

    struct Fixture {
        env: Env,
        contract_id: Address,
        token: Address,
        client: Address,
        freelancer: Address,
        escrow_id: u64,
    }

    fn setup_without_escrow() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        EscrowContractClient::new(&env, &contract_id).initialize(&admin);
        (env, contract_id)
    }

    fn setup() -> Fixture {
        let (env, contract_id) = setup_without_escrow();
        let escrow = EscrowContractClient::new(&env, &contract_id);
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(token_admin).address();
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&client, &1030);
        sac.mint(&freelancer, &STAKE);

        let escrow_id = escrow.create_escrow(
            &client,
            &freelancer,
            &token,
            &500,
            &BytesN::from_array(&env, &[1; 32]),
            &None,
            &None,
            &None,
            &None,
            &MultisigConfig {
                approvers: soroban_sdk::Vec::new(&env),
                weights: soroban_sdk::Vec::new(&env),
                threshold: 0,
            },
            &None,
        );
        env.as_contract(&contract_id, || set_required_stake(&env, escrow_id, STAKE).unwrap());

        Fixture { env, contract_id, token, client, freelancer, escrow_id }
    }

    fn balance(f: &Fixture, who: &Address) -> i128 {
        token::Client::new(&f.env, &f.token).balance(who)
    }

    fn meta(f: &Fixture) -> EscrowMeta {
        f.env
            .as_contract(&f.contract_id, || ContractStorage::load_escrow_meta(&f.env, f.escrow_id).unwrap())
    }

    fn deposit(f: &Fixture) {
        f.env.as_contract(&f.contract_id, || {
            deposit_stake_and_activate(&f.env, f.escrow_id, &f.freelancer).unwrap()
        });
    }

    // ── deposit_stake_and_activate (#672) ────────────────────────────────────

    #[test]
    fn test_deposit_stake_and_activate_by_freelancer_succeeds() {
        let f = setup();
        let contract_before = balance(&f, &f.contract_id);

        let result = f.env.as_contract(&f.contract_id, || {
            deposit_stake_and_activate(&f.env, f.escrow_id, &f.freelancer)
        });

        assert_eq!(result, Ok(()));
        assert_eq!(balance(&f, &f.freelancer), 0);
        assert_eq!(balance(&f, &f.contract_id), contract_before + STAKE);
        assert!(f.env.as_contract(&f.contract_id, || is_stake_deposited(&f.env, f.escrow_id)));
    }

    #[test]
    fn test_deposit_stake_and_activate_rejects_other_address() {
        let f = setup();
        let stranger = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token).mint(&stranger, &STAKE);

        let result = f.env.as_contract(&f.contract_id, || {
            deposit_stake_and_activate(&f.env, f.escrow_id, &stranger)
        });

        assert_eq!(result, Err(EscrowError::E3));
        assert_eq!(balance(&f, &stranger), STAKE);
        assert!(!f.env.as_contract(&f.contract_id, || is_stake_deposited(&f.env, f.escrow_id)));
    }

    #[test]
    fn test_deposit_stake_and_activate_escrow_id_zero_and_max_return_error() {
        let (env, contract_id) = setup_without_escrow();
        let freelancer = Address::generate(&env);
        for escrow_id in [0_u64, u64::MAX] {
            let result = env.as_contract(&contract_id, || {
                deposit_stake_and_activate(&env, escrow_id, &freelancer)
            });
            assert_eq!(result, Err(EscrowError::E8));
        }
    }

    #[test]
    fn test_deposit_stake_and_activate_twice_returns_error() {
        let f = setup();
        deposit(&f);
        let result = f.env.as_contract(&f.contract_id, || {
            deposit_stake_and_activate(&f.env, f.escrow_id, &f.freelancer)
        });
        assert_eq!(result, Err(EscrowError::E19));
    }

    #[test]
    fn test_deposit_stake_and_activate_insufficient_balance_returns_error() {
        let f = setup();
        f.env.as_contract(&f.contract_id, || {
            set_required_stake(&f.env, f.escrow_id, i128::MAX).unwrap()
        });
        let result = f.env.as_contract(&f.contract_id, || {
            deposit_stake_and_activate(&f.env, f.escrow_id, &f.freelancer)
        });
        assert_eq!(result, Err(EscrowError::E19));
        assert_eq!(balance(&f, &f.freelancer), STAKE);
    }

    #[test]
    fn test_deposit_stake_and_activate_negative_stake_rejected() {
        let f = setup();
        let result = f
            .env
            .as_contract(&f.contract_id, || set_required_stake(&f.env, f.escrow_id, i128::MIN));
        assert_eq!(result, Err(EscrowError::E19));
    }

    // ── return_stake_on_completion (#673) ────────────────────────────────────

    #[test]
    fn test_return_stake_on_completion_returns_stake_to_freelancer() {
        let f = setup();
        deposit(&f);
        let meta = meta(&f);

        let result = f.env.as_contract(&f.contract_id, || return_stake_on_completion(&f.env, &meta));

        assert_eq!(result, Ok(()));
        assert_eq!(balance(&f, &f.freelancer), STAKE);
    }

    #[test]
    fn test_return_stake_on_completion_rejects_other_freelancer_address() {
        let f = setup();
        deposit(&f);
        let mut meta = meta(&f);
        let stranger = Address::generate(&f.env);
        meta.freelancer = stranger.clone();

        let result = f.env.as_contract(&f.contract_id, || return_stake_on_completion(&f.env, &meta));

        assert_eq!(result, Err(EscrowError::E3));
        assert_eq!(balance(&f, &stranger), 0);
    }

    #[test]
    fn test_return_stake_on_completion_without_deposit_moves_nothing() {
        let f = setup();
        let meta = meta(&f);
        let contract_before = balance(&f, &f.contract_id);

        let result = f.env.as_contract(&f.contract_id, || return_stake_on_completion(&f.env, &meta));

        assert_eq!(result, Ok(()));
        assert_eq!(balance(&f, &f.contract_id), contract_before);
    }

    #[test]
    fn test_return_stake_on_completion_zero_and_max_stake_do_not_panic() {
        let f = setup();
        deposit(&f);
        let meta = meta(&f);

        // Zero stake: nothing to return.
        f.env.as_contract(&f.contract_id, || set_required_stake(&f.env, f.escrow_id, 0).unwrap());
        let zero = f.env.as_contract(&f.contract_id, || return_stake_on_completion(&f.env, &meta));
        assert_eq!(zero, Ok(()));
        assert_eq!(balance(&f, &f.freelancer), 0);

        // Max stake: more than the contract holds is an error, not a trap.
        f.env.as_contract(&f.contract_id, || set_required_stake(&f.env, f.escrow_id, i128::MAX).unwrap());
        let max = f.env.as_contract(&f.contract_id, || return_stake_on_completion(&f.env, &meta));
        assert_eq!(max, Err(EscrowError::E19));
        assert_eq!(balance(&f, &f.freelancer), 0);
    }

    // ── slash_stake_to_client (#674) ─────────────────────────────────────────

    #[test]
    fn test_slash_stake_to_client_transfers_percentage_to_client() {
        let f = setup();
        deposit(&f);
        let meta = meta(&f);
        let client_before = balance(&f, &f.client);

        let result = f.env.as_contract(&f.contract_id, || slash_stake_to_client(&f.env, &meta, 50));

        assert_eq!(result, Ok(()));
        assert_eq!(balance(&f, &f.client), client_before + STAKE / 2);
    }

    #[test]
    fn test_slash_stake_to_client_rejects_other_client_address() {
        let f = setup();
        deposit(&f);
        let mut meta = meta(&f);
        let stranger = Address::generate(&f.env);
        meta.client = stranger.clone();

        let result = f.env.as_contract(&f.contract_id, || slash_stake_to_client(&f.env, &meta, 100));

        assert_eq!(result, Err(EscrowError::E3));
        assert_eq!(balance(&f, &stranger), 0);
    }

    #[test]
    fn test_slash_stake_to_client_zero_and_max_percentage() {
        let f = setup();
        deposit(&f);
        let meta = meta(&f);
        let client_before = balance(&f, &f.client);

        let zero = f.env.as_contract(&f.contract_id, || slash_stake_to_client(&f.env, &meta, 0));
        assert_eq!(zero, Ok(()));
        assert_eq!(balance(&f, &f.client), client_before);

        let max = f.env.as_contract(&f.contract_id, || slash_stake_to_client(&f.env, &meta, u32::MAX));
        assert_eq!(max, Err(EscrowError::E19));
        assert_eq!(balance(&f, &f.client), client_before);
    }

    #[test]
    fn test_slash_stake_to_client_max_stake_returns_error_instead_of_panicking() {
        let f = setup();
        deposit(&f);
        let meta = meta(&f);
        f.env.as_contract(&f.contract_id, || set_required_stake(&f.env, f.escrow_id, i128::MAX).unwrap());

        let result = f.env.as_contract(&f.contract_id, || slash_stake_to_client(&f.env, &meta, 100));

        assert!(matches!(result, Err(EscrowError::E19) | Err(EscrowError::E28)));
    }
}
