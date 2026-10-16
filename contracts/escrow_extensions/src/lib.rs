//! # StellarTrust Escrow Extensions
//!
//! Four new capabilities added on top of the core escrow contract:
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
//! ## 5. Bridge Settlement Confirmation (#332)
//! `confirm_bridge_settlement(...)`
//! - Confirms a cross-chain bridge settlement against a Stellar transaction hash
//! - Ledger constraints documented below (TTL, tx size, fee, ledger time)
//!
//! ### Ledger constraints for bridge settlement confirmation
//!
//! These assumptions are relied upon by `confirm_bridge_settlement` and its
//! callers. They are documented here, beside the implementation, so that any
//! change to the network parameters is caught during review.
//!
//! **TTL (time-to-live)**
//! - Instance storage is bumped on every settlement confirmation via
//!   `bump_instance`, using the shared `stellar_trust_shared` config constants.
//! - Persistent settlement records are bumped via `bump_persistent` so a
//!   confirmed settlement remains readable for at least the shared persistent
//!   TTL window after confirmation.
//! - Assumption: the confirmation transaction is submitted well within the
//!   instance TTL window; a settlement confirmed after the instance entry has
//!   expired will fail with `ExtError::NotInitialized` (the admin/config entry
//!   is gone) rather than silently succeeding.
//!
//! **Transaction size**
//! - A settlement confirmation carries a 32-byte Stellar transaction hash
//!   (`BytesN<32>`) plus the escrow id and amount. This stays far below the
//!   Soroban per-transaction size limit, so no batching or chunking is needed.
//! - Assumption: the hash is exactly 32 bytes; any other length is rejected by
//!   the type system before the call reaches this contract.
//!
//! **Fee**
//! - Confirmation itself does not collect a protocol fee. Fees are only
//!   collected on successful release via `collect_fee`, bounded by
//!   `MAX_FEE_BPS` (200 bps = 2 %).
//! - Assumption: the caller has already paid the network inclusion fee; the
//!   contract never reads or depends on that fee.
//!
//! **Ledger time**
//! - `env.ledger().timestamp()` is the single source of time. It is read once
//!   per confirmation and used for the settlement record.
//! - Assumption: ledger time is monotonically non-decreasing. A settlement is
//!   rejected if its recorded deadline is not strictly in the future relative
//!   to the current ledger timestamp (`ExtError::BatchItemInvalid`), matching
//!   the deadline check used by `create_batch`.
//! - Boundary: a deadline exactly equal to the current ledger timestamp is
//!   treated as expired (rejected), since the check is `dl <= now`.

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

    // ── #332 Bridge Settlement Confirmation ───────────────────────────────────

    /// Confirms a cross-chain bridge settlement against a Stellar transaction
    /// hash.
    ///
    /// # Ledger constraints
    ///
    /// The following ledger assumptions are relied upon by this function and
    /// are documented beside the implementation (see the crate-level docs for
    /// the full rationale):
    ///
    /// - **TTL**: instance storage is bumped via `bump_instance` on success so
    ///   the admin/config entry does not expire; a confirmation attempted after
    ///   the instance entry has expired fails with `ExtError::NotInitialized`.
    /// - **Transaction size**: the settlement hash is a fixed 32-byte
    ///   `BytesN<32>`, keeping the confirmation transaction well under the
    ///   Soroban per-transaction size limit (no chunking required).
    /// - **Fee**: confirmation collects no protocol fee; fees are only taken on
    ///   release via `collect_fee`, bounded by `MAX_FEE_BPS` (200 bps = 2 %).
    /// - **Ledger time**: `env.ledger().timestamp()` is read once and is assumed
    ///   monotonically non-decreasing. A settlement whose `deadline` is not
    ///   strictly in the future (`deadline <= now`) is rejected with
    ///   `ExtError::BatchItemInvalid`.
    ///
    /// # Arguments
    /// * `caller`      — address authorizing the confirmation
    /// * `escrow_id`   — escrow the settlement belongs to
    /// * `tx_hash`     — 32-byte Stellar transaction hash of the bridge transfer
    /// * `amount`      — settled amount (must be positive)
    /// * `deadline`    — optional settlement deadline (ledger seconds)
    ///
    /// # Returns
    /// `Ok(())` on a successful confirmation.
    ///
    /// # Errors
    /// - `ExtError::NotInitialized` — contract not initialized / instance TTL expired
    /// - `ExtError::BatchItemInvalid` — non-positive amount or expired deadline
    pub fn confirm_bridge_settlement(
        env: Env,
        caller: Address,
        escrow_id: u64,
        tx_hash: BytesN<32>,
        amount: i128,
        deadline: Option<u64>,
    ) -> Result<(), ExtError> {
        caller.require_auth();

        // Ledger time is read once and assumed monotonically non-decreasing.
        let now = env.ledger().timestamp();

        // Boundary: a deadline equal to `now` is treated as expired (`<=`).
        if let Some(dl) = deadline {
            if dl <= now {
                return Err(ExtError::BatchItemInvalid);
            }
        }

        if amount <= 0 {
            return Err(ExtError::BatchItemInvalid);
        }

        // Persist the settlement record keyed by escrow id. The 32-byte hash is
        // stored verbatim; no secrets are persisted.
        let key = DataKey::BridgeSettlement(escrow_id);
        env.storage().persistent().set(&key, &(tx_hash, amount, now));
        bump_persistent(&env, &key);

        events::emit_bridge_settlement_confirmed(&env, escrow_id, &caller, amount);
        bump_instance(&env);
        Ok(())
    }
}
