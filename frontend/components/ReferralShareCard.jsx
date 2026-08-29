'use client';

/**
 * ReferralShareCard — Card showing a user's referral link/code with quick
 * share actions (copy link, share via native share sheet, dismiss).
 *
 * Accessibility notes:
 * - Every interactive element is a real <button> so it is focusable and
 *   operable via Enter/Space without extra key handlers.
 * - The card container listens for Escape to dismiss, mirroring the
 *   pattern used in NotificationCenter.jsx.
 * - Tab order follows DOM order (copy -> share -> dismiss); no positive
 *   tabIndex values are used, so focus order stays predictable.
 * - Focus rings use the same focus-visible utility classes as the rest of
 *   the app (see DarkModeToggle.jsx) so keyboard focus is always visible.
 */

import { useCallback, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * @param {object} props
 * @param {string} props.referralCode - The user's referral code, e.g. "ABC123".
 * @param {string} props.referralUrl - Full shareable referral URL.
 * @param {Function} [props.onDismiss] - Called when the card is dismissed (click or Escape).
 * @param {string} [props.className] - Additional class names for the outer card.
 * @returns {JSX.Element} The referral share card.
 */
export default function ReferralShareCard({ referralCode, referralUrl, onDismiss, className }) {
  const [copied, setCopied] = useState(false);
  const cardRef = useRef(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [referralUrl]);

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join me on TrustChain Escrow', url: referralUrl });
      } catch {
        // user cancelled the native share sheet — no-op
      }
    } else {
      handleCopy();
    }
  }, [referralUrl, handleCopy]);

  const handleDismiss = useCallback(() => {
    onDismiss?.();
  }, [onDismiss]);

  const handleCardKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleDismiss();
      }
    },
    [handleDismiss],
  );

  const focusRing =
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900';

  return (
    <div
      ref={cardRef}
      role="region"
      aria-label="Referral sharing"
      onKeyDown={handleCardKeyDown}
      className={cn(
        'relative rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm',
        className,
      )}
    >
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss referral card"
        className={cn(
          'absolute right-2 top-2 rounded-full p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300',
          focusRing,
        )}
      >
        <span aria-hidden="true">✕</span>
      </button>

      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Invite a friend</h3>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Share your referral link and you&apos;ll both earn a fee credit on your next escrow.
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-300">
          {referralUrl}
        </code>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            'inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700',
            focusRing,
          )}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        <button
          type="button"
          onClick={handleShare}
          className={cn(
            'inline-flex items-center rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800',
            focusRing,
          )}
        >
          Share
        </button>
      </div>

      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        Referral code: <span className="font-mono">{referralCode}</span>
      </p>
    </div>
  );
}
