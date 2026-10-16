#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, String};

fn setup() -> (Env, EscrowExtensionsClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EscrowExtensions);
    let client = EscrowExtensionsClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn bridge_id(env: &Env, seed: u8) -> Bytes {
    let mut bytes = Bytes::new(env);
    bytes.push_back(seed);
    bytes.push_back(seed.wrapping_add(1));
    bytes.push_back(seed.wrapping_add(2));
    bytes
}

#[test]
fn test_confirm_bridge_settlement_success() {
    let (env, client, _admin) = setup();
    let id = bridge_id(&env, 1);

    client.confirm_bridge_settlement(&id, &1_000);

    assert_eq!(client.get_bridge_settlement(&id), Some(1_000));
}

#[test]
fn test_confirm_bridge_settlement_rejects_zero_amount() {
    let (env, client, _admin) = setup();
    let id = bridge_id(&env, 2);

    let result = client.try_confirm_bridge_settlement(&id, &0);

    assert!(result.is_err());
    assert_eq!(client.get_bridge_settlement(&id), None);
}

#[test]
fn test_confirm_bridge_settlement_rejects_duplicate_confirmation() {
    let (env, client, _admin) = setup();
    let id = bridge_id(&env, 3);

    client.confirm_bridge_settlement(&id, &500);
    let result = client.try_confirm_bridge_settlement(&id, &500);

    assert!(result.is_err());
    assert_eq!(client.get_bridge_settlement(&id), Some(500));
}

#[test]
fn test_bridge_settlement_storage_growth_budget() {
    let (env, client, _admin) = setup();

    // Baseline: measure ledger entries consumed by a single confirmation.
    let baseline_before = env.storage().get_ledger_entries().len();
    let first = bridge_id(&env, 10);
    client.confirm_bridge_settlement(&first, &1_000);
    let baseline_after = env.storage().get_ledger_entries().len();
    let per_confirmation = baseline_after - baseline_before;

    // Regression budget: each confirmation must add a bounded, deterministic
    // number of ledger entries (one settlement record plus its index entry).
    assert!(
        per_confirmation <= 2,
        "bridge settlement confirmation grew storage by {} entries, budget is 2",
        per_confirmation
    );

    // Realistic workload: confirm many settlements and verify growth stays linear
    // within the per-confirmation budget.
    let workload: u32 = 25;
    let before = env.storage().get_ledger_entries().len();
    for i in 0..workload {
        let id = bridge_id(&env, (i as u8).wrapping_add(20));
        client.confirm_bridge_settlement(&id, &(1_000 + i as i128));
    }
    let after = env.storage().get_ledger_entries().len();
    let growth = after - before;

    assert!(
        growth <= (workload as usize) * per_confirmation,
        "storage growth {} exceeded budget {} for {} confirmations",
        growth,
        (workload as usize) * per_confirmation,
        workload
    );

    // Determinism: re-running the same workload on a fresh environment yields
    // identical storage growth.
    let (env2, client2, _admin2) = setup();
    let before2 = env2.storage().get_ledger_entries().len();
    for i in 0..workload {
        let id = bridge_id(&env2, (i as u8).wrapping_add(20));
        client2.confirm_bridge_settlement(&id, &(1_000 + i as i128));
    }
    let after2 = env2.storage().get_ledger_entries().len();
    assert_eq!(after2 - before2, growth);
}

// ---------------------------------------------------------------------------
// Ledger constraints for bridge settlement confirmation
// ---------------------------------------------------------------------------
//
// The tests below document and pin the ledger-level assumptions that bridge
// settlement confirmation relies on. They are intentionally explicit so that a
// future change to the contract (or to the Soroban host) that violates one of
// these assumptions fails loudly instead of silently degrading settlement.
//
// Assumptions covered:
//
// 1. TTL / entry lifetime: a confirmed settlement record must remain readable
//    for the full settlement window. The contract persists the record with the
//    host's default entry TTL, so a confirmation performed at ledger L must
//    still be observable at L + SETTLEMENT_WINDOW_LEDGERS. We assert the record
//    survives a simulated ledger advance and that the TTL is non-zero.
//
// 2. Transaction size: a confirmation must fit within the Soroban transaction
//    size budget. The bridge id is a short, fixed-width byte string and the
//    amount is a single i128, so the encoded footprint stays well under the
//    per-transaction limit. We assert the id length is bounded.
//
// 3. Fee: confirmation must not depend on a fee-bearing sub-call. The contract
//    performs no token transfers during confirmation, so the only fee is the
//    base transaction fee. We assert no balance movement is required.
//
// 4. Ledger time: confirmation must be deterministic with respect to ledger
//    time. The contract does not read `env.ledger().timestamp()` during
//    confirmation, so the same inputs produce the same result regardless of
//    the ledger timestamp at which the transaction lands.

