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

    // ── Caller and bound checks (#671) ───────────────────────────────────────

    use crate::{EscrowContract, EscrowContractClient, MultisigConfig};
    use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
    use soroban_sdk::{token, BytesN, IntoVal, Vec};

    fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, u64) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let client = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));
        client.initialize(&admin);
        let depositor = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let amount: i128 = 10_000;
        token::StellarAssetClient::new(&env, &token).mint(&depositor, &(amount + 1_000));
        let escrow_id = client.create_escrow(
            &depositor,
            &freelancer,
            &token,
            &amount,
            &BytesN::from_array(&env, &[1; 32]),
            &None::<Address>,
            &None::<u64>,
            &None::<u64>,
            &None,
            &MultisigConfig {
                approvers: Vec::new(&env),
                weights: Vec::new(&env),
                threshold: 0,
            },
            &None,
        );
        (env, client, depositor, freelancer, escrow_id)
    }

    /// #671: only the client or freelancer may consent; unknown escrow ids
    /// (0, u64::MAX), past deadlines (0, now) and non-increasing deadlines
    /// return the crate's errors; `u64::MAX` applies once both consent.
    #[test]
    fn test_consent_extend_caller_and_bounds() {
        let (env, client, depositor, freelancer, escrow_id) = setup();
        let stranger = Address::generate(&env);
        env.ledger().with_mut(|l| l.timestamp = 1_000);

        assert_eq!(
            client.try_consent_extend_deadline(&depositor, &0, &2_000),
            Err(Ok(EscrowError::E8))
        );
        assert_eq!(
            client.try_consent_extend_deadline(&depositor, &u64::MAX, &2_000),
            Err(Ok(EscrowError::E8))
        );
        assert_eq!(
            client.try_consent_extend_deadline(&stranger, &escrow_id, &2_000),
            Err(Ok(EscrowError::E3))
        );
        assert_eq!(
            client.try_consent_extend_deadline(&depositor, &escrow_id, &0),
            Err(Ok(EscrowError::E3))
        );
        assert_eq!(
            client.try_consent_extend_deadline(&depositor, &escrow_id, &1_000),
            Err(Ok(EscrowError::E3))
        );

        // One party alone only records a pending request.
        assert!(!client.consent_extend_deadline(&depositor, &escrow_id, &u64::MAX));
        assert_eq!(client.get_pending_extension_deadline(&escrow_id), u64::MAX);
        // The other party's consent applies it.
        assert!(client.consent_extend_deadline(&freelancer, &escrow_id, &u64::MAX));
        assert_eq!(client.get_pending_extension_deadline(&escrow_id), 0);

        // Nothing is later than u64::MAX.
        assert_eq!(
            client.try_consent_extend_deadline(&freelancer, &escrow_id, &u64::MAX),
            Err(Ok(EscrowError::E3))
        );
    }

    /// #671: another address cannot consent on the client's behalf.
    #[test]
    fn test_consent_extend_rejects_other_signer() {
        let (env, client, depositor, _freelancer, escrow_id) = setup();
        let stranger = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "consent_extend_deadline",
                args: (depositor.clone(), escrow_id, 5_000u64).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        assert!(client
            .try_consent_extend_deadline(&depositor, &escrow_id, &5_000)
            .is_err());
        assert_eq!(client.get_pending_extension_deadline(&escrow_id), 0);
    }

    /// #671: an escrow that is no longer active cannot be extended.
    #[test]
    fn test_consent_extend_rejects_inactive_escrow() {
        let (_env, client, depositor, _freelancer, escrow_id) = setup();
        client.cancel_escrow(&depositor, &escrow_id);
        assert_eq!(
            client.try_consent_extend_deadline(&depositor, &escrow_id, &5_000),
            Err(Ok(EscrowError::E9))
        );
    }
}

#[cfg(test)]
mod scval_roundtrip_tests {
    use super::ExtensionRequest;
    use soroban_sdk::{Env, TryFromVal, Val};

    fn assert_scval_roundtrip<T>(env: &Env, original: &T)
    where
        T: soroban_sdk::IntoVal<Env, Val>
            + soroban_sdk::TryFromVal<Env, Val>
            + Clone
            + core::fmt::Debug,
    {
        let serialised: Val = original.clone().into_val(env);
        let decoded = T::try_from_val(env, &serialised).expect("ScVal round-trip must not fail");
        assert_eq!(
            format!("{original:?}"),
            format!("{decoded:?}"),
            "ScVal round-trip changed the value"
        );
    }

    #[test]
    fn extension_request_scval_roundtrip() {
        let env = Env::default();
        assert_scval_roundtrip(&env, &ExtensionRequest {
            new_deadline: 0,
            client_consented: false,
            freelancer_consented: false,
            requested_at: 0,
        });
        assert_scval_roundtrip(&env, &ExtensionRequest {
            new_deadline: 99,
            client_consented: true,
            freelancer_consented: true,
            requested_at: 12,
        });
    }

}
