export class BoundedRetentionStore {
  constructor(limit = 1000, { onEvict } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('retention limit must be a positive integer');
    this.limit = limit;
    this.onEvict = onEvict;
    this.entries = new Map();
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const [oldestKey, oldestValue] = this.entries.entries().next().value;
      this.entries.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestValue);
    }
  }

  get(key) { return this.entries.get(key); }

  delete(key) { return this.entries.delete(key); }

  get size() { return this.entries.size; }
}

export function createSingleFlight() {
  const pending = new Map();
  return async (key, work) => {
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(work).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}

export async function gracefullyDegrade(work, fallback) {
  try { return await work(); } catch { return typeof fallback === 'function' ? fallback() : fallback; }
}
