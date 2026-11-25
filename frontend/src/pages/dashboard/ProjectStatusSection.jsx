import { useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AsOfNote from '../../components/AsOfNote';
import DataList from '../../components/DataList';
import InsightSection from '../../components/InsightSection';
import ProgressBar from '../../components/ProgressBar';
import StatusChip from '../../components/StatusChip';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { daysBetween, formatDate, formatDaysToDeadline } from '../../utils/format';

/** The toggle's choices; `query` is the API's `status` filter (empty: every open project). */
const STATUS_CHOICES = [
  { value: 'active', label: 'Active', query: 'active', noun: 'active' },
  { value: 'planned', label: 'Planned', query: 'planned', noun: 'planned' },
  { value: 'on_hold', label: 'On hold', query: 'on_hold', noun: 'on-hold' },
  { value: 'all', label: 'All open', query: '', noun: 'open' },
];

function DeadlineCell({ project }) {
  const overdue = project.days_to_deadline < 0;
  return (
    <Box>
      <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>{formatDate(project.end_date)}</Typography>
      <Typography
        variant="caption"
        sx={{ color: overdue ? 'overdue.main' : 'text.secondary', fontWeight: overdue ? 600 : 400 }}
      >
        {formatDaysToDeadline(project.days_to_deadline)}
      </Typography>
    </Box>
  );
}

DeadlineCell.propTypes = {
  project: PropTypes.shape({
    end_date: PropTypes.string,
    days_to_deadline: PropTypes.number,
  }).isRequired,
};

function DoneCell({ project }) {
  if (project.percent_done === null || project.percent_done === undefined) {
    return <Typography variant="body2" color="text.secondary">No deliverables</Typography>;
  }
  return (
    <ProgressBar
      value={project.percent_done}
      label={`${project.name} deliverables done`}
      valueText={`${project.deliverables_done} of ${project.deliverables_total} (${Math.round(project.percent_done)}%)`}
    />
  );
}

DoneCell.propTypes = {
  project: PropTypes.shape({
    name: PropTypes.string,
    percent_done: PropTypes.number,
    deliverables_done: PropTypes.number,
    deliverables_total: PropTypes.number,
  }).isRequired,
};

function ForecastCell({ project }) {
  if (!project.forecast_end_date) {
    return <Typography variant="body2" color="text.secondary">No forecast yet</Typography>;
  }
  const late = daysBetween(project.end_date, project.forecast_end_date);
  return (
    <Box>
      <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
        {formatDate(project.forecast_end_date)}
      </Typography>
      <Typography
        variant="caption"
        sx={{ color: late > 0 ? 'overdue.main' : 'text.secondary', fontWeight: late > 0 ? 600 : 400 }}
      >
        {late > 0 ? `+${late} ${late === 1 ? 'day' : 'days'}` : 'On time'}
      </Typography>
    </Box>
  );
}

ForecastCell.propTypes = {
  project: PropTypes.shape({
    end_date: PropTypes.string,
    forecast_end_date: PropTypes.string,
  }).isRequired,
};

const COLUMNS = [
  { key: 'name', label: 'Project' },
  { key: 'status', label: 'Status', render: (project) => <StatusChip status={project.status} /> },
  { key: 'health', label: 'Health', render: (project) => <StatusChip status={project.health} /> },
  { key: 'percent_done', label: 'Deliverables done', render: (project) => <DoneCell project={project} /> },
  { key: 'end_date', label: 'Deadline', render: (project) => <DeadlineCell project={project} /> },
  {
    key: 'forecast_end_date',
    label: 'Forecast',
    render: (project) => <ForecastCell project={project} />,
  },
];

/**
 * "What is the status of each active project?": projects with their status, health, share of
 * deliverables done, time to deadline and the forecast finish at the current pace ("+N days"
 * when that is after the deadline), worst health first. A toggle switches from active
 * projects (the default) to planned, on-hold or every open project.
 *
 * @returns {JSX.Element} The section.
 */
export default function ProjectStatusSection() {
  const [status, setStatus] = useState(STATUS_CHOICES[0].value);
  const choice = STATUS_CHOICES.find((item) => item.value === status);
  return (
    <InsightSection
      id={SECTION_IDS.projectStatus}
      title="What is the status of each active project?"
      description={`Showing ${choice.noun} projects, worst health first. The forecast extends the current pace of work.`}
      label="project status"
      path="/insights/project-status"
      query={{ status: choice.query }}
      isEmpty={(data) => data.items.length === 0}
      emptyMessage={`No ${choice.noun} projects.`}
      controls={(
        <ToggleButtonGroup
          exclusive
          size="small"
          color="primary"
          value={status}
          onChange={(event, next) => next && setStatus(next)}
          aria-label="Projects to show"
          sx={{ flexWrap: 'wrap' }}
        >
          {STATUS_CHOICES.map((item) => (
            <ToggleButton key={item.value} value={item.value}>{item.label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
    >
      {(data) => (
        <>
          <DataList
            ariaLabel="Project status"
            columns={COLUMNS}
            rows={data.items}
            getRowHref={(project) => `/projects/${project.id}`}
            emptyState={{ title: `No ${choice.noun} projects` }}
          />
          <AsOfNote date={data.as_of} />
        </>
      )}
    </InsightSection>
  );
}
