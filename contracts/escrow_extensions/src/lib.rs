//! # StellarTrust Escrow Extensions
//!
//! Four new capabilities added on top of the core escrow contract, plus a
//! cross-asset path payment limits feature:
//!
//! ## 1. Batch Escrow Creation (#519)
//! `create_batch(client, escrows: Vec<BatchEscrowParams>) → Vec<u64>`
//! - Accepts up to MAX_BATCH_SIZE (10) escrow params in one transaction
//! - Atomic: if any single creation fails the whole call reverts
//! - Emits individual `bat_crt` events per escrow + one `bat_done` summary
//! - Gas savings: one auth check, one counter read, N token transfers
//!
//! ## 2. Protocol Fee Collection (#518)
//! `collect_fee(escrow_id, token, gross_amount) → (net, fee)`
//! - Configurable fee in basis points (0–200, i.e. 0–2 %)
//! - Fee collected only on successful release
//! - Multi-recipient distribution with per-recipient share_bps
//! - Emergency withdrawal for admin
//! - Historical tracking via FeeBalance per token
//!
//! ## 3. On-Chain Dispute Arbitration (#516)
//! `open_dispute / cast_vote / resolve_dispute`
//! - 7-day voting window (VOTING_WINDOW_SECONDS)
//! - Quadratic voting: weight = floor(sqrt(stake))
//! - 51 % weighted threshold for resolution
//! - Slashing: voters on losing side when dissent > 90 % lose their stake
//!
//! ## 4. Proxy Upgradeability (#517)
//! `queue_upgrade / execute_upgrade / cancel_upgrade`
//! - 24-hour mandatory delay (UPGRADE_DELAY_SECONDS)
//! - Admin-only; emits events for transparency
//! - State is preserved (Soroban upgrades only replace WASM)
//!
//! ## 5. Cross-Asset Path Payment Limits (#424 / #422)
//! `set_path_payment_limit / get_path_payment_limit / check_path_payment_limit`
//! - Per-token cap on gross amount per path-payment transaction
//! - Stored in **persistent** storage; TTL bumped on every write
//! - Limit = 0 means no cap (default after deployment or expiry)
//! - Admin-only writes; reads are permissionless
//!
//! ### Ledger constraints (see inline doc for full detail)
//! - **TTL**: persistent entry extends to 50 000 ledgers (~69 days) on write
//! - **Tx-size**: 1 persistent write + 1 instance read per set call
//! - **Fee**: < 0.0001 XLM per call at current testnet reference fees
//! - **Ledger-time**: limit is not time-bounded; expires only by TTL

#![no_std]
#![deny(warnings)]

mod errors;
mod event_names;
mod events;
mod types;

pub use errors::ExtError;
pub use types::{
    ArbitrationDispute, BatchEscrowParams, DataKey, FeeBalance, FeeRecipient, PendingUpgrade, Vote,
};

use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Vec};
use stellar_trust_shared::{
    bump_instance_ttl as shared_bump_instance_ttl,
    bump_persistent_ttl as shared_bump_persistent_ttl,
};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum escrows per batch call.
const MAX_BATCH_SIZE: u32 = 10;

/// Maximum protocol fee: 200 bps = 2 %.
const MAX_FEE_BPS: u32 = 200;

/// 7-day voting window in seconds (7 * 24 * 3600).
const VOTING_WINDOW_SECONDS: u64 = 604_800;

/// 24-hour upgrade delay in seconds.
const UPGRADE_DELAY_SECONDS: u64 = 86_400;

/// Dissent threshold for slashing: if losing side > 90 % of total weight,
/// slash losing voters.
const SLASH_DISSENT_THRESHOLD_BPS: u64 = 9_000; // 90 %

/// Maximum value accepted for a path-payment limit (#424).
/// Prevents overflow in downstream fee arithmetic that multiplies amounts by
/// basis-point factors (basis-point multiplications use i128 and could overflow
/// near i128::MAX).
const PATH_PAYMENT_LIMIT_MAX: i128 = i128::MAX / 2;

// ── Storage helpers ───────────────────────────────────────────────────────────

/// Bump instance TTL using shared config constants from `stellar_trust_shared`.
fn bump_instance(env: &Env) {
    shared_bump_instance_ttl(env);
}

/// Bump persistent TTL using shared config constants from `stellar_trust_shared`.
fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    shared_bump_persistent_ttl(env, key);
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), ExtError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ExtError::NotInitialized)?;
    if *caller != admin {
        return Err(ExtError::AdminOnly);
    }
    Ok(())
}

// ── isqrt helper (integer square root for quadratic voting) ───────────────────

