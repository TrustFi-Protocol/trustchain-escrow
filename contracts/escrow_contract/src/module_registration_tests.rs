//! # Module registration tests
//!
//! Two concerns are covered here:
//!
//! 1. **File-registration guard** — Every `*_tests.rs` file in `src/` must be
//!    declared with `mod <name>;` in `lib.rs`, or its tests silently never run.
//!    The guard surfaces the gap on the next `cargo test`.
//!
//! 2. **Authorization tests** — Only the contract admin may register, replace,
//!    or disable modules. Non-admin calls must be rejected. Duplicate names
//!    result in a replacement (the new address takes effect, status resets to
//!    Active). Querying a missing module returns the uninitialised error.

// ── Guard: every test file must be registered in lib.rs ──────────────────────

#[cfg(test)]
#[allow(clippy::module_inception)]
mod module_registration_tests {
    extern crate std;

    use std::format;
    use std::fs;
    use std::string::{String, ToString};
    use std::vec::Vec;

    /// Every `*_tests.rs` file in `src/` must have a matching `mod` declaration
    /// in `lib.rs`, otherwise its tests never compile or run.
    #[test]
    fn every_test_file_is_registered_in_lib_rs() {
        let src_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let lib_rs = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("src/lib.rs must be readable");

        let mut unregistered: Vec<String> = Vec::new();

        for entry in fs::read_dir(src_dir).expect("src/ must be readable") {
            let entry = entry.expect("src/ entry must be readable");
            let file_name = entry.file_name().to_string_lossy().to_string();

            let stem = match file_name.strip_suffix(".rs") {
                Some(stem) => stem,
                None => continue,
            };
            if !stem.ends_with("_tests") {
                continue;
            }

            // `mod name;` is the declaration form used throughout lib.rs.
            if !lib_rs.contains(&format!("mod {stem};")) {
                unregistered.push(file_name);
            }
        }

        unregistered.sort();

        assert!(
            unregistered.is_empty(),
            "these test files exist in src/ but are not declared in lib.rs, so their \
             tests never compile or run — add `mod <name>;` to lib.rs for each: {:?}",
            unregistered
        );
    }
}

// ── Authorization tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod module_auth_tests {
    use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

    use crate::{EscrowContract, EscrowContractClient, EscrowError, ModuleStatus};

    // ── helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, admin, client)
    }

    // ── register_module ───────────────────────────────────────────────────────

    /// Admin can register a new module; the record is immediately queryable and
    /// starts in Active status.
    #[test]
    fn test_admin_can_register_module() {
        let (env, admin, client) = setup();
        let module_addr = Address::generate(&env);
        let name = symbol_short!("payments");

        client.register_module(&admin, &name, &module_addr);

        let record = client.get_module(&name).expect("module should exist");
        assert_eq!(record.address, module_addr);
        assert_eq!(record.status, ModuleStatus::Active);
    }

    /// A non-admin caller must be rejected when attempting to register a module.
    #[test]
    fn test_non_admin_cannot_register_module() {
        let (env, _admin, client) = setup();
        let attacker = Address::generate(&env);
        let module_addr = Address::generate(&env);
        let name = symbol_short!("payments");

        let result = client.try_register_module(&attacker, &name, &module_addr);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E4)),
            "non-admin register_module must return E4 (NotAdmin)"
        );
    }

    /// Registering under a name that already exists replaces the record: the new
    /// address takes effect and status resets to Active (even if it was Disabled).
    #[test]
    fn test_duplicate_module_name_replaces_existing_record() {
        let (env, admin, client) = setup();
        let first_addr = Address::generate(&env);
        let second_addr = Address::generate(&env);
        let name = symbol_short!("payments");

        // Register first, then disable it.
        client.register_module(&admin, &name, &first_addr);
        client.disable_module(&admin, &name);

        let disabled = client.get_module(&name).expect("module should exist");
        assert_eq!(disabled.status, ModuleStatus::Disabled);

        // Re-register under the same name → should replace.
        client.register_module(&admin, &name, &second_addr);

        let replaced = client.get_module(&name).expect("replaced module should exist");
        assert_eq!(
            replaced.address, second_addr,
            "address must be updated to the new contract"
        );
        assert_eq!(
            replaced.status,
            ModuleStatus::Active,
            "status must reset to Active on re-registration"
        );
    }

    // ── disable_module ────────────────────────────────────────────────────────

    /// Admin can disable an active module; the record persists but is marked
    /// Disabled.
    #[test]
    fn test_admin_can_disable_module() {
        let (env, admin, client) = setup();
        let module_addr = Address::generate(&env);
        let name = symbol_short!("bridge");

        client.register_module(&admin, &name, &module_addr);
        client.disable_module(&admin, &name);

        let record = client.get_module(&name).expect("module should still exist after disable");
        assert_eq!(record.status, ModuleStatus::Disabled);
        assert_eq!(
            record.address, module_addr,
            "address must be preserved when disabling"
        );
    }

    /// A non-admin caller must be rejected when attempting to disable a module.
    #[test]
    fn test_non_admin_cannot_disable_module() {
        let (env, admin, client) = setup();
        let module_addr = Address::generate(&env);
        let attacker = Address::generate(&env);
        let name = symbol_short!("bridge");

        client.register_module(&admin, &name, &module_addr);

        let result = client.try_disable_module(&attacker, &name);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E4)),
            "non-admin disable_module must return E4 (NotAdmin)"
        );

        // Module must remain Active after the rejected call.
        let record = client.get_module(&name).expect("module should still exist");
        assert_eq!(record.status, ModuleStatus::Active);
    }

    /// Attempting to disable a module that was never registered returns E2
    /// (contract not initialised / key not found).
    #[test]
    fn test_disable_nonexistent_module_returns_error() {
        let (env, admin, client) = setup();
        let name = symbol_short!("ghost");

        let result = client.try_disable_module(&admin, &name);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E2)),
            "disabling a non-existent module must return E2"
        );
        let _ = env;
    }

    // ── get_module ────────────────────────────────────────────────────────────

    /// Querying a module that was never registered returns E2.
    #[test]
    fn test_get_unregistered_module_returns_error() {
        let (env, _admin, client) = setup();
        let name = symbol_short!("unknown");

        let result = client.try_get_module(&name);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E2)),
            "get_module on unknown name must return E2"
        );
        let _ = env;
    }

    /// Multiple distinct modules can be registered independently and each is
    /// queryable by its own name without interfering with the others.
    #[test]
    fn test_multiple_modules_registered_independently() {
        let (env, admin, client) = setup();
        let addr_a = Address::generate(&env);
        let addr_b = Address::generate(&env);
        let name_a = symbol_short!("alpha");
        let name_b = symbol_short!("beta");

        client.register_module(&admin, &name_a, &addr_a);
        client.register_module(&admin, &name_b, &addr_b);

        let rec_a = client.get_module(&name_a).expect("alpha must exist");
        let rec_b = client.get_module(&name_b).expect("beta must exist");

        assert_eq!(rec_a.address, addr_a);
        assert_eq!(rec_b.address, addr_b);
        assert_eq!(rec_a.status, ModuleStatus::Active);
        assert_eq!(rec_b.status, ModuleStatus::Active);
    }
}
