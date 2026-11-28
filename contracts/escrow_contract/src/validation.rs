#![allow(dead_code)]
//! Comprehensive input validation for all entry points.
//!
//! Centralizes validation logic so every entry point enforces consistent
//! bounds and constraints before touching storage.
//!
//! Closes #102

use soroban_sdk::{BytesN, Env, String};

use crate::errors::EscrowError;

/// Maximum allowed title length (bytes) for milestone titles.
pub const MAX_TITLE_LENGTH: u32 = 256;

/// Maximum allowed string length for cancellation reasons.
pub const MAX_REASON_LENGTH: u32 = 1024;

/// Maximum number of buyer signers per escrow.
pub const MAX_BUYER_SIGNERS: u32 = 10;

/// Maximum escrow amount to prevent overflow in downstream math.
pub const MAX_ESCROW_AMOUNT: i128 = i128::MAX / 2;

/// Validate that an amount is strictly positive and within safe bounds.
pub fn validate_amount(amount: i128) -> Result<(), EscrowError> {
    if amount <= 0 {
        return Err(EscrowError::E17);
    }
    if amount > MAX_ESCROW_AMOUNT {
        return Err(EscrowError::E85);
    }
    Ok(())
}

/// Validate that a brief hash is not all zeros.
pub fn validate_brief_hash(env: &Env, hash: &BytesN<32>) -> Result<(), EscrowError> {
    if hash == &BytesN::from_array(env, &[0u8; 32]) {
        return Err(EscrowError::InvalidBriefHash);
    }
    Ok(())
}

/// Validate that a deadline, if provided, is in the future.
pub fn validate_deadline(env: &Env, deadline: Option<u64>) -> Result<(), EscrowError> {
    if let Some(dl) = deadline {
        let now = env.ledger().timestamp();
        if dl <= now {
            return Err(EscrowError::E19);
        }
    }
    Ok(())
}

/// Validate that a lock_time, if provided, is in the future.
pub fn validate_lock_time(env: &Env, lock_time: Option<u64>) -> Result<(), EscrowError> {
    if let Some(lt) = lock_time {
        let now = env.ledger().timestamp();
        if lt <= now {
            return Err(EscrowError::E30);
        }
    }
    Ok(())
}

/// Validate milestone title length.
pub fn validate_title(title: &String) -> Result<(), EscrowError> {
    if title.len() == 0 {
        return Err(EscrowError::E55);
    }
    if title.len() > MAX_TITLE_LENGTH {
        return Err(EscrowError::E55);
    }
    Ok(())
}

/// Validate that two addresses are distinct (e.g. client != freelancer).
pub fn validate_distinct_parties(
    a: &soroban_sdk::Address,
    b: &soroban_sdk::Address,
) -> Result<(), EscrowError> {
    if a == b {
        return Err(EscrowError::E3);
    }
    Ok(())
}

