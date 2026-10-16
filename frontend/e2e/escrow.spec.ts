import { test, expect, Page } from '@playwright/test';

/**
 * E2E coverage for expired escrow actions (issue #276).
 *
 * Seeds both an active and an expired escrow, then verifies that:
 *  - expired escrows disable invalid actions (release / dispute / cancel)
 *  - the correct expired messaging is shown
 *  - the detail view countdown renders correctly
 */

const ACTIVE_ESCROW = {
  id: 'escrow-active-001',
  title: 'Active Escrow',
  amount: '100',
  asset: 'XLM',
  status: 'active',
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
};

const EXPIRED_ESCROW = {
  id: 'escrow-expired-001',
  title: 'Expired Escrow',
  amount: '250',
  asset: 'XLM',
  status: 'expired',
  expiresAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
};

async function seedEscrows(page: Page, escrows: unknown[]) {
  await page.addInitScript((data) => {
    window.localStorage.setItem('escrows', JSON.stringify(data));
  }, escrows);
}

test.describe('Expired escrow actions', () => {
  test.beforeEach(async ({ page }) => {
    await seedEscrows(page, [ACTIVE_ESCROW, EXPIRED_ESCROW]);
  });

  test('disables invalid actions and shows messaging for expired escrows', async ({ page }) => {
    await page.goto('/escrows');

    const expiredRow = page.getByTestId(`escrow-row-${EXPIRED_ESCROW.id}`);
    await expect(expiredRow).toBeVisible();

    // Expired escrow surfaces the correct status messaging.
    await expect(expiredRow.getByTestId('escrow-status')).toHaveText(/expired/i);

    // Invalid actions are disabled for the expired escrow.
    await expect(expiredRow.getByRole('button', { name: /release/i })).toBeDisabled();
    await expect(expiredRow.getByRole('button', { name: /dispute/i })).toBeDisabled();
    await expect(expiredRow.getByRole('button', { name: /cancel/i })).toBeDisabled();

    // Active escrow keeps its actions enabled.
    const activeRow = page.getByTestId(`escrow-row-${ACTIVE_ESCROW.id}`);
    await expect(activeRow.getByRole('button', { name: /release/i })).toBeEnabled();
  });

  test('shows expired messaging and disabled actions on the detail view', async ({ page }) => {
    await page.goto(`/escrows/${EXPIRED_ESCROW.id}`);

    await expect(page.getByTestId('escrow-status')).toHaveText(/expired/i);
    await expect(page.getByTestId('expired-message')).toBeVisible();

    await expect(page.getByRole('button', { name: /release/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /dispute/i })).toBeDisabled();
  });

  test('renders the countdown on the detail view', async ({ page }) => {
    await page.goto(`/escrows/${ACTIVE_ESCROW.id}`);

    const countdown = page.getByTestId('escrow-countdown');
    await expect(countdown).toBeVisible();
    await expect(countdown).toHaveText(/\d/);
  });
});
