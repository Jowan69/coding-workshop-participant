import { useId } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { formatCurrency, formatPercent } from '../utils/format';
import ProgressBar from './ProgressBar';
import StatusChip from './StatusChip';

function Figure({ label, value, tone }) {
  return (
    <Box>
      <Typography component="dt" variant="body2" color="text.secondary">{label}</Typography>
      <Typography
        component="dd"
        variant="h5"
        sx={{ m: 0, color: tone, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

Figure.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  tone: PropTypes.string,
};

/**
 * Planned versus spent for one project: the four figures, a bar, and an over-budget alert
 * when spending passes the plan. Says so when no budget is planned.
 *
 * @param {object} props Component props.
 * @param {{planned: number, spent: number, remaining: number, percent_used: number|null}}
 *   props.summary The API's `/budgets/summary` response.
 * @returns {JSX.Element} The summary card.
 */
export default function BudgetSummary({ summary }) {
  const headingId = useId();
  const planned = Number(summary.planned ?? 0);
  const spent = Number(summary.spent ?? 0);
  const remaining = Number(summary.remaining ?? planned - spent);
  const over = spent > planned;

  let alert = null;
  if (over && planned > 0) {
    alert = (
      <Alert severity="error">
        {`Over budget by ${formatCurrency(spent - planned)}: ${formatPercent(summary.percent_used)} of the planned ${formatCurrency(planned)} is spent.`}
      </Alert>
    );
  } else if (over) {
    alert = (
      <Alert severity="error">
        {`No budget is planned for this project, but ${formatCurrency(spent)} has been spent.`}
      </Alert>
    );
  } else if (planned === 0) {
    alert = <Alert severity="info">No budget is planned for this project yet.</Alert>;
  }

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 3 }, display: 'grid', gap: 2 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography id={headingId} variant="h6" component="h2">Budget summary</Typography>
        {over && <StatusChip status="over_budget" />}
      </Box>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 2,
        }}
      >
        <Figure label="Planned" value={formatCurrency(planned)} />
        <Figure label="Spent" value={formatCurrency(spent)} />
        <Figure
          label={remaining < 0 ? 'Overspent' : 'Remaining'}
          value={formatCurrency(Math.abs(remaining))}
          tone={remaining < 0 ? 'error.main' : undefined}
        />
        <Figure label="Used" value={formatPercent(summary.percent_used)} />
      </Box>
      {planned > 0 && (
        <ProgressBar
          value={summary.percent_used}
          label="Budget used"
          valueText={`${formatCurrency(spent)} of ${formatCurrency(planned)} (${formatPercent(summary.percent_used)})`}
        />
      )}
      {alert}
    </Paper>
  );
}

BudgetSummary.propTypes = {
  summary: PropTypes.shape({
    planned: PropTypes.number,
    spent: PropTypes.number,
    remaining: PropTypes.number,
    percent_used: PropTypes.number,
  }).isRequired,
};
