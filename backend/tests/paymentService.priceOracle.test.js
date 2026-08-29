/**
 * paymentService.getXlmUsdPrice — Edge Case Unit Tests
 *
 * This is the closest real equivalent to a "price oracle" in this codebase
 * (backend/services/priceOracleService.js doesn't exist) — it fetches the
 * current XLM/USD spot price from the Stellar DEX order book via Horizon.
 * Only the happy path was ever exercised indirectly (through
 * paymentController.authz.test.js's mocked service layer); this adds
 * focused tests for empty input, malformed data, and the unhappy path
 * directly against the real function (issue #97).
 *
 * @module tests/paymentService.priceOracle
 */

import { jest } from '@jest/globals';

const { getXlmUsdPrice } = await import('../services/paymentService.js');

function mockFetchResolved(body, ok = true, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  });
}

describe('getXlmUsdPrice', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the best bid price on a well-formed response (happy path)', async () => {
    mockFetchResolved({ bids: [{ price: '0.115' }] });

    const price = await getXlmUsdPrice();

    expect(price).toBe(0.115);
  });

  it('throws when Horizon responds with a non-ok status', async () => {
    mockFetchResolved({}, false, 503);

    await expect(getXlmUsdPrice()).rejects.toThrow('Failed to fetch XLM price');
  });

  it('throws when the order book has no bids (empty array)', async () => {
    mockFetchResolved({ bids: [] });

    await expect(getXlmUsdPrice()).rejects.toThrow('No bids in order book');
  });

  it('throws when the response has no bids field at all (malformed data)', async () => {
    mockFetchResolved({});

    await expect(getXlmUsdPrice()).rejects.toThrow('No bids in order book');
  });

  it('throws when bids is null (malformed data)', async () => {
    mockFetchResolved({ bids: null });

    await expect(getXlmUsdPrice()).rejects.toThrow('No bids in order book');
  });

  it('propagates a network-level rejection from fetch (unhappy path)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network unreachable'));

    await expect(getXlmUsdPrice()).rejects.toThrow('network unreachable');
  });

  it('returns NaN when the bid price field is present but not numeric (malformed data)', async () => {
    // Documents current behavior: parseFloat on a non-numeric price silently
    // yields NaN rather than throwing — callers that don't guard against
    // this (e.g. dividing a USD amount by the price) would produce NaN
    // downstream, not a caught error.
    mockFetchResolved({ bids: [{ price: 'not-a-number' }] });

    const price = await getXlmUsdPrice();

    expect(price).toBeNaN();
  });
});
