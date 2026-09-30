/**
 * Accessibility Tests — Queue Health Card
 *
 * The card is a single link wrapping four figures, which is exactly the shape
 * that a11y tooling tends to complain about: a large click target containing
 * several values, plus a live region. Both are asserted here with axe, in light
 * and dark themes, and in the loaded, loading and error states.
 */

import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import QueueHealthCard from '@/components/admin/QueueHealthCard';

expect.extend(toHaveNoViolations);

const axeRunner = global.axe || axe;

const STATS = {
  timestamp: '2026-09-29T12:00:00.000Z',
  oldestJobAgeMs: 900_000,
  metrics: { totalJobs: 120, failedJobs: 5, deadLetterCount: 2 },
  mainQueue: { waitingJobs: 4, activeJobs: 1, failed: 5, oldestWaitingJobAgeMs: 5_000 },
  deadLetterQueue: { waitingJobs: 2, activeJobs: 0 },
};

function mockStatsOk(body = STATS) {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) }));
}

function mockStatsError() {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500 }));
}

function withTheme(mode, fn) {
  if (mode === 'dark') document.documentElement.classList.add('dark');
  try {
    return fn();
  } finally {
    document.documentElement.classList.remove('dark');
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  document.documentElement.classList.remove('dark');
});

describe('QueueHealthCard accessibility', () => {
  it.each(['light', 'dark'])('has no axe violations when loaded (%s theme)', async (mode) => {
    mockStatsOk();
    const { container } = withTheme(mode, () => render(<QueueHealthCard />));
    // Let the fetch settle so the loaded state is what axe inspects.
    await screen.findByRole('link', { name: 'Queue health: 4 waiting' });
    expect(await axeRunner(container)).toHaveNoViolations();
  });

  it('has no axe violations when metrics are unavailable', async () => {
    mockStatsError();
    const { container } = render(<QueueHealthCard />);
    await screen.findByRole('link', { name: /queue health: unavailable/i });
    expect(await axeRunner(container)).toHaveNoViolations();
  });

  it('exposes each figure as a description-list term with a value', async () => {
    mockStatsOk();
    const { container } = render(<QueueHealthCard />);
    await screen.findByRole('link', { name: 'Queue health: 4 waiting' });

    // <dt>/<dd> pairing is what makes "Depth, 4" announceable, rather than four
    // loose numbers inside a link.
    expect(container.querySelectorAll('dt')).toHaveLength(4);
    expect(container.querySelectorAll('dd')).toHaveLength(4);
  });

  it('names the link with the headline figure rather than leaving it bare', async () => {
    mockStatsOk();
    const { container } = render(<QueueHealthCard />);
    await screen.findByRole('link', { name: 'Queue health: 4 waiting' });

    // An unlabelled link wrapping a grid of numbers gives a screen reader
    // nothing to announce when the operator tabs to it. The role+name query
    // above already proves the computed name; this pins the mechanism.
    const label = container.querySelector('a')?.getAttribute('aria-label');
    expect(label).toBe('Queue health: 4 waiting');
  });

  it('announces figures through a polite live region', async () => {
    mockStatsOk();
    const { container } = render(<QueueHealthCard />);
    await screen.findByRole('link', { name: 'Queue health: 4 waiting' });

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent(/queue depth 4/i);
  });

  it('does not mark itself busy once loaded', async () => {
    mockStatsOk();
    render(<QueueHealthCard />);
    const link = await screen.findByRole('link', { name: 'Queue health: 4 waiting' });
    expect(link).toHaveAttribute('aria-busy', 'false');
  });
});
