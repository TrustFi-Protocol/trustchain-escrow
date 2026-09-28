//! # Escrow template tests
//!
//! Restored against the current contract API.

#[cfg(test)]
#[allow(clippy::module_inception)]
mod escrow_template_tests {
    use crate::{EscrowContract, EscrowContractClient, EscrowError, MilestoneTemplate};

    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

    fn setup() -> (Env, Address, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, admin, contract_id, client)
    }

    fn register_token(env: &Env, admin: &Address, recipient: &Address, amount: i128) -> Address {
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = soroban_sdk::token::StellarAssetClient::new(env, &token_id.address());
        sac.mint(recipient, &amount);
        token_id.address()
    }

    #[test]
    fn test_create_and_get_template() {
        let (env, _, _, client) = setup();
        let creator = Address::generate(&env);

        let mut milestones = soroban_sdk::Vec::new(&env);
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Design"),
            description_hash: BytesN::from_array(&env, &[1u8; 32]),
            amount: 100,
        });
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Development"),
            description_hash: BytesN::from_array(&env, &[2u8; 32]),
            amount: 200,
        });

        let template_id = client.create_template(
            &creator,
            &String::from_str(&env, "Web Dev Template"),
            &milestones,
        );

        let template = client.get_template(&template_id);
        assert_eq!(template.id, template_id);
        assert_eq!(template.creator, creator);
        assert_eq!(template.name, String::from_str(&env, "Web Dev Template"));
        assert_eq!(template.milestones.len(), 2);
        assert_eq!(
            template.milestones.get(0).unwrap().title,
            String::from_str(&env, "Design")
        );
        assert_eq!(template.milestones.get(1).unwrap().amount, 200);
    }

    #[test]
    fn test_create_escrow_from_template() {
        let (env, admin, contract_id, client) = setup();
        let creator = Address::generate(&env);
        let escrow_client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token = register_token(&env, &admin, &escrow_client, 1_001_000);

        let mut milestones = soroban_sdk::Vec::new(&env);
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Phase 1"),
            description_hash: BytesN::from_array(&env, &[1u8; 32]),
            amount: 300,
        });
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Phase 2"),
            description_hash: BytesN::from_array(&env, &[2u8; 32]),
            amount: 400,
        });

        let template_id = client.create_template(
            &creator,
            &String::from_str(&env, "Test Template"),
            &milestones,
        );

        let total_amount = 700;
        let brief_hash = BytesN::from_array(&env, &[9u8; 32]);
        let escrow_id = client.create_escrow_from_template(
            &escrow_client,
            &template_id,
            &escrow_client,
            &freelancer,
            &token,
            &total_amount,
            &brief_hash,
            &None::<Address>,
            &None::<u64>,
        );

        let meta = client.get_escrow_meta(&escrow_id);
        assert_eq!(meta.total_amount, total_amount);
        assert_eq!(meta.allocated_amount, 700);
        assert_eq!(meta.milestone_count, 2);
        assert!(soroban_sdk::token::Client::new(&env, &token).balance(&contract_id) >= total_amount);

        // Check milestones
        let milestone0 = client.get_milestone(&escrow_id, &0);
        assert_eq!(milestone0.title, String::from_str(&env, "Phase 1"));
        assert_eq!(milestone0.amount, 300);

        let milestone1 = client.get_milestone(&escrow_id, &1);
        assert_eq!(milestone1.title, String::from_str(&env, "Phase 2"));
        assert_eq!(milestone1.amount, 400);

        client.submit_milestone(&freelancer, &escrow_id, &0);
        client.approve_milestone(&escrow_client, &escrow_id, &0);
        assert_eq!(
            client.get_milestone(&escrow_id, &0).status,
            crate::MS_RELEASED
        );

        client.submit_milestone(&freelancer, &escrow_id, &1);
        client.approve_milestone(&escrow_client, &escrow_id, &1);

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), total_amount);
        assert_eq!(client.get_milestone(&escrow_id, &1).status, crate::MS_RELEASED);
        let completed_meta = client.get_escrow_meta(&escrow_id);
        assert_eq!(completed_meta.remaining_balance, 0);
        assert_eq!(completed_meta.released_count, 2);
    }

    #[test]
    fn test_template_cannot_allocate_more_than_escrow_funding() {
        let (env, admin, contract_id, client) = setup();
        let escrow_client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token = register_token(&env, &admin, &escrow_client, 1_001_000);
        let token_client = soroban_sdk::token::Client::new(&env, &token);

        let mut milestones = soroban_sdk::Vec::new(&env);
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Phase 1"),
            description_hash: BytesN::from_array(&env, &[1u8; 32]),
            amount: 300,
        });
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Phase 2"),
            description_hash: BytesN::from_array(&env, &[2u8; 32]),
            amount: 401,
        });
        let template_id = client.create_template(
            &escrow_client,
            &String::from_str(&env, "Over-allocated Template"),
            &milestones,
        );

        let client_balance_before = token_client.balance(&escrow_client);
        let contract_balance_before = token_client.balance(&contract_id);
        let result = client.try_create_escrow_from_template(
            &escrow_client,
            &template_id,
            &escrow_client,
            &freelancer,
            &token,
            &700,
            &BytesN::from_array(&env, &[9u8; 32]),
            &None::<Address>,
            &None::<u64>,
        );

        assert_eq!(result.err().unwrap(), Ok(EscrowError::E15));
        assert_eq!(token_client.balance(&escrow_client), client_balance_before);
        assert_eq!(token_client.balance(&contract_id), contract_balance_before);
    }

    #[test]
    fn test_zero_value_template_milestone_is_rejected_without_funding() {
        let (env, admin, contract_id, client) = setup();
        let escrow_client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token = register_token(&env, &admin, &escrow_client, 1_001_000);
        let token_client = soroban_sdk::token::Client::new(&env, &token);

        let mut milestones = soroban_sdk::Vec::new(&env);
        milestones.push_back(MilestoneTemplate {
            title: String::from_str(&env, "Zero-value Phase"),
            description_hash: BytesN::from_array(&env, &[1u8; 32]),
            amount: 0,
        });
        let template_id = client.create_template(
            &escrow_client,
            &String::from_str(&env, "Invalid Template"),
            &milestones,
        );

        let client_balance_before = token_client.balance(&escrow_client);
        let contract_balance_before = token_client.balance(&contract_id);
        let result = client.try_create_escrow_from_template(
            &escrow_client,
            &template_id,
            &escrow_client,
            &freelancer,
            &token,
            &700,
            &BytesN::from_array(&env, &[9u8; 32]),
            &None::<Address>,
            &None::<u64>,
        );

        assert_eq!(result.err().unwrap(), Ok(EscrowError::E17));
        assert_eq!(token_client.balance(&escrow_client), client_balance_before);
        assert_eq!(token_client.balance(&contract_id), contract_balance_before);
    }

    #[test]
    fn test_invalid_template_id() {
        let (_env, _, _, client) = setup();

        let result = client.try_get_template(&999);
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), Ok(EscrowError::E8));
    }
}
