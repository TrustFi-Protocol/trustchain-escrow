//! # Property-Based Invariant Tests
//!
//! This crate has no `proptest`/`quickcheck` dependency, so these tests
//! implement the same idea directly: a small deterministic PRNG (xorshift)
//! drives many randomized scenarios per test, and each scenario checks a
//! *general* invariant rather than one fixed example.
//!
//! Invariants covered:
//!
//! 1. **Conservation** — for any random partition of `total_amount` across
//!    1..=5 milestones, approved in any random order, the freelancer ends up
//!    with exactly `total_amount` and the escrow completes with a zero
//!    remaining balance. This must hold regardless of how the total is split
//!    or in what order milestones are approved.
//! 2. **Allocation ceiling** — milestone amounts can never be allocated past
//!    `total_amount`. For any random valid partition that already accounts
//!    for the full total, adding one more unit of milestone amount must
//!    always be rejected — for every partition shape, not just a hand-picked
//!    example.
//! 3. **Split escrow cancellation invariants** — covers two-way split,
//!    multi-party split, partial release before cancellation, and rounding
//!    residue, ensuring each participant receives only their intended refund
//!    share and total funds are strictly conserved without residue leakage.

#[cfg(test)]
#[allow(clippy::module_inception)]
mod property_invariant_tests {
    extern crate std;

    use soroban_sdk::{testutils::Address as _, token, Address, BytesN, Env, String};
    use std::vec::Vec as StdVec;

    use crate::{EscrowContract, EscrowContractClient, EscrowError, EscrowStatus, MultisigConfig};

    const RENT_RESERVE_PER_ENTRY: i128 = 30;

    fn no_multisig(env: &Env) -> MultisigConfig {
        MultisigConfig {
            approvers: soroban_sdk::Vec::new(env),
            weights: soroban_sdk::Vec::new(env),
            threshold: 0,
        }
    }

    struct TestEnv {
        env: Env,
        admin: Address,
        client: EscrowContractClient<'static>,
        token_id: Address,
    }

    fn setup() -> TestEnv {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = token_contract.address();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        TestEnv {
            env,
            admin,
            client,
            token_id,
        }
    }

    fn mint(env: &Env, token_id: &Address, to: &Address, amount: i128) {
        token::StellarAssetClient::new(env, token_id).mint(to, &amount);
    }