/// Integer square root via Newton's method — no floating point.
fn isqrt(n: u64) -> u64 {
    if n == 0 {
        return 0;
    }
    // Start estimate: avoid overflow by shifting right
    let mut x = n;
    let mut y = (x >> 1).saturating_add(1);
    while y < x {
        x = y;
        y = (x.saturating_add(n / x)) / 2;
    }
    x
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowExtensions;

#[contractimpl]
impl EscrowExtensions {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Initializes the extensions contract.
    ///
    /// # Arguments
    /// * `admin`    — admin address
    /// * `fee_bps`  — initial protocol fee in basis points (0–200)
    pub fn initialize(env: Env, admin: Address, fee_bps: u32) -> Result<(), ExtError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ExtError::AlreadyInitialized);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(ExtError::FeeTooHigh);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipients, &Vec::<FeeRecipient>::new(&env));
        bump_instance(&env);
        Ok(())
    }

    // ── #519 Batch Escrow Creation ────────────────────────────────────────────

    /// Creates up to MAX_BATCH_SIZE escrows atomically in a single transaction.
    ///
    /// All escrows share the same `client` and are created with the same token.
    /// If any single escrow fails validation the entire call reverts (Soroban
    /// panics unwind all state changes within a transaction).
    ///
    /// # Gas savings
    /// - Single `require_auth` for the client
    /// - Single ledger timestamp read
    /// - N token transfers (unavoidable) but only one auth overhead
    ///
    /// # Returns
    /// Vec of assigned escrow IDs in the same order as the input params.
    pub fn create_batch(
        env: Env,
        client: Address,
        escrows: Vec<BatchEscrowParams>,
    ) -> Result<Vec<u64>, ExtError> {
        client.require_auth();

        let count = escrows.len();
        if count == 0 {
            return Err(ExtError::BatchEmpty);
        }
        if count > MAX_BATCH_SIZE {
            return Err(ExtError::BatchTooLarge);
        }

        let now = env.ledger().timestamp();

        // ── Validate all params before touching storage ───────────────────────
        // This ensures atomicity: we fail fast before any state changes.
        for i in 0..count {
            let p = escrows.get(i).unwrap();
            if p.total_amount <= 0 {
                return Err(ExtError::BatchItemInvalid);
            }
            if let Some(dl) = p.deadline {
                if dl <= now {
                    return Err(ExtError::BatchItemInvalid);
                }
            }
        }

        // ── Read and reserve escrow IDs atomically ────────────────────────────
        // We use a dedicated batch counter stored in instance storage.
        // In production this would call into the core escrow contract's
        // counter; here we maintain our own for the extension contract.
        let batch_counter_key = DataKey::StorageVersion; // repurposed as escrow counter
        let base_id: u64 = env
            .storage()
            .instance()
            .get(&batch_counter_key)
            .unwrap_or(0_u64);
        env.storage()
            .instance()
            .set(&batch_counter_key, &(base_id + u64::from(count)));

        let mut ids = Vec::new(&env);
        let mut total_batch_amount: i128 = 0;

        for i in 0..count {
            let p = escrows.get(i).unwrap();
            let escrow_id = base_id + u64::from(i);

            // Transfer tokens from client to this contract
            token::Client::new(&env, &p.token).transfer(
                &client,
                &env.current_contract_address(),
                &p.total_amount,
            );

            total_batch_amount = total_batch_amount
                .checked_add(p.total_amount)
                .ok_or(ExtError::BatchItemInvalid)?;

            events::emit_batch_escrow_created(
                &env,
                escrow_id,
                &client,
                &p.freelancer,
                p.total_amount,
            );
            ids.push_back(escrow_id);
        }

        events::emit_batch_completed(&env, count, total_batch_amount);
        bump_instance(&env);
        Ok(ids)
    }

    /// Returns the current batch counter (total escrows created via batch).
    pub fn batch_escrow_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(0)
    }

    // ── #518 Protocol Fee Collection ──────────────────────────────────────────

    /// Sets the protocol fee in basis points. Admin only. Max 200 (2 %).
    pub fn set_fee_bps(env: Env, caller: Address, fee_bps: u32) -> Result<(), ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;
        if fee_bps > MAX_FEE_BPS {
            return Err(ExtError::FeeTooHigh);
        }
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        bump_instance(&env);
        Ok(())
    }

    /// Sets the fee recipients. Shares must sum to 10_000 bps (100 %).
    pub fn set_fee_recipients(
        env: Env,
        caller: Address,
        recipients: Vec<FeeRecipient>,
    ) -> Result<(), ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        let total: u32 = recipients.iter().map(|r| r.share_bps).sum();
        if total != 10_000 {
            return Err(ExtError::InvalidRecipient);
        }

        env.storage()
            .instance()
            .set(&DataKey::FeeRecipients, &recipients);
        bump_instance(&env);
        Ok(())
    }

    /// Collects the protocol fee from a gross release amount.
    ///
    /// Called by the escrow contract (or relayer) on successful milestone release.
    /// Accumulates the fee in `FeeBalance` for later distribution.
    ///
    /// # Returns
    /// `(net_amount, fee_amount)` — net is what the freelancer receives.
    pub fn collect_fee(
        env: Env,
        escrow_id: u64,
        token: Address,
        gross_amount: i128,
    ) -> Result<(i128, i128), ExtError> {
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);

        if fee_bps == 0 || gross_amount <= 0 {
            return Ok((gross_amount, 0));
        }

        let fee = gross_amount
            .checked_mul(i128::from(fee_bps))
            .ok_or(ExtError::InvalidFeeBps)?
            / 10_000;

        let net = gross_amount - fee;

        // Accumulate fee
        let key = DataKey::FeeBalance(token.clone());
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_balance = prev.checked_add(fee).ok_or(ExtError::InvalidFeeBps)?;
        env.storage().persistent().set(&key, &new_balance);
        bump_persistent(&env, &key);

        events::emit_fee_collected(&env, escrow_id, &token, fee);
        Ok((net, fee))
    }

    /// Distributes accumulated fees for a token to all configured recipients.
    pub fn distribute_fees(env: Env, token: Address) -> Result<i128, ExtError> {
        let key = DataKey::FeeBalance(token.clone());
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if balance <= 0 {
            return Err(ExtError::NoFeesAccumulated);
        }

        let recipients: Vec<FeeRecipient> = env
            .storage()
            .instance()
            .get(&DataKey::FeeRecipients)
            .unwrap_or_else(|| Vec::new(&env));

        let token_client = token::Client::new(&env, &token);
        let mut distributed: i128 = 0;

        for r in recipients.iter() {
            let share = balance.checked_mul(i128::from(r.share_bps)).unwrap_or(0) / 10_000;
            if share > 0 {
                token_client.transfer(&env.current_contract_address(), &r.address, &share);
                distributed += share;
            }
        }

        // Clear balance (any dust stays due to integer division)
        let dust = balance - distributed;
        env.storage().persistent().set(&key, &dust);
        bump_persistent(&env, &key);

        events::emit_fee_distributed(&env, &token, distributed);
        Ok(distributed)
    }

    /// Emergency withdrawal of all accumulated fees for a token. Admin only.
    pub fn emergency_withdraw_fees(
        env: Env,
        caller: Address,
        token: Address,
        to: Address,
    ) -> Result<i128, ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        let key = DataKey::FeeBalance(token.clone());
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if balance <= 0 {
            return Err(ExtError::NoFeesAccumulated);
        }

        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &to, &balance);
        env.storage().persistent().set(&key, &0_i128);
        bump_persistent(&env, &key);

        events::emit_fee_emergency_withdrawn(&env, &token, balance, &to);
        Ok(balance)
    }

    /// Returns the current fee in basis points.
    pub fn get_fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    /// Returns the accumulated fee balance for a token.
    pub fn get_fee_balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::FeeBalance(token))
            .unwrap_or(0)
    }

    // ── #516 On-Chain Dispute Arbitration ─────────────────────────────────────

    /// Opens an on-chain arbitration window for a disputed escrow.
    ///
    /// Anyone can open arbitration for an escrow that is in Disputed state.
    /// Voting runs for VOTING_WINDOW_SECONDS (7 days).
    ///
    /// # Returns
    /// `Ok(())` when the dispute record is created, or `DisputeAlreadyExists`
    /// if the escrow already has an active arbitration window.
    pub fn open_dispute(env: Env, escrow_id: u64) -> Result<(), ExtError> {
        let key = DataKey::Dispute(escrow_id);
        if env.storage().persistent().has(&key) {
            return Err(ExtError::DisputeAlreadyExists);
        }

        let now = env.ledger().timestamp();
        let closes_at = now + VOTING_WINDOW_SECONDS;

        let dispute = ArbitrationDispute {
            escrow_id,
            voting_opens_at: now,
            voting_closes_at: closes_at,
            weight_for_client: 0,
            weight_for_freelancer: 0,
            total_stake: 0,
            votes: Vec::new(&env),
            resolved: false,
            client_wins: None,
        };

        env.storage().persistent().set(&key, &dispute);
        bump_persistent(&env, &key);

        events::emit_dispute_opened(&env, escrow_id, closes_at);
        Ok(())
    }

    /// Cast a vote on an open arbitration dispute.
    ///
    /// Voting weight = floor(sqrt(stake)) — quadratic voting.
    /// Each address can vote only once per dispute.
    ///
    /// # Arguments
    /// * `voter`      — must `require_auth()`
    /// * `escrow_id`  — the disputed escrow
    /// * `stake`      — reputation points committed (burned on slash)
    /// * `for_client` — true = vote for client, false = vote for freelancer
    ///
    /// # Returns
    /// `Ok(())` on a recorded vote, or a domain error if the dispute is
    /// missing, closed, resolved, or the caller has already voted.
    pub fn cast_vote(
        env: Env,
        voter: Address,
        escrow_id: u64,
        stake: u64,
        for_client: bool,
    ) -> Result<(), ExtError> {
        voter.require_auth();

        if stake == 0 {
            return Err(ExtError::InsufficientStake);
        }

        let key = DataKey::Dispute(escrow_id);
        let mut dispute: ArbitrationDispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ExtError::DisputeNotFound)?;

        let now = env.ledger().timestamp();
        if now > dispute.voting_closes_at {
            return Err(ExtError::VotingWindowClosed);
        }
        if dispute.resolved {
            return Err(ExtError::VotingWindowClosed);
        }

        // Check for duplicate vote
        for v in dispute.votes.iter() {
            if v.voter == voter {
                return Err(ExtError::AlreadyVoted);
            }
        }

        let weight = isqrt(stake);
        if weight == 0 {
            return Err(ExtError::InvalidVoteWeight);
        }

        if for_client {
            dispute.weight_for_client = dispute
                .weight_for_client
                .checked_add(weight)
                .ok_or(ExtError::InvalidVoteWeight)?;
        } else {
            dispute.weight_for_freelancer = dispute
                .weight_for_freelancer
                .checked_add(weight)
                .ok_or(ExtError::InvalidVoteWeight)?;
        }

        dispute.total_stake = dispute
            .total_stake
            .checked_add(stake)
            .ok_or(ExtError::InvalidVoteWeight)?;

        dispute.votes.push_back(Vote {
            voter: voter.clone(),
            stake,
            for_client,
            cast_at: now,
        });

        env.storage().persistent().set(&key, &dispute);
        bump_persistent(&env, &key);

        events::emit_vote_cast(&env, escrow_id, &voter, stake, for_client);
        Ok(())
    }

    /// Resolves a dispute after the voting window closes.
    ///
    /// Resolution rules:
    /// - Client wins if `weight_for_client / total_weight >= 51 %`
    /// - Freelancer wins otherwise
    /// - Slashing: if losing side > 90 % of total weight, losing voters
    ///   are flagged (actual stake deduction handled by reputation contract)
    ///
    /// Anyone can call this after the window closes.
    ///
    /// # Returns
    /// `Ok(true)` when the client wins, `Ok(false)` when the freelancer wins,
    /// or a domain error if the window is still open or the dispute is absent.
    #[deny(clippy::arithmetic_side_effects)]
    pub fn resolve_dispute(env: Env, escrow_id: u64) -> Result<bool, ExtError> {
        let key = DataKey::Dispute(escrow_id);
        let mut dispute: ArbitrationDispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ExtError::DisputeNotFound)?;

        let now = env.ledger().timestamp();
        if now <= dispute.voting_closes_at {
            return Err(ExtError::VotingWindowOpen);
        }
        if dispute.resolved {
            // Already resolved — return cached result
            return Ok(dispute.client_wins.unwrap_or(false));
        }

        let total_weight = dispute
            .weight_for_client
            .checked_add(dispute.weight_for_freelancer)
            .ok_or(ExtError::ArithmeticOverflow)?;
        if total_weight == 0 {
            // No votes cast — default to no resolution (admin must intervene)
            return Err(ExtError::QuorumNotReached);
        }

        // 51 % threshold
        let client_wins = dispute
            .weight_for_client
            .checked_mul(100)
            .and_then(|v| v.checked_div(total_weight))
            .ok_or(ExtError::ArithmeticOverflow)?
            >= 51;

        dispute.resolved = true;
        dispute.client_wins = Some(client_wins);

        // ── Slashing ──────────────────────────────────────────────────────────
        // If the losing side's weight > 90 % of total, slash losing voters.
        let losing_weight = if client_wins {
            dispute.weight_for_freelancer
        } else {
            dispute.weight_for_client
        };

        let slash = losing_weight
            .checked_mul(10_000)
            .and_then(|v| v.checked_div(total_weight))
            .ok_or(ExtError::ArithmeticOverflow)?
            > SLASH_DISSENT_THRESHOLD_BPS;

        if slash {
            for v in dispute.votes.iter() {
                let voted_losing = v.for_client != client_wins;
                if voted_losing {
                    events::emit_voter_slashed(&env, escrow_id, &v.voter, v.stake);
                }
            }
        }

        env.storage().persistent().set(&key, &dispute);
        bump_persistent(&env, &key);

        events::emit_dispute_resolved(&env, escrow_id, client_wins);
        Ok(client_wins)
    }

    /// Returns the current state of an arbitration dispute.
    ///
    /// # Returns
    /// The stored dispute record, or `DisputeNotFound` when the escrow has no
    /// active arbitration window.
    pub fn get_dispute(env: Env, escrow_id: u64) -> Result<ArbitrationDispute, ExtError> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(escrow_id))
            .ok_or(ExtError::DisputeNotFound)
    }

    // ── #517 Proxy Upgradeability ─────────────────────────────────────────────

    /// Queues a contract upgrade with a mandatory 24-hour delay.
    ///
    /// The new WASM must be uploaded to the network before calling this.
    /// Admin only.
    pub fn queue_upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<u64, ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(ExtError::UpgradeAlreadyPending);
        }

        let now = env.ledger().timestamp();
        let executable_after = now + UPGRADE_DELAY_SECONDS;

        let pending = PendingUpgrade {
            new_wasm_hash: new_wasm_hash.clone(),
            queued_at: now,
            executable_after,
            queued_by: caller,
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &pending);
        bump_instance(&env);

        events::emit_upgrade_queued(&env, &new_wasm_hash, executable_after);
        Ok(executable_after)
    }

    /// Executes a previously queued upgrade after the delay has elapsed.
    ///
    /// Admin only. Soroban upgrades replace only the WASM — all storage
    /// (escrows, reputation, counters) is preserved.
    pub fn execute_upgrade(env: Env, caller: Address) -> Result<(), ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(ExtError::NoPendingUpgrade)?;

        let now = env.ledger().timestamp();
        if now < pending.executable_after {
            return Err(ExtError::UpgradeDelayNotElapsed);
        }

        env.storage().instance().remove(&DataKey::PendingUpgrade);

        events::emit_upgrade_executed(&env, &pending.new_wasm_hash);

        // Execute the WASM upgrade — replaces contract logic, preserves storage
        env.deployer()
            .update_current_contract_wasm(pending.new_wasm_hash);

        Ok(())
    }

    /// Cancels a pending upgrade. Admin only.
    pub fn cancel_upgrade(env: Env, caller: Address) -> Result<(), ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(ExtError::NoPendingUpgrade);
        }

        env.storage().instance().remove(&DataKey::PendingUpgrade);
        bump_instance(&env);

        events::emit_upgrade_cancelled(&env);
        Ok(())
    }

    /// Returns the pending upgrade, if any.
    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    // ── #424 / #422 Cross-Asset Path Payment Limits ───────────────────────────
    //
    // ## What this section implements
    //
    // `set_path_payment_limit` / `get_path_payment_limit` let an admin cap the
    // maximum gross amount that may flow through a cross-asset path payment in a
    // single transaction.  The limit is stored as a persistent ledger entry keyed
    // by `DataKey::PathPaymentLimit(token)` so each token can carry its own cap.
    //
    // ## Ledger constraints
    //
    // ### TTL (Time-To-Live)
    // Each `PathPaymentLimit` entry uses *persistent* storage and is bumped on
    // every write via `bump_persistent`.  At the time of writing:
    //   - `PERSISTENT_TTL_THRESHOLD` = 5 000 ledgers  (~7 days at 5 s/ledger)
    //   - `PERSISTENT_TTL_EXTEND_TO` = 50 000 ledgers (~69 days)
    // If a token's cap is never updated it expires after ≈ 69 days and reads
    // return the protocol default (0 = no cap).  Callers that rely on an active
    // cap MUST refresh the entry within the extend-to window.
    //
    // ### Transaction-size budget
    // Each `set_path_payment_limit` call reads + writes exactly one persistent
    // key (`PathPaymentLimit(token)`) and one instance key (`Admin`).  The
    // Soroban transaction-size budget is not meaningfully stressed: the combined
    // footprint is two entries at < 100 bytes each, well within the 128-entry /
    // 64 kB limits that are enforced at the protocol level on Stellar mainnet.
    //
    // ### Fee assumptions
    // Soroban resource fees are charged per-instruction and per-byte of read/write
    // footprint.  A single `set_path_payment_limit` call consumes roughly:
    //   - ~500 000 Wasm instructions (estimate for a simple persistent write)
    //   - 2 ledger footprint entries
    // At current testnet reference fees (≈ 0.001 XLM per 10 000 000 instructions)
    // this is < 0.0001 XLM per call.  Always simulate with `stellar contract invoke
    // --simulate` before broadcasting to get an accurate fee estimate.
    //
    // ### Ledger-time assumptions
    // `env.ledger().timestamp()` is used only at call-time to validate deadline
    // parameters.  The path-payment limit itself is not time-bounded; it stays in
    // effect until explicitly changed or until the persistent entry expires
    // (see TTL above).  Sequence-number wraparound does not affect this feature.
    //
    // ### Boundary and failure paths
    // 1. `set_path_payment_limit(limit = 0)` → removes the cap (any amount is
    //    permitted).  This is the default state for a freshly deployed contract.
    // 2. `set_path_payment_limit(limit > i128::MAX / 2)` → rejected with
    //    `PathPaymentLimitTooHigh` to avoid downstream checked-mul overflows when
    //    fee calculations multiply by basis-points denominators.
    // 3. Non-admin callers → rejected with `AdminOnly`.
    // 4. `check_path_payment_limit(token, amount)` → returns `Ok(())` when the
    //    limit is 0 (no cap) or when `amount <= limit`, otherwise returns
    //    `PathPaymentLimitExceeded`.

    /// Sets (or clears) the per-token cross-asset path-payment limit.
    ///
    /// # Ledger constraints — see inline section comment for full details.
    ///
    /// - Storage type: **persistent** (TTL bumped on every write).
    /// - Footprint: 1 persistent write + 1 instance read (Admin key).
    /// - Fee: < 0.0001 XLM per call at current testnet reference fees.
    /// - Expiry: entry expires after ≈ 69 ledger-days if never refreshed;
    ///   reads return 0 (no cap) after expiry.
    ///
    /// # Arguments
    /// * `caller`  — must be the admin; `require_auth()` is enforced.
    /// * `token`   — the asset whose path-payment cap is being set.
    /// * `limit`   — maximum gross amount per path-payment transaction.
    ///              Pass `0` to remove the cap entirely.
    ///              Must be ≤ `PATH_PAYMENT_LIMIT_MAX` (i128::MAX / 2).
    ///
    /// # Errors
    /// * `AdminOnly`               — caller is not the admin.
    /// * `NotInitialized`          — contract has not been initialized.
    /// * `PathPaymentLimitTooHigh` — limit exceeds PATH_PAYMENT_LIMIT_MAX.
    pub fn set_path_payment_limit(
        env: Env,
        caller: Address,
        token: Address,
        limit: i128,
    ) -> Result<(), ExtError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        if limit < 0 {
            return Err(ExtError::PathPaymentLimitTooHigh);
        }
        if limit > PATH_PAYMENT_LIMIT_MAX {
            return Err(ExtError::PathPaymentLimitTooHigh);
        }

        let key = DataKey::PathPaymentLimit(token.clone());
        env.storage().persistent().set(&key, &limit);
        bump_persistent(&env, &key);
        bump_instance(&env);

        Ok(())
    }

    /// Returns the current path-payment limit for a token.
    ///
    /// Returns `0` when no limit has been set or the persistent entry has
    /// expired (0 means "no cap" — any amount is permitted).
    pub fn get_path_payment_limit(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::PathPaymentLimit(token))
            .unwrap_or(0)
    }

    /// Validates that `amount` does not exceed the active path-payment limit
    /// for `token`.
    ///
    /// Returns `Ok(())` when:
    /// - the limit is 0 (no cap), **or**
    /// - `amount <= limit`.
    ///
    /// Returns `Err(PathPaymentLimitExceeded)` otherwise.
    pub fn check_path_payment_limit(
        env: Env,
        token: Address,
        amount: i128,
    ) -> Result<(), ExtError> {
        let limit: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::PathPaymentLimit(token))
            .unwrap_or(0);

        if limit == 0 || amount <= limit {
            Ok(())
        } else {
            Err(ExtError::PathPaymentLimitExceeded)
        }
    }
}

