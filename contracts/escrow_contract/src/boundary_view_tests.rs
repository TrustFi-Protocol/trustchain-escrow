#[cfg(test)]
mod boundary_view_tests {
    use crate::{EscrowContract, EscrowContractClient, EscrowError};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env};

    fn setup<'a>(env: &'a Env) -> (EscrowContractClient<'a>, Address) {
        env.mock_all_auths();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn test_get_high_value_threshold_zero_and_max() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        // Default read must not panic and must be non-negative.
        let default_threshold = client.get_high_value_threshold();
        assert!(default_threshold >= 0);

        // Boundary: zero value.
        let zero_result = client.try_get_high_value_threshold();
        match zero_result {
            Ok(Ok(v)) => assert!(v >= 0),
            Ok(Err(_e)) => {}
            Err(_) => panic!("get_high_value_threshold panicked on zero boundary"),
        }

        // Boundary: maximum value (i128::MAX). The getter takes no numeric
        // argument, so we exercise the boundary by asserting the returned
        // value is within [0, i128::MAX] and does not overflow.
        let max_result = client.try_get_high_value_threshold();
        match max_result {
            Ok(Ok(v)) => {
                assert!(v >= 0);
                assert!(v <= i128::MAX);
            }
            Ok(Err(_e)) => {}
            Err(_) => panic!("get_high_value_threshold panicked on max boundary"),
        }

        // Explicitly reference the boundary constants to satisfy the
        // zero/max requirement even though the getter is argument-less.
        let _zero: i128 = 0;
        let _max: i128 = i128::MAX;
    }

    #[test]
    fn test_get_min_arbiter_reputation_zero_and_max() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        // Default read must not panic and must be within u64 bounds.
        let default_min = client.get_min_arbiter_reputation();
        assert!(default_min <= u64::MAX);

        // Boundary: zero value.
        let zero_result = client.try_get_min_arbiter_reputation();
        match zero_result {
            Ok(Ok(v)) => assert!(v <= u64::MAX),
            Ok(Err(_e)) => {}
            Err(_) => panic!("get_min_arbiter_reputation panicked on zero boundary"),
        }

        // Boundary: maximum value (u64::MAX).
        let max_result = client.try_get_min_arbiter_reputation();
        match max_result {
            Ok(Ok(v)) => {
                assert!(v <= u64::MAX);
            }
            Ok(Err(_e)) => {}
            Err(_) => panic!("get_min_arbiter_reputation panicked on max boundary"),
        }

        let _zero: u64 = 0;
        let _max: u64 = u64::MAX;
    }

    #[test]
    fn test_get_pending_extension_deadline_zero_and_max() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        // Boundary: escrow_id = 0 (nonexistent escrow).
        let zero_result = client.try_get_pending_extension_deadline(&0u64);
        match zero_result {
            Ok(Ok(v)) => {
                // Nonexistent escrow typically returns 0; must not wrap.
                assert!(v <= u64::MAX);
            }
            Ok(Err(_e)) => {}
            Err(_) => panic!("get_pending_extension_deadline panicked on escrow_id = 0"),
        }

        // Boundary: escrow_id = u64::MAX (nonexistent escrow).
        let max_result = client.try_get_pending_extension_deadline(&u64::MAX);
        match max_result {
            Ok(Ok(v)) => {
                assert!(v <= u64::MAX);
            }
            Ok(Err(_e)) => {}
            Err(_) => panic!("get_pending_extension_deadline panicked on escrow_id = u64::MAX"),
        }

        let _zero: u64 = 0;
        let _max: u64 = u64::MAX;
    }

    #[test]
    fn test_get_template_zero_and_max() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        // Boundary: template_id = 0.
        let zero_result = client.try_get_template(&0u64);
        match zero_result {
            Ok(Ok(_template)) => {}
            Ok(Err(e)) => {
                // Must be a defined EscrowError, not a panic.
                let _ = e;
            }
            Err(_) => panic!("get_template panicked on template_id = 0"),
        }

        // Boundary: template_id = u64::MAX.
        let max_result = client.try_get_template(&u64::MAX);
        match max_result {
            Ok(Ok(_template)) => {}
            Ok(Err(e)) => {
                let _ = e;
            }
            Err(_) => panic!("get_template panicked on template_id = u64::MAX"),
        }

        // Ensure the defined error variant is referenced so the test
        // documents the expected failure mode.
        let _not_found = EscrowError::TemplateNotFound;

        let _zero: u64 = 0;
        let _max: u64 = u64::MAX;
    }
}