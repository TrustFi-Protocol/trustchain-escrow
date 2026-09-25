//! # Slippage boundary tests for path-payment escrow flows
//!
//! Covers the `check_slippage` invariant across exact boundary conditions:
//!
//! - **Zero tolerance** (`slippage_bps == 0`): check is bypassed entirely;
//!   any price movement is allowed.
//! - **Just within tolerance** (`actual_deviation < max_deviation`): release
//!   must succeed.
//! - **Exactly at tolerance** (`actual_deviation == max_deviation`): release
//!   must succeed (the check uses `>`, not `>=`).
//! - **Just outside tolerance** (`actual_deviation == max_deviation + 1`):
//!   release must be rejected with `E86`.
//!
//! Each test wires a mock oracle whose `lastprice` always returns the current
//! ledger timestamp so prices are always fresh, allowing the test to vary only
//! the price value without worrying about staleness.

#[cfg(test)]
#[allow(clippy::module_inception)]
mod slippage_tests {
    use soroban_sdk::{
        contract, contractimpl, testutils::Address as _, testutils::Ledger as _, Address, BytesN,
        Env, String,
    };

    use crate::{
        oracle::PriceData, EscrowContract, EscrowContractClient, EscrowError, MultisigConfig,
        MAX_ESCROW_AMOUNT,
    };

    // ── Mock oracle ───────────────────────────────────────────────────────────

    /// A mock oracle whose `lastprice` returns whatever price is stored under
    /// the key "price", with a timestamp equal to the current ledger time so
    /// the data is always considered fresh by `check_slippage`.
    #[contract]
    struct SlippageMockOracle;

    #[contractimpl]
    impl SlippageMockOracle {
        pub fn set_price(env: Env, price: i128) {
            env.storage().instance().set(&"price", &price);
        }

        pub fn lastprice(env: Env, _asset: Address) -> Option<PriceData> {
            let price: i128 = env.storage().instance().get(&"price").unwrap_or(0);
            Some(PriceData {
                price,
                timestamp: env.ledger().timestamp(),
            })
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    struct Setup {
        env: Env,
        admin: Address,
        escrow_client: Address,
        freelancer: Address,
        contract: EscrowContractClient<'static>,
        oracle: Address,
        token: Address,
    }

    fn make_setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let admin = Address::generate(&env);
        let escrow_client = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let contract_id = env.register_contract(None, EscrowContract);
        let contract = EscrowContractClient::new(&env, &contract_id);
        contract.initialize(&admin);

        // Register mock oracle.
        let oracle = env.register_contract(None, SlippageMockOracle);
        let oracle_client = SlippageMockOracleClient::new(&env, &oracle);
        // Default price: 1_000_000 (used when set_slippage_bps is called).
        oracle_client.set_price(&1_000_000_i128);
        contract.set_oracle(&admin, &oracle);

        // Token: mint enough for the client to fund escrows.
        let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let token = token_contract.address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token)
            .mint(&escrow_client, &MAX_ESCROW_AMOUNT);

        Setup {
            env,
            admin,
            escrow_client,
            freelancer,
            contract,
            oracle,
            token,
        }
    }

    fn no_multisig(env: &Env) -> MultisigConfig {
        MultisigConfig {
            approvers: soroban_sdk::Vec::new(env),
            weights: soroban_sdk::Vec::new(env),
            threshold: 0,
        }
    }