    /// Builds a deterministic, always-nonzero 32-byte brief hash from a seed
    /// (an all-zero hash is rejected by `create_escrow` as `InvalidBriefHash`).
    fn hash(env: &Env, seed: u32) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        let nonzero = seed.wrapping_add(1);
        bytes[28..32].copy_from_slice(&nonzero.to_be_bytes());
        BytesN::from_array(env, &bytes)
    }

    /// Minimal xorshift64* PRNG — deterministic, dependency-free, good enough
    /// to drive property-test input generation across many seeds.
    struct Rng(u64);

    impl Rng {
        fn new(seed: u64) -> Self {
            // xorshift requires a nonzero state.
            Rng(seed ^ 0x9E3779B97F4A7C15)
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        /// Random integer in `[lo, hi]` inclusive.
        fn range_i128(&mut self, lo: i128, hi: i128) -> i128 {
            let span = (hi - lo + 1) as u64;
            lo + (self.next_u64() % span) as i128
        }

        fn range_u32(&mut self, lo: u32, hi: u32) -> u32 {
            let span = (hi - lo + 1) as u64;
            lo + (self.next_u64() % span) as u32
        }

        /// Splits `total` into `n` positive parts that sum exactly to `total`,
        /// via n-1 distinct random cut points in `[1, total-1]`.
        fn partition(&mut self, total: i128, n: u32) -> StdVec<i128> {
            if n == 1 {
                let mut v = StdVec::new();
                v.push(total);
                return v;
            }
            let mut points: StdVec<i128> = StdVec::new();
            while points.len() < (n - 1) as usize {
                let candidate = self.range_i128(1, total - 1);
                if !points.contains(&candidate) {
                    points.push(candidate);
                }
            }
            points.sort_unstable();

            let mut amounts = StdVec::new();
            let mut prev = 0i128;
            for p in points.iter() {
                amounts.push(*p - prev);
                prev = *p;
            }
            amounts.push(total - prev);
            amounts
        }

        /// Fisher–Yates shuffle of `0..n`.
        fn shuffled_indices(&mut self, n: u32) -> StdVec<u32> {
            let mut idx: StdVec<u32> = (0..n).collect();
            for i in (1..idx.len()).rev() {
                let j = self.range_u32(0, i as u32) as usize;
                idx.swap(i, j);
            }
            idx
        }
    }

    // ── Invariant 1: conservation, for any partition and any approval order ──

    #[test]
    fn test_property_full_release_conserves_funds_for_any_partition_and_order() {
        for seed in 0u64..20 {
            let mut rng = Rng::new(seed);
            let n = rng.range_u32(1, 5);
            let total = rng.range_i128(1_000, 10_000);
            let amounts = rng.partition(total, n);
            assert_eq!(
                amounts.iter().sum::<i128>(),
                total,
                "partition must always sum exactly to total (seed {seed})"
            );

            let t = setup();
            let client_addr = Address::generate(&t.env);
            let freelancer = Address::generate(&t.env);
            let rent_reserve = RENT_RESERVE_PER_ENTRY * (1 + i128::from(n));
            mint(&t.env, &t.token_id, &client_addr, total + rent_reserve);

            let escrow_id = t.client.create_escrow(
                &client_addr,
                &freelancer,
                &t.token_id,
                &total,
                &hash(&t.env, seed as u32 * 1000),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&t.env),
                &None,
            );

            let mut milestone_ids: StdVec<u32> = StdVec::new();
            for (i, amount) in amounts.iter().enumerate() {
                let mid = t.client.add_milestone(
                    &client_addr,
                    &escrow_id,
                    &String::from_str(&t.env, "M"),
                    &hash(&t.env, seed as u32 * 1000 + i as u32 + 1),
                    amount,
                );
                milestone_ids.push(mid);
            }

            // Submit in creation order, approve in a random order — the final
            // conserved state must not depend on either order.
            for mid in milestone_ids.iter() {
                t.client.submit_milestone(&freelancer, &escrow_id, mid);
            }
            let approval_order = rng.shuffled_indices(n);
            for i in approval_order.iter() {
                let mid = milestone_ids[*i as usize];
                t.client.approve_milestone(&client_addr, &escrow_id, &mid);
            }

            let state = t.client.get_escrow(&escrow_id);
            assert_eq!(
                state.status,
                EscrowStatus::Completed,
                "seed {seed}: escrow must complete once every milestone is released"
            );
            assert_eq!(
                state.remaining_balance, 0,
                "seed {seed}: remaining_balance must be exactly zero after full release"
            );
            assert_eq!(
                token::Client::new(&t.env, &t.token_id).balance(&freelancer),
                total,
                "seed {seed}: freelancer must receive exactly total_amount, no more, no less"
            );
        }
    }

    // ── Invariant 2: milestone amounts can never be allocated past total ────

    #[test]
    fn test_property_milestone_allocation_never_exceeds_total() {
        for seed in 100u64..120 {
            let mut rng = Rng::new(seed);
            let n = rng.range_u32(1, 5);
            let total = rng.range_i128(1_000, 10_000);
            let amounts = rng.partition(total, n);

            let t = setup();
            let client_addr = Address::generate(&t.env);
            let freelancer = Address::generate(&t.env);
            // Fund one extra unit so the final over-allocation attempt fails
            // on the allocation check itself, not on insufficient balance.
            let rent_reserve = RENT_RESERVE_PER_ENTRY * (2 + i128::from(n));
            mint(&t.env, &t.token_id, &client_addr, total + rent_reserve + 1);

            let escrow_id = t.client.create_escrow(
                &client_addr,
                &freelancer,
                &t.token_id,
                &total,
                &hash(&t.env, seed as u32 * 1000),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&t.env),
                &None,
            );

            for (i, amount) in amounts.iter().enumerate() {
                t.client.add_milestone(
                    &client_addr,
                    &escrow_id,
                    &String::from_str(&t.env, "M"),
                    &hash(&t.env, seed as u32 * 1000 + i as u32 + 1),
                    amount,
                );
            }

            // The partition already accounts for the full total — one more
            // unit of allocation must always be rejected, regardless of how
            // many milestones or what split was used to reach `total`.
            let result = t.client.try_add_milestone(
                &client_addr,
                &escrow_id,
                &String::from_str(&t.env, "Over"),
                &hash(&t.env, seed as u32 * 1000 + n + 1),
                &1,
            );
            assert_eq!(
                result,
                Err(Ok(EscrowError::E15)),
                "seed {seed}: allocating past total_amount must always be rejected"
            );
        }
    }

    // ── Invariant 3: Two-way split escrow cancellation ───────────────────────

    #[test]
    fn test_invariant_two_way_split_cancellation() {
        for seed in 200u64..215 {
            let mut rng = Rng::new(seed);
            let total = rng.range_i128(2_000, 10_000);
            let alloc = rng.range_i128(500, total - 500);
            let unallocated = total - alloc;
            let split_amount = rng.range_i128(100, unallocated - 100);

            let t = setup();
            let treasury = Address::generate(&t.env);
            t.client.set_platform_treasury(&t.admin, &treasury);

            let client_addr = Address::generate(&t.env);
            let freelancer = Address::generate(&t.env);
            let rent_buffer = 10_000_000_i128;
            mint(&t.env, &t.token_id, &client_addr, total + unallocated + rent_buffer);

            let parent_id = t.client.create_escrow(
                &client_addr,
                &freelancer,
                &t.token_id,
                &total,
                &hash(&t.env, seed as u32 * 1000),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&t.env),
                &None,
            );

            // Allocate `alloc` to a milestone, leaving `unallocated` splittable
            t.client.add_milestone(
                &client_addr,
                &parent_id,
                &String::from_str(&t.env, "M1"),
                &hash(&t.env, seed as u32 * 1000 + 1),
                &alloc,
            );

            // Execute two-way split
            let (child1, child2) = t.client.split_escrow(
                &client_addr,
                &parent_id,
                &split_amount,
                &hash(&t.env, seed as u32 * 1000 + 2),
            );

            let child1_meta = t.client.get_escrow_meta(&child1);
            let child2_meta = t.client.get_escrow_meta(&child2);
            assert_eq!(child1_meta.total_amount, split_amount);
            assert_eq!(child2_meta.total_amount, unallocated - split_amount);

            let token_client = token::Client::new(&t.env, &t.token_id);
            let client_bal_before = token_client.balance(&client_addr);
            let treasury_bal_before = token_client.balance(&treasury);

            // Cancel child 1
            t.client.cancel_escrow(&client_addr, &child1);
            let child1_post = t.client.get_escrow(&child1);
            assert_eq!(child1_post.status, EscrowStatus::Cancelled);
            assert_eq!(child1_post.remaining_balance, 0);

            // Cancel child 2
            t.client.cancel_escrow(&client_addr, &child2);
            let child2_post = t.client.get_escrow(&child2);
            assert_eq!(child2_post.status, EscrowStatus::Cancelled);
            assert_eq!(child2_post.remaining_balance, 0);

            let client_refunded = token_client.balance(&client_addr) - client_bal_before;
            let treasury_fees = token_client.balance(&treasury) - treasury_bal_before;

            // Invariant: client refund + platform fees strictly conserves the split balance
            assert_eq!(
                client_refunded + treasury_fees,
                unallocated,
                "seed {seed}: two-way split cancellation must conserve all split funds"
            );
        }
    }

    // ── Invariant 4: Multi-party split cancellation ───────────────────────────

    #[test]
    fn test_invariant_multi_party_split_cancellation() {
        for seed in 300u64..315 {
            let mut rng = Rng::new(seed);
            let total = rng.range_i128(5_000, 15_000);
            let alloc = rng.range_i128(1_000, 2_000);
            let unallocated = total - alloc;

            let t = setup();
            let treasury = Address::generate(&t.env);
            t.client.set_platform_treasury(&t.admin, &treasury);

            let client_addr = Address::generate(&t.env);
            let freelancer = Address::generate(&t.env);
            let rent_buffer = 10_000_000_i128;
            mint(&t.env, &t.token_id, &client_addr, total * 3 + rent_buffer);

            let parent_id = t.client.create_escrow(
                &client_addr,
                &freelancer,
                &t.token_id,
                &total,
                &hash(&t.env, seed as u32 * 1000),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&t.env),
                &None,
            );

            t.client.add_milestone(
                &client_addr,
                &parent_id,
                &String::from_str(&t.env, "M_Alloc"),
                &hash(&t.env, seed as u32 * 1000 + 1),
                &alloc,
            );

            // First split: parent unallocated into child1 and child2
            let split1 = unallocated / 2;
            let (child1, child2) = t.client.split_escrow(
                &client_addr,
                &parent_id,
                &split1,
                &hash(&t.env, seed as u32 * 1000 + 2),
            );

            // Add small milestone in child2 to leave splittable remainder
            let child2_meta = t.client.get_escrow_meta(&child2);
            let child2_alloc = 200_i128;
            t.client.add_milestone(
                &client_addr,
                &child2,
                &String::from_str(&t.env, "M_Child2"),
                &hash(&t.env, seed as u32 * 1000 + 3),
                &child2_alloc,
            );

            // Second split: multi-party hierarchy (child2 split into child3 and child4)
            let child2_unallocated = child2_meta.total_amount - child2_alloc;
            let split2 = child2_unallocated / 2;
            let (child3, child4) = t.client.split_escrow(
                &client_addr,
                &child2,
                &split2,
                &hash(&t.env, seed as u32 * 1000 + 4),
            );

            let token_client = token::Client::new(&t.env, &t.token_id);
            let client_bal_before = token_client.balance(&client_addr);
            let treasury_bal_before = token_client.balance(&treasury);

            // Cancel all multi-party split child escrows
            t.client.cancel_escrow(&client_addr, &child1);
            t.client.cancel_escrow(&client_addr, &child3);
            t.client.cancel_escrow(&client_addr, &child4);

            for cid in [child1, child3, child4] {
                let s = t.client.get_escrow(&cid);
                assert_eq!(s.status, EscrowStatus::Cancelled);
                assert_eq!(s.remaining_balance, 0);
            }

            let total_split_sum = split1 + child2_unallocated;
            let client_refunded = token_client.balance(&client_addr) - client_bal_before;
            let treasury_fees = token_client.balance(&treasury) - treasury_bal_before;

            assert_eq!(
                client_refunded + treasury_fees,
                total_split_sum,
                "seed {seed}: multi-party split cancellation must strictly conserve split funds"
            );
        }
    }

    // ── Invariant 5: Partial release before cancellation ──────────────────────

    #[test]
    fn test_invariant_partial_release_before_cancellation() {
        for seed in 400u64..415 {
            let mut rng = Rng::new(seed);
            let n = rng.range_u32(2, 5);
            let total = rng.range_i128(2_000, 10_000);
            let amounts = rng.partition(total, n);

            let t = setup();
            let treasury = Address::generate(&t.env);
            t.client.set_platform_treasury(&t.admin, &treasury);

            let client_addr = Address::generate(&t.env);
            let freelancer = Address::generate(&t.env);
            let rent_reserve = RENT_RESERVE_PER_ENTRY * (2 + i128::from(n));
            mint(&t.env, &t.token_id, &client_addr, total + rent_reserve);

            let escrow_id = t.client.create_escrow(
                &client_addr,
                &freelancer,
                &t.token_id,
                &total,
                &hash(&t.env, seed as u32 * 1000),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&t.env),
                &None,
            );

            let mut mids = StdVec::new();
            for (i, amt) in amounts.iter().enumerate() {
                let mid = t.client.add_milestone(
                    &client_addr,
                    &escrow_id,
                    &String::from_str(&t.env, "M"),
                    &hash(&t.env, seed as u32 * 1000 + i as u32 + 1),
                    amt,
                );
                mids.push(mid);
            }

            // Submit and approve/release the first milestone before cancellation
            t.client.submit_milestone(&freelancer, &escrow_id, &mids[0]);
            t.client.approve_milestone(&client_addr, &escrow_id, &mids[0]);

            let token_client = token::Client::new(&t.env, &t.token_id);
            let freelancer_after_release = token_client.balance(&freelancer);
            assert_eq!(freelancer_after_release, amounts[0]);

            let client_bal_before_cancel = token_client.balance(&client_addr);
            let treasury_bal_before_cancel = token_client.balance(&treasury);

            // Cancel escrow with remaining unreleased/unapproved milestones
            t.client.cancel_escrow(&client_addr, &escrow_id);

            let post_state = t.client.get_escrow(&escrow_id);
            assert_eq!(post_state.status, EscrowStatus::Cancelled);
            assert_eq!(post_state.remaining_balance, 0);

            let client_refund = token_client.balance(&client_addr) - client_bal_before_cancel;
            let treasury_fee = token_client.balance(&treasury) - treasury_bal_before_cancel;
            let freelancer_total = token_client.balance(&freelancer);

            // Invariant: prior releases + client refund + treasury fee == initial total
            assert_eq!(
                freelancer_total + client_refund + treasury_fee,
                total,
                "seed {seed}: partial release before cancellation must conserve total funds"
            );
        }
    }

    // ── Invariant 6: Rounding residue strictly conserved ──────────────────────

    #[test]
    fn test_invariant_cancellation_rounding_residue() {
        // Test varying totals that produce non-zero integer division remainder with fee tiers
        let odd_totals: [i128; 7] = [1_001, 1_337, 3_333, 7_777, 9_999, 12_345, 99_999];

        for total in odd_totals {
            let t = setup();
            let treasury = Address::generate(&t.env);
            t.client.set_platform_treasury(&t.admin, &treasury);

            let client_addr = Address::generate(&t.env);
            let freelancer = Address::generate(&t.env);
            let rent_reserve = RENT_RESERVE_PER_ENTRY * 2;
            mint(&t.env, &t.token_id, &client_addr, total + rent_reserve);

            let escrow_id = t.client.create_escrow(
                &client_addr,
                &freelancer,
                &t.token_id,
                &total,
                &hash(&t.env, (total % 100_000) as u32),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&t.env),
                &None,
            );

            let token_client = token::Client::new(&t.env, &t.token_id);
            let client_bal_before = token_client.balance(&client_addr);
            let treasury_bal_before = token_client.balance(&treasury);

            t.client.cancel_escrow(&client_addr, &escrow_id);

            let post_state = t.client.get_escrow(&escrow_id);
            assert_eq!(post_state.status, EscrowStatus::Cancelled);
            assert_eq!(post_state.remaining_balance, 0);

            let client_refund = token_client.balance(&client_addr) - client_bal_before;
            let fee_collected = token_client.balance(&treasury) - treasury_bal_before;

            // Invariant: refund + fee == total, no stroops lost to rounding residue
            assert_eq!(
                client_refund + fee_collected,
                total,
                "total {total}: client refund + fee must exactly equal total with no rounding residue lost"
            );
            assert!(client_refund > 0);
        }
    }
}
