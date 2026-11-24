import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TestProviders from '../TestProviders';
import BudgetSummary from './BudgetSummary';

function renderSummary(summary) {
  render(<TestProviders><BudgetSummary summary={summary} /></TestProviders>);
  return screen.getByRole('region', { name: 'Budget summary' });
}

/** The figure shown for a term in the summary's definition list. */
function figure(region, term) {
  const dt = within(region).getByText(term, { selector: 'dt' });
  return dt.nextElementSibling.textContent;
}

describe('BudgetSummary', () => {
  it('shows planned, spent, remaining and percent used within budget', () => {
    const region = renderSummary({
      planned: 200000, spent: 50000, remaining: 150000, percent_used: 25,
    });

    expect(figure(region, 'Planned')).toBe('$200,000');
    expect(figure(region, 'Spent')).toBe('$50,000');
    expect(figure(region, 'Remaining')).toBe('$150,000');
    expect(figure(region, 'Used')).toBe('25%');
    const bar = within(region).getByRole('progressbar', { name: 'Budget used' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(bar).toHaveAttribute('aria-valuetext', '$50,000 of $200,000 (25%)');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(region).queryByText('Over budget')).not.toBeInTheDocument();
  });

  it('shows the over-budget state: overspend, red bar, chip and alert', () => {
    const region = renderSummary({
      planned: 100000, spent: 120000.5, remaining: -20000.5, percent_used: 120,
    });

    expect(within(region).queryByText('Remaining', { selector: 'dt' })).not.toBeInTheDocument();
    expect(figure(region, 'Overspent')).toBe('$20,000.50');
    expect(figure(region, 'Used')).toBe('120%');
    expect(within(region).getByText('Over budget')).toBeInTheDocument();
    expect(within(region).getByRole('alert'))
      .toHaveTextContent('Over budget by $20,000.50: 120% of the planned $100,000 is spent.');
    const bar = within(region).getByRole('progressbar', { name: 'Budget used' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar.className).toMatch(/colorOverdue/);
  });

  it('treats exactly the planned amount as on budget', () => {
    const region = renderSummary({ planned: 1000, spent: 1000, remaining: 0, percent_used: 100 });
    expect(figure(region, 'Remaining')).toBe('$0');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when no budget is planned', () => {
    const region = renderSummary({ planned: 0, spent: 0, remaining: 0, percent_used: null });
    expect(figure(region, 'Used')).toBe('—');
    expect(within(region).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(region).getByText('No budget is planned for this project yet.')).toBeInTheDocument();
  });

  it('flags spending without a planned budget as over budget', () => {
    const region = renderSummary({ planned: 0, spent: 5000, remaining: -5000, percent_used: null });
    expect(within(region).getByText('Over budget')).toBeInTheDocument();
    expect(within(region).getByRole('alert'))
      .toHaveTextContent('No budget is planned for this project, but $5,000 has been spent.');
  });
});
