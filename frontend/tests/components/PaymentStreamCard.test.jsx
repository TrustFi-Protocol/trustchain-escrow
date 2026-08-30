import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import PaymentStreamCard from '@/components/PaymentStreamCard';

// Mock dependecies
jest.mock('next/link', () => ({ children, href }) => <a href={href}>{children}</a>);
jest.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key) => key,
  }),
}));
jest.mock('@/components/ui/Badge', () => ({ children, variant }) => (
  <span data-testid="badge" data-variant={variant}>
    {children}
  </span>
));
jest.mock('@/components/ui/CurrencyAmount', () => ({ amount, symbol }) => (
  <span data-testid="currency-amount">
    {amount} {symbol}
  </span>
));
jest.mock('@/components/ui/CopyButton', () => ({ text }) => (
  <button data-testid="copy-button" data-text={text}>
    Copy
  </button>
));

describe('PaymentStreamCard', () => {
  const mockStream = {
    id: 'stream_1234567890abcdef',
    sender: 'GA2C5V43MW62A9B26771694',
    recipient: 'GB18083827112048202948',
    tokenSymbol: 'USDC',
    totalDeposit: 1000,
    withdrawnAmount: 250,
    remainingAmount: 750,
    ratePerSecond: 0.005,
    status: 'active',
    startTime: '2026-08-01T00:00:00Z',
    endTime: '2026-09-01T00:00:00Z',
  };

  it('renders stream details correctly', () => {
    render(<PaymentStreamCard stream={mockStream} />);

    expect(screen.getByText('#stream_1...cdef')).toBeInjestDom || expect(screen.getByText(/stream_1/i)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument(); // progress percentage
  });

  it('handles null or undefined stream gracefully without crashing', () => {
    const { container } = render(<PaymentStreamCard stream={null} />);
    expect(container).toHaveTextContent('paymentStream.noData');
  });

  /**
   * Regression Test:
   * Checks that numeric 0 for remainingAmount or withdrawnAmount is accurately rendered as 0,
   * avoiding accidental fallbacks caused by truthy check !value bugs.
   */
  it('correctly displays zero values for remainingAmount and withdrawnAmount', () => {
    const zeroValueStream = {
      ...mockStream,
      totalDeposit: 500,
      withdrawnAmount: 0,
      remainingAmount: 0,
      ratePerSecond: 0,
    };

    render(<PaymentStreamCard stream={zeroValueStream} />);

    const currencyElements = screen.getAllByTestId('currency-amount');
    // totalDeposit = 500, withdrawnAmount = 0, remainingAmount = 0
    expect(currencyElements[1]).toHaveTextContent('0 USDC');
    expect(currencyElements[2]).toHaveTextContent('0 USDC');
  });

  it('correctly maps various stream statuses', () => {
    const { rerender } = render(
      <PaymentStreamCard stream={{ ...mockStream, status: 'paused' }} />
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();

    rerender(<PaymentStreamCard stream={{ ...mockStream, status: 'completed' }} />);
    expect(screen.getByText('Completed')).toBeInTheDocument();

    rerender(<PaymentStreamCard stream={{ ...mockStream, status: 'cancelled' }} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
});