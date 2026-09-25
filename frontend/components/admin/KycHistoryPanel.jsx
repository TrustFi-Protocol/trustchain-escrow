'use client';

/**
 * KYC History Panel — Issue #229
 *
 * Shows timeline of KYC status changes for a user.
 * Admin view shows who changed it and why.
 * User view shows their own status history.
 */

import { useState, useEffect } from 'react';
import { ChevronDown, Clock, AlertCircle } from 'lucide-react';
import { buildAdminHeaders } from '../../../store/admin';
import { useAdminStore } from '../../../store/app-store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function KycHistoryPanel({ address, isAdmin = false }) {
  const { apiKey } = useAdminStore();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || !address) return;

    const fetchHistory = async () => {
      setLoading(true);
      setError('');
      try {
        const endpoint = isAdmin
          ? `/api/kyc/admin/history?address=${address}&page=1&limit=50`
          : `/api/kyc/history/${address}?page=1&limit=50`;

        const res = await fetch(`${API_BASE}${endpoint}`, {
          headers: isAdmin ? buildAdminHeaders(apiKey) : {},
        });

        if (!res.ok) throw new Error('Failed to load history');
        const data = await res.json();
        setHistory(data.data || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [expanded, address, isAdmin, apiKey]);

  const statusColor = {
    Pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
    Init: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200',
    Processing: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200',
    Approved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200',
    Declined: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200',
  };

  return (
    <div className="card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <h3 className="font-semibold text-gray-900 dark:text-gray-50">KYC Status History</h3>
        </div>
        <ChevronDown
          className={`h-5 w-5 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-900/20 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No history available</p>
          ) : (
            <div className="space-y-4">
              {history.map((event, idx) => (
                <div key={event.id || idx} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-3 w-3 rounded-full bg-indigo-600" />
                    {idx < history.length - 1 && <div className="mt-2 h-8 w-0.5 bg-gray-300 dark:bg-gray-600" />}
                  </div>
                  <div className="pb-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-block rounded px-2 py-1 text-xs font-medium ${statusColor[event.oldStatus] || 'bg-gray-100'}`}>
                        {event.oldStatus}
                      </span>
                      <span className="text-gray-500">→</span>
                      <span className={`inline-block rounded px-2 py-1 text-xs font-medium ${statusColor[event.newStatus] || 'bg-gray-100'}`}>
                        {event.newStatus}
                      </span>
                    </div>
                    {event.reason && <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{event.reason}</p>}
                    {isAdmin && event.actor && (
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        By: <code className="bg-gray-100 px-1 dark:bg-gray-800">{event.actor.slice(0, 12)}...</code>
                      </p>
                    )}
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {new Date(event.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
