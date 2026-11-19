use soroban_sdk::{contracttype, Address, String};

/// Supported bridge protocols.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeProtocol {
    Wormhole,
    Allbridge,
}

/// Canonical metadata for a cross-chain (wrapped) token.
#[contracttype]
#[derive(Clone, Debug)]
pub struct WrappedTokenInfo {
    /// The Stellar SAC address of the wrapped token.
    pub stellar_address: Address,
    /// The originating chain identifier (e.g. "ethereum", "solana").
    pub origin_chain: String,
    /// The original token address on the source chain (hex string).
    pub origin_address: String,
    /// Which bridge protocol wrapped this token.
    pub bridge: BridgeProtocol,
    /// Whether this token is approved for use in escrows.
    pub is_approved: bool,
}

/// Tracks the confirmation state of a cross-chain deposit.
#[contracttype]
#[derive(Clone, Debug)]
pub struct BridgeConfirmation {
    /// The bridged token used in the escrow.
    pub token: Address,
    /// Bridge protocol used.
    pub bridge: BridgeProtocol,
    /// Number of confirmations received so far.
    pub confirmations: u32,
    /// Whether the transfer has reached `MIN_BRIDGE_CONFIRMATIONS`.
    pub is_finalized: bool,
    /// Ledger timestamp when this record was last updated.
    pub updated_at: u64,
}

/// Persistent storage key for wrapped token metadata.
/// Keyed by the Stellar SAC address of the wrapped token.
#[contracttype]
#[derive(Clone)]
pub enum BridgeDataKey {
    /// WrappedTokenInfo keyed by Stellar token address.
    WrappedToken(Address),
    /// BridgeConfirmation keyed by bridged token address.
    BridgeConfirmation(Address),
}

#[cfg(test)]
mod scval_roundtrip_tests {
    use super::{BridgeConfirmation, BridgeProtocol};
    use soroban_sdk::{Address, Env, TryFromVal, Val};
    use soroban_sdk::testutils::Address as _;

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
    fn bridge_confirmation_scval_roundtrip() {
        let env = Env::default();
        let token = Address::generate(&env);
        let zero = BridgeConfirmation {
            token: token.clone(),
            bridge: BridgeProtocol::Wormhole,
            confirmations: 0,
            is_finalized: false,
            updated_at: 0,
        };
        assert_scval_roundtrip(&env, &zero);
        let nonzero = BridgeConfirmation {
            token,
            bridge: BridgeProtocol::Allbridge,
            confirmations: 12,
            is_finalized: true,
            updated_at: 42,
        };
        assert_scval_roundtrip(&env, &nonzero);
    }

}
