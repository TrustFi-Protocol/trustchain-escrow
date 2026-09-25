'use client';

/**
 * Incident Impact Panel — Issue #231
 *
 * Show affected escrows linked to an incident.
 * Admins can view and manage the impact relationships.
 */

import { useState, useEffect } from 'react';
import { AlertTriangle, Loader, X } from 'lucide-react';
import { buildAdminHeaders } from '../../../store/admin';
import { useAdminStore } from '../../../store/app-store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const severityBg = {
  low: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

export default function IncidentImpactPanel({ incidentId, onNavigateEscrow = () => {} }) {
  const { apiKey } = useAdminStore();
  const [escrows, setEscrows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removeId, setRemoveId] = useState(null);

  useEffect(() => {
    const fetchEscrows = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/admin/incidents/${incidentId}/escrows`, {
          headers: buildAdminHeaders(apiKey),
        });
        if (!res.ok) throw new Error('Failed to load affected escrows');
        const data = await res.json();
        setEscrows(data.data || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchEscrows();
  }, [incidentId, apiKey]);

  const handleRemove = async (escrowId) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/admin/incidents/${incidentId}/escrows/${escrowId}`,
        {
          method: 'DELETE',
          headers: buildAdminHeaders(apiKey),
        },
      );
      if (!res.ok) throw new Error('Failed to remove escrow');
      setEscrows(escrows.filter((e) => e.escrowId !== escrowId));
      setRemoveId(null);
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="card flex items-center justify-center py-8">
        <Loader className="h-5 w-5 animate-spin text-indigo-600 dark:text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="mb-4 flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-50">
        <AlertTriangle className="h-5 w-5 text-orange-500" />
        Affected Escrows
      </h3>

      {error && (
        <div className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      {escrows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No linked escrows</p>
      ) : (
        <div className="space-y-3">
          {escrows.map((link) => (
            <div
              key={link.id}
              className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50"
            >
              <div className="flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <code className="text-sm font-mono font-medium text-gray-900 dark:text-gray-100">
                    Escrow #{link.escrowId.toString()}
                  </code>
                </div>
                {link.reason && (
                  <p className="text-xs text-gray-600 dark:text-gray-400">{link.reason}</p>
                )}
              </div>
              <button
                onClick={() => {
                  if (removeId === link.id) {
                    handleRemove(link.escrowId);
                  } else {
                    setRemoveId(link.id);
                  }
                }}
                className={`ml-2 flex-shrink-0 rounded p-1 transition-colors ${
                  removeId === link.id
                    ? 'bg-red-500 text-white'
                    : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
