import React from 'react';
import Link from 'next/link';
import { 
  ArrowRight, 
  Clock, 
  Play, 
  Pause, 
  CheckCircle, 
  XCircle, 
  Calendar, 
  TrendingUp,
  User
} from 'lucide-react';
import Badge from '@/components/ui/Badge';
import CurrencyAmount from '@/components/ui/CurrencyAmount';
import CopyButton from '@/components/ui/CopyButton';
import { useI18n } from '@/hooks/useI18n';

/**
 * Truncate a Stellar public key or address for display.
 */
function truncateAddress(address) {
  if (address == null || typeof address !== 'string') return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Standardized helper to format timestamps safely.
 */
function formatDate(timestamp) {
  if (timestamp == null) return 'N/A';
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(String(timestamp));
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Get status badge variant and label.
 */
function getStatusConfig(status) {
  const normalizedStatus = (status ?? 'unknown').toString().toLowerCase();
  switch (normalizedStatus) {
    case 'active':
    case 'running':
      return { variant: 'success', label: 'Active', icon: Play };
    case 'paused':
      return { variant: 'warning', label: 'Paused', icon: Pause };
    case 'completed':
    case 'finished':
      return { variant: 'info', label: 'Completed', icon: CheckCircle };
    case 'cancelled':
    case 'canceled':
      return { variant: 'danger', label: 'Cancelled', icon: XCircle };
    default:
      return { variant: 'neutral', label: status ?? 'Unknown', icon: Clock };
  }
}

export default function PaymentStreamCard({ stream, className = '' }) {
  const { t } = useI18n();

  if (stream == null) {
    return (
      <div className={`rounded-xl border border-gray-200 dark:border-gray-800 p-6 bg-white dark:bg-gray-900 shadow-sm ${className}`}>
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
          {t?.('paymentStream.noData') ?? 'No payment stream details available.'}
        </p>
      </div>
    );
  }

  // Explicit null/undefined handling using nullish coalescing (??)
  // Ensures numeric 0 is preserved rather than falling back to defaults via truthy check !val
  const id = stream.id ?? stream.streamId ?? '';
  const sender = stream.sender ?? stream.senderAddress ?? '';
  const recipient = stream.recipient ?? stream.recipientAddress ?? '';
  const tokenSymbol = stream.tokenSymbol ?? stream.assetCode ?? 'USDC';

  const totalDeposit = stream.totalDeposit ?? stream.depositAmount ?? 0;
  const remainingAmount = stream.remainingAmount ?? stream.remainingBalance ?? 0;
  const withdrawnAmount = stream.withdrawnAmount ?? stream.transferredAmount ?? 0;
  const ratePerSecond = stream.ratePerSecond ?? stream.rate ?? 0;

  const startTime = stream.startTime ?? stream.createdAt ?? null;
  const endTime = stream.endTime ?? null;

  // Calculate progress percentage safely (0 to 100)
  const calculatedProgress = totalDeposit > 0 ? (withdrawnAmount / totalDeposit) * 100 : 0;
  const progressPercentage = Math.min(100, Math.max(0, stream.progressPercentage ?? calculatedProgress));

  const statusConfig = getStatusConfig(stream.status);
  const StatusIcon = statusConfig.icon;

  return (
    <div className={`rounded-xl border border-gray-200 dark:border-gray-800 p-6 bg-white dark:bg-gray-900 shadow-sm hover:shadow-md transition-shadow ${className}`}>
      {/* Top Header: ID & Status */}
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t?.('paymentStream.stream') ?? 'Stream'}
          </span>
          {id ? (
            <Link 
              href={`/streams/${id}`}
              className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              #{id.length > 12 ? truncateAddress(id) : id}
            </Link>
          ) : null}
        </div>
        <Badge variant={statusConfig.variant} className="flex items-center gap-1.5 px-2.5 py-1">
          <StatusIcon className="w-3.5 h-3.5" />
          <span>{statusConfig.label}</span>
        </Badge>
      </div>

      {/* Participants: Sender -> Recipient */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-4 py-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
            <User className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {t?.('paymentStream.sender') ?? 'Sender'}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-sm font-mono text-gray-800 dark:text-gray-200 truncate">
                {truncateAddress(sender) || '—'}
              </span>
              {sender ? <CopyButton text={sender} /> : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
            <ArrowRight className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {t?.('paymentStream.recipient') ?? 'Recipient'}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-sm font-mono text-gray-800 dark:text-gray-200 truncate">
                {truncateAddress(recipient) || '—'}
              </span>
              {recipient ? <CopyButton text={recipient} /> : null}
            </div>
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="my-4">
        <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          <span>{t?.('paymentStream.withdrawn') ?? 'Withdrawn'}</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {progressPercentage.toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
          <div 
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progressPercentage}%` }}
          />
        </div>
      </div>

      {/* Stream Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 my-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
        <div>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t?.('paymentStream.totalDeposit') ?? 'Total Deposit'}
          </span>
          <div className="mt-1">
            <CurrencyAmount amount={totalDeposit} symbol={tokenSymbol} size="sm" />
          </div>
        </div>

        <div>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t?.('paymentStream.withdrawn') ?? 'Withdrawn'}
          </span>
          <div className="mt-1">
            <CurrencyAmount amount={withdrawnAmount} symbol={tokenSymbol} size="sm" />
          </div>
        </div>

        <div className="col-span-2 md:col-span-1">
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t?.('paymentStream.remaining') ?? 'Remaining'}
          </span>
          <div className="mt-1">
            <CurrencyAmount amount={remainingAmount} symbol={tokenSymbol} size="sm" />
          </div>
        </div>
      </div>

      {/* Footer: Timeline & Flow Rate */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" />
          <span>
            {formatDate(startTime)} — {formatDate(endTime)}
          </span>
        </div>

        {ratePerSecond > 0 && (
          <div className="flex items-center gap-1 text-gray-600 dark:text-gray-300 font-mono">
            <TrendingUp className="w-3.5 h-3.5 text-blue-500" />
            <span>
              {ratePerSecond} {tokenSymbol}/sec
            </span>
          </div>
        )}
      </div>
    </div>
  );
}