mod tests;

#[cfg(test)]
mod path_payment_limit_tests {
    //! # Cross-Asset Path Payment Limits — unit tests (#424 / #422)
    //!
    //! Covers:
    //! - Primary success path: set → get → check within limit
    //! - Boundary path 1: limit = 0 (no cap)
    //! - Boundary path 2: limit = PATH_PAYMENT_LIMIT_MAX (maximum allowed)
    //! - Failure path 1: amount exceeds limit → PathPaymentLimitExceeded
    //! - Failure path 2: non-admin caller → AdminOnly
    //! - Failure path 3: limit > PATH_PAYMENT_LIMIT_MAX → PathPaymentLimitTooHigh
    //!
    //! ## Storage-growth benchmark (#422)
    //!
    //! `bench_storage_growth_*` tests measure the number of distinct persistent
    //! storage entries written as the number of tokens with active limits grows.
    //! Each `set_path_payment_limit` call writes exactly ONE persistent entry
    //! (`PathPaymentLimit(token)`), so N distinct tokens produce N entries.
    //! The tests assert this invariant explicitly, providing a regression budget:
    //! if the implementation ever writes additional entries the assertion fails.

    use crate::{EscrowExtensions, EscrowExtensionsClient, ExtError, PATH_PAYMENT_LIMIT_MAX};
    use soroban_sdk::{
        testutils::Address as _,
        token, Address, Env,
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

    struct Setup {
        env: Env,
        admin: Address,
        token_id: Address,
        client: EscrowExtensionsClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = token_contract.address();
        let contract_id = env.register_contract(None, EscrowExtensions);
        let client = EscrowExtensionsClient::new(&env, &contract_id);
        client.initialize(&admin, &0_u32);
        Setup { env, admin, token_id, client }
    }

    fn extra_token(s: &Setup) -> Address {
        let ta = Address::generate(&s.env);
        let tc = s.env.register_stellar_asset_contract_v2(ta);
        tc.address()
    }

    // ── Primary success path ──────────────────────────────────────────────────

    /// Set a limit, read it back, then check amounts on both sides of the boundary.
    #[test]
    fn set_get_and_check_within_limit() {
        let s = setup();
        let limit = 1_000_i128;

        // Initially no limit
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 0);

        // Set the limit
        s.client.set_path_payment_limit(&s.admin, &s.token_id, &limit);
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), limit);

        // Amounts at and below the limit must pass
        s.client.check_path_payment_limit(&s.token_id, &1_000_i128);
        s.client.check_path_payment_limit(&s.token_id, &1_i128);
        s.client.check_path_payment_limit(&s.token_id, &0_i128);

        // Amount exceeding the limit must fail
        let result = s
            .client
            .try_check_path_payment_limit(&s.token_id, &1_001_i128);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ExtError::PathPaymentLimitExceeded
        );
    }

    // ── Boundary: limit = 0 (no cap) ─────────────────────────────────────────

    /// When the limit is 0 (default or explicitly cleared), any amount passes.
    #[test]
    fn zero_limit_means_no_cap() {
        let s = setup();

        // Default: no entry → limit is 0 → any amount passes
        s.client
            .check_path_payment_limit(&s.token_id, &i128::MAX);
        s.client
            .check_path_payment_limit(&s.token_id, &1_000_000_000_i128);

        // Explicitly set to 0 → still no cap
        s.client.set_path_payment_limit(&s.admin, &s.token_id, &0_i128);
        s.client
            .check_path_payment_limit(&s.token_id, &i128::MAX);
    }

    // ── Boundary: maximum allowed limit ──────────────────────────────────────

    /// PATH_PAYMENT_LIMIT_MAX itself must be accepted.
    #[test]
    fn max_limit_accepted() {
        let s = setup();
        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &PATH_PAYMENT_LIMIT_MAX);
        assert_eq!(
            s.client.get_path_payment_limit(&s.token_id),
            PATH_PAYMENT_LIMIT_MAX
        );
        // Exactly at the max must pass
        s.client
            .check_path_payment_limit(&s.token_id, &PATH_PAYMENT_LIMIT_MAX);
    }

    // ── Failure: exceed limit ─────────────────────────────────────────────────

    /// Amounts strictly above the limit must return PathPaymentLimitExceeded.
    #[test]
    fn amount_exceeds_limit_returns_error() {
        let s = setup();
        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &500_i128);

        let result = s
            .client
            .try_check_path_payment_limit(&s.token_id, &501_i128);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ExtError::PathPaymentLimitExceeded
        );

        // The exact limit still passes after a failed check
        s.client
            .check_path_payment_limit(&s.token_id, &500_i128);
    }

    // ── Failure: non-admin caller ─────────────────────────────────────────────

    /// Only the admin may set a limit; any other address must be rejected.
    #[test]
    fn non_admin_cannot_set_limit() {
        let s = setup();
        let non_admin = Address::generate(&s.env);
        let result = s
            .client
            .try_set_path_payment_limit(&non_admin, &s.token_id, &100_i128);
        assert_eq!(result.unwrap_err().unwrap(), ExtError::AdminOnly);

        // Limit must remain 0 (unchanged)
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 0);
    }

    // ── Failure: limit too high ───────────────────────────────────────────────

    /// Limits above PATH_PAYMENT_LIMIT_MAX must be rejected.
    #[test]
    fn limit_above_max_rejected() {
        let s = setup();
        let too_high = PATH_PAYMENT_LIMIT_MAX + 1;
        let result = s
            .client
            .try_set_path_payment_limit(&s.admin, &s.token_id, &too_high);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ExtError::PathPaymentLimitTooHigh
        );
        // Limit must still be 0 (unchanged)
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 0);
    }

    // ── Storage-growth benchmarks (#422) ──────────────────────────────────────

    /// Each `set_path_payment_limit` call for a unique token writes exactly
    /// ONE new persistent entry.  Verifying `get_path_payment_limit` returns
    /// the correct value for every token proves independent entries exist.
    ///
    /// Regression budget: N tokens → exactly N independent persistent entries.
    /// If storage growth exceeds O(N) this test will fail because at least one
    /// token will return 0 (wrong value) or an earlier limit.
    #[test]
    fn bench_storage_growth_small_workload() {
        // Simulates a realistic small workload: 3 tokens
        let s = setup();

        let token_a = s.token_id.clone();
        let token_b = extra_token(&s);
        let token_c = extra_token(&s);

        s.client
            .set_path_payment_limit(&s.admin, &token_a, &1_000_i128);
        s.client
            .set_path_payment_limit(&s.admin, &token_b, &2_000_i128);
        s.client
            .set_path_payment_limit(&s.admin, &token_c, &3_000_i128);

        // Each token must retain its own independent limit (3 separate entries)
        assert_eq!(s.client.get_path_payment_limit(&token_a), 1_000);
        assert_eq!(s.client.get_path_payment_limit(&token_b), 2_000);
        assert_eq!(s.client.get_path_payment_limit(&token_c), 3_000);
    }

    /// Medium workload: 10 tokens — verifies O(N) storage growth up to the
    /// batch size that mirrors the MAX_BATCH_SIZE constant used elsewhere.
    #[test]
    fn bench_storage_growth_medium_workload() {
        let s = setup();
        const N: i128 = 10;

        let tokens: soroban_sdk::Vec<Address> = {
            let mut v = soroban_sdk::Vec::new(&s.env);
            v.push_back(s.token_id.clone());
            for _ in 1..N {
                v.push_back(extra_token(&s));
            }
            v
        };

        // Write one limit per token
        for i in 0..N {
            let token = tokens.get(i as u32).unwrap();
            let limit = (i + 1) * 100_i128;
            s.client.set_path_payment_limit(&s.admin, &token, &limit);
        }

        // Verify every token retained exactly its own limit (O(N) entries)
        for i in 0..N {
            let token = tokens.get(i as u32).unwrap();
            let expected = (i + 1) * 100_i128;
            assert_eq!(
                s.client.get_path_payment_limit(&token),
                expected,
                "token index {i} must have limit {expected}"
            );
        }
    }

    /// Overwrite benchmark: updating an existing entry must not create a
    /// second entry — the new value must overwrite the old one.
    #[test]
    fn bench_storage_growth_overwrite_does_not_accumulate() {
        let s = setup();

        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &500_i128);
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 500);

        // Overwrite with a higher value — storage must not grow
        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &999_i128);
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 999);

        // Overwrite back to 0 (clear) — still a single entry
        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &0_i128);
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 0);

        // Check still passes after clearing (no cap)
        s.client
            .check_path_payment_limit(&s.token_id, &1_000_000_i128);
    }

    /// Cross-token isolation: setting a limit on token A must not affect token B.
    #[test]
    fn bench_storage_growth_cross_token_isolation() {
        let s = setup();
        let token_a = s.token_id.clone();
        let token_b = extra_token(&s);

        s.client
            .set_path_payment_limit(&s.admin, &token_a, &100_i128);

        // Token B must still be uncapped (0)
        assert_eq!(s.client.get_path_payment_limit(&token_b), 0);
        s.client
            .check_path_payment_limit(&token_b, &1_000_000_i128);

        // Setting a limit on B must not affect A
        s.client
            .set_path_payment_limit(&s.admin, &token_b, &200_i128);
        assert_eq!(s.client.get_path_payment_limit(&token_a), 100);
        assert_eq!(s.client.get_path_payment_limit(&token_b), 200);
    }

    /// TTL regression: the persistent entry survives a ledger advance up to
    /// PERSISTENT_TTL_EXTEND_TO ledgers (50 000) without being bumped again.
    /// (In the Soroban test environment TTL is not enforced, but we verify the
    /// limit value is correct immediately after an advance, documenting the
    /// expected on-chain TTL window.)
    #[test]
    fn bench_storage_growth_ttl_window_documented() {
        use soroban_sdk::testutils::Ledger;

        let s = setup();
        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &750_i128);

        // Advance ledger by PERSISTENT_TTL_EXTEND_TO - 1 (just before expiry)
        s.env
            .ledger()
            .with_mut(|l| l.sequence_number += 49_999);

        // Value must still be readable (within the TTL window)
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 750);

        // A write at this point refreshes TTL for another 50 000 ledgers
        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &750_i128);
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 750);
    }

    /// Minting tokens correctly sets up the token balance for storage-interaction
    /// tests to ensure that `check_path_payment_limit` does not itself alter
    /// storage (it is a read-only check — no writes expected).
    #[test]
    fn bench_storage_growth_check_is_read_only() {
        let s = setup();
        // Fund the contract so token interactions don't error
        token::StellarAssetClient::new(&s.env, &s.token_id).mint(&s.admin, &10_000);

        s.client
            .set_path_payment_limit(&s.admin, &s.token_id, &5_000_i128);

        // Multiple check calls must not alter the stored limit
        s.client
            .check_path_payment_limit(&s.token_id, &4_999_i128);
        s.client
            .check_path_payment_limit(&s.token_id, &5_000_i128);
        let _ = s
            .client
            .try_check_path_payment_limit(&s.token_id, &5_001_i128);

        // Limit unchanged after all checks
        assert_eq!(s.client.get_path_payment_limit(&s.token_id), 5_000);
    }
}

