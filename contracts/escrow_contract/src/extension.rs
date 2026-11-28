#![allow(dead_code)]
//! Escrow extension by mutual consent.
//!
//! Allows the client and freelancer to jointly extend the escrow deadline.
//! Both parties must call `consent_extend` before the extension takes effect.
//!
//! Closes #96

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::EscrowError;
use crate::events;
use crate::types::EscrowStatus;
use crate::ContractStorage;

/// Storage key for pending extension requests.
#[contracttype]
pub enum ExtensionKey {
    /// Pending extension for escrow_id — value: ExtensionRequest
    Pending(u64),
}

/// A pending deadline extension request.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ExtensionRequest {
    /// The proposed new deadline.
    pub new_deadline: u64,
    /// Whether the client has consented.
    pub client_consented: bool,
    /// Whether the freelancer has consented.
    pub freelancer_consented: bool,
    /// When the request was created.
    pub requested_at: u64,
}

/// Request or consent to a deadline extension.
///
/// Either the client or freelancer may initiate. Once both have consented
/// to the same `new_deadline`, the escrow deadline is updated.
/// Returns `true` when the extension was applied (both consented).
pub fn consent_extend(
    env: &Env,
    caller: &Address,
    escrow_id: u64,
    new_deadline: u64,
) -> Result<bool, EscrowError> {
    caller.require_auth();
    ContractStorage::require_not_paused(env)?;
    ContractStorage::require_not_frozen(env, escrow_id)?;

    let mut meta = ContractStorage::load_escrow_meta(env, escrow_id)?;
    if meta.status != EscrowStatus::Active {
        return Err(EscrowError::E9);
    }

    // Only client or freelancer may consent
    let is_client = caller == &meta.client;
    let is_freelancer = caller == &meta.freelancer;
    if !is_client && !is_freelancer {
        return Err(EscrowError::E3);
    }

    // New deadline must be in the future
    let now = env.ledger().timestamp();
    if new_deadline <= now {
        return Err(EscrowError::E3);
    }

    // New deadline must be later than current deadline (if set)
    if let Some(current) = meta.deadline {
        if new_deadline <= current {
            return Err(EscrowError::E3);
        }
    }

    let key = ExtensionKey::Pending(escrow_id);
    let mut request: ExtensionRequest =
        env.storage()
            .temporary()
            .get(&key)
            .unwrap_or(ExtensionRequest {
                new_deadline,
                client_consented: false,
                freelancer_consented: false,
                requested_at: now,
            });

    // If the proposed deadline differs, reset consents
    if request.new_deadline != new_deadline {
        request = ExtensionRequest {
            new_deadline,
            client_consented: false,
            freelancer_consented: false,
            requested_at: now,
        };
    }

    if is_client {
        request.client_consented = true;
    }
    if is_freelancer {
        request.freelancer_consented = true;
    }

    if request.client_consented && request.freelancer_consented {
        // Both consented — apply the extension
        let old_deadline = meta.deadline.unwrap_or(0);
        meta.deadline = Some(new_deadline);
        ContractStorage::save_escrow_meta(env, &meta);
        env.storage().temporary().remove(&key);
        events::emit_deadline_extended(env, escrow_id, old_deadline, new_deadline);
        Ok(true)
    } else {
        // Save pending request, wait for other party
        env.storage().temporary().set(&key, &request);
        Ok(false)
    }
}

/// Get the pending extension request for an escrow, if any.
pub fn get_pending_extension(env: &Env, escrow_id: u64) -> Option<ExtensionRequest> {
    let key = ExtensionKey::Pending(escrow_id);
    env.storage().temporary().get(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extension_request_struct() {
        let req = ExtensionRequest {
            new_deadline: 1000,
            client_consented: true,
            freelancer_consented: false,
            requested_at: 500,
        };
        assert!(req.client_consented);
        assert!(!req.freelancer_consented);
        assert_eq!(req.new_deadline, 1000);
    }

    // ── consent_extend caller and bound checks (#671) ────────────────────────

    use crate::{EscrowContract, EscrowContractClient, MultisigConfig};
    use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, BytesN};

    fn setup_without_escrow() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        EscrowContractClient::new(&env, &contract_id).initialize(&admin);
        (env, contract_id)
    }

    /// Returns (env, contract_id, client, freelancer, escrow_id) for an Active escrow.
    fn setup() -> (Env, Address, Address, Address, u64) {
        let (env, contract_id) = setup_without_escrow();
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(token_admin).address();
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&client, &1030);
        let escrow_id = EscrowContractClient::new(&env, &contract_id).create_escrow(
            &client,
            &freelancer,
            &token,
            &500,
            &BytesN::from_array(&env, &[1; 32]),
            &None,
            &None,
            &None,
            &None,
            &MultisigConfig {
                approvers: soroban_sdk::Vec::new(&env),
                weights: soroban_sdk::Vec::new(&env),
                threshold: 0,
            },
            &None,
        );
        (env, contract_id, client, freelancer, escrow_id)
    }

    #[test]
    fn test_consent_extend_by_client_and_freelancer_applies_extension() {
        let (env, contract_id, client, freelancer, escrow_id) = setup();

        let first = env.as_contract(&contract_id, || consent_extend(&env, &client, escrow_id, u64::MAX));
        assert_eq!(first, Ok(false));
        assert_eq!(
            env.as_contract(&contract_id, || get_pending_extension(&env, escrow_id)).map(|r| r.new_deadline),
            Some(u64::MAX)
        );

        let second = env.as_contract(&contract_id, || consent_extend(&env, &freelancer, escrow_id, u64::MAX));
        assert_eq!(second, Ok(true));
        let meta = env.as_contract(&contract_id, || ContractStorage::load_escrow_meta(&env, escrow_id).unwrap());
        assert_eq!(meta.deadline, Some(u64::MAX));
        assert!(env.as_contract(&contract_id, || get_pending_extension(&env, escrow_id)).is_none());
    }

    #[test]
    fn test_consent_extend_rejects_non_party_caller() {
        let (env, contract_id, _client, _freelancer, escrow_id) = setup();
        let stranger = Address::generate(&env);

        let result = env.as_contract(&contract_id, || consent_extend(&env, &stranger, escrow_id, u64::MAX));

        assert_eq!(result, Err(EscrowError::E3));
        assert!(env.as_contract(&contract_id, || get_pending_extension(&env, escrow_id)).is_none());
    }

    #[test]
    fn test_consent_extend_zero_deadline_returns_error() {
        let (env, contract_id, client, _freelancer, escrow_id) = setup();

        let result = env.as_contract(&contract_id, || consent_extend(&env, &client, escrow_id, 0));

        assert_eq!(result, Err(EscrowError::E3));
    }

    #[test]
    fn test_consent_extend_escrow_id_zero_and_max_without_escrow_return_error() {
        let (env, contract_id) = setup_without_escrow();
        let caller = Address::generate(&env);
        for escrow_id in [0_u64, u64::MAX] {
            for new_deadline in [0_u64, u64::MAX] {
                let result = env.as_contract(&contract_id, || consent_extend(&env, &caller, escrow_id, new_deadline));
                assert_eq!(result, Err(EscrowError::E8));
            }
        }
    }
}
