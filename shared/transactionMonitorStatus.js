const TransactionMonitorStatus = Object.freeze({
  QUEUED: 'queued',
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  RETRYABLE: 'retryable',
  MANUAL_REVIEW: 'manual_review',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
});

const TERMINAL_TRANSACTION_MONITOR_STATUSES = Object.freeze([
  TransactionMonitorStatus.CONFIRMED,
  TransactionMonitorStatus.FAILED,
  TransactionMonitorStatus.TIMEOUT,
  TransactionMonitorStatus.CANCELLED,
]);

const RETRYABLE_TRANSACTION_MONITOR_STATUSES = Object.freeze([
  TransactionMonitorStatus.QUEUED,
  TransactionMonitorStatus.PENDING,
  TransactionMonitorStatus.RETRYABLE,
  TransactionMonitorStatus.TIMEOUT,
]);

const TRANSACTION_MONITOR_STATUS_LABELS = Object.freeze({
  [TransactionMonitorStatus.QUEUED]: 'Queued',
  [TransactionMonitorStatus.PENDING]: 'Pending confirmation',
  [TransactionMonitorStatus.SUBMITTED]: 'Submitted to Stellar',
  [TransactionMonitorStatus.CONFIRMED]: 'Confirmed',
  [TransactionMonitorStatus.FAILED]: 'Failed',
  [TransactionMonitorStatus.RETRYABLE]: 'Retryable',
  [TransactionMonitorStatus.MANUAL_REVIEW]: 'Manual review',
  [TransactionMonitorStatus.TIMEOUT]: 'Timed out',
  [TransactionMonitorStatus.CANCELLED]: 'Cancelled',
});

function isTransactionMonitorStatus(value) {
  return Object.values(TransactionMonitorStatus).includes(value);
}

module.exports = {
  TransactionMonitorStatus,
  TERMINAL_TRANSACTION_MONITOR_STATUSES,
  RETRYABLE_TRANSACTION_MONITOR_STATUSES,
  TRANSACTION_MONITOR_STATUS_LABELS,
  isTransactionMonitorStatus,
};
