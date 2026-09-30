import { render, screen, within, waitFor, act } from '@testing-library/react';
import QueueHealthCard from '@/components/admin/QueueHealthCard';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A response shaped like the real /admin/queues/stats payload. */
function fullStats() {
  return {
    timestamp: '2026-09-29T12:00:00.000Z',
    oldestJobAgeMs: 900_000,
    metrics: { totalJobs: 120, failedJobs: 5, deadLetterCount: 2 },
    mainQueue: { waitingJobs: 4, activeJobs: 1, failed: 5, oldestWaitingJobAgeMs: 5_000 },
    deadLetterQueue: { waitingJobs: 2, activeJobs: 0 },
  };
}

function mockStatsOk(body = fullStats()) {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) }),
  );
}

function mockStatsHttpError(status = 500) {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status }));
}

function mockStatsNetworkError() {
  global.fetch = jest.fn(() => Promise.reject(new Error('network error')));
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueueHealthCard', () => {
  it('renders the heading and links to the queue page', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);

    const link = await screen.findByRole('link', { name: /queue health/i });
    expect(link).toHaveAttribute('href', '/admin/queues');
    expect(within(link).getByRole('heading', { name: /queue health/i })).toBeInTheDocument();
  });

  it('summarises depth, failed, dead-letter and oldest job age', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);

    expect(await screen.findByText('4')).toBeInTheDocument(); // depth
    expect(screen.getByText('5')).toBeInTheDocument(); // failed
    expect(screen.getByText('2')).toBeInTheDocument(); // dead letter
    // 900000ms -> 15m 0s
    expect(screen.getByText('15m 0s')).toBeInTheDocument();
  });

  it('labels each figure so the numbers are not unlabelled', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);

    // Each figure has a visible term label, so no number is unlabelled.
    for (const term of ['Depth', 'Failed', 'Dead letter', 'Oldest job']) {
      expect(await screen.findByText(term)).toBeInTheDocument();
    }
  });

  it('gives the link an accessible name carrying the headline figure', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);

    // One link, not four: the name should say what the operator needs to know
    // without visiting each number.
    expect(await screen.findByRole('link', { name: 'Queue health: 4 waiting' })).toBeInTheDocument();
  });

  it('shows how many jobs are processing', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);

    expect(await screen.findByText(/1 processing now/i)).toBeInTheDocument();
  });

  it('announces the figures politely once loaded', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);

    await waitFor(() => {
      expect(
        screen.getByText(/queue depth 4, 5 failed, 2 dead letter, oldest job 15m 0s old/i),
      ).toBeInTheDocument();
    });
  });
});

describe('QueueHealthCard — missing metrics', () => {
  it('degrades each absent figure to an em dash independently', async () => {
    // An older backend that reports none of the new fields.
    mockStatsOk({ metrics: {}, mainQueue: {}, deadLetterQueue: {} });
    render(<QueueHealthCard />);

    await waitFor(() => {
      expect(screen.getAllByText('—').length).toBe(4);
    });
    // Still renders, and still links.
    expect(screen.getByRole('link', { name: /queue health/i })).toHaveAttribute(
      'href',
      '/admin/queues',
    );
  });

  it('keeps known figures when only the age is missing', async () => {
    // Both age sources absent: the headline field and the per-queue fallback.
    const stats = fullStats();
    delete stats.oldestJobAgeMs;
    delete stats.mainQueue.oldestWaitingJobAgeMs;
    mockStatsOk(stats);
    render(<QueueHealthCard />);

    // Depth/failed/dead-letter survive; only the age is unknown.
    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(1);
  });

  it('falls back to the per-queue age when the headline field is absent', async () => {
    const stats = fullStats();
    delete stats.oldestJobAgeMs;
    mockStatsOk(stats); // mainQueue.oldestWaitingJobAgeMs is 5000
    render(<QueueHealthCard />);

    // 5000ms from the per-queue field, not a dash and not the stale headline.
    expect(await screen.findByText('5s')).toBeInTheDocument();
  });

  it('falls back to the in-process metric when the queue count is absent', async () => {
    // `mainQueue.failed` missing, but `metrics.failedJobs` present.
    mockStatsOk({ ...fullStats(), mainQueue: { waitingJobs: 4, activeJobs: 1 } });
    render(<QueueHealthCard />);

    expect(await screen.findByText('5')).toBeInTheDocument();
  });

  it('shows an em dash for age when nothing is waiting', async () => {
    // The backend sends null when there is no backlog — a real "all clear", not
    // a missing value. It must render as a dash rather than 0ms, and it must not
    // be overridden by the per-queue field.
    const stats = fullStats();
    stats.oldestJobAgeMs = null;
    stats.mainQueue.waitingJobs = 0;
    stats.mainQueue.oldestWaitingJobAgeMs = 5000; // stale, must be ignored
    stats.deadLetterQueue.waitingJobs = 0;
    mockStatsOk(stats);
    render(<QueueHealthCard />);

    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
    expect(screen.queryByText('5s')).not.toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('formats sub-minute, minute, hour and day scales', async () => {
    mockStatsOk({ ...fullStats(), oldestJobAgeMs: 500 });
    const { unmount } = render(<QueueHealthCard />);
    expect(await screen.findByText('500ms')).toBeInTheDocument();
    unmount();

    mockStatsOk({ ...fullStats(), oldestJobAgeMs: 45_000 });
    const b = render(<QueueHealthCard />);
    expect(await screen.findByText('45s')).toBeInTheDocument();
    b.unmount();

    mockStatsOk({ ...fullStats(), oldestJobAgeMs: 3_600_000 });
    const c = render(<QueueHealthCard />);
    expect(await screen.findByText('1h 0m')).toBeInTheDocument();
    c.unmount();

    mockStatsOk({ ...fullStats(), oldestJobAgeMs: 90_000_000 });
    render(<QueueHealthCard />);
    expect(await screen.findByText('1d 1h')).toBeInTheDocument();
  });
});

describe('QueueHealthCard — failure handling', () => {
  it('keeps the card and link when the endpoint returns an error status', async () => {
    mockStatsHttpError(500);
    render(<QueueHealthCard />);

    const link = await screen.findByRole('link', { name: /queue health: unavailable/i });
    expect(link).toHaveAttribute('href', '/admin/queues');
    expect(screen.getAllByText('—').length).toBe(4);
  });

  it('keeps the card when the request rejects outright', async () => {
    mockStatsNetworkError();
    render(<QueueHealthCard />);

    expect(
      await screen.findByRole('link', { name: /queue health: unavailable/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/queue metrics unavailable/i)).toBeInTheDocument();
  });

  it('announces unavailability politely', async () => {
    mockStatsNetworkError();
    render(<QueueHealthCard />);

    await waitFor(() => {
      expect(screen.getByText(/queue metrics are unavailable/i)).toBeInTheDocument();
    });
  });

  it('recovers on the next poll after a failure', async () => {
    let call = 0;
    global.fetch = jest.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('network error'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fullStats()) });
    });

    // Fake timers must be installed before render so the poll interval is the
    // fake one, and the tick is advanced inside act() so the fetch settles.
    jest.useFakeTimers();
    try {
      render(<QueueHealthCard />);

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('link', { name: /queue health: unavailable/i })).toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
      });

      expect(screen.getByRole('link', { name: 'Queue health: 4 waiting' })).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
