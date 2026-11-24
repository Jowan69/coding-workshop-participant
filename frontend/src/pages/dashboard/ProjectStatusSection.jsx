import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DataList from '../../components/DataList';
import InsightSection from '../../components/InsightSection';
import ProgressBar from '../../components/ProgressBar';
import StatusChip from '../../components/StatusChip';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { formatDate, formatDaysToDeadline } from '../../utils/format';

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

const COLUMNS = [
  { key: 'name', label: 'Project' },
  { key: 'status', label: 'Status', render: (project) => <StatusChip status={project.status} /> },
  { key: 'health', label: 'Health', render: (project) => <StatusChip status={project.health} /> },
  { key: 'percent_done', label: 'Deliverables done', render: (project) => <DoneCell project={project} /> },
  { key: 'end_date', label: 'Deadline', render: (project) => <DeadlineCell project={project} /> },
];

/**
 * "Where does each project stand?": every open project with its status, health, share of
 * deliverables done and time to deadline, worst health first.
 *
 * @returns {JSX.Element} The section.
 */
export default function ProjectStatusSection() {
  return (
    <InsightSection
      id={SECTION_IDS.projectStatus}
      title="Where does each project stand?"
      description="Every planned, active or on-hold project, worst health first."
      label="project status"
      path="/insights/project-status"
      isEmpty={(data) => data.items.length === 0}
      emptyMessage="No open projects. Planned, active and on-hold projects appear here."
    >
      {(data) => (
        <DataList
          ariaLabel="Project status"
          columns={COLUMNS}
          rows={data.items}
          getRowHref={(project) => `/projects/${project.id}`}
          emptyState={{ title: 'No open projects' }}
        />
      )}
    </InsightSection>
  );
}
