/// Storage-growth benchmarks for `slash_arbitrator` (issue #345).
///
/// The slash flow is admin-driven and evidence-based: the admin supplies an
/// opaque `reason` string (typically an IPFS CID) that is emitted in the
/// `arb_slh` event payload. This module establishes a regression budget for:
///
///   1. Persistent-key storage growth (entry count + key/value XDR bytes).
///   2. Branch boundaries between the in-place-rewrite path
///      (`remaining >= MIN_STAKE`) and the delete-both-entries path
///      (`remaining <  MIN_STAKE`).
///   3. Evidence-length neutrality: a longer `reason` must NOT grow any
///      persistent key.
///   4. Failure paths: non-admin and unstaked callers must not write storage.
///
/// Each test prints a structured line the `scripts/gas-profile.sh` collector
/// can pick up:
///
///   GAS_PROFILE | governance_contract | <case> | cpu=<n> | mem=<n> | ...
///
/// Budgets below are deliberately conservative ceilings. If a legitimate
/// change moves the numbers, update them with a note in the PR ﹣never
/// loosen silently to make the suite green.
#[cfg(test)]
mod gas_profiling {
    extern crate std;
    use std::println;

    use crate::types::DataKey;
    use crate::{GovernanceContract, GovernanceContractClient};
    use soroban_sdk::testutils::storage::Persistent as _;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::xdr::ToXdr;
    use soroban_sdk::{token, Address, Env, String};

    // ── Storage budgets ─────────────────────────────────────────────────
    /// Ceiling for the `ArbitratorStake(addr) → i128` key+value XDR bytes.
    /// The key encodes `DataKey::ArbitratorStake(Address)` and the value is a
    /// 16-byte big-endian i128; well under this cap.
    const MAX_SLASH_WRITE_BYTES: u32 = 256;

    // ── CPU / memory ceilings ───────────────────────────────────────────
    /// Success paths include one token transfer + one persistent write (or
    /// two deletes) + one event. Compared to escrow's `approve_milestone`
    /// (~330k CPU) this is lighter, but leave headroom for genuine refactors.
    const MAX_SLASH_ABOVE_MIN_CPU: u64 = 500_000;
    const MAX_SLASH_ABOVE_MIN_MEM: u64 = 80_000;
    const MAX_SLASH_BELOW_MIN_CPU: u64 = 500_000;
    const MAX_SLASH_BELOW_MIN_MEM: u64 = 80_000;

    /// Failure paths perform at most one storage read (Config) before
    /// returning. Any accidental write pushes them over this ceiling.
    const MAX_SLASH_FAIL_CPU: u64 = 200_000;
    const MAX_SLASH_FAIL_MEM: u64 = 40_000;

    // ── Fixed contract constants used by tests ──────────────────────────
    const START_TS: u64 = 1_000;
    const GOVERNANCE_THRESHOLD: i128 = 100;
    const VOTING_DELAY: u64 = 60;
    const VOTING_PERIOD: u64 = 3_600;
    const TIMELOCK_DELAY: u64 = 7_200;
    const QUORUM_BPS: u32 = 400;
    const APPROVAL_BPS: u32 = 5_100;
    const MIN_STAKE: i128 = 1_000;
    const SLASH_PERCENT: i128 = 10;

    // ── Snapshot of the two persistent entries slash_arbitrator can touch
    struct Snapshot {
        stake: Option<i128>,
        flag: Option<bool>,
        stake_bytes: u32,
        flag_bytes: u32,
        entries: u32,
    }

