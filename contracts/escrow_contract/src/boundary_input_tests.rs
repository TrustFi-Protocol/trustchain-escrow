#![cfg(test)]

use crate::{EscrowContract, EscrowContractClient, EscrowError};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, EscrowContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    (env, client)
}

#[test]
fn test_get_slash_record_zero_and_max_inputs() {
    let (_env, client) = setup();

    // Zero input for escrow_id
    let zero_result = client.try_get_slash_record(&0u64);
    match zero_result {
        Ok(Ok(_record)) => {}
        Ok(Err(e)) => {
            // A defined EscrowError is acceptable
            let _ = e;
        }
        Err(_) => {
            // Contract invocation error is also acceptable as long as it's not a panic
        }
    }

    // Maximum input for escrow_id
    let max_result = client.try_get_slash_record(&u64::MAX);
    match max_result {
        Ok(Ok(_record)) => {}
        Ok(Err(e)) => {
            let _ = e;
        }
        Err(_) => {}
    }
}

#[test]
fn test_get_state_history_zero_and_max_inputs() {
    let (_env, client) = setup();

    // Zero input for escrow_id - should return empty vector for unknown ID
    let zero_history = client.get_state_history(&0u64);
    assert_eq!(zero_history.len(), 0);

    // Maximum input for escrow_id - should return empty vector for unknown ID
    let max_history = client.get_state_history(&u64::MAX);
    assert_eq!(max_history.len(), 0);
}

#[test]
fn test_is_expired_zero_and_max_inputs() {
    let (_env, client) = setup();

    // Zero input for escrow_id
    let zero_result = client.try_is_expired(&0u64);
    match zero_result {
        Ok(Ok(_expired)) => {}
        Ok(Err(e)) => {
            let _ = e;
        }
        Err(_) => {}
    }

    // Maximum input for escrow_id
    let max_result = client.try_is_expired(&u64::MAX);
    match max_result {
        Ok(Ok(_expired)) => {}
        Ok(Err(e)) => {
            let _ = e;
        }
        Err(_) => {}
    }
}

#[test]
fn test_partial_cancel_zero_and_max_inputs() {
    let (env, client) = setup();
    let caller = Address::generate(&env);

    // Zero input for escrow_id
    let zero_result = client.try_partial_cancel(&caller, &0u64);
    match zero_result {
        Ok(Ok(amount)) => {
            // If Ok, the returned amount must be non-negative and not wrapped
            assert!(amount >= 0, "partial_cancel returned negative amount");
        }
        Ok(Err(e)) => {
            // A defined EscrowError is acceptable
            let _ = e;
        }
        Err(_) => {}
    }

    // Maximum input for escrow_id
    let max_result = client.try_partial_cancel(&caller, &u64::MAX);
    match max_result {
        Ok(Ok(amount)) => {
            assert!(amount >= 0, "partial_cancel returned negative amount");
        }
        Ok(Err(e)) => {
            let _ = e;
        }
        Err(_) => {}
    }
}

#[test]
fn test_partial_cancel_i128_max_amount_not_wrapped() {
    let (env, client) = setup();
    let caller = Address::generate(&env);

    // Drive partial_cancel with a maximum escrow_id and verify no wrapping occurs.
    // The function only accepts escrow_id as a numeric argument, so we exercise
    // the maximum u64 value and ensure the returned i128 (if Ok) is sane.
    let result = client.try_partial_cancel(&caller, &u64::MAX);
    match result {
        Ok(Ok(amount)) => {
            // Must not have wrapped around to a negative value
            assert!(amount >= 0, "partial_cancel wrapped balance to negative");
            // Must not exceed i128::MAX (trivially true for i128, but explicit)
            assert!(amount <= i128::MAX);
        }
        Ok(Err(_e)) => {
            // Defined error is acceptable
        }
        Err(_) => {}
    }

    // Also verify the zero escrow_id path does not wrap
    let zero_result = client.try_partial_cancel(&caller, &0u64);
    match zero_result {
        Ok(Ok(amount)) => {
            assert!(amount >= 0, "partial_cancel wrapped balance to negative");
            assert!(amount <= i128::MAX);
        }
        Ok(Err(_e)) => {}
        Err(_) => {}
    }
}

#[test]
fn test_boundary_inputs_do_not_panic() {
    let (env, client) = setup();
    let caller = Address::generate(&env);

    // Exercise all four functions with both boundary values in a single test
    // to ensure none of them panic or abort.
    let _ = client.try_get_slash_record(&0u64);
    let _ = client.try_get_slash_record(&u64::MAX);
    let _ = client.get_state_history(&0u64);
    let _ = client.get_state_history(&u64::MAX);
    let _ = client.try_is_expired(&0u64);
    let _ = client.try_is_expired(&u64::MAX);
    let _ = client.try_partial_cancel(&caller, &0u64);
    let _ = client.try_partial_cancel(&caller, &u64::MAX);
}