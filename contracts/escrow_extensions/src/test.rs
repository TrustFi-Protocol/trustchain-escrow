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
