//! # Contract Version Compatibility Query Tests
//!
//! Covers `ContractVersionInfo`, tracked in persistent storage separately
//! from `storage::STORAGE_VERSION` (which only tracks the data layout).
//!
//! ## Existing coverage
//! - Fresh deploy starts at `INITIAL_CONTRACT_VERSION` (1).
//! - `upgrade()` increments `version` and `upgrade_count`, and refreshes
//!   `last_upgraded_at` while leaving `deployed_at` untouched.
//! - `get_contract_version` fails before `initialize` has been called.
//!
//! ## New coverage (issue #214)
//! - All `ContractVersionInfo` fields are populated with expected types and
//!   sensible values on first deploy.
//! - `version` is stable across multiple consecutive `get_contract_version`
//!   calls (idempotent read).
//! - `deployed_at` is never mutated by an upgrade.
//! - `last_upgraded_at` equals `deployed_at` until the first upgrade, then
//!   advances on every subsequent upgrade.
//! - `upgrade_count` increments by exactly 1 per upgrade.
//! - A non-admin upgrade attempt leaves every version field unchanged.
//! - After N upgrades the returned `version` equals
//!   `INITIAL_CONTRACT_VERSION + N`.
//! - `upgrade_count` mirrors the number of successful upgrades, not attempts.

