'use client';

/**
 * Feature Flag Evaluation Preview — Issue #232
 *
 * Allow admins to preview whether a flag would apply for a tenant, role, and user
 * BEFORE saving rollout rules. Shows matched rule and variant without persisting.
 */

import { useState } from 'react';
import { Eye, CheckCircle, XCircle } from 'lucide-react';
import { buildAdminHeaders } from '../../../store/admin';
import { useAdminStore } from '../../../store/app-store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export default function FeatureFlagPreview({ flagKey }) {
  const { apiKey } = useAdminStore();
  const [address, setAddress] = useState('');
  const [role, setRole] = useState('user');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handlePreview = async (e) => {
    e.preventDefault();
    setError('');
    setPreview(null);

    if (address && !STELLAR_ADDRESS_RE.test(address)) {
      setError('Invalid Stellar address format');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/flags/preview`, {
        method: 'POST',
        headers: {
          ...buildAdminHeaders(apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flagKey,
          address: address || undefined,
          role,
        }),
      });

      if (!res.ok) throw new Error('Preview failed');
      const data = await res.json();
      setPreview(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const ruleDescriptions = {
    flag_not_found: 'Flag does not exist',
    flag_disabled: 'Flag is globally disabled',
    target_user: 'User is in target list',
    not_in_target_list: 'User is not in target list',
    percentage_rollout_included: 'Included in percentage rollout',
    percentage_rollout_excluded: 'Excluded from percentage rollout',
    globally_enabled: 'Flag is globally enabled',
  };

  return (
    <div className="card">
      <h3 className="mb-4 flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-50">
        <Eye className="h-5 w-5" />
        Evaluation Preview (Issue #232)
      </h3>

      <form onSubmit={handlePreview} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Stellar Address (optional)
          </label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            placeholder="G..."
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 placeholder-gray-500 focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          {address && !STELLAR_ADDRESS_RE.test(address) && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">Invalid address format</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
            <option value="superadmin">Superadmin</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? 'Previewing...' : 'Preview Evaluation'}
        </button>
      </form>

      {error && (
        <div className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      {preview && (
        <div className="mt-6 space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
          {/* Applies Status */}
          <div
            className={`flex items-center gap-3 rounded-lg px-4 py-3 ${
              preview.applies
                ? 'bg-green-50 dark:bg-green-900/20'
                : 'bg-red-50 dark:bg-red-900/20'
            }`}
          >
            {preview.applies ? (
              <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
            ) : (
              <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            )}
            <span
              className={`font-medium ${
                preview.applies
                  ? 'text-green-800 dark:text-green-200'
                  : 'text-red-800 dark:text-red-200'
              }`}
            >
              {preview.applies ? 'Flag applies' : 'Flag does not apply'}
            </span>
          </div>

          {/* Matched Rule */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Matched Rule</p>
            <p className="mt-1 font-mono text-sm text-gray-900 dark:text-gray-100">
              {ruleDescriptions[preview.rule] || preview.rule}
            </p>
          </div>

          {/* Percentage Details */}
          {preview.percentageValue !== undefined && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Percentage Rollout
              </p>
              <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                User hash: {preview.percentageValue}% (threshold: {preview.percentageThreshold}%)
              </p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-300 dark:bg-gray-600">
                <div
                  className={`h-full ${preview.applies ? 'bg-green-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(preview.percentageValue, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
