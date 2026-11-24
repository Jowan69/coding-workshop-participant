import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import BudgetBar from '../../components/BudgetBar';
import DataList from '../../components/DataList';
import InsightSection from '../../components/InsightSection';
import ProgressBar from '../../components/ProgressBar';
import StatusChip from '../../components/StatusChip';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { formatCurrency } from '../../utils/format';

function burnText(gap) {
  if (gap === null || gap === undefined) return 'No planned budget to compare';
  const points = Math.round(Math.abs(gap) * 10) / 10;
  if (gap > 0) return `Spending ${points} pts ahead of time`;
  if (gap < 0) return `Spending ${points} pts behind time`;
  return 'Spending in step with time';
}

function BurnCell({ project }) {
  const ahead = project.burn_gap_pts > 0;
  return (
    <Box sx={{ display: 'grid', gap: 0.5 }}>
      <ProgressBar
        value={project.time_elapsed_pct}
        label={`${project.project_name} time elapsed`}
        valueText={`${Math.round(project.time_elapsed_pct)}% of time elapsed`}
        color="secondary"
      />
      <Typography
        variant="caption"
        sx={{ color: ahead ? 'atRisk.main' : 'text.secondary', fontWeight: ahead ? 600 : 400 }}
      >
        {burnText(project.burn_gap_pts)}
      </Typography>
    </Box>
  );
}

BurnCell.propTypes = {
  project: PropTypes.shape({
    project_name: PropTypes.string,
    time_elapsed_pct: PropTypes.number,
    burn_gap_pts: PropTypes.number,
  }).isRequired,
};

function StandingCell({ project }) {
  if (project.over_budget) {
    return (
      <Box>
        <StatusChip status="over_budget" />
        <Typography variant="caption" sx={{ display: 'block', color: 'overdue.main', mt: 0.5 }}>
          {`${formatCurrency(Math.abs(project.remaining))} over`}
        </Typography>
      </Box>
    );
  }
  return <Typography variant="body2">{`${formatCurrency(project.remaining)} left`}</Typography>;
}

StandingCell.propTypes = {
  project: PropTypes.shape({
    over_budget: PropTypes.bool,
    remaining: PropTypes.number,
  }).isRequired,
};

const COLUMNS = [
  { key: 'project_name', label: 'Project' },
  {
    key: 'spent',
    label: 'Spent of planned',
    render: (project) => (
      <BudgetBar
        planned={project.planned}
        spent={project.spent}
        label={`${project.project_name} budget used`}
      />
    ),
  },
  { key: 'burn', label: 'Burn against time', render: (project) => <BurnCell project={project} /> },
  { key: 'standing', label: 'Budget', render: (project) => <StandingCell project={project} /> },
];

/**
 * "Are projects within budget?": planned against spent for every project, closed ones
 * included, and how fast the money goes compared with the calendar. A row opens the
 * project's budget tab.
 *
 * @returns {JSX.Element} The section.
 */
export default function BudgetSection() {
  return (
    <InsightSection
      id={SECTION_IDS.budget}
      title="Are projects within budget?"
      description="Every project, highest share of budget used first. Burn compares the share spent with the share of time elapsed."
      label="budgets"
      path="/insights/budget"
      isEmpty={(data) => data.items.length === 0}
      emptyMessage="No projects yet, so no budgets to compare."
    >
      {(data) => (
        <DataList
          ariaLabel="Budgets"
          columns={COLUMNS}
          rows={data.items}
          getRowId={(project) => project.project_id}
          getRowHref={(project) => `/projects/${project.project_id}?tab=budget`}
          emptyState={{ title: 'No projects' }}
        />
      )}
    </InsightSection>
  );
}
