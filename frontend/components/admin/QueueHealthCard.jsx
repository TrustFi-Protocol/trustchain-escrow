'use client';

/**
 * QueueHealthCard
 *
 * A single admin-dashboard card summarising the background event queue:
 * depth, failed jobs, dead-letter count, and how long the oldest waiting job
 * has been waiting. The whole card links to `/admin/queues`, which hosts the
 * dead-letter UI where those jobs can actually be inspected and acted on.
 *
 * The card is a summary, not a control surface — retry and acknowledge live on
 * the queue page, so nothing here mutates state.
 *
 * Missing data is the normal case, not an edge case: the endpoint is
 * unauthenticated-operator-facing and returns 500 whenever Redis is
 * unreachable. Every figure therefore degrades to an em dash independently, so
 * one absent number never blanks the rest, and the card stays rendered (and
 * still links) when the whole request fails.
 *
 * Accessibility:
 *   - The card is one link, so its accessible name carries the headline status
 *     rather than being four separate stops.
 *   - Figures are laid out as a description list, so a screen reader announces
 *     "Queue depth, 4" rather than two unlabelled numbers.
 *   - aria-busy while loading; a polite status region reports the outcome,
 *     including when figures are unavailable.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle } from 'lucide-react';

import { cn } from '../../lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const POLL_MS = 30000;

/** Render a count, or an em dash when the backend did not supply one. */
function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : '—';
}

/** Render a duration in ms, or an em dash when there is no backlog to age. */
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Pull the four figures out of the stats payload without assuming the shape.
 * A field that is absent reads as `undefined`, which the formatters turn into
 * an em dash, so this never throws on a partial or older response.
 */
function readFigures(stats) {
  const main = stats?.mainQueue ?? {};
  const dlq = stats?.deadLetterQueue ?? {};
  const metrics = stats?.metrics ?? {};
  // An explicit `null` age is meaningful: the backend sends null when a queue
  // has nothing waiting, i.e. a genuine all-clear. Falling back on `??` would
  // read that as "field absent" and substitute a stale per-queue age, so only an
  // actually-missing field falls through.
  const oldestAgeMs =
    stats?.oldestJobAgeMs !== undefined
      ? stats.oldestJobAgeMs
      : main.oldestWaitingJobAgeMs;
  return {
    depth: main.waitingJobs,
    failed: main.failed ?? metrics.failedJobs,
    deadLetter: dlq.waitingJobs ?? metrics.deadLetterCount,
    oldestAgeMs,
    processing: main.activeJobs,
  };
}

export default function QueueHealthCard() {
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/queues/stats`);
      if (!res.ok) throw new Error(`stats request failed (${res.status})`);
      setStats(await res.json());
      setError('');
      setStatus('ready');
    } catch (err) {
      // Keep the card rendered: an unreachable queue backend is precisely the
      // condition an operator needs to see on the dashboard, not a blank space.
      setError(err.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
    const intervalId = setInterval(load, POLL_MS);
    return () => clearInterval(intervalId);
  }, [load]);

  const { depth, failed, deadLetter, oldestAgeMs, processing } = readFigures(stats);
  const busy = status === 'loading';
  const unavailable = status === 'error';

  // Headline for the link's accessible name: the one number that decides
  // whether anyone needs to click through.
  const headline = unavailable
    ? 'Queue health: unavailable'
    : `Queue health: ${formatCount(depth)} waiting`;

  return (
    <Link
      href="/admin/queues"
      aria-label={headline}
      aria-busy={busy}
      className={cn(
        'card group block no-underline transition-all duration-200',
        'hover:border-indigo-500/50',
        unavailable && 'border-rose-500/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {unavailable ? (
            <AlertTriangle
              aria-hidden="true"
              className="h-5 w-5 shrink-0 text-rose-500"
            />
          ) : (
            <Activity
              aria-hidden="true"
              className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400"
            />
          )}
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-50">
            Queue health
          </h3>
        </div>
        <span className="text-xs text-indigo-600 group-hover:text-indigo-500 dark:text-indigo-400">
          View queue →
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-600 dark:text-gray-400">
            Depth
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-50">
            {formatCount(depth)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-600 dark:text-gray-400">
            Failed
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-50">
            {formatCount(failed)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-600 dark:text-gray-400">
            Dead letter
          </dt>
          <dd
            className={cn(
              'mt-1 text-2xl font-semibold',
              typeof deadLetter === 'number' && deadLetter > 0
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-900 dark:text-gray-50',
            )}
          >
            {formatCount(deadLetter)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wider text-gray-600 dark:text-gray-400">
            Oldest job
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-50">
            {formatDuration(oldestAgeMs)}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        {unavailable
          ? `Queue metrics unavailable — ${error}`
          : `${formatCount(processing)} processing now`}
      </p>

      {/* Announce the outcome without stealing focus from the dashboard. */}
      <p className="sr-only" role="status" aria-live="polite">
        {unavailable
          ? 'Queue metrics are unavailable.'
          : `Queue depth ${formatCount(depth)}, ${formatCount(failed)} failed, ` +
            `${formatCount(deadLetter)} dead letter, oldest job ` +
            `${formatDuration(oldestAgeMs)} old.`}
      </p>
    </Link>
  );
}
