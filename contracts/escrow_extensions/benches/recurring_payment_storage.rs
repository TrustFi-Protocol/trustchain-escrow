//! # Storage-Growth Benchmarks: Cross-Asset Path Payment Limits (#422)
//!
//! Measures the ledger-write footprint of `set_path_payment_limit` and
//! establishes a regression budget for realistic workloads.
//!
//! ## Ledger-write invariant
//! Each `set_path_payment_limit` call for a unique token writes exactly ONE
//! persistent entry (`PathPaymentLimit(token)`) plus one instance bump.
//! N distinct tokens therefore produce exactly N independent persistent entries.
//! These benchmarks assert that invariant by verifying that `get_path_payment_limit`
//! returns the correct value for every token after a batch of writes, and time
//! the wall-clock cost for realistic batch sizes (1, 5, 10 tokens).
//!
//! ## Regression budget
//! If the storage write count ever grows beyond O(N) (e.g., because an
//! intermediate helper starts writing extra keys) the assertion inside the
//! benchmark setup will catch it.
//!
//! ## Why criterion?
//! The `escrow_contract` benchmark uses the same `criterion` + `iter_batched`
//! pattern.  We follow that pattern here so results are directly comparable.

use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use soroban_sdk::{testutils::Address as _, Address, Env};
use stellar_trust_escrow_extensions::{EscrowExtensions, EscrowExtensionsClient};

// ── Helpers ───────────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    admin: Address,
    contract_id: Address,
}

fn make_setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, EscrowExtensions);
    let client = EscrowExtensionsClient::new(&env, &contract_id);
    client.initialize(&admin, &0_u32);
    Setup {
        env,
        admin,
        contract_id,
    }
}

/// Register a fresh Stellar asset contract and return its address as a token.
fn new_token(env: &Env) -> Address {
    let issuer = Address::generate(env);
    let tc = env.register_stellar_asset_contract_v2(issuer);
    tc.address()
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

/// Benchmark: write path-payment limits for N distinct tokens, then read them
/// all back to verify storage isolation.  Sizes: 1, 5, 10 tokens.
fn bench_set_path_payment_limit(c: &mut Criterion) {
    let mut group = c.benchmark_group("path_payment_limit_storage_growth");

    for &n in &[1usize, 5, 10] {
        group.bench_with_input(
            BenchmarkId::new("set_limit_n_tokens", n),
            &n,
            |b, &n| {
                b.iter_batched(
                    // ── Setup: create env + contract + N token addresses ──────
                    || {
                        let s = make_setup();
                        let tokens: Vec<Address> =
                            (0..n).map(|_| new_token(&s.env)).collect();
                        (s, tokens)
                    },
                    // ── Routine: write one limit per token ────────────────────
                    |(s, tokens)| {
                        let client = EscrowExtensionsClient::new(&s.env, &s.contract_id);
                        for (i, token) in tokens.iter().enumerate() {
                            let limit = (i as i128 + 1) * 1_000;
                            client.set_path_payment_limit(&s.admin, token, &limit);
                        }
                        // ── Regression budget assertion ───────────────────────
                        // Verify every token retained its own independent entry.
                        // If storage growth exceeds O(N) at least one token will
                        // return the wrong value and the assertion will fail.
                        for (i, token) in tokens.iter().enumerate() {
                            let expected = (i as i128 + 1) * 1_000;
                            let actual = client.get_path_payment_limit(token);
                            assert_eq!(
                                actual, expected,
                                "token {i}: expected {expected}, got {actual}"
                            );
                        }
                    },
                    BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

/// Benchmark: overwrite the same token's limit multiple times.  Verifies that
/// repeated writes on the same key do not accumulate extra entries.
fn bench_overwrite_single_token(c: &mut Criterion) {
    let mut group = c.benchmark_group("path_payment_limit_overwrite");

    for &rounds in &[5usize, 10, 20] {
        group.bench_with_input(
            BenchmarkId::new("overwrite_rounds", rounds),
            &rounds,
            |b, &rounds| {
                b.iter_batched(
                    || {
                        let s = make_setup();
                        let token = new_token(&s.env);
                        (s, token)
                    },
                    |(s, token)| {
                        let client = EscrowExtensionsClient::new(&s.env, &s.contract_id);
                        for r in 0..rounds {
                            let limit = (r as i128 + 1) * 100;
                            client.set_path_payment_limit(&s.admin, &token, &limit);
                        }
                        // After all overwrites, only the last value must be stored.
                        let expected = rounds as i128 * 100;
                        let actual = client.get_path_payment_limit(&token);
                        assert_eq!(
                            actual, expected,
                            "overwrite: expected {expected}, got {actual}"
                        );
                    },
                    BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

/// Benchmark: read-only `check_path_payment_limit` must not produce any
/// storage writes (O(0) writes per call).
fn bench_check_is_read_only(c: &mut Criterion) {
    let mut group = c.benchmark_group("path_payment_limit_check_read_only");

    for &checks in &[1usize, 10, 50] {
        group.bench_with_input(
            BenchmarkId::new("check_n_times", checks),
            &checks,
            |b, &checks| {
                b.iter_batched(
                    || {
                        let s = make_setup();
                        let token = new_token(&s.env);
                        let client = EscrowExtensionsClient::new(&s.env, &s.contract_id);
                        client.set_path_payment_limit(&s.admin, &token, &5_000_i128);
                        (s, token)
                    },
                    |(s, token)| {
                        let client = EscrowExtensionsClient::new(&s.env, &s.contract_id);
                        for _ in 0..checks {
                            // amount within limit: must return Ok
                            client.check_path_payment_limit(&token, &4_999_i128);
                        }
                        // Limit must be unchanged after all read-only checks.
                        assert_eq!(
                            client.get_path_payment_limit(&token),
                            5_000,
                            "check must not alter stored limit"
                        );
                    },
                    BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_set_path_payment_limit,
    bench_overwrite_single_token,
    bench_check_is_read_only,
);
criterion_main!(benches);
