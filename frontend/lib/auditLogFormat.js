/**
 * auditLogFormat
 *
 * Shared formatting/classification helpers for admin audit log entries.
 * Extracted from the audit logs table (issue #102), which previously
 * reimplemented address truncation inline instead of using the existing
 * `truncateAddress` helper — a real drift risk if the two implementations
 * ever diverged.
 */

import { truncateAddress } from './truncateAddress';

/**
 * Maps an audit log action string to a Tailwind color class set for its
 * badge, based on keywords in the action name.
 *
 * @param {string} [action]
 * @returns {string} Tailwind classes for text/background/border color.
 */
export function actionColor(action) {
  if (action?.includes('BAN')) return 'text-red-400 bg-red-500/10 border-red-500/20';
  if (action?.includes('SUSPEND')) return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
  if (action?.includes('RESOLVE'))
    return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  return 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20';
}

/**
 * Formats an audit log entry's target address for table display, using the
 * canonical `truncateAddress` helper rather than a bespoke inline slice.
 *
 * @param {string} [targetAddress]
 * @returns {string}
 */
export function formatAuditLogTarget(targetAddress) {
  if (!targetAddress) return targetAddress ?? '';
  return targetAddress.length > 20 ? truncateAddress(targetAddress) : targetAddress;
}

/**
 * Formats an audit log entry's `performedAt` timestamp for table display.
 *
 * @param {string|number|Date} performedAt
 * @returns {string}
 */
export function formatAuditLogTimestamp(performedAt) {
  return new Date(performedAt).toLocaleString();
}