    fn hash32(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0xabu8; 32])
    }

    /// Creates an escrow and returns its ID.
    fn create_escrow(s: &Setup, amount: i128) -> u64 {
        s.contract
            .create_escrow(
                &s.escrow_client,
                &s.freelancer,
                &s.token,
                &amount,
                &hash32(&s.env),
                &None,
                &None,
                &None,
                &None,
                &no_multisig(&s.env),
                &None,
            )
            .expect("create_escrow must succeed")
    }

    /// Adds a milestone for `amount` and returns its ID.
    fn add_milestone(s: &Setup, escrow_id: u64, amount: i128) -> u32 {
        s.contract
            .add_milestone(
                &s.escrow_client,
                &escrow_id,
                &String::from_str(&s.env, "Deliverable"),
                &hash32(&s.env),
                &amount,
            )
            .expect("add_milestone must succeed")
    }

    /// Sets the oracle price, then records the slippage reference via
    /// `set_slippage_bps`.  After this call, `reference_price` equals
    /// whatever `oracle_price` is set to right now.
    fn arm_slippage(s: &Setup, escrow_id: u64, oracle_price: i128, slippage_bps: u32) {
        let oracle_client = SlippageMockOracleClient::new(&s.env, &s.oracle);
        oracle_client.set_price(&oracle_price);
        s.contract
            .set_slippage_bps(&s.escrow_client, escrow_id, slippage_bps)
            .expect("set_slippage_bps must succeed");
    }

    /// Submits a milestone (as freelancer) then approves it (as client).
    fn submit_and_try_approve(
        s: &Setup,
        escrow_id: u64,
        milestone_id: u32,
    ) -> Result<(), EscrowError> {
        s.contract
            .submit_milestone(&s.freelancer, &escrow_id, &milestone_id)
            .expect("submit_milestone must succeed");
        s.contract
            .try_approve_milestone(&s.escrow_client, &escrow_id, &milestone_id)
            .map(|r| r.expect("inner Result must be Ok on success"))
    }

    // ── Existing auth / validation tests (preserved) ──────────────────────────

    #[test]
    fn test_set_slippage_bps_requires_client_auth() {
        let s = make_setup();
        let escrow_id = create_escrow(&s, 100_000);
        let other = Address::generate(&s.env);
        let result = s.contract.try_set_slippage_bps(&other, escrow_id, 500);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_slippage_bps_non_client_rejected() {
        let s = make_setup();
        let escrow_id = create_escrow(&s, 100_000);
        let other = Address::generate(&s.env);
        let result = s.contract.try_set_slippage_bps(&other, escrow_id, 500);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_slippage_bps_exceeds_max() {
        let s = make_setup();
        let escrow_id = create_escrow(&s, 100_000);
        let result = s.contract.try_set_slippage_bps(&s.escrow_client, escrow_id, 10_001);
        assert!(result.is_err());
    }

    // ── New coverage: exact boundary conditions (issue #216) ──────────────────

    /// Zero tolerance (`slippage_bps == 0`): the slippage check is bypassed
    /// entirely. Even a large price swing must not block fund release.
    #[test]
    fn test_zero_slippage_bps_bypasses_check() {
        let s = make_setup();
        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);

        // Reference price recorded as 1_000_000.
        arm_slippage(&s, escrow_id, 1_000_000, 0);

        // Move price to a wildly different value — check must still pass.
        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&9_000_000_i128);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert!(
            result.is_ok(),
            "zero slippage_bps must bypass the check; got: {:?}",
            result
        );
    }

    /// Price has not moved at all — `actual_deviation == 0` which is well
    /// within any non-zero tolerance. Release must succeed.
    #[test]
    fn test_no_price_movement_always_passes() {
        let s = make_setup();
        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);

        // Reference price = current price = 1_000_000, tolerance = 5% (500 bps).
        arm_slippage(&s, escrow_id, 1_000_000, 500);
        // Price unchanged.
        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&1_000_000_i128);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert!(result.is_ok(), "no price movement must pass; got: {:?}", result);
    }

    /// Price moved to exactly `reference − max_deviation`:
    /// `actual_deviation == max_deviation` — the check uses `>` not `>=`, so
    /// this must succeed (boundary is inclusive).
    ///
    /// reference = 1_000_000, slippage_bps = 500 (5%)
    /// max_deviation = 1_000_000 * 500 / 10_000 = 50_000
    /// current_price = 1_000_000 − 50_000 = 950_000  →  deviation = 50_000 == max
    #[test]
    fn test_price_deviation_exactly_at_tolerance_passes() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        let slippage_bps: u32 = 500; // 5%
        let max_deviation = reference_price * i128::from(slippage_bps) / 10_000; // 50_000
        let current_price = reference_price - max_deviation; // exactly at boundary

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, slippage_bps);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert!(
            result.is_ok(),
            "deviation == max_deviation must pass (boundary inclusive); got: {:?}",
            result
        );
    }

    /// Price moved to `reference − (max_deviation − 1)`:
    /// `actual_deviation == max_deviation − 1` — strictly inside tolerance.
    /// Release must succeed.
    ///
    /// reference = 1_000_000, slippage_bps = 500 (5%)
    /// max_deviation = 50_000
    /// current_price = 1_000_000 − 49_999 = 950_001  →  deviation = 49_999 < max
    #[test]
    fn test_price_deviation_just_inside_tolerance_passes() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        let slippage_bps: u32 = 500; // 5%
        let max_deviation = reference_price * i128::from(slippage_bps) / 10_000; // 50_000
        let current_price = reference_price - (max_deviation - 1); // one unit inside

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, slippage_bps);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert!(
            result.is_ok(),
            "deviation one unit inside tolerance must pass; got: {:?}",
            result
        );
    }

    /// Price moved to `reference − (max_deviation + 1)`:
    /// `actual_deviation == max_deviation + 1` — one unit outside tolerance.
    /// Release must be rejected with `E86`.
    ///
    /// reference = 1_000_000, slippage_bps = 500 (5%)
    /// max_deviation = 50_000
    /// current_price = 1_000_000 − 50_001 = 949_999  →  deviation = 50_001 > max
    #[test]
    fn test_price_deviation_just_outside_tolerance_rejected() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        let slippage_bps: u32 = 500; // 5%
        let max_deviation = reference_price * i128::from(slippage_bps) / 10_000; // 50_000
        let current_price = reference_price - (max_deviation + 1); // one unit outside

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, slippage_bps);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert_eq!(
            result,
            Err(EscrowError::E86),
            "deviation one unit outside tolerance must return E86"
        );
    }

    /// Same boundary check but with price moving *up* rather than *down*.
    ///
    /// reference = 1_000_000, slippage_bps = 500 (5%)
    /// max_deviation = 50_000
    /// current_price = 1_000_000 + 50_001 = 1_050_001  →  deviation = 50_001 > max
    #[test]
    fn test_price_increase_just_outside_tolerance_rejected() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        let slippage_bps: u32 = 500; // 5%
        let max_deviation = reference_price * i128::from(slippage_bps) / 10_000; // 50_000
        let current_price = reference_price + max_deviation + 1; // one unit above tolerance

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, slippage_bps);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert_eq!(
            result,
            Err(EscrowError::E86),
            "upward deviation one unit outside tolerance must return E86"
        );
    }

    /// Price increase exactly at tolerance (upper boundary, inclusive).
    ///
    /// reference = 1_000_000, slippage_bps = 500 (5%)
    /// max_deviation = 50_000
    /// current_price = 1_000_000 + 50_000 = 1_050_000  →  deviation = 50_000 == max
    #[test]
    fn test_price_increase_exactly_at_tolerance_passes() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        let slippage_bps: u32 = 500; // 5%
        let max_deviation = reference_price * i128::from(slippage_bps) / 10_000; // 50_000
        let current_price = reference_price + max_deviation; // exactly at upper boundary

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, slippage_bps);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert!(
            result.is_ok(),
            "upward deviation == max_deviation must pass (boundary inclusive); got: {:?}",
            result
        );
    }

    /// Maximum allowed tolerance: `slippage_bps == 10_000` (100%).
    /// A price drop of exactly 100% would reach zero, but any drop less than
    /// 100% must succeed because max_deviation == reference_price.
    #[test]
    fn test_maximum_slippage_bps_allows_large_price_movement() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        // 10_000 bps = 100% tolerance — max_deviation == reference_price
        let max_deviation = reference_price; // 1_000_000 * 10_000 / 10_000 = 1_000_000

        // Move price down by exactly max_deviation (boundary, should pass).
        let current_price = reference_price - max_deviation + 1; // 1 — inside boundary

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, 10_000);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert!(
            result.is_ok(),
            "100% tolerance must allow large price movement; got: {:?}",
            result
        );
    }

    /// Very tight tolerance: `slippage_bps == 1` (0.01%).
    ///
    /// reference = 1_000_000, max_deviation = 100
    /// current_price = 1_000_000 − 101  →  deviation = 101 > max → rejected.
    #[test]
    fn test_very_tight_tolerance_rejects_small_price_movement() {
        let s = make_setup();
        let reference_price: i128 = 1_000_000;
        let slippage_bps: u32 = 1; // 0.01%
        let max_deviation = reference_price * i128::from(slippage_bps) / 10_000; // 100
        let current_price = reference_price - (max_deviation + 1); // 1 unit over

        let escrow_id = create_escrow(&s, 50_000);
        let milestone_id = add_milestone(&s, escrow_id, 50_000);
        arm_slippage(&s, escrow_id, reference_price, slippage_bps);

        SlippageMockOracleClient::new(&s.env, &s.oracle).set_price(&current_price);

        let result = submit_and_try_approve(&s, escrow_id, milestone_id);
        assert_eq!(
            result,
            Err(EscrowError::E86),
            "tight tolerance 1 bps must reject a price movement of max+1; got: {:?}",
            result
        );
    }
}
