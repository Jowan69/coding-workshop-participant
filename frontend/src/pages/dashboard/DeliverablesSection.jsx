import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import DataList from '../../components/DataList';
import InsightSection from '../../components/InsightSection';
import ProgressBar from '../../components/ProgressBar';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { formatDate } from '../../utils/format';
import { DELIVERABLE_STATUS_OPTIONS } from '../../utils/status';

function ProgressCell({ project }) {
  if (project.total === 0) {
    return <Typography variant="body2" color="text.secondary">No deliverables</Typography>;
  }
  return (
    <ProgressBar
      value={project.percent_done}
      label={`${project.project_name} deliverables done`}
      valueText={`${project.counts.done} of ${project.total} done`}
    />
  );
}

ProgressCell.propTypes = {
  project: PropTypes.shape({
    project_name: PropTypes.string,
    total: PropTypes.number,
    percent_done: PropTypes.number,
    counts: PropTypes.object,
  }).isRequired,
};

function CountsCell({ counts }) {
  const parts = DELIVERABLE_STATUS_OPTIONS
    .filter((option) => counts[option.value] > 0)
    .map((option) => `${counts[option.value]} ${option.label.toLowerCase()}`);
  return <Typography variant="body2">{parts.length ? parts.join(' · ') : '—'}</Typography>;
}

CountsCell.propTypes = {
  counts: PropTypes.objectOf(PropTypes.number).isRequired,
};

function OverdueCell({ overdue }) {
  if (!overdue) return <Typography variant="body2" color="text.secondary">None</Typography>;
  return (
    <Chip
      size="small"
      color="overdue"
      icon={<EventBusyIcon aria-hidden="true" />}
      label={`${overdue} overdue`}
    />
  );
}

OverdueCell.propTypes = {
  overdue: PropTypes.number.isRequired,
};

function NextDueCell({ next }) {
  if (!next) return <Typography variant="body2" color="text.secondary">Nothing upcoming</Typography>;
  return (
    <Box>
      <Typography variant="body2">{next.title}</Typography>
      <Typography variant="caption" color="text.secondary">{`Due ${formatDate(next.due_date)}`}</Typography>
    </Box>
  );
}

NextDueCell.propTypes = {
  next: PropTypes.shape({ title: PropTypes.string, due_date: PropTypes.string }),
};

const COLUMNS = [
  { key: 'project_name', label: 'Project' },
  { key: 'progress', label: 'Progress', render: (project) => <ProgressCell project={project} /> },
  { key: 'counts', label: 'By status', render: (project) => <CountsCell counts={project.counts} /> },
  { key: 'overdue', label: 'Overdue', render: (project) => <OverdueCell overdue={project.overdue} /> },
  { key: 'next_due', label: 'Next due', render: (project) => <NextDueCell next={project.next_due} /> },
];

/**
 * "How are deliverables progressing?": per open project, the share done, counts by status,
 * how many are overdue and what is due next. A row opens the project's deliverables.
 *
 * @returns {JSX.Element} The section.
 */
export default function DeliverablesSection() {
  return (
    <InsightSection
      id={SECTION_IDS.deliverables}
      title="How are deliverables progressing?"
      description="Open projects, most overdue first. Overdue means not done and due before today."
      label="deliverable progress"
      path="/insights/deliverables"
      isEmpty={(data) => data.items.length === 0}
      emptyMessage="No open projects, so no deliverables to track."
    >
      {(data) => (
        <DataList
          ariaLabel="Deliverable progress"
          columns={COLUMNS}
          rows={data.items}
          getRowId={(project) => project.project_id}
          getRowHref={(project) => `/projects/${project.project_id}?tab=deliverables`}
          emptyState={{ title: 'No open projects' }}
        />
      )}
    </InsightSection>
  );
}