    fn setup() -> (Env, Address, Address, GovernanceContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = START_TS);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let contract_id = env.register_contract(None, GovernanceContract);
        let client = GovernanceContractClient::new(&env, &contract_id);
        client.initialize(
            &admin,
            &token,
            &GOVERNANCE_THRESHOLD,
            &VOTING_DELAY,
            &VOTING_PERIOD,
            &TIMELOCK_DELAY,
            &QUORUM_BPS,
            &APPROVAL_BPS,
        );
        (env, admin, token, client)
    }

    fn fund_and_stake(
        env: &Env,
        token: &Address,
        client: &GovernanceContractClient,
        who: &Address,
        amount: i128,
    ) {
        token::StellarAssetClient::new(env, token).mint(who, &amount);
        client.stake_arbitrator(who, &amount);
    }

    fn snapshot(env: &Env, contract: &Address, arb: &Address) -> Snapshot {
        let stake_key = DataKey::ArbitratorStake(arb.clone());
        let flag_key = DataKey::Arbitrator(arb.clone());

        let (stake, flag, entries) = env.as_contract(contract, || {
            let s = env.storage().persistent().get::<_, i128>(&stake_key);
            let f = env.storage().persistent().get::<_, bool>(&flag_key);
            let n = env.storage().persistent().all().len();
            (s, f, n)
        });

        let stake_bytes = match stake {
            Some(v) => stake_key.to_xdr(env).len() + v.to_xdr(env).len(),
            None => 0,
        };
        let flag_bytes = match flag {
            Some(v) => flag_key.to_xdr(env).len() + v.to_xdr(env).len(),
            None => 0,
        };
        Snapshot {
            stake,
            flag,
            stake_bytes,
            flag_bytes,
            entries,
        }
    }

    fn short_evidence(env: &Env) -> String {
        String::from_str(env, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")
    }

    // ───────────────────────────────────────────────────────────────────
    // Success path #1 ﹣ stake above MIN_STAKE: single in-place rewrite.
    // ───────────────────────────────────────────────────────────────────
    #[test]
    fn profile_slash_arbitrator_above_min_storage_budget() {
        let (env, admin, token, client) = setup();
        let arbitrator = Address::generate(&env);
        let recipient = Address::generate(&env);
        fund_and_stake(&env, &token, &client, &arbitrator, 2_000);

        let before = snapshot(&env, &client.address, &arbitrator);
        assert_eq!(before.stake, Some(2_000));
        assert_eq!(before.flag, Some(true));

        let reason = short_evidence(&env);
        env.budget().reset_default();
        let slash_amount = client.slash_arbitrator(&admin, &arbitrator, &recipient, &reason);
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();

        let after = snapshot(&env, &client.address, &arbitrator);

        // Behavior: 10% slash; entry kept because remaining >= MIN_STAKE.
        assert_eq!(slash_amount, 2_000 * SLASH_PERCENT / 100);
        assert_eq!(after.stake, Some(1_800));
        assert_eq!(after.flag, Some(true));

        // Storage growth: same entry, same byte size ﹣ i128 is fixed-width.
        assert_eq!(after.entries, before.entries);
        assert_eq!(after.stake_bytes, before.stake_bytes);
        assert_eq!(after.flag_bytes, before.flag_bytes);
        assert!(after.stake_bytes <= MAX_SLASH_WRITE_BYTES);
        assert!(after.flag_bytes <= MAX_SLASH_WRITE_BYTES);

        println!(
            "GAS_PROFILE | governance_contract | slash_arbitrator_above_min | cpu={} | mem={} | stake_bytes={} | flag_bytes={} | entries={}",
            cpu, mem, after.stake_bytes, after.flag_bytes, after.entries,
        );

        assert!(cpu <= MAX_SLASH_ABOVE_MIN_CPU, "cpu {cpu} > {MAX_SLASH_ABOVE_MIN_CPU}");
        assert!(mem <= MAX_SLASH_ABOVE_MIN_MEM, "mem {mem} > {MAX_SLASH_ABOVE_MIN_MEM}");
    }

    // ───────────────────────────────────────────────────────────────────
    // Success path #2 ﹣ stake below MIN_STAKE after slash: delete both.
    // stake=1100 ├бРђаРђЎ slash=110 ├бРђаРђЎ remaining=990 < MIN_STAKE.
    // ───────────────────────────────────────────────────────────────────
    #[test]
    fn profile_slash_arbitrator_below_min_storage_budget() {
        let (env, admin, token, client) = setup();
        let arbitrator = Address::generate(&env);
        let recipient = Address::generate(&env);
        fund_and_stake(&env, &token, &client, &arbitrator, 1_100);

        let before = snapshot(&env, &client.address, &arbitrator);
        assert_eq!(before.stake, Some(1_100));
        assert_eq!(before.flag, Some(true));

        let reason = short_evidence(&env);
        env.budget().reset_default();
        let slash_amount = client.slash_arbitrator(&admin, &arbitrator, &recipient, &reason);
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();

        let after = snapshot(&env, &client.address, &arbitrator);

        // Behavior: slash lands, entry is deleted (below-min branch).
        assert_eq!(slash_amount, 1_100 * SLASH_PERCENT / 100);
        assert_eq!(after.stake, None);
        assert_eq!(after.flag, None);
        assert_eq!(after.stake_bytes, 0);
        assert_eq!(after.flag_bytes, 0);

        // Storage growth: two entries removed, none added.
        assert_eq!(after.entries + 2, before.entries);

        println!(
            "GAS_PROFILE | governance_contract | slash_arbitrator_below_min | cpu={} | mem={} | entries_delta=-2 | entries_after={}",
            cpu, mem, after.entries,
        );

        assert!(cpu <= MAX_SLASH_BELOW_MIN_CPU, "cpu {cpu} > {MAX_SLASH_BELOW_MIN_CPU}");
        assert!(mem <= MAX_SLASH_BELOW_MIN_MEM, "mem {mem} > {MAX_SLASH_BELOW_MIN_MEM}");
    }

    // ───────────────────────────────────────────────────────────────────
    // Boundary path ﹣ remaining == MIN_STAKE exactly: must stay in the
    // above-min branch (i.e. NOT delete). stake=1111 ├бРђаРђЎ slash=111
    // ├бРђаРђЎ remaining=1000 == MIN_STAKE. Guards against an accidental
    // `<`  vs  `<=` regression in the branch condition.
    // ───────────────────────────────────────────────────────────────────
    #[test]
    fn profile_slash_arbitrator_exact_min_boundary_storage_budget() {
        let (env, admin, token, client) = setup();
        let arbitrator = Address::generate(&env);
        let recipient = Address::generate(&env);
        fund_and_stake(&env, &token, &client, &arbitrator, 1_111);

        let before = snapshot(&env, &client.address, &arbitrator);
        assert_eq!(before.stake, Some(1_111));

        let reason = short_evidence(&env);
        env.budget().reset_default();
        let slash_amount = client.slash_arbitrator(&admin, &arbitrator, &recipient, &reason);
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();

        let after = snapshot(&env, &client.address, &arbitrator);

        assert_eq!(slash_amount, 1_111 * SLASH_PERCENT / 100);
        assert_eq!(after.stake, Some(MIN_STAKE));
        assert_eq!(after.flag, Some(true));
        assert_eq!(after.entries, before.entries);
        assert_eq!(after.stake_bytes, before.stake_bytes);

        println!(
            "GAS_PROFILE | governance_contract | slash_arbitrator_at_min_boundary | cpu={} | mem={} | stake_bytes={} | entries={}",
            cpu, mem, after.stake_bytes, after.entries,
        );

        assert!(cpu <= MAX_SLASH_ABOVE_MIN_CPU);
        assert!(mem <= MAX_SLASH_ABOVE_MIN_MEM);
    }

    // ───────────────────────────────────────────────────────────────────
    // Boundary path ﹣ evidence length is storage-neutral. A ~200-byte
    // reason proves that a future refactor stuffing evidence into a new
    // persistent key (or into the stake record) would immediately break
    // this test.
    // ───────────────────────────────────────────────────────────────────
    #[test]
    fn profile_slash_arbitrator_evidence_length_does_not_grow_persistent_keys() {
        let (env, admin, token, client) = setup();
        let arbitrator = Address::generate(&env);
        let recipient = Address::generate(&env);
        fund_and_stake(&env, &token, &client, &arbitrator, 2_000);

        let before = snapshot(&env, &client.address, &arbitrator);

        // 200-byte "evidence" string ﹣ far larger than any CIDv1 (max 64).
        let long_reason = String::from_str(
            &env,
            "ipfs://evidence_padded_to_200_bytes_to_prove_that_the_on-chain_reason_string_does_not_leak_into_persistent_storage_where_it_would_cause_unbounded_ledger_growth_and_break_the_issue_345_budget_xxxxxxxxxxxxxxxx",
        );

        env.budget().reset_default();
        let slash_amount = client.slash_arbitrator(&admin, &arbitrator, &recipient, &long_reason);
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();

        let after = snapshot(&env, &client.address, &arbitrator);

        assert_eq!(slash_amount, 2_000 * SLASH_PERCENT / 100);
        assert_eq!(after.stake, Some(1_800));
        assert_eq!(after.flag, Some(true));

        // Evidence-length neutrality ﹣ the whole point of issue #345.
        assert_eq!(after.entries, before.entries, "evidence created a new persistent entry");
        assert_eq!(after.stake_bytes, before.stake_bytes, "evidence grew the stake record");
        assert_eq!(after.flag_bytes, before.flag_bytes, "evidence grew the flag record");

        println!(
            "GAS_PROFILE | governance_contract | slash_arbitrator_long_evidence | cpu={} | mem={} | stake_bytes={} | entries={}",
            cpu, mem, after.stake_bytes, after.entries,
        );

        assert!(cpu <= MAX_SLASH_ABOVE_MIN_CPU);
        assert!(mem <= MAX_SLASH_ABOVE_MIN_MEM);
    }

    // ───────────────────────────────────────────────────────────────────
    // Failure path ﹣ non-admin caller: zero storage writes.
    // ───────────────────────────────────────────────────────────────────
    #[test]
    fn profile_slash_arbitrator_non_admin_zero_write_budget() {
        let (env, _admin, token, client) = setup();
        let arbitrator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let outsider = Address::generate(&env);
        fund_and_stake(&env, &token, &client, &arbitrator, 2_000);

        let before = snapshot(&env, &client.address, &arbitrator);

        let reason = short_evidence(&env);
        env.budget().reset_default();
        let result = client.try_slash_arbitrator(&outsider, &arbitrator, &recipient, &reason);
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();

        assert!(result.is_err(), "non-admin caller must be rejected");

        let after = snapshot(&env, &client.address, &arbitrator);
        assert_eq!(before.entries, after.entries);
        assert_eq!(before.stake, after.stake);
        assert_eq!(before.flag, after.flag);
        assert_eq!(before.stake_bytes, after.stake_bytes);
        assert_eq!(before.flag_bytes, after.flag_bytes);

        println!(
            "GAS_PROFILE | governance_contract | slash_arbitrator_non_admin | cpu={} | mem={} | entries={}",
            cpu, mem, after.entries,
        );

        assert!(cpu <= MAX_SLASH_FAIL_CPU, "cpu {cpu} > {MAX_SLASH_FAIL_CPU}");
        assert!(mem <= MAX_SLASH_FAIL_MEM, "mem {mem} > {MAX_SLASH_FAIL_MEM}");
    }

    // ───────────────────────────────────────────────────────────────────
    // Failure path ﹣ unstaked target: zero storage writes.
    // ───────────────────────────────────────────────────────────────────
    #[test]
    fn profile_slash_arbitrator_unstaked_zero_write_budget() {
        let (env, admin, _token, client) = setup();
        let unknown = Address::generate(&env);
        let recipient = Address::generate(&env);

        let before = snapshot(&env, &client.address, &unknown);
        assert_eq!(before.stake, None);
        assert_eq!(before.flag, None);

        let reason = short_evidence(&env);
        env.budget().reset_default();
        let result = client.try_slash_arbitrator(&admin, &unknown, &recipient, &reason);
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();

        assert!(result.is_err(), "slashing unstaked address must be rejected");

        let after = snapshot(&env, &client.address, &unknown);
        assert_eq!(before.entries, after.entries);
        assert_eq!(after.stake, None);
        assert_eq!(after.flag, None);

        println!(
            "GAS_PROFILE | governance_contract | slash_arbitrator_unstaked | cpu={} | mem={} | entries={}",
            cpu, mem, after.entries,
        );

        assert!(cpu <= MAX_SLASH_FAIL_CPU);
        assert!(mem <= MAX_SLASH_FAIL_MEM);
    }
}
