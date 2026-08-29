/**
 * KycStatusBanner Component
 *
 * Reusable status card showing the current KYC verification state plus a
 * short, human-readable message. Mirrors the "status card" block previously
 * inlined in app/kyc/page.jsx so the same banner can be reused elsewhere
 * (e.g. dashboard widgets, admin review screens).
 *
 * @param {object} props
 * @param {string} [props.status] — KYC status value (Pending | Init | Processing | Approved | Declined)
 * @param {string} [props.error] — optional error message to surface for the unhappy path
 */
import Badge from './ui/Badge';

const STATUS_MESSAGES = {
  Pending: 'Start verification to unlock full platform access.',
  Init: 'Verification started. Complete the steps below.',
  Processing: 'Your documents are being reviewed. This usually takes a few minutes.',
  Approved: 'Your identity has been verified.',
  Declined: 'Verification was declined. Please review the requirements and try again.',
};

const FALLBACK_STATUS = 'Pending';

function resolveStatus(status) {
  if (typeof status !== 'string' || status.trim() === '') return FALLBACK_STATUS;
  if (!Object.prototype.hasOwnProperty.call(STATUS_MESSAGES, status)) return FALLBACK_STATUS;
  return status;
}

export default function KycStatusBanner({ status, error }) {
  const resolvedStatus = resolveStatus(status);
  const message = STATUS_MESSAGES[resolvedStatus] ?? '';

  return (
    <div className="card flex items-center justify-between" data-testid="kyc-status-banner">
      <div>
        <p className="text-sm text-gray-500 mb-1">Verification Status</p>
        <Badge status={resolvedStatus} />
      </div>
      {error ? (
        <p className="text-sm text-red-400 max-w-xs text-right" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-sm text-gray-400 max-w-xs text-right">{message}</p>
      )}
    </div>
  );
}
