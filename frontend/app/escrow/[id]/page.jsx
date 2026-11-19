/**
 * Escrow Details Page — /escrow/[id]
 *
 * Shows full escrow information, milestone timeline, and action buttons.
 *
 * Actions shown depend on the connected wallet's role:
 * - Client:     Approve / Reject milestone buttons
 * - Freelancer: Submit milestone button
 * - Both:       Raise Dispute button (if Active)
 *
 * Auto-refresh: data is polled every 30 seconds via SWR.
 * Polling pauses when the page tab is hidden and resumes on visibility.
 * A manual refresh button and last-updated timestamp are always shown.
 *
 * TODO (contributor — hard, Issue #34):
 * - Detect wallet role (client vs freelancer)
 * - Wire approve/reject/submit/dispute to contract interactions via Freighter
 * - Handle error states
 */

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useEscrow } from '../../../hooks/useEscrow';
import { useCountdown } from '../../../hooks/useCountdown';
import { useRelativeTime } from '../../../hooks/useRelativeTime';
import { useWallet } from '../../../hooks/useWallet';
import { useToast } from '../../../contexts/ToastContext';
import MilestoneList from '../../../components/escrow/MilestoneList';
import TransactionHistoryList, {
  buildHistoryFromEscrow,
} from '../../../components/escrow/TransactionHistoryList';
import DisputeModal from '../../../components/escrow/DisputeModal';
import CancelEscrowModal from '../../../components/escrow/CancelEscrowModal';
import ExpiryExtensionRequest from '../../../components/escrow/ExpiryExtensionRequest';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import ReputationBadge from '../../../components/ui/ReputationBadge';
import CurrencyAmount from '../../../components/ui/CurrencyAmount';
import TransactionHash from '../../../components/ui/TransactionHash';
import Avatar from '../../../components/ui/Avatar';
import {
  buildApproveMilestoneTx,
  buildSubmitMilestoneTx,
  buildRaiseDisputeTx,
  broadcastTransaction,
} from '../../../lib/stellar';
import { isValidStellarTransactionHash } from '../../../../shared/stellarTransactionHash.js';

// Fallback data used while the API integration (Issue #34) is pending.
const PLACEHOLDER_ESCROW = {
  id: 1,
  title: 'Smart Contract Audit',
  status: 'Active',
  txHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', // TODO: replace with real tx hash
  clientAddress: 'GABCD...1234',
  freelancerAddress: 'GXYZ...5678',
  totalAmount: '2,000 USDC',
  remainingBalance: '1,500 USDC',
  createdAt: '2025-03-01',
  deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
  transactionHash: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2',
  milestones: [
    {
      id: 0,
      title: 'Codebase Review',
      amount: '500 USDC',
      status: 'Approved',
      submittedAt: '2025-03-05',
    },
    {
      id: 1,
      title: 'Vulnerability Report',
      amount: '1,000 USDC',
      status: 'Submitted',
      submittedAt: '2025-03-12',
    },
    {
      id: 2,
      title: 'Final Sign-off',
      amount: '500 USDC',
      status: 'Pending',
      submittedAt: null,
    },
  ],
};

function truncateAddress(address) {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function PartyCard({ role, address }) {
  const truncated = truncateAddress(address);
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">{role}</p>
      {address ? (
        <Link
          href={`/profile/${address}`}
          aria-label={`View ${role} profile for ${truncated}`}
          className="font-mono text-sm text-indigo-400 hover:text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          {truncated}
        </Link>
      ) : (
        <span className="font-mono text-sm text-gray-500">—</span>
      )}
    </div>
  );
}

export default function EscrowDetailPage({ params }) {
  const { id } = params;
  const [isDisputeOpen, setDisputeOpen] = useState(false);
  const [isCancelOpen, setCancelOpen] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);

  const { escrow: fetchedEscrow, isLoading, mutate } = useEscrow(id);
  const { address, signTx } = useWallet();
  const relativeTime = useRelativeTime(lastRefreshed);
  const { showToast } = useToast();

  // Use fetched data when available, fall back to placeholder during development.
  const escrow = fetchedEscrow ?? PLACEHOLDER_ESCROW;
  const countdown = useCountdown(escrow.deadline);
  const isExpired = escrow.status === 'Expired' || countdown.isExpired;

  // Update the last-refreshed timestamp whenever data arrives from SWR
  // (initial load, scheduled poll, or manual refresh).
  useEffect(() => {
    setLastRefreshed(new Date());
  }, [fetchedEscrow]);

  // Set an initial timestamp on mount so the UI is never empty.
  useEffect(() => {
    setLastRefreshed(new Date());
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await mutate();
      setLastRefreshed(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  // Derive connected role from wallet address
  const connectedRole = address
    ? address === escrow.clientAddress
      ? 'client'
      : address === escrow.freelancerAddress
        ? 'freelancer'
        : 'observer'
    : 'observer';

  const handleApproveMilestone = async (milestoneId) => {
    setIsActionLoading(true);
    try {
      if (!address) throw new Error('Please connect your wallet first');

      const unsignedXdr = await buildApproveMilestoneTx({
        sourceAddress: address,
        escrowId: BigInt(id).toString(),
        milestoneId: Number(milestoneId),
      });

      const signedXdr = await signTx(unsignedXdr);
      await broadcastTransaction(signedXdr);

      showToast('Milestone approved', 'success');
      await mutate();
    } catch (err) {
      showToast(err.message || 'Failed to approve milestone', 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleSubmitMilestone = async (milestoneId) => {
    setIsActionLoading(true);
    try {
      if (!address) throw new Error('Please connect your wallet first');

      const unsignedXdr = await buildSubmitMilestoneTx({
        sourceAddress: address,
        escrowId: BigInt(id).toString(),
        milestoneId: Number(milestoneId),
      });

      const signedXdr = await signTx(unsignedXdr);
      await broadcastTransaction(signedXdr);

      showToast('Milestone submitted', 'success');
      await mutate();
    } catch (err) {
      showToast(err.message || 'Failed to submit milestone', 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRejectMilestone = async (milestoneId) => {
    setIsActionLoading(true);
    try {
      if (!address) throw new Error('Please connect your wallet first');

      // TODO: Implement reject_milestone if not already in contract
      showToast('Milestone rejection not yet implemented', 'warning');
    } catch (err) {
      showToast(err.message || 'Failed to reject milestone', 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleCancelEscrow = async () => {
    setIsActionLoading(true);
    try {
      if (!address) throw new Error('Please connect your wallet first');

      // TODO: Implement cancel_escrow if not already in contract
      showToast('Escrow cancellation not yet implemented', 'warning');
      setCancelOpen(false);
    } catch (err) {
      showToast(err.message || 'Failed to cancel escrow', 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  if (isLoading && !fetchedEscrow) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-gray-400">
        Loading escrow…
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-white">{escrow.title}</h1>
            <Badge status={escrow.status} />
          </div>
          <p className="text-gray-400 text-sm">Escrow #{id}</p>
          <p data-testid="escrow-countdown" className="text-sm text-gray-400 mt-1">
            {isExpired
              ? 'Expired'
              : escrow.deadline
                ? `Time remaining: ${countdown.days}d ${countdown.hours}h ${countdown.minutes}m ${countdown.seconds}s`
                : 'No deadline set'}
          </p>
        </div>
      </div>

      {/* Parties */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <PartyCard role="Client" address={escrow.clientAddress} />
        <PartyCard role="Freelancer" address={escrow.freelancerAddress} />
        <PartyCard role="Arbiter" address={escrow.arbiterAddress} />
      </div>
    </div>
  );
}
