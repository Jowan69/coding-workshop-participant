import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders from './TestProviders';
import DataList from './components/DataList';
import InsightSection from './components/InsightSection';
import PageHeader from './components/PageHeader';
import AtRiskSection from './pages/dashboard/AtRiskSection';
import { request } from './services/apiClient';
import theme, { WRAPPING_CHIP_SX } from './theme';

vi.mock('./services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

/**
 * Phase 6, E1: long unbroken values wrap. jsdom has no layout engine, so these check the
 * styles that make wrapping possible (the real-browser check is in TESTING.md).
 */
const LONG = 'X'.repeat(150);

beforeEach(() => request.mockReset());

describe('theme rules for long unbroken values', () => {
  it('sets the three rules once, in the theme', () => {
    const { components } = theme;
    expect(components.MuiCssBaseline.styleOverrides.body).toEqual({ overflowWrap: 'break-word' });
    expect(components.MuiTableCell.styleOverrides.root).toEqual({ overflowWrap: 'anywhere' });
    expect(components.MuiTableCell.styleOverrides.head.whiteSpace).toBe('nowrap');
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'subtitle1', 'subtitle2'].forEach((variant) => {
      expect(components.MuiTypography.styleOverrides[variant]).toEqual({ overflowWrap: 'anywhere' });
    });
    expect(components.MuiDialogTitle.styleOverrides.root.overflowWrap).toBe('anywhere');
    expect(components.MuiMenuItem.styleOverrides.root).toEqual({ whiteSpace: 'normal', overflowWrap: 'anywhere' });
    expect(components.MuiChip.styleOverrides.root.maxWidth).toBe('100%');
  });

  it('lets table cells break anywhere but keeps column headings on one line', () => {
    render(
      <TestProviders>
        <Table>
          <TableHead><TableRow><TableCell>Department</TableCell></TableRow></TableHead>
          <TableBody><TableRow><TableCell>{LONG}</TableCell></TableRow></TableBody>
        </Table>
      </TestProviders>,
    );
    expect(screen.getByRole('cell', { name: LONG })).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.getByRole('columnheader', { name: 'Department' })).toHaveStyle({ whiteSpace: 'nowrap' });
  });

  it.each(['h1', 'h2', 'h3', 'h5', 'h6', 'subtitle1'])('lets a %s heading break anywhere', (variant) => {
    render(<TestProviders><Typography variant={variant}>{LONG}</Typography></TestProviders>);
    expect(screen.getByText(LONG)).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('lets dialog titles break anywhere', () => {
    render(
      <TestProviders>
        <Dialog open><DialogTitle>{`Edit ${LONG}`}</DialogTitle></Dialog>
      </TestProviders>,
    );
    expect(screen.getByRole('heading', { name: `Edit ${LONG}` })).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('lets menu options wrap instead of widening the menu', async () => {
    const user = userEvent.setup();
    render(
      <TestProviders>
        <TextField select label="Department" value="">
          <MenuItem value={LONG}>{LONG}</MenuItem>
        </TextField>
      </TestProviders>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Department' }));
    expect(await screen.findByRole('option', { name: LONG }))
      .toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' });
  });

  it('never lets a chip grow wider than its container, and wraps chips that carry user text', () => {
    render(
      <TestProviders>
        <Chip label="Active" data-testid="plain" />
        <Chip label={LONG} sx={WRAPPING_CHIP_SX} data-testid="wrapping" />
      </TestProviders>,
    );
    expect(screen.getByTestId('plain')).toHaveStyle({ maxWidth: '100%' });
    const wrapping = screen.getByTestId('wrapping');
    expect(wrapping).toHaveStyle({ maxWidth: '100%', height: 'auto' });
    expect(within(wrapping).getByText(LONG)).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' });
  });
});

describe('shared components', () => {
  it('PageHeader lets a long title and description wrap inside a shrinkable box', () => {
    render(<TestProviders><PageHeader title={LONG} description={`dept-${LONG}`} actions={<button type="button">New</button>} /></TestProviders>);
    const title = screen.getByRole('heading', { level: 1, name: LONG });
    expect(title).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(title.parentElement).toHaveStyle({ minWidth: '0', maxWidth: '100%' });
    expect(screen.getByText(`dept-${LONG}`)).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.getByRole('button', { name: 'New' }).parentElement).toHaveStyle({ minWidth: '0', flexWrap: 'wrap' });
  });

  it('DataList cards cannot be widened by a long value on a phone', () => {
    window.innerWidth = 360;
    render(
      <TestProviders>
        <DataList
          ariaLabel="Things"
          columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }]}
          rows={[{ id: 1, name: LONG, email: `${LONG}@example.test` }]}
          emptyState={{ title: 'Nothing' }}
        />
      </TestProviders>,
    );
    const list = screen.getByRole('list', { name: 'Things' });
    expect(list).toHaveStyle({ gridTemplateColumns: 'minmax(0, 1fr)' });
    const card = within(list).getByRole('listitem');
    expect(card).toHaveStyle({ minWidth: '0' });
    expect(within(card).getByRole('heading', { level: 3 })).toHaveStyle({ overflowWrap: 'anywhere' });
    const value = within(card).getByText(`${LONG}@example.test`);
    expect(value).toHaveStyle({ minWidth: '0', overflowWrap: 'anywhere' });
    expect(value.parentElement.parentElement).toHaveStyle({ gridTemplateColumns: 'minmax(96px, auto) minmax(0, 1fr)' });
  });

  it('DataList table cells take the theme rule on desktop', () => {
    render(
      <TestProviders>
        <DataList
          ariaLabel="Things"
          columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }]}
          rows={[{ id: 1, name: LONG, email: `${LONG}@example.test` }]}
          emptyState={{ title: 'Nothing' }}
        />
      </TestProviders>,
    );
    expect(screen.getByRole('cell', { name: LONG })).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.getByRole('cell', { name: `${LONG}@example.test` })).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('a Dashboard section is a grid whose content may shrink', async () => {
    request.mockResolvedValue({ items: [1] });
    render(
      <TestProviders>
        <InsightSection id="s" title={LONG} label="things" path="/things" isEmpty={() => false} emptyMessage="none">
          {() => <p>answer</p>}
        </InsightSection>
      </TestProviders>,
    );
    expect(await screen.findByText('answer')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: LONG });
    expect(section).toHaveStyle({ gridTemplateColumns: 'minmax(0, 1fr)', minWidth: '0' });
    expect(screen.getByRole('heading', { level: 2, name: LONG })).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('an at-risk card cannot be widened by a long project name', async () => {
    request.mockResolvedValue({
      as_of: '2026-11-24',
      items: [{
        id: 1, name: LONG, health: 'at_risk', end_date: '2026-12-01', forecast_end_date: null,
        reasons: [{ code: 'behind_schedule', message: `reason-${LONG}` }],
      }],
    });
    render(<TestProviders><AtRiskSection /></TestProviders>);
    const list = await screen.findByRole('list', { name: 'At-risk projects' });
    expect(list).toHaveStyle({ gridTemplateColumns: 'minmax(0, 1fr)' });
    const heading = within(list).getByRole('heading', { level: 3, name: LONG });
    expect(heading).toHaveStyle({ overflowWrap: 'anywhere', minWidth: '0' });
    expect(heading.closest('li')).toHaveStyle({ gridTemplateColumns: 'minmax(0, 1fr)', minWidth: '0' });
    expect(screen.getByText(`reason-${LONG}`)).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' });
  });
});
