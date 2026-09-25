#[cfg(test)]
#[allow(clippy::module_inception)]
mod oracle_fallback_tests {
    use crate::oracle::{PriceData, PRICE_STALENESS_THRESHOLD};
    use crate::{EscrowContract, EscrowContractClient, EscrowError};
    use soroban_sdk::{
        contract, contractimpl, testutils::Address as _, testutils::Ledger as _, Address, Env,
    };

    // ── Mock oracle contracts ─────────────────────────────────────────────────

    /// Returns a fixed price with a timestamp injected at registration time via
    /// a single-entry instance storage key ("ts").
    #[contract]
    struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn set_price_data(env: Env, price: i128, timestamp: u64) {
            env.storage().instance().set(&"price", &price);
            env.storage().instance().set(&"ts", &timestamp);
        }

        pub fn lastprice(env: Env, _asset: Address) -> Option<PriceData> {
            let price: i128 = env.storage().instance().get(&"price").unwrap_or(0);
            let timestamp: u64 = env.storage().instance().get(&"ts").unwrap_or(0);
            Some(PriceData { price, timestamp })
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, admin, client)
    }

    fn register_mock_oracle(env: &Env, price: i128, timestamp: u64) -> Address {
        let id = env.register_contract(None, MockOracle);
        let mock = MockOracleClient::new(env, &id);
        mock.set_price_data(&price, &timestamp);
        id
    }

    // ── Existing tests (preserved) ────────────────────────────────────────────

    /// Primary oracle returns a stale price → get_price must return the
    /// fallback oracle's fresh price.
    #[test]
    fn test_oracle_fallback_on_stale_primary() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD + 10_000;
        let stale_ts = now - PRICE_STALENESS_THRESHOLD - 1; // older than threshold
        let fresh_ts = now - 1; // within threshold

        let primary = register_mock_oracle(&env, 1_000_000, stale_ts);
        let fallback = register_mock_oracle(&env, 2_000_000, fresh_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let price = client.get_price(&asset);
        assert_eq!(
            price, 2_000_000,
            "should return fallback price when primary is stale"
        );
    }

    /// Both oracles return stale prices → get_price must return OracleStaleFeed.
    #[test]
    fn test_oracle_both_stale_returns_error() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD + 10_000;
        let stale_ts = now - PRICE_STALENESS_THRESHOLD - 1;

        let primary = register_mock_oracle(&env, 1_000_000, stale_ts);
        let fallback = register_mock_oracle(&env, 2_000_000, stale_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let result = client.try_get_price(&asset);
        assert!(
            matches!(result, Err(Ok(EscrowError::OracleStaleFeed))),
            "should return OracleStaleFeed when both oracles are stale"
        );
    }

    /// Primary oracle returns a fresh price → get_price must return it without
    /// consulting the fallback.
    #[test]
    fn test_oracle_uses_primary_when_fresh() {
        let (env, admin, client) = setup();

        let now: u64 = 10_000;
        let fresh_ts = now - 1;

        let primary = register_mock_oracle(&env, 5_000_000, fresh_ts);
        // Fallback has a different price; it must NOT be used.
        let fallback = register_mock_oracle(&env, 9_999_999, fresh_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let price = client.get_price(&asset);
        assert_eq!(
            price, 5_000_000,
            "should return primary price when it is fresh"
        );
    }

    // ── New coverage: source priority and boundary conditions (issue #215) ────

    /// Primary price timestamp is exactly at the staleness boundary (age ==
    /// PRICE_STALENESS_THRESHOLD) — this is still considered fresh, so the
    /// primary price must be returned and the fallback must NOT be consulted.
    #[test]
    fn test_primary_at_exact_staleness_boundary_is_fresh() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD * 2;
        // age == PRICE_STALENESS_THRESHOLD exactly → still fresh per is_fresh()
        let boundary_ts = now - PRICE_STALENESS_THRESHOLD;

        let primary = register_mock_oracle(&env, 3_000_000, boundary_ts);
        // Fallback has a distinct price so we can tell if it was used.
        let fallback = register_mock_oracle(&env, 7_777_777, boundary_ts - 1);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let price = client.get_price(&asset);
        assert_eq!(
            price, 3_000_000,
            "price at exactly the staleness boundary must be treated as fresh"
        );
    }

    /// Primary price timestamp is one second past the boundary (age ==
    /// PRICE_STALENESS_THRESHOLD + 1) → stale, fallback must be used.
    #[test]
    fn test_primary_one_second_past_boundary_triggers_fallback() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD * 2;
        let just_stale_ts = now - PRICE_STALENESS_THRESHOLD - 1; // one second past threshold
        let fresh_ts = now - 1;

        let primary = register_mock_oracle(&env, 1_111_111, just_stale_ts);
        let fallback = register_mock_oracle(&env, 2_222_222, fresh_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let price = client.get_price(&asset);
        assert_eq!(
            price, 2_222_222,
            "primary just past the staleness boundary must trigger fallback"
        );
    }

    /// No fallback oracle is configured and the primary is stale →
    /// `OracleStaleFeed` must be returned (no panic, no default price).
    #[test]
    fn test_stale_primary_no_fallback_returns_error() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD + 10_000;
        let stale_ts = now - PRICE_STALENESS_THRESHOLD - 1;

        let primary = register_mock_oracle(&env, 4_000_000, stale_ts);
        client.set_oracle(&admin, &primary);
        // Intentionally do NOT set a fallback oracle.

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let result = client.try_get_price(&asset);
        assert!(
            matches!(result, Err(Ok(EscrowError::OracleStaleFeed))),
            "stale primary with no fallback must return OracleStaleFeed"
        );
    }

    /// When the admin replaces the primary oracle with a new contract, the new
    /// contract's price must be used — the old contract is no longer consulted.
    /// This verifies that source priority changes take effect immediately.
    #[test]
    fn test_replacing_primary_oracle_changes_priority() {
        let (env, admin, client) = setup();

        let now: u64 = 50_000;
        let fresh_ts = now - 1;

        let original_primary = register_mock_oracle(&env, 1_000_000, fresh_ts);
        let new_primary = register_mock_oracle(&env, 8_000_000, fresh_ts);

        client.set_oracle(&admin, &original_primary);
        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);

        // Confirm original primary is used.
        let before = client.get_price(&asset);
        assert_eq!(before, 1_000_000, "original primary must be used before replacement");

        // Replace with new primary.
        client.set_oracle(&admin, &new_primary);

        let after = client.get_price(&asset);
        assert_eq!(
            after, 8_000_000,
            "new primary must be consulted after set_oracle replacement"
        );
    }

    /// When the admin replaces the fallback oracle with a new contract, the new
    /// fallback must be used when the primary is stale.
    #[test]
    fn test_replacing_fallback_oracle_changes_fallback_source() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD + 20_000;
        let stale_ts = now - PRICE_STALENESS_THRESHOLD - 1;
        let fresh_ts = now - 1;

        let primary = register_mock_oracle(&env, 1_000_000, stale_ts);
        let old_fallback = register_mock_oracle(&env, 2_000_000, fresh_ts);
        let new_fallback = register_mock_oracle(&env, 9_000_000, fresh_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &old_fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);

        // Before replacement: old fallback is used.
        let before = client.get_price(&asset);
        assert_eq!(before, 2_000_000, "old fallback must be used before replacement");

        // Replace fallback.
        client.set_fallback_oracle(&admin, &new_fallback);

        let after = client.get_price(&asset);
        assert_eq!(
            after, 9_000_000,
            "new fallback must be used after set_fallback_oracle replacement"
        );
    }

    /// Primary stale, fallback also stale (all sources stale) →
    /// `OracleStaleFeed` must be returned regardless of the number of sources.
    #[test]
    fn test_all_sources_stale_returns_oracle_stale_feed() {
        let (env, admin, client) = setup();

        let now: u64 = PRICE_STALENESS_THRESHOLD * 3;
        let stale_ts = now - PRICE_STALENESS_THRESHOLD - 1;

        let primary = register_mock_oracle(&env, 5_000_000, stale_ts);
        let fallback = register_mock_oracle(&env, 6_000_000, stale_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let result = client.try_get_price(&asset);
        assert_eq!(
            result,
            Err(Ok(EscrowError::OracleStaleFeed)),
            "all sources stale must return OracleStaleFeed"
        );
    }

    /// Primary price is zero (non-positive) even though the timestamp is fresh →
    /// the implementation must return `OracleInvalidPrice`, not a fallback lookup.
    #[test]
    fn test_primary_zero_price_returns_invalid_price_error() {
        let (env, admin, client) = setup();

        let now: u64 = 30_000;
        let fresh_ts = now - 1;

        // Price of 0 is not a valid oracle value.
        let primary = register_mock_oracle(&env, 0, fresh_ts);
        let fallback = register_mock_oracle(&env, 4_000_000, fresh_ts);

        client.set_oracle(&admin, &primary);
        client.set_fallback_oracle(&admin, &fallback);

        env.ledger().with_mut(|l| l.timestamp = now);

        let asset = Address::generate(&env);
        let result = client.try_get_price(&asset);
        assert_eq!(
            result,
            Err(Ok(EscrowError::OracleInvalidPrice)),
            "a zero primary price must return OracleInvalidPrice"
        );
    }
}
