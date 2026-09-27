import {
  getDeadlineStatus,
  EXPIRING_SOON_MS,
  STALE_THRESHOLD_MS,
} from '../../lib/deadlineStatus';

describe('getDeadlineStatus', () => {
  // Pin "now" so every boundary assertion is deterministic.
  const NOW = 1_700_000_000_000; // arbitrary fixed epoch ms

  // ─── null / missing deadline ────────────────────────────────────────────────

  it('returns stale for null deadline', () => {
    expect(getDeadlineStatus(null, NOW)).toBe('stale');
  });

  it('returns stale for undefined deadline', () => {
    expect(getDeadlineStatus(undefined, NOW)).toBe('stale');
  });

  it('returns stale for an invalid date string', () => {
    expect(getDeadlineStatus('not-a-date', NOW)).toBe('stale');
  });

  // ─── active ─────────────────────────────────────────────────────────────────

  it('returns active when deadline is exactly EXPIRING_SOON_MS + 1 ms away', () => {
    const deadline = NOW + EXPIRING_SOON_MS + 1;
    expect(getDeadlineStatus(deadline, NOW)).toBe('active');
  });

  it('returns active when deadline is 7 days away', () => {
    const deadline = NOW + 7 * 24 * 60 * 60 * 1000;
    expect(getDeadlineStatus(deadline, NOW)).toBe('active');
  });

  it('returns active when deadline is exactly 24 h + 1 ms away (just above boundary)', () => {
    const deadline = NOW + EXPIRING_SOON_MS + 1;
    expect(getDeadlineStatus(deadline, NOW)).toBe('active');
  });

  // ─── expiring_soon ───────────────────────────────────────────────────────────

  it('returns expiring_soon when deadline is exactly EXPIRING_SOON_MS away (boundary)', () => {
    const deadline = NOW + EXPIRING_SOON_MS;
    expect(getDeadlineStatus(deadline, NOW)).toBe('expiring_soon');
  });

  it('returns expiring_soon when deadline is 1 ms away', () => {
    const deadline = NOW + 1;
    expect(getDeadlineStatus(deadline, NOW)).toBe('expiring_soon');
  });

  it('returns expiring_soon when deadline is 12 h away', () => {
    const deadline = NOW + 12 * 60 * 60 * 1000;
    expect(getDeadlineStatus(deadline, NOW)).toBe('expiring_soon');
  });

  // ─── expired ────────────────────────────────────────────────────────────────

  it('returns expired when deadline was exactly 1 ms ago', () => {
    const deadline = NOW - 1;
    expect(getDeadlineStatus(deadline, NOW)).toBe('expired');
  });

  it('returns expired when deadline was 1 day ago', () => {
    const deadline = NOW - 24 * 60 * 60 * 1000;
    expect(getDeadlineStatus(deadline, NOW)).toBe('expired');
  });

  it('returns expired when deadline was exactly STALE_THRESHOLD_MS ago (boundary)', () => {
    const deadline = NOW - STALE_THRESHOLD_MS;
    expect(getDeadlineStatus(deadline, NOW)).toBe('expired');
  });

  // ─── stale ───────────────────────────────────────────────────────────────────

  it('returns stale when deadline was STALE_THRESHOLD_MS + 1 ms ago (just past boundary)', () => {
    const deadline = NOW - STALE_THRESHOLD_MS - 1;
    expect(getDeadlineStatus(deadline, NOW)).toBe('stale');
  });

  it('returns stale when deadline was 60 days ago', () => {
    const deadline = NOW - 60 * 24 * 60 * 60 * 1000;
    expect(getDeadlineStatus(deadline, NOW)).toBe('stale');
  });

  // ─── input type coercion ─────────────────────────────────────────────────────

  it('accepts a Date object', () => {
    const deadline = new Date(NOW + 7 * 24 * 60 * 60 * 1000);
    expect(getDeadlineStatus(deadline, NOW)).toBe('active');
  });

  it('accepts an ISO date string', () => {
    const deadline = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(getDeadlineStatus(deadline, NOW)).toBe('active');
  });

  it('accepts a numeric ms timestamp', () => {
    const deadline = NOW + 7 * 24 * 60 * 60 * 1000;
    expect(getDeadlineStatus(deadline, NOW)).toBe('active');
  });

  // ─── default now ─────────────────────────────────────────────────────────────

  it('uses real Date.now() when no now override is provided', () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(getDeadlineStatus(future)).toBe('active');
  });
});
