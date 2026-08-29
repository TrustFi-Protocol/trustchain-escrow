import { screen, fireEvent, waitFor } from '@testing-library/react';
import DisputeModal from '../../../components/escrow/DisputeModal';
import { renderWithAppProviders } from '../../test-utils';
import { buildRaiseDisputeTx, broadcastTransaction } from '../../../lib/stellar';

const mockUseWallet = jest.fn();
jest.mock('../../../hooks/useWallet', () => ({
  useWallet: () => mockUseWallet(),
}));

jest.mock('../../../lib/stellar', () => ({
  buildRaiseDisputeTx: jest.fn(),
  broadcastTransaction: jest.fn(),
}));

const CONNECTED_ADDRESS = 'GA5DTCACZO4727N6LG5L3A54WQENY73CFESY2GLSKM5X6XEMY6IOJGUI';

describe('DisputeModal', () => {
  const defaultProps = { isOpen: true, onClose: jest.fn(), escrowId: 42 };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWallet.mockReturnValue({
      address: CONNECTED_ADDRESS,
      signTx: jest.fn().mockResolvedValue('signed-xdr'),
    });
  });

  it('renders nothing when isOpen is false', () => {
    renderWithAppProviders(<DisputeModal isOpen={false} onClose={jest.fn()} escrowId={1} />);
    expect(screen.queryByText('Raise Dispute')).not.toBeInTheDocument();
  });

  it('renders modal when isOpen is true', () => {
    renderWithAppProviders(<DisputeModal {...defaultProps} />);
    expect(screen.getByText('Raise Dispute')).toBeInTheDocument();
  });

  it('shows escrow ID in header', () => {
    renderWithAppProviders(<DisputeModal {...defaultProps} />);
    expect(screen.getByText('Escrow #42')).toBeInTheDocument();
  });

  it('shows warning about freezing funds', () => {
    renderWithAppProviders(<DisputeModal {...defaultProps} />);
    expect(screen.getByText(/freeze all funds/)).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = jest.fn();
    renderWithAppProviders(<DisputeModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = jest.fn();
    const { container } = renderWithAppProviders(
      <DisputeModal {...defaultProps} onClose={onClose} />,
    );
    const backdrop = container.querySelector('.absolute.inset-0');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('allows typing in reason textarea', () => {
    renderWithAppProviders(<DisputeModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Describe the issue/);
    fireEvent.change(textarea, { target: { value: 'Work was not delivered' } });
    expect(textarea).toHaveValue('Work was not delivered');
  });

  // Issue #96: the two tests that used to occupy this space ("shows error
  // message when submission fails" / "shows error and re-enables buttons
  // after failed submission") never actually submitted anything — they just
  // re-asserted the buttons render. Replaced with a real happy-path
  // submission and a real failure-path submission below.

  it('builds, signs, and broadcasts the dispute transaction, then closes on success (happy path)', async () => {
    buildRaiseDisputeTx.mockResolvedValue('unsigned-xdr');
    broadcastTransaction.mockResolvedValue({ hash: 'tx-hash-123' });

    const onClose = jest.fn();
    const onSuccess = jest.fn();
    renderWithAppProviders(
      <DisputeModal {...defaultProps} onClose={onClose} onSuccess={onSuccess} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Describe the issue/), {
      target: { value: 'Work was not delivered' },
    });
    fireEvent.click(screen.getByText('Confirm Dispute'));

    await waitFor(() => {
      expect(buildRaiseDisputeTx).toHaveBeenCalledWith({
        sourceAddress: CONNECTED_ADDRESS,
        escrowId: '42',
      });
    });
    await waitFor(() => expect(broadcastTransaction).toHaveBeenCalledWith('signed-xdr'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and does not close when broadcasting fails (unhappy path)', async () => {
    buildRaiseDisputeTx.mockResolvedValue('unsigned-xdr');
    broadcastTransaction.mockRejectedValue(new Error('Simulation failed: insufficient balance'));

    const onClose = jest.fn();
    renderWithAppProviders(<DisputeModal {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('Confirm Dispute'));

    expect(await screen.findByText('Simulation failed: insufficient balance')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // The button must be re-enabled, not stuck on the pending label.
    expect(screen.getByText('Confirm Dispute')).toBeInTheDocument();
  });

  it('shows an inline error immediately when no wallet is connected (unhappy path)', async () => {
    mockUseWallet.mockReturnValue({ address: null, signTx: jest.fn() });

    renderWithAppProviders(<DisputeModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Confirm Dispute'));

    expect(await screen.findByText('Please connect your wallet first')).toBeInTheDocument();
    expect(buildRaiseDisputeTx).not.toHaveBeenCalled();
  });
});
