/**
 * deadlineStatus.js
 *
 * Converts an escrow deadline timestamp into one of four display states:
 *
 *   'active'        — deadline is more than EXPIRING_SOON_MS away
 *   'expiring_soon' — deadline is within EXPIRING_SOON_MS (but not yet past)
 *   'expired'       — deadline has passed, within the STALE_THRESHOLD_MS window
 *   'stale'         — deadline passed more than STALE_THRESHOLD_MS ago (or no deadline set)
 *
 * Thresholds are exported so callers can reference the same constants for UI labels.
 */

/** Escrows expiring within 24 h are flagged as "expiring soon". */
export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Escrows whose deadline is older than 30 days are considered stale. */
export const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * @typedef {'active' | 'expiring_soon' | 'expired' | 'stale'} DeadlineState
 */

/**
 * Derives the deadline display state for an escrow.
 *
 * @param {Date | number | string | null | undefined} deadline
 * @param {number} [now] — override for current time (ms since epoch); defaults to Date.now()
 * @returns {DeadlineState}
 */
export function getDeadlineStatus(deadline, now = Date.now()) {
  if (deadline == null) return 'stale';

  const deadlineMs = new Date(deadline).getTime();

  // Invalid date guard
  if (Number.isNaN(deadlineMs)) return 'stale';

  const msUntilDeadline = deadlineMs - now;

  if (msUntilDeadline > EXPIRING_SOON_MS) return 'active';
  if (msUntilDeadline > 0) return 'expiring_soon';
  if (now - deadlineMs <= STALE_THRESHOLD_MS) return 'expired';
  return 'stale';
}
