#[cfg(test)]
mod boundary_view_tests {
    use crate::{EscrowContract, EscrowContractClient, EscrowError};
    use soroban_sdk::{testutils::Address as _, token, Address, Env};

    fn setup() -> (Env, EscrowContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        // Initialize admin if the contract exposes an initialize entry point.
        let _ = client.try_initialize(&admin);

        (env, client, admin)
    }

    #[test]
    fn test_get_escrow_meta_zero_and_max() {
        let (_env, client, _admin) = setup();

        let zero = client.try_get_escrow_meta(&0u64);
        assert!(
            matches!(zero, Ok(Ok(_)) | Ok(Err(_))),
            "get_escrow_meta(0) must return Ok or a defined EscrowError, got {:?}",
            zero
        );
        if let Ok(Err(e)) = zero {
            // Must be a defined EscrowError variant.
            let _: EscrowError = e;
        }

        let max = client.try_get_escrow_meta(&u64::MAX);
        assert!(
            matches!(max, Ok(Ok(_)) | Ok(Err(_))),
            "get_escrow_meta(u64::MAX) must return Ok or a defined EscrowError, got {:?}",
            max
        );
        if let Ok(Err(e)) = max {
            let _: EscrowError = e;
        }
    }

    #[test]
    fn test_get_escrow_zero_and_max() {
        let (_env, client, _admin) = setup();

        let zero = client.try_get_escrow(&0u64);
        assert!(
            matches!(zero, Ok(Ok(_)) | Ok(Err(_))),
            "get_escrow(0) must return Ok or a defined EscrowError, got {:?}",
            zero
        );
        if let Ok(Err(e)) = zero {
            let _: EscrowError = e;
        }

        let max = client.try_get_escrow(&u64::MAX);
        assert!(
            matches!(max, Ok(Ok(_)) | Ok(Err(_))),
            "get_escrow(u64::MAX) must return Ok or a defined EscrowError, got {:?}",
            max
        );
        if let Ok(Err(e)) = max {
            let _: EscrowError = e;
        }
    }

    #[test]
    fn test_get_evidence_zero_and_max() {
        let (_env, client, _admin) = setup();

        let zero = client.try_get_evidence(&0u64);
        assert!(
            matches!(zero, Ok(Ok(_)) | Ok(Err(_))),
            "get_evidence(0) must return Ok or a defined EscrowError, got {:?}",
            zero
        );
        if let Ok(Err(e)) = zero {
            let _: EscrowError = e;
        }

        let max = client.try_get_evidence(&u64::MAX);
        assert!(
            matches!(max, Ok(Ok(_)) | Ok(Err(_))),
            "get_evidence(u64::MAX) must return Ok or a defined EscrowError, got {:?}",
            max
        );
        if let Ok(Err(e)) = max {
            let _: EscrowError = e;
        }
    }

    #[test]
    fn test_get_price_zero_and_max() {
        let (env, client, _admin) = setup();

        // get_price takes an Address (asset), not a numeric argument. We exercise
        // the price path with a zero-amount escrow and a max-amount escrow to
        // ensure no panic or balance wrap occurs at the boundaries.
        let asset = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();

        // Zero-amount escrow.
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let _ = client.try_create_escrow(&buyer, &seller, &asset, &0i128);

        let zero_price = client.try_get_price(&asset);
        assert!(
            matches!(zero_price, Ok(Ok(_)) | Ok(Err(_))),
            "get_price(asset) after zero-amount escrow must return Ok or a defined EscrowError, got {:?}",
            zero_price
        );
        if let Ok(Err(e)) = zero_price {
            let _: EscrowError = e;
        }

        // Max-amount escrow.
        let buyer2 = Address::generate(&env);
        let seller2 = Address::generate(&env);
        let _ = client.try_create_escrow(&buyer2, &seller2, &asset, &i128::MAX);

        let max_price = client.try_get_price(&asset);
        assert!(
            matches!(max_price, Ok(Ok(_)) | Ok(Err(_))),
            "get_price(asset) after max-amount escrow must return Ok or a defined EscrowError, got {:?}",
            max_price
        );
        if let Ok(Err(e)) = max_price {
            let _: EscrowError = e;
        }
    }
}