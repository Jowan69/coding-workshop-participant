import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TestProviders from '../TestProviders';
import StatusChip from './StatusChip';

function renderChip(status) {
  const { container, unmount } = render(<TestProviders><StatusChip status={status} /></TestProviders>);
  return { chip: container.querySelector('.MuiChip-root'), unmount };
}

describe('StatusChip health mapping', () => {
  it.each([
    ['on_track', 'On track', 'MuiChip-colorOnTrack', 'TrendingUpIcon'],
    ['at_risk', 'At risk', 'MuiChip-colorAtRisk', 'WarningAmberIcon'],
    ['overdue', 'Overdue', 'MuiChip-colorOverdue', 'ReportIcon'],
  ])('shows %s as "%s" with its own colour and icon', (health, label, colorClass, icon) => {
    const { chip } = renderChip(health);
    expect(chip).toHaveTextContent(label);
    expect(chip).toHaveClass(colorClass);
    expect(chip.querySelector(`[data-testid="${icon}"]`)).toBeInTheDocument();
  });

  it('never shows two health values in the same colour', () => {
    const colours = ['on_track', 'at_risk', 'overdue'].map((health) => {
      const { chip, unmount } = renderChip(health);
      const colour = [...chip.classList].find((name) => name.startsWith('MuiChip-color'));
      unmount();
      return colour;
    });
    expect(new Set(colours).size).toBe(3);
  });

  it('falls back to a neutral chip labelled from the key for an unknown value', () => {
    const { chip } = renderChip('mystery_state');
    expect(chip).toHaveTextContent('mystery state');
    expect(chip).toHaveClass('MuiChip-colorDefault');
    expect(chip.querySelector('svg')).not.toBeInTheDocument();
  });
});