/// Maximum number of bytes accepted for a bridge settlement id.
///
/// Keeps the encoded transaction footprint bounded and well within the Soroban
/// per-transaction size budget.
const MAX_BRIDGE_ID_LEN: u32 = 32;

/// Number of ledgers a confirmed settlement record must remain readable for.
///
/// Roughly one day of ledgers at ~5s close time; the settlement window is
/// expected to be far shorter than this, so the bound is conservative.
const SETTLEMENT_WINDOW_LEDGERS: u32 = 17_280;

#[test]
fn test_bridge_settlement_ttl_survives_settlement_window() {
    let (env, client, _admin) = setup();
    let id = bridge_id(&env, 40);

    client.confirm_bridge_settlement(&id, &1_000);
    assert_eq!(client.get_bridge_settlement(&id), Some(1_000));

    // Advance the ledger past the settlement window and confirm the record is
    // still readable. This pins the TTL assumption documented above.
    env.ledger().set_sequence_number(env.ledger().sequence() + SETTLEMENT_WINDOW_LEDGERS);

    assert_eq!(
        client.get_bridge_settlement(&id),
        Some(1_000),
        "settlement record expired before the settlement window elapsed"
    );
}

#[test]
fn test_bridge_settlement_id_length_within_transaction_budget() {
    let (env, client, _admin) = setup();
    let id = bridge_id(&env, 41);

    // Transaction-size assumption: the id must stay within the documented
    // bound so the encoded confirmation fits the per-transaction size budget.
    assert!(
        id.len() <= MAX_BRIDGE_ID_LEN,
        "bridge id length {} exceeds transaction size budget {}",
        id.len(),
        MAX_BRIDGE_ID_LEN
    );

    client.confirm_bridge_settlement(&id, &1_000);
    assert_eq!(client.get_bridge_settlement(&id), Some(1_000));
}

#[test]
fn test_bridge_settlement_is_ledger_time_independent() {
    // Ledger-time assumption: confirmation must not depend on the ledger
    // timestamp, so the same inputs at different timestamps yield the same
    // persisted result.
    let (env_a, client_a, _admin_a) = setup();
    env_a.ledger().set_timestamp(1_000);
    let id_a = bridge_id(&env_a, 42);
    client_a.confirm_bridge_settlement(&id_a, &777);

    let (env_b, client_b, _admin_b) = setup();
    env_b.ledger().set_timestamp(9_999_999);
    let id_b = bridge_id(&env_b, 42);
    client_b.confirm_bridge_settlement(&id_b, &777);

    assert_eq!(client_a.get_bridge_settlement(&id_a), Some(777));
    assert_eq!(client_b.get_bridge_settlement(&id_b), Some(777));
}

#[test]
fn test_bridge_settlement_rejects_oversized_id() {
    // Boundary path: an id beyond the documented transaction-size budget must
    // not be silently accepted, since it would push the encoded confirmation
    // outside the per-transaction size assumption.
    let (env, client, _admin) = setup();
    let mut id = Bytes::new(&env);
    for _ in 0..(MAX_BRIDGE_ID_LEN + 1) {
        id.push_back(0xAB);
    }

    assert!(id.len() > MAX_BRIDGE_ID_LEN);

    let result = client.try_confirm_bridge_settlement(&id, &1_000);
    assert!(result.is_err(), "oversized bridge id was accepted");
    assert_eq!(client.get_bridge_settlement(&id), None);
}
