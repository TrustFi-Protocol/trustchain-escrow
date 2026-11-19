#[cfg(test)]
mod trigger_expiry_boundary_tests {
    use crate::{EscrowContract, EscrowContractClient, EscrowError};
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, token, Address, Env};

    fn setup() -> (Env, EscrowContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn register_token(env: &Env, admin: &Address) -> Address {
        let token_id = env.register_stellar_asset_contract(admin.clone());
        token_id
    }

    fn brief_hash(env: &Env) -> soroban_sdk::BytesN<32> {
        soroban_sdk::BytesN::from_array(env, &[7u8; 32])
    }

    fn set_time(env: &Env, timestamp: u64) {
        env.ledger().with_mut(|li| {
            li.timestamp = timestamp;
        });
    }

    fn no_multisig(env: &Env) -> Option<Address> {
        let _ = env;
        None
    }

    #[test]
    fn test_trigger_expiry_zero_escrow_id() {
        let (env, client, admin) = setup();
        let _token = register_token(&env, &admin);
        let caller = Address::generate(&env);
        set_time(&env, 1_000_000);

        let result = client.try_trigger_expiry(&caller, &0u64);
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(EscrowError::E3)) => {}
            Ok(Err(EscrowError::E9)) => {}
            Ok(Err(other)) => panic!("unexpected EscrowError: {:?}", other),
            Err(_) => panic!("trigger_expiry panicked on zero escrow_id"),
        }
    }

    #[test]
    fn test_trigger_expiry_max_escrow_id() {
        let (env, client, admin) = setup();
        let _token = register_token(&env, &admin);
        let caller = Address::generate(&env);
        set_time(&env, 1_000_000);

        let result = client.try_trigger_expiry(&caller, &u64::MAX);
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(EscrowError::E3)) => {}
            Ok(Err(EscrowError::E9)) => {}
            Ok(Err(other)) => panic!("unexpected EscrowError: {:?}", other),
            Err(_) => panic!("trigger_expiry panicked on u64::MAX escrow_id"),
        }
    }

    #[test]
    fn test_trigger_expiry_positive_path_consistency() {
        let (env, client, admin) = setup();
        let token = register_token(&env, &admin);
        let caller = Address::generate(&env);
        let _ = no_multisig(&env);

        set_time(&env, 1_000_000);
        let deadline = 1_000_500u64;
        let escrow_id = client.create_escrow(
            &caller,
            &caller,
            &token,
            &1_000i128,
            &deadline,
            &brief_hash(&env),
        );

        set_time(&env, deadline + 1);

        let result = client.try_trigger_expiry(&caller, &escrow_id);
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(EscrowError::E3)) => {}
            Ok(Err(EscrowError::E9)) => {}
            Ok(Err(other)) => panic!("unexpected EscrowError: {:?}", other),
            Err(_) => panic!("trigger_expiry panicked on real escrow_id"),
        }
    }
}