import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import FilterBar from './FilterBar';

const FILTERS = [
  { name: 'category', label: 'Category', options: [{ value: 'labor', label: 'Labor' }] },
  { name: 'spent_from', label: 'From', type: 'date' },
];

function renderBar(entry = '/budget?tab=budget') {
  return render(
    <TestProviders initialEntries={[entry]}>
      <FilterBar filters={FILTERS} />
      <LocationProbe />
    </TestProviders>,
  );
}

describe('FilterBar', () => {
  it('writes date filters to the URL and clears only its own params', async () => {
    const user = userEvent.setup();
    renderBar();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-02-01' } });
    expect(screen.getByTestId('location')).toHaveTextContent('/budget?tab=budget&spent_from=2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/budget\?tab=budget$/);
    expect(screen.getByLabelText('From')).toHaveValue('');
  });

  it('reads date filters from the URL', () => {
    renderBar('/budget?spent_from=2026-03-01');
    expect(screen.getByLabelText('From')).toHaveValue('2026-03-01');
  });
});
