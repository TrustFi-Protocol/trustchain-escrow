#[cfg(test)]
mod collect_rent_boundary_tests {
    use crate::{EscrowContract, EscrowContractClient, EscrowError};
    use soroban_sdk::{
        testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation},
        token, Address, Env, IntoVal, Symbol,
    };

    fn nonzero_hash(env: &Env, seed: u8) -> soroban_sdk::BytesN<32> {
        let mut arr = [0u8; 32];
        for (i, b) in arr.iter_mut().enumerate() {
            *b = seed.wrapping_add(i as u8);
        }
        soroban_sdk::BytesN::from_array(env, &arr)
    }

    fn no_multisig(env: &Env) -> Option<Address> {
        let _ = env;
        None
    }

    struct Setup {
        env: Env,
        client: EscrowContractClient<'static>,
        token: Address,
        escrow_id: u64,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let payee = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = token_contract.address();
        let token_client = token::StellarAssetClient::new(&env, &token);
        token_client.mint(&payer, &1_000_000i128);

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        client.initialize(&admin);

        let escrow_id = client.create_escrow(
            &payer,
            &payee,
            &token,
            &100i128,
            &nonzero_hash(&env, 1),
            &no_multisig(&env),
        );

        // Leak the client to satisfy the 'static lifetime used in the struct.
        let client: EscrowContractClient<'static> = unsafe { core::mem::transmute(client) };

        Setup {
            env,
            client,
            token,
            escrow_id,
        }
    }

    #[test]
    fn collect_rent_zero_escrow_id_does_not_panic() {
        let s = setup();
        let _ = &s.token;

        let result = s.client.try_collect_rent(&0u64);

        // Must be either Ok(Ok(_)) or Ok(Err(EscrowError::E1)) — never a panic.
        assert!(
            matches!(result, Ok(Ok(_)) | Ok(Err(EscrowError::E1))),
            "collect_rent(0) returned unexpected result: {:?}",
            result
        );
    }

    #[test]
    fn collect_rent_max_escrow_id_does_not_panic_or_overflow() {
        let s = setup();
        let _ = &s.token;

        let result = s.client.try_collect_rent(&u64::MAX);

        // Must be either Ok(Ok(_)) or Ok(Err(EscrowError::E1)) — never a panic or overflow.
        assert!(
            matches!(result, Ok(Ok(_)) | Ok(Err(EscrowError::E1))),
            "collect_rent(u64::MAX) returned unexpected result: {:?}",
            result
        );
    }

    #[test]
    fn collect_rent_valid_escrow_id_returns_non_negative() {
        let s = setup();
        let _ = &s.token;

        let result = s.client.try_collect_rent(&s.escrow_id);

        match result {
            Ok(Ok(amount)) => {
                assert!(
                    amount >= 0,
                    "collect_rent returned negative amount: {}",
                    amount
                );
            }
            Ok(Err(e)) => {
                // A defined error is acceptable; a panic is not.
                let _ = e;
            }
            Err(_) => {
                panic!("collect_rent on valid escrow id panicked");
            }
        }
    }
}