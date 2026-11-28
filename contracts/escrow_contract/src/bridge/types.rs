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
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, IntoVal, TryFromVal};

    /// Asserts that every field of `WrappedTokenInfo` survives a ScVal round trip.
    fn assert_round_trip(env: &Env, original: &WrappedTokenInfo) {
        let val = original.clone().into_val(env);
        let decoded = WrappedTokenInfo::try_from_val(env, &val)
            .expect("WrappedTokenInfo should decode from its own ScVal");

        assert_eq!(decoded.stellar_address, original.stellar_address);
        assert_eq!(decoded.origin_chain, original.origin_chain);
        assert_eq!(decoded.origin_address, original.origin_address);
        assert_eq!(decoded.bridge, original.bridge);
        assert_eq!(decoded.is_approved, original.is_approved);
    }

    #[test]
    fn wrapped_token_info_scval_round_trip() {
        let env = Env::default();

        // Empty / zero-ish value: empty strings, first bridge variant, false flag.
        let empty = WrappedTokenInfo {
            stellar_address: Address::generate(&env),
            origin_chain: String::from_str(&env, ""),
            origin_address: String::from_str(&env, ""),
            bridge: BridgeProtocol::Wormhole,
            is_approved: false,
        };
        assert_round_trip(&env, &empty);

        // Non-zero value: non-empty strings, other bridge variant, true flag.
        let populated = WrappedTokenInfo {
            stellar_address: Address::generate(&env),
            origin_chain: String::from_str(&env, "ethereum"),
            origin_address: String::from_str(&env, "0xdeadbeef"),
            bridge: BridgeProtocol::Allbridge,
            is_approved: true,
        };
        assert_round_trip(&env, &populated);

        // Cross-check the two bridge variants independently.
        let wormhole = WrappedTokenInfo {
            stellar_address: Address::generate(&env),
            origin_chain: String::from_str(&env, "solana"),
            origin_address: String::from_str(&env, "So11111111111111111111111111111111111111112"),
            bridge: BridgeProtocol::Wormhole,
            is_approved: true,
        };
        assert_round_trip(&env, &wormhole);
    }
}
