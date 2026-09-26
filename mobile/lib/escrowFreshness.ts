export function getEscrowDeadlineState(deadline?: string | null, now = new Date()) {
  if (!deadline) return { isExpired: false, label: null };

  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime())) {
    return { isExpired: false, label: 'Deadline unavailable' };
  }

  if (parsed.getTime() <= now.getTime()) {
    return { isExpired: true, label: `Expired ${parsed.toLocaleDateString()}` };
  }

  return { isExpired: false, label: `Due ${parsed.toLocaleDateString()}` };
}

export function getCacheFreshnessLabel(cachedAt?: string | number | Date | null, now = new Date()) {
  if (!cachedAt) return null;

  const cachedTime = new Date(cachedAt).getTime();
  if (Number.isNaN(cachedTime)) return null;

  const ageMinutes = Math.max(0, Math.floor((now.getTime() - cachedTime) / 60000));
  if (ageMinutes < 1) return 'Synced just now';
  return `Offline cache: ${ageMinutes}m old`;
}
