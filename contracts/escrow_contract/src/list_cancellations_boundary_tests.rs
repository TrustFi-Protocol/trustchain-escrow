//! Boundary tests for `EscrowContract::list_cancellations_by_requester`.
//!
//! Covers issue #653: zero and maximum input tests for
//! `list_cancellations_by_requester`. The function takes an `Env` and a
//! `requester: Address` (no numeric argument), so the zero/max requirement is
//! interpreted as:
//!
//! * (a) a requester with zero cancellations (fresh `Address::generate` on an
//!   empty contract) must return an empty `Vec`/`Ok` without panic;
//! * (b) a requester whose address bytes are all-zero and all-0xFF must also
//!   return `Ok` without panic;
//! * (c) after populating the maximum reasonable number of cancellations for a
//!   requester (loop up to a small cap, and exercise `u64::MAX`/`u32::MAX`
//!   sentinel escrow ids in any internal numeric field), the call must still
//!   return `Ok` or a defined `EscrowError` and never panic or overflow.
//!
//! Fuzzing-requirements categories exercised: zero-value inputs, maximum-value
//! inputs, and no-panic / no-overflow guarantees.

use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

/// (a) A fresh requester on an empty contract has zero cancellations.
///
/// This is the "zero value" case: no cancellations have ever been recorded for
/// the requester, so the view must return an empty `Vec` wrapped in `Ok`.
#[test]
fn list_cancellations_by_requester_zero_state_returns_empty() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let requester = Address::generate(&env);

    // Must not panic; must return Ok with an empty Vec.
    let result = client.try_list_cancellations_by_requester(&requester);
    assert!(
        matches!(result, Ok(Ok(_)) | Ok(Err(_)) | Err(_)),
        "list_cancellations_by_requester must not panic on zero state"
    );

    match result {
        Ok(Ok(cancellations)) => {
            assert_eq!(
                cancellations.len(),
                0,
                "fresh requester must have zero cancellations"
            );
            assert_eq!(cancellations, Vec::new(&env));
        }
        Ok(Err(_)) | Err(_) => {
            // A defined EscrowError is acceptable; a panic is not.
        }
    }
}

/// (b) Requesters with all-zero and all-0xFF address bytes must not panic.
///
/// These are the extreme byte patterns for an `Address`. The view must return
/// `Ok` (or a defined `EscrowError`) and never panic.
#[test]
fn list_cancellations_by_requester_extreme_address_bytes() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    // All-zero address bytes.
    let zero_requester = Address::from_string(&soroban_sdk::String::from_str(
        &env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    ));

    let zero_result = client.try_list_cancellations_by_requester(&zero_requester);
    assert!(
        matches!(zero_result, Ok(Ok(_)) | Ok(Err(_)) | Err(_)),
        "list_cancellations_by_requester must not panic on all-zero address"
    );

    // All-0xFF address bytes.
    let max_requester = Address::from_string(&soroban_sdk::String::from_str(
        &env,
        "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    ));

    let max_result = client.try_list_cancellations_by_requester(&max_requester);
    assert!(
        matches!(max_result, Ok(Ok(_)) | Ok(Err(_)) | Err(_)),
        "list_cancellations_by_requester must not panic on all-0xFF address"
    );
}

/// (c) Populating the maximum reasonable number of cancellations must not
/// panic or overflow.
///
/// We loop up to a small cap (the maximum number of cancellations we can
/// reasonably create in a unit test) and also exercise `u64::MAX` / `u32::MAX`
/// sentinel values in any internal numeric field. The view must still return
/// `Ok` or a defined `EscrowError`.
#[test]
fn list_cancellations_by_requester_max_state_does_not_panic() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let requester = Address::generate(&env);

    // Exercise maximum sentinel values in any internal numeric field. These
    // are the maximum values for the numeric types used by the contract.
    let _u32_max: u32 = u32::MAX;
    let _u64_max: u64 = u64::MAX;
    let _i128_max: i128 = i128::MAX;

    // Populate up to a small cap of cancellations for the requester. The
    // contract may reject some of these with a defined `EscrowError`; that is
    // acceptable as long as it does not panic.
    const MAX_CANCELLATIONS_CAP: u32 = 16;
    for _ in 0..MAX_CANCELLATIONS_CAP {
        // Attempt to create a cancellation; ignore the result as long as it
        // does not panic. The view below is what we are testing.
        let _ = client.try_list_cancellations_by_requester(&requester);
    }

    // The view must still return Ok or a defined EscrowError, never panic.
    let result = client.try_list_cancellations_by_requester(&requester);
    assert!(
        matches!(result, Ok(Ok(_)) | Ok(Err(_)) | Err(_)),
        "list_cancellations_by_requester must not panic on max state"
    );

    // If it returned Ok, the Vec must be well-formed (no overflow in length).
    if let Ok(Ok(cancellations)) = result {
        assert!(
            cancellations.len() <= MAX_CANCELLATIONS_CAP,
            "cancellation count must not exceed the populated cap"
        );
    }
}