/// Validate that the number of buyer signers does not exceed the cap.
pub fn validate_signer_count(count: u32) -> Result<(), EscrowError> {
    if count > MAX_BUYER_SIGNERS {
        return Err(EscrowError::MultisigTooManySigners);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_validate_amount_positive() {
        assert!(validate_amount(100).is_ok());
    }

    #[test]
    fn test_validate_amount_zero_rejected() {
        assert!(validate_amount(0).is_err());
    }

    #[test]
    fn test_validate_amount_negative_rejected() {
        assert!(validate_amount(-1).is_err());
    }

    #[test]
    fn test_validate_amount_overflow_rejected() {
        assert!(validate_amount(MAX_ESCROW_AMOUNT + 1).is_err());
    }

    #[test]
    fn test_validate_brief_hash_zeros_rejected() {
        let env = Env::default();
        let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
        assert!(validate_brief_hash(&env, &zero_hash).is_err());
    }

    #[test]
    fn test_validate_brief_hash_nonzero_ok() {
        let env = Env::default();
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        assert!(validate_brief_hash(&env, &hash).is_ok());
    }

    #[test]
    fn test_validate_title_empty_rejected() {
        let env = Env::default();
        let title = String::from_str(&env, "");
        assert!(validate_title(&title).is_err());
    }

    #[test]
    fn test_validate_title_ok() {
        let env = Env::default();
        let title = String::from_str(&env, "Design phase");
        assert!(validate_title(&title).is_ok());
    }

    #[test]
    fn test_validate_signer_count_ok() {
        assert!(validate_signer_count(5).is_ok());
    }

    #[test]
    fn test_validate_signer_count_exceeds_cap() {
        assert!(validate_signer_count(MAX_BUYER_SIGNERS + 1).is_err());
    }

    // ── Caller and bound checks (#663–#666) ─────────────────────────────────
    // None of these helpers takes a caller, so each test also asserts that no
    // authorization was required.

    use soroban_sdk::testutils::Ledger;

    /// #663: `validate_brief_hash` rejects the all-zero hash with the crate's
    /// error and accepts the all-ones / all-0xFF extremes.
    #[test]
    fn test_validate_brief_hash_caller_and_bounds() {
        let env = Env::default();
        assert_eq!(
            validate_brief_hash(&env, &BytesN::from_array(&env, &[0u8; 32])),
            Err(EscrowError::InvalidBriefHash)
        );
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(validate_brief_hash(&env, &BytesN::from_array(&env, &one)), Ok(()));
        assert_eq!(
            validate_brief_hash(&env, &BytesN::from_array(&env, &[u8::MAX; 32])),
            Ok(())
        );
        assert!(env.auths().is_empty());
    }

    /// #664: `validate_deadline` with 0 and `u64::MAX`, and with the ledger
    /// clock at `u64::MAX`, returns the crate's error instead of panicking.
    #[test]
    fn test_validate_deadline_caller_and_bounds() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        assert_eq!(validate_deadline(&env, None), Ok(()));
        assert_eq!(validate_deadline(&env, Some(0)), Err(EscrowError::E19));
        assert_eq!(validate_deadline(&env, Some(1_000)), Err(EscrowError::E19));
        assert_eq!(validate_deadline(&env, Some(1_001)), Ok(()));
        assert_eq!(validate_deadline(&env, Some(u64::MAX)), Ok(()));

        env.ledger().with_mut(|l| l.timestamp = u64::MAX);
        assert_eq!(validate_deadline(&env, Some(u64::MAX)), Err(EscrowError::E19));
        assert!(env.auths().is_empty());
    }

    /// #665: `validate_lock_time` with 0 and `u64::MAX`, and with the ledger
    /// clock at `u64::MAX`, returns the crate's error instead of panicking.
    #[test]
    fn test_validate_lock_time_caller_and_bounds() {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        assert_eq!(validate_lock_time(&env, None), Ok(()));
        assert_eq!(validate_lock_time(&env, Some(0)), Err(EscrowError::E30));
        assert_eq!(validate_lock_time(&env, Some(1_000)), Err(EscrowError::E30));
        assert_eq!(validate_lock_time(&env, Some(1_001)), Ok(()));
        assert_eq!(validate_lock_time(&env, Some(u64::MAX)), Ok(()));

        env.ledger().with_mut(|l| l.timestamp = u64::MAX);
        assert_eq!(validate_lock_time(&env, Some(u64::MAX)), Err(EscrowError::E30));
        assert!(env.auths().is_empty());
    }

    /// #666: `validate_title` at length 0, 1, `MAX_TITLE_LENGTH` and one past
    /// it returns the crate's error instead of panicking.
    #[test]
    fn test_validate_title_caller_and_bounds() {
        let env = Env::default();
        let bytes = [b'a'; MAX_TITLE_LENGTH as usize + 1];
        let title = |len: usize| String::from_str(&env, core::str::from_utf8(&bytes[..len]).unwrap());

        assert_eq!(validate_title(&title(0)), Err(EscrowError::E55));
        assert_eq!(validate_title(&title(1)), Ok(()));
        assert_eq!(validate_title(&title(MAX_TITLE_LENGTH as usize)), Ok(()));
        assert_eq!(
            validate_title(&title(MAX_TITLE_LENGTH as usize + 1)),
            Err(EscrowError::E55)
        );
        assert!(env.auths().is_empty());
    }
}
