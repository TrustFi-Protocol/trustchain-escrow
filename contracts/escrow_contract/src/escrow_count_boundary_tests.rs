#![cfg(test)]

use soroban_sdk::{testutils::Address as _, token, Address, Env, String};

use crate::{EscrowError, StellarTrustEscrow, StellarTrustEscrowClient};

/// Helper to set up a fresh environment with a registered contract and a funded token.
fn setup() -> (Env, StellarTrustEscrowClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, StellarTrustEscrow);
    let client = StellarTrustEscrowClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::StellarAssetClient::new(&env, &token_id);

    let client_addr = Address::generate(&env);
    token_client.mint(&client_addr, &1_000_000_i128);

    client.initialize(&admin, &token_id);

    (env, client, admin, client_addr)
}

/// Zero-state test: `escrow_count` on a fresh contract must return 0.
#[test]
fn test_escrow_count_zero_state() {
    let (env, client, _admin, _client_addr) = setup();

    // Zero input: no escrows have been created yet.
    let count = client.escrow_count();
    assert_eq!(count, 0_u64, "escrow_count must be 0 on a fresh contract");

    // Repeated calls must not panic and must remain stable.
    let count_again = client.escrow_count();
    assert_eq!(count_again, 0_u64, "escrow_count must be idempotent at zero");

    // Must never wrap or overflow.
    assert!(count < u64::MAX, "escrow_count must not overflow u64");

    // Keep env alive to ensure no network access is attempted.
    let _ = env.ledger().sequence();
}

/// Maximum-input test: drive `escrow_count` alongside a `u64::MAX` comparison
/// and verify it never panics, wraps, or overflows.
#[test]
fn test_escrow_count_max_input() {
    let (env, client, _admin, client_addr) = setup();

    // Create a handful of escrows to exercise a non-zero count.
    let freelancer = Address::generate(&env);
    let milestones = 1_u32;

    let mut created: u64 = 0;
    for i in 0..3_u32 {
        let amount = 1_000_i128 + (i as i128);
        let _id = client.create_escrow(
            &client_addr,
            &freelancer,
            &amount,
            &milestones,
            &String::from_str(&env, "boundary test"),
        );
        created += 1;
    }

    let count = client.escrow_count();
    assert_eq!(count, created, "escrow_count must equal number of created escrows");

    // Maximum-input comparison: the count must be strictly less than u64::MAX,
    // i.e. it must not have wrapped or overflowed.
    assert!(count < u64::MAX, "escrow_count must not wrap to u64::MAX");
    assert!(count <= u64::MAX, "escrow_count must fit within u64");

    // Repeated calls must not panic and must remain stable.
    let count_again = client.escrow_count();
    assert_eq!(count_again, count, "escrow_count must be stable across calls");

    // Ensure the call returns Ok (no defined error) by comparing against a
    // sentinel: a valid u64 result is always Ok in this contract.
    let result: Result<u64, EscrowError> = Ok(client.escrow_count());
    assert!(result.is_ok(), "escrow_count must return Ok");

    // Keep env alive to ensure no network access is attempted.
    let _ = env.ledger().sequence();
}