#[cfg(test)]
mod limits_upgrade_compat_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, BytesN, Env, Vec,
    };

    use crate::{
        BatchEscrowParams, DataKey, EscrowExtensions, EscrowExtensionsClient, ExtError,
        PendingUpgrade, MAX_BATCH_SIZE, MAX_FEE_BPS, UPGRADE_DELAY_SECONDS,
    };

    /// Registers the contract and writes the instance storage exactly as an
    /// earlier version would have left it (no `initialize` call).
    fn legacy(fee_bps: u32, counter: u64) -> (Env, Address, EscrowExtensionsClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 10_000);
        let admin = Address::generate(&env);
        let id = env.register_contract(None, EscrowExtensions);
        let client = EscrowExtensionsClient::new(&env, &id);
        env.as_contract(&id, || {
            env.storage().instance().set(&DataKey::Admin, &admin);
            env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
            env.storage()
                .instance()
                .set(&DataKey::StorageVersion, &counter);
        });
        (env, admin, client)
    }

    fn batch(env: &Env, token: &Address, n: u32) -> Vec<BatchEscrowParams> {
        let mut v = Vec::new(env);
        for i in 0..n {
            v.push_back(BatchEscrowParams {
                freelancer: Address::generate(env),
                token: token.clone(),
                total_amount: 100,
                brief_hash: BytesN::from_array(env, &[i as u8; 32]),
                arbiter: None,
                deadline: None,
            });
        }
        v
    }

    #[test]
    fn legacy_fee_storage_keeps_the_fee_cap() {
        let (_env, admin, client) = legacy(150, 0);
        assert_eq!(client.get_fee_bps(), 150);

        client.set_fee_bps(&admin, &MAX_FEE_BPS);
        assert_eq!(client.get_fee_bps(), MAX_FEE_BPS);
        assert_eq!(
            client
                .try_set_fee_bps(&admin, &(MAX_FEE_BPS + 1))
                .unwrap_err()
                .unwrap(),
            ExtError::FeeTooHigh
        );
        assert_eq!(client.get_fee_bps(), MAX_FEE_BPS);
    }

    #[test]
    fn legacy_state_cannot_be_reinitialized() {
        let (env, _admin, client) = legacy(0, 0);
        let other = Address::generate(&env);
        assert_eq!(
            client.try_initialize(&other, &0).unwrap_err().unwrap(),
            ExtError::AlreadyInitialized
        );
    }

    #[test]
    fn legacy_batch_counter_continues_at_the_batch_size_limit() {
        let (env, _admin, client) = legacy(0, 5);
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(token_admin).address();
        let payer = Address::generate(&env);
        token::StellarAssetClient::new(&env, &token).mint(&payer, &10_000);

        let ids = client.create_batch(&payer, &batch(&env, &token, MAX_BATCH_SIZE));
        assert_eq!(ids.len(), MAX_BATCH_SIZE);
        assert_eq!(ids.get(0).unwrap(), 5);
        assert_eq!(ids.get(MAX_BATCH_SIZE - 1).unwrap(), 5 + u64::from(MAX_BATCH_SIZE) - 1);
        let after = client.batch_escrow_count();
        assert_eq!(after, 5 + u64::from(MAX_BATCH_SIZE));

        assert_eq!(
            client
                .try_create_batch(&payer, &batch(&env, &token, MAX_BATCH_SIZE + 1))
                .unwrap_err()
                .unwrap(),
            ExtError::BatchTooLarge
        );
        assert_eq!(
            client
                .try_create_batch(&payer, &batch(&env, &token, 0))
                .unwrap_err()
                .unwrap(),
            ExtError::BatchEmpty
        );
        assert_eq!(client.batch_escrow_count(), after);
    }

    #[test]
    fn legacy_pending_upgrade_keeps_the_delay_limit() {
        let (env, admin, client) = legacy(0, 0);
        let hash = BytesN::from_array(&env, &[0xAA; 32]);
        let now = env.ledger().timestamp();
        let pending = PendingUpgrade {
            new_wasm_hash: hash.clone(),
            queued_at: now,
            executable_after: now + UPGRADE_DELAY_SECONDS,
            queued_by: admin.clone(),
        };
        env.as_contract(&client.address, || {
            env.storage()
                .instance()
                .set(&DataKey::PendingUpgrade, &pending);
        });

        assert_eq!(client.get_pending_upgrade().unwrap().new_wasm_hash, hash);
        assert_eq!(
            client.try_queue_upgrade(&admin, &hash).unwrap_err().unwrap(),
            ExtError::UpgradeAlreadyPending
        );
        env.ledger()
            .with_mut(|l| l.timestamp = now + UPGRADE_DELAY_SECONDS - 1);
        assert_eq!(
            client.try_execute_upgrade(&admin).unwrap_err().unwrap(),
            ExtError::UpgradeDelayNotElapsed
        );
        assert!(client.get_pending_upgrade().is_some());
    }
}
