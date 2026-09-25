'use client';

/**
 * Export Job Progress UI — Issue #230
 *
 * Display queued/running/completed/failed/cancelled states for long-running exports.
 * Users can cancel eligible jobs, download completed exports, see failure reasons.
 */

import { useState, useEffect, useCallback } from 'react';
import { Download, X, AlertCircle, CheckCircle, Clock, Loader } from 'lucide-react';
import { buildAdminHeaders } from '../../../store/admin';
import { useAdminStore } from '../../../store/app-store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const statusConfig = {
  queued: {
    icon: Clock,
    color: 'text-gray-500',
    bgColor: 'bg-gray-100 dark:bg-gray-900',
    label: 'Queued',
  },
  running: {
    icon: Loader,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900',
    label: 'Processing',
  },
  completed: {
    icon: CheckCircle,
    color: 'text-green-500',
    bgColor: 'bg-green-100 dark:bg-green-900',
    label: 'Completed',
  },
  failed: {
    icon: AlertCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900',
    label: 'Failed',
  },
  cancelled: {
    icon: X,
    color: 'text-gray-400',
    bgColor: 'bg-gray-100 dark:bg-gray-900',
    label: 'Cancelled',
  },
};

export default function ExportJobProgress({ jobId, onComplete = () => {} }) {
  const { apiKey } = useAdminStore();
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/exports/${jobId}`, {
        headers: buildAdminHeaders(apiKey),
      });
      if (!res.ok) throw new Error('Failed to fetch job');
      const data = await res.json();
      setJob(data);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [jobId, apiKey]);

  useEffect(() => {
    fetchJob();
    // Poll every 2 seconds while running
    const interval = setInterval(() => {
      fetchJob();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchJob]);

  const handleCancel = async () => {
    if (!confirm('Cancel this export job?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/exports/${jobId}`, {
        method: 'DELETE',
        headers: buildAdminHeaders(apiKey),
      });
      if (!res.ok) throw new Error('Failed to cancel');
      await fetchJob();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDownload = () => {
    if (job?.fileUrl) {
      window.open(job.fileUrl, '_blank');
    }
  };

  if (loading) {
    return (
      <div className="card space-y-3">
        <div className="h-6 w-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="space-y-2">
          <div className="h-4 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (!job || error) {
    return (
      <div className="card">
        <p className="text-sm text-red-600 dark:text-red-400">{error || 'Job not found'}</p>
      </div>
    );
  }

  const statusInfo = statusConfig[job.status] || statusConfig.queued;
  const StatusIcon = statusInfo.icon;
  const canCancel = ['queued', 'running'].includes(job.status);
  const canDownload = job.status === 'completed' && job.fileUrl;

  return (
    <div className="card">
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={`rounded-lg p-2 ${statusInfo.bgColor}`}>
            <StatusIcon className={`h-5 w-5 ${statusInfo.color} animate-spin motion-reduce:animate-none`} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-50">{job.type}</h3>
            <p className={`text-xs font-medium ${statusInfo.color}`}>{statusInfo.label}</p>
          </div>
        </div>

        {canCancel && (
          <button
            onClick={handleCancel}
            className="text-xs text-red-600 transition-colors hover:text-red-500 dark:text-red-400"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress Bar */}
      {job.status === 'running' && (
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-gray-600 dark:text-gray-400">Progress</span>
            <span className="text-xs font-medium text-gray-900 dark:text-gray-50">{job.progress}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
          {job.itemsProcessed && job.totalItems && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {job.itemsProcessed.toLocaleString()} / {job.totalItems.toLocaleString()} items
            </p>
          )}
        </div>
      )}

      {/* Error Message */}
      {job.status === 'failed' && job.errorMsg && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 dark:border-red-500/30 dark:bg-red-900/20">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          <span className="text-xs text-red-800 dark:text-red-300">{job.errorMsg}</span>
        </div>
      )}

      {/* Metadata */}
      <div className="space-y-1 border-t border-gray-200 pt-4 dark:border-gray-700">
        <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
          <span>Created:</span>
          <span>{new Date(job.createdAt).toLocaleString()}</span>
        </div>
        {job.expiresAt && (
          <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
            <span>Expires:</span>
            <span>{new Date(job.expiresAt).toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      {canDownload && (
        <div className="mt-4">
          <button
            onClick={handleDownload}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500"
          >
            <Download className="h-4 w-4" />
            Download Export
          </button>
        </div>
      )}
    </div>
  );
}
