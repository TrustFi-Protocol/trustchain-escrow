import { render, screen } from '@testing-library/react';
import KycStatusBanner from '../../components/KycStatusBanner';

describe('KycStatusBanner', () => {
  it('renders the happy path for an Approved status', () => {
    render(<KycStatusBanner status="Approved" />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(/identity has been verified/i)).toBeInTheDocument();
  });

  it('renders a Pending fallback when status is empty string', () => {
    render(<KycStatusBanner status="" />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/Start verification to unlock/i)).toBeInTheDocument();
  });

  it('renders a Pending fallback when status is undefined', () => {
    render(<KycStatusBanner />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('renders a Pending fallback when status is null', () => {
    render(<KycStatusBanner status={null} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('falls back gracefully for malformed (non-string) status data', () => {
    render(<KycStatusBanner status={{ unexpected: 'object' }} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('falls back gracefully for an unrecognized status string', () => {
    render(<KycStatusBanner status="TotallyUnknownStatus" />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('renders the unhappy path error message instead of the status message when error is set', () => {
    render(<KycStatusBanner status="Declined" error="Network request failed. Please retry." />);
    expect(screen.getByText('Declined')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Network request failed. Please retry.');
    expect(screen.queryByText(/Verification was declined/i)).not.toBeInTheDocument();
  });

  it('renders the banner container with a stable test id for layout/regression checks', () => {
    render(<KycStatusBanner status="Processing" />);
    expect(screen.getByTestId('kyc-status-banner')).toBeInTheDocument();
  });
});
