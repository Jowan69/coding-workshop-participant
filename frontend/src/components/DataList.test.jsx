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
