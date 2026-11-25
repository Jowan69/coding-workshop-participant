import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import DataList from './DataList';

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'department', label: 'Department' },
  { key: 'budget', label: 'Budget', render: (row) => `$${row.budget}` },
];

const ROWS = [
  { id: 1, name: 'Customer Portal Revamp', department: 'Digital', budget: 100 },
  { id: 2, name: 'Data Center Migration', department: null, budget: 200 },
];

function renderList(props = {}) {
  const merged = {
    columns: COLUMNS,
    rows: ROWS,
    total: 2,
    ariaLabel: 'Projects',
    emptyState: { title: 'No projects yet' },
    getRowHref: (row) => `/projects/${row.id}`,
    ...props,
  };
  return render(
    <TestProviders initialEntries={['/projects']}>
      <Routes>
        <Route path="/projects" element={<DataList {...merged} />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </TestProviders>,
  );
}

describe('DataList', () => {
  it('shows skeleton rows on the first load', () => {
    renderList({ rows: [], loading: true });
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(5);
    expect(screen.getByRole('table', { name: 'Projects' })).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps the rows on screen with a progress bar while refreshing', () => {
    renderList({ loading: true });
    expect(screen.getByRole('progressbar', { name: 'Refreshing projects' })).toBeInTheDocument();
    expect(screen.getByText('Customer Portal Revamp')).toBeInTheDocument();
  });

  it('shows the empty state with its call to action', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderList({
      rows: [],
      total: 0,
      emptyState: { title: 'No projects yet', message: 'Create one.', action: { label: 'Create project', onClick } },
    });

    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the error with a retry button', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderList({ rows: [], error: new Error('Cannot reach the server.'), onRetry });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load projects');
    expect(alert).toHaveTextContent('Cannot reach the server.');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a table on desktop, with an em dash for empty cells and custom renderers', () => {
    renderList();
    const table = screen.getByRole('table', { name: 'Projects' });
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'Department', 'Budget']);
    expect(within(table).getByRole('link', { name: 'Customer Portal Revamp' }))
      .toHaveAttribute('href', '/projects/1');
    expect(within(table).getByText('—')).toBeInTheDocument();
    expect(within(table).getByText('$200')).toBeInTheDocument();
  });

  it('opens a row when it is clicked, but not when a row action is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderList({
      rowActions: (row) => <button type="button" onClick={() => onEdit(row.id)}>{`Edit ${row.name}`}</button>,
    });

    await user.click(screen.getByRole('button', { name: 'Edit Data Center Migration' }));
    expect(onEdit).toHaveBeenCalledWith(2);
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();

    await user.click(screen.getByText('Digital'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/1');
  });

  it('renders stacked cards on phones', () => {
    window.innerWidth = 375;
    renderList({ rowActions: () => <button type="button">Edit</button> });

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Projects' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole('link', { name: 'Customer Portal Revamp' })).toBeInTheDocument();
    expect(within(cards[0]).getByText('Department')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('paginates', async () => {
    const onPageChange = vi.fn();
    const onRowsPerPageChange = vi.fn();
    const user = userEvent.setup();
    renderList({ total: 25, page: 0, rowsPerPage: 10, onPageChange, onRowsPerPageChange });

    expect(screen.getByText('1–10 of 25')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    await user.click(screen.getByRole('combobox', { name: /rows per page/i }));
    await user.click(screen.getByRole('option', { name: '25' }));
    expect(onRowsPerPageChange).toHaveBeenCalledWith(25);
  });
});

describe('DataList sorting (phase 6, F3)', () => {
  const SORTABLE = [
    { key: 'name', label: 'Name', sortKey: 'name' },
    { key: 'department', label: 'Department' },
    { key: 'budget', label: 'Budget', sortKey: 'budget_planned', render: (row) => `$${row.budget}` },
  ];
  const CHOICES = [
    { value: 'name', label: 'Name, ascending' },
    { value: '-name', label: 'Name, descending' },
    { value: 'budget_planned', label: 'Budget, ascending' },
    { value: '-budget_planned', label: 'Budget, descending' },
  ];
  const header = (name) => screen.getByRole('columnheader', { name });

  it('marks the sorted column with aria-sort and only that one', () => {
    renderList({ columns: SORTABLE, sort: '-name', onSortChange: vi.fn(), sortChoices: CHOICES });
    expect(header('Name')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Budget')).not.toHaveAttribute('aria-sort');
    expect(header('Department')).not.toHaveAttribute('aria-sort');
  });

  it('offers a sort button on sortable columns only', () => {
    renderList({ columns: SORTABLE, sort: 'name', onSortChange: vi.fn(), sortChoices: CHOICES });
    expect(within(header('Name')).getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(within(header('Budget')).getByRole('button', { name: 'Budget' })).toBeInTheDocument();
    expect(within(header('Department')).queryByRole('button')).not.toBeInTheDocument();
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('sorts ascending first and flips the direction on the sorted column', async () => {
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderList({ columns: SORTABLE, sort: 'name', onSortChange, sortChoices: CHOICES });

    await user.click(within(header('Budget')).getByRole('button'));
    expect(onSortChange).toHaveBeenLastCalledWith('budget_planned');
    await user.click(within(header('Name')).getByRole('button'));
    expect(onSortChange).toHaveBeenLastCalledWith('-name');
    expect(rerender).toBeDefined();
  });

  it('can be operated from the keyboard', async () => {
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    renderList({ columns: SORTABLE, sort: 'name', onSortChange, sortChoices: CHOICES });
    within(header('Budget')).getByRole('button').focus();
    await user.keyboard('{Enter}');
    expect(onSortChange).toHaveBeenCalledWith('budget_planned');
  });

  it('has no sort controls when the page gives no handler', () => {
    renderList({ columns: SORTABLE });
    expect(within(header('Name')).queryByRole('button')).not.toBeInTheDocument();
    expect(header('Name')).not.toHaveAttribute('aria-sort');
  });

  it('offers a Sort select instead on phones', async () => {
    window.innerWidth = 375;
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    renderList({ columns: SORTABLE, sort: '-name', onSortChange, sortChoices: CHOICES });

    const select = screen.getByRole('combobox', { name: 'Sort' });
    expect(select).toHaveTextContent('Name, descending');
    await user.click(select);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
      CHOICES.map((choice) => choice.label),
    );
    await user.click(screen.getByRole('option', { name: 'Budget, ascending' }));
    expect(onSortChange).toHaveBeenCalledWith('budget_planned');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows no Sort select on phones without sort choices, or on desktop', () => {
    window.innerWidth = 375;
    const { unmount } = renderList({ columns: SORTABLE });
    expect(screen.queryByRole('combobox', { name: 'Sort' })).not.toBeInTheDocument();
    unmount();
    window.innerWidth = 1024;
    renderList({ columns: SORTABLE, sort: 'name', onSortChange: vi.fn(), sortChoices: CHOICES });
    expect(screen.queryByRole('combobox', { name: 'Sort' })).not.toBeInTheDocument();
  });
});
