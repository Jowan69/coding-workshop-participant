import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DataList from '../../components/DataList';
import InsightSection from '../../components/InsightSection';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { formatDate } from '../../utils/format';

function PeakCell({ person }) {
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600, color: 'atRisk.main' }}>
        {`${person.peak_pct}% booked`}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {`Capacity ${person.capacity_pct}% · peak from ${formatDate(person.peak_on)}`}
      </Typography>
    </Box>
  );
}

PeakCell.propTypes = {
  person: PropTypes.shape({
    peak_pct: PropTypes.number,
    capacity_pct: PropTypes.number,
    peak_on: PropTypes.string,
  }).isRequired,
};

function ProjectsCell({ projects }) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {projects.map((project) => (
        <Typography component="li" variant="body2" key={project.project_id}>
          {`${project.project_name}: ${project.allocation_pct}%`}
        </Typography>
      ))}
    </Box>
  );
}

ProjectsCell.propTypes = {
  projects: PropTypes.arrayOf(PropTypes.shape({
    project_id: PropTypes.number,
    project_name: PropTypes.string,
    allocation_pct: PropTypes.number,
  })).isRequired,
};

const COLUMNS = [
  { key: 'full_name', label: 'Person' },
  { key: 'peak', label: 'Peak', render: (person) => <PeakCell person={person} /> },
  {
    key: 'overlap',
    label: 'Overlap',
    render: (person) => `${formatDate(person.overlap_start)} – ${formatDate(person.overlap_end)}`,
  },
  { key: 'projects', label: 'Projects', render: (person) => <ProjectsCell projects={person.projects} /> },
];

/**
 * "Who is over-allocated?": people booked above their capacity on any day of the API's
 * look-ahead window (shown under the heading), their peak, when the clashing allocations
 * overlap, and on which projects.
 *
 * @returns {JSX.Element} The section.
 */
export default function OverAllocatedSection() {
  return (
    <InsightSection
      id={SECTION_IDS.overAllocated}
      title="Who is over-allocated?"
      description="People booked above their capacity on any day of the coming weeks. Exactly at capacity is fine."
      label="over-allocated people"
      path="/insights/over-allocated"
      isEmpty={(data) => data.items.length === 0}
      emptyMessage={(data) => `Nobody is booked above capacity between ${formatDate(data.from)} and ${formatDate(data.to)}.`}
    >
      {(data) => (
        <>
          <Typography variant="body2" color="text.secondary">
            {`Checked from ${formatDate(data.from)} to ${formatDate(data.to)}.`}
          </Typography>
          <DataList
            ariaLabel="Over-allocated people"
            columns={COLUMNS}
            rows={data.items}
            getRowId={(person) => person.resource_id}
            emptyState={{ title: 'Nobody is over-allocated' }}
          />
        </>
      )}
    </InsightSection>
  );
}
