import { storage } from '../lib/storage';

const QUEUE_KEY = 'pending_transaction_submissions';

export type PendingTransactionSubmission = {
  id: string;
  signedXdr: string;
  intent: string;
  createdAt: string;
  retryCount: number;
  lastError?: string;
};

export function getPendingTransactionSubmissions(): PendingTransactionSubmission[] {
  const raw = storage.getString(QUEUE_KEY);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as PendingTransactionSubmission[];
  } catch {
    storage.delete(QUEUE_KEY);
    return [];
  }
}

export function enqueueTransactionSubmission(
  submission: Omit<PendingTransactionSubmission, 'createdAt' | 'retryCount'>,
): PendingTransactionSubmission[] {
  const queue = getPendingTransactionSubmissions();
  const next = [
    ...queue.filter((item) => item.id !== submission.id),
    {
      ...submission,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    },
  ];

  storage.set(QUEUE_KEY, JSON.stringify(next));
  return next;
}

export function markTransactionSubmissionAttempt(
  id: string,
  lastError?: string,
): PendingTransactionSubmission[] {
  const next = getPendingTransactionSubmissions().map((item) =>
    item.id === id ? { ...item, retryCount: item.retryCount + 1, lastError } : item,
  );
  storage.set(QUEUE_KEY, JSON.stringify(next));
  return next;
}

export function removeTransactionSubmission(id: string): PendingTransactionSubmission[] {
  const next = getPendingTransactionSubmissions().filter((item) => item.id !== id);
  storage.set(QUEUE_KEY, JSON.stringify(next));
  return next;
}