#[cfg(test)]
#[allow(clippy::module_inception)]
mod contract_version_tests {
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, BytesN, Env};

    use crate::{EscrowContract, EscrowContractClient, EscrowError, INITIAL_CONTRACT_VERSION};

    fn setup() -> (Env, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        (env, admin, client)
    }

    /// Uploads a minimal WASM blob and returns its content-addressed hash.
    /// `seed` varies the trailing byte so distinct calls yield distinct hashes,
    /// as required by `env.deployer().update_current_contract_wasm`.
    fn wasm_hash(env: &Env, seed: u8) -> BytesN<32> {
        let bytes: [u8; 9] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, seed];
        env.deployer()
            .upload_contract_wasm(soroban_sdk::Bytes::from_slice(env, &bytes))
    }

    // ── Existing tests (preserved) ────────────────────────────────────────────

    #[test]
    fn test_initial_version_is_one_after_initialize() {
        let (env, admin, client) = setup();
        client.initialize(&admin);

        let info = client.get_contract_version();
        assert_eq!(info.version, INITIAL_CONTRACT_VERSION);
        assert_eq!(info.upgrade_count, 0);
        assert_eq!(info.deployed_at, info.last_upgraded_at);
        let _ = env;
    }

    #[test]
    fn test_get_contract_version_fails_before_initialize() {
        let (env, _admin, client) = setup();
        let result = client.try_get_contract_version();
        assert_eq!(result, Err(Ok(EscrowError::E2)));
        let _ = env;
    }

    #[test]
    fn test_upgrade_increments_version_and_history() {
        let (env, admin, client) = setup();
        client.initialize(&admin);

        let before = client.get_contract_version();
        assert_eq!(before.version, INITIAL_CONTRACT_VERSION);

        env.ledger().with_mut(|l| l.timestamp += 1_000);
        client.upgrade(&admin, &wasm_hash(&env, 1));

        let after_first = client.get_contract_version();
        assert_eq!(after_first.version, INITIAL_CONTRACT_VERSION + 1);
        assert_eq!(after_first.upgrade_count, 1);
        assert_eq!(after_first.deployed_at, before.deployed_at);
        assert!(after_first.last_upgraded_at > before.last_upgraded_at);

        env.ledger().with_mut(|l| l.timestamp += 1_000);
        client.upgrade(&admin, &wasm_hash(&env, 2));

        let after_second = client.get_contract_version();
        assert_eq!(after_second.version, INITIAL_CONTRACT_VERSION + 2);
        assert_eq!(after_second.upgrade_count, 2);
        assert_eq!(after_second.deployed_at, before.deployed_at);
        assert!(after_second.last_upgraded_at > after_first.last_upgraded_at);
    }

    #[test]
    fn test_upgrade_by_non_admin_rejected_and_version_unchanged() {
        let (env, admin, client) = setup();
        client.initialize(&admin);
        let attacker = Address::generate(&env);

        let result = client.try_upgrade(&attacker, &wasm_hash(&env, 3));
        assert_eq!(result, Err(Ok(EscrowError::E87)));

        let info = client.get_contract_version();
        assert_eq!(
            info.version, INITIAL_CONTRACT_VERSION,
            "version must not advance on a rejected upgrade"
        );
        assert_eq!(info.upgrade_count, 0);
    }

    // ── New coverage: version field completeness ──────────────────────────────

    /// All four `ContractVersionInfo` fields must be populated with meaningful
    /// values immediately after `initialize`. Clients and deployment scripts rely
    /// on these being present and well-typed.
    #[test]
    fn test_all_version_fields_populated_after_initialize() {
        let (env, admin, client) = setup();
        env.ledger().with_mut(|l| l.timestamp = 5_000);
        client.initialize(&admin);

        let info = client.get_contract_version();

        // version starts at the defined constant, never 0
        assert_eq!(
            info.version, INITIAL_CONTRACT_VERSION,
            "version must equal INITIAL_CONTRACT_VERSION"
        );
        assert!(
            info.version >= 1,
            "version must be a positive non-zero value"
        );

        // upgrade_count is 0 — no upgrades have been applied yet
        assert_eq!(
            info.upgrade_count, 0,
            "upgrade_count must be 0 immediately after initialize"
        );

        // deployed_at must reflect the ledger timestamp at init time
        assert_eq!(
            info.deployed_at, 5_000,
            "deployed_at must equal the ledger timestamp at initialize"
        );

        // last_upgraded_at equals deployed_at when no upgrade has occurred
        assert_eq!(
            info.last_upgraded_at, info.deployed_at,
            "last_upgraded_at must equal deployed_at before any upgrade"
        );

        let _ = env;
    }

    /// `get_contract_version` is a pure read: calling it multiple times in
    /// succession must return identical data (idempotent, no side effects).
    #[test]
    fn test_version_query_is_stable_across_multiple_reads() {
        let (env, admin, client) = setup();
        client.initialize(&admin);

        let first = client.get_contract_version();
        let second = client.get_contract_version();
        let third = client.get_contract_version();

        assert_eq!(first.version, second.version);
        assert_eq!(second.version, third.version);
        assert_eq!(first.upgrade_count, second.upgrade_count);
        assert_eq!(first.deployed_at, second.deployed_at);
        assert_eq!(first.last_upgraded_at, second.last_upgraded_at);

        let _ = env;
    }

    /// `deployed_at` must never be mutated by any number of successful upgrades.
    #[test]
    fn test_deployed_at_is_immutable_across_upgrades() {
        let (env, admin, client) = setup();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        client.initialize(&admin);

        let original_deployed_at = client.get_contract_version().deployed_at;

        for seed in 1_u8..=4 {
            env.ledger().with_mut(|l| l.timestamp += 500);
            client.upgrade(&admin, &wasm_hash(&env, seed));
            let info = client.get_contract_version();
            assert_eq!(
                info.deployed_at, original_deployed_at,
                "deployed_at must remain constant after upgrade {seed}"
            );
        }
    }

    /// After N upgrades, `version` must equal `INITIAL_CONTRACT_VERSION + N`
    /// and `upgrade_count` must equal N — exactly one increment per successful
    /// upgrade, no more, no fewer.
    #[test]
    fn test_version_and_count_advance_exactly_once_per_upgrade() {
        let (env, admin, client) = setup();
        client.initialize(&admin);

        for n in 1_u32..=5 {
            env.ledger().with_mut(|l| l.timestamp += 1_000);
            client.upgrade(&admin, &wasm_hash(&env, n as u8));

            let info = client.get_contract_version();
            assert_eq!(
                info.version,
                INITIAL_CONTRACT_VERSION + n,
                "version must be INITIAL + {n} after {n} upgrades"
            );
            assert_eq!(
                info.upgrade_count, n,
                "upgrade_count must equal {n} after {n} upgrades"
            );
        }
    }

    /// `last_upgraded_at` must equal `deployed_at` before the first upgrade and
    /// must strictly advance with each subsequent upgrade.
    #[test]
    fn test_last_upgraded_at_tracks_each_upgrade_timestamp() {
        let (env, admin, client) = setup();
        env.ledger().with_mut(|l| l.timestamp = 10_000);
        client.initialize(&admin);

        let init_info = client.get_contract_version();
        assert_eq!(
            init_info.last_upgraded_at, init_info.deployed_at,
            "last_upgraded_at must equal deployed_at before any upgrade"
        );

        let mut prev_ts = init_info.last_upgraded_at;
        for seed in 1_u8..=3 {
            env.ledger().with_mut(|l| l.timestamp += 2_000);
            client.upgrade(&admin, &wasm_hash(&env, seed));

            let info = client.get_contract_version();
            assert!(
                info.last_upgraded_at > prev_ts,
                "last_upgraded_at must strictly increase after upgrade {seed}"
            );
            prev_ts = info.last_upgraded_at;
        }
    }

    /// A failed non-admin upgrade must not alter `upgrade_count` or
    /// `last_upgraded_at` — only successful upgrades change these fields.
    #[test]
    fn test_failed_upgrade_does_not_mutate_any_version_field() {
        let (env, admin, client) = setup();
        env.ledger().with_mut(|l| l.timestamp = 3_000);
        client.initialize(&admin);

        // Capture baseline after one legitimate upgrade.
        env.ledger().with_mut(|l| l.timestamp += 1_000);
        client.upgrade(&admin, &wasm_hash(&env, 1));
        let baseline = client.get_contract_version();

        // Advance time and attempt a non-admin upgrade.
        env.ledger().with_mut(|l| l.timestamp += 5_000);
        let attacker = Address::generate(&env);
        let result = client.try_upgrade(&attacker, &wasm_hash(&env, 2));
        assert_eq!(
            result,
            Err(Ok(EscrowError::E87)),
            "non-admin upgrade must return E87"
        );

        // Every field must be unchanged.
        let after = client.get_contract_version();
        assert_eq!(after.version, baseline.version);
        assert_eq!(after.upgrade_count, baseline.upgrade_count);
        assert_eq!(after.deployed_at, baseline.deployed_at);
        assert_eq!(after.last_upgraded_at, baseline.last_upgraded_at);
    }

    /// `get_contract_version` returns E2 when called before `initialize`,
    /// confirming that there is no default / zero-value fallback that clients
    /// could mistakenly treat as a valid version.
    #[test]
    fn test_version_query_before_init_returns_uninitialised_error() {
        let (env, _admin, client) = setup();
        let result = client.try_get_contract_version();
        assert_eq!(
            result,
            Err(Ok(EscrowError::E2)),
            "version query before initialize must return E2, not a default value"
        );
        let _ = env;
    }
}
