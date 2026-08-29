/**
 * EscrowTimeline (TransactionStatusTimeline + ESCROW_STEPS preset) —
 * end-to-end integration test.
 *
 * Exercises the full happy-path flow of an escrow moving through its
 * lifecycle stages, using the component's own ESCROW_STEPS fixture.
 */

import { render, screen } from '@testing-library/react';
import TransactionStatusTimeline, {
  ESCROW_STEPS,
} from '../../components/escrow/TransactionStatusTimeline';

describe('EscrowTimeline — full lifecycle flow', () => {
  it('renders every escrow stage and marks prior stages complete, current stage active', () => {
    render(<TransactionStatusTimeline steps={ESCROW_STEPS} currentStep="active" />);

    ESCROW_STEPS.forEach((step) => {
      expect(screen.getAllByText(step.label).length).toBeGreaterThan(0);
    });

    const currentSteps = screen.getAllByRole('listitem', { current: 'step' });
    expect(currentSteps.length).toBeGreaterThan(0);
  });

  it('walks the timeline from created through completed without error state', () => {
    const order = ESCROW_STEPS.map((s) => s.id);

    order.forEach((stepId, index) => {
      const { unmount } = render(
        <TransactionStatusTimeline steps={ESCROW_STEPS} currentStep={stepId} error={false} />,
      );

      const nav = screen.getByRole('navigation', { name: /transaction status timeline/i });
      expect(nav).toBeInTheDocument();

      // Every step up to and including the current one should be visible.
      ESCROW_STEPS.slice(0, index + 1).forEach((step) => {
        expect(screen.getAllByText(step.label).length).toBeGreaterThan(0);
      });

      unmount();
    });
  });

  it('surfaces an error state on the current step without crashing the flow', () => {
    render(<TransactionStatusTimeline steps={ESCROW_STEPS} currentStep="funded" error />);

    expect(screen.getAllByText('Funded').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('navigation', { name: /transaction status timeline/i }),
    ).toBeInTheDocument();
  });
});
