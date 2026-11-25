import { useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import InsightSection from '../../components/InsightSection';
import StatusChip from '../../components/StatusChip';
import { useIsDesktop } from '../../hooks/useIsDesktop';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { DATE_MAX, DATE_MIN, formatDate } from '../../utils/format';

// The person column stays put while the project columns scroll sideways.
const STICKY_SX = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  bgcolor: 'background.paper',
  borderRight: 1,
  borderRightColor: 'divider',
};

function PersonCell({ person }) {
  return (
    <TableCell component="th" scope="row" sx={{ ...STICKY_SX, minWidth: 150 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{person.full_name}</Typography>
      <Typography variant="caption" color="text.secondary">{`Capacity ${person.capacity_pct}%`}</Typography>
    </TableCell>
  );
}

PersonCell.propTypes = {
  person: PropTypes.shape({ full_name: PropTypes.string, capacity_pct: PropTypes.number }).isRequired,
};

function TotalCell({ person }) {
  return (
    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {`${person.total_pct}%`}
        </Typography>
        {person.over_capacity && <StatusChip status="over_allocated" />}
      </Box>
    </TableCell>
  );
}

TotalCell.propTypes = {
  person: PropTypes.shape({ total_pct: PropTypes.number, over_capacity: PropTypes.bool }).isRequired,
};

function AllocationMatrix({ matrix }) {
  const isDesktop = useIsDesktop();
  return (
    <TableContainer
      role="region"
      aria-label="Allocation matrix"
      tabIndex={0}
      sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Table size={isDesktop ? 'medium' : 'small'} aria-label={`Allocation on ${formatDate(matrix.on)}`}>
        <TableHead>
          <TableRow>
            <TableCell scope="col" sx={STICKY_SX}>Person</TableCell>
            {matrix.projects.map((project) => (
              <TableCell
                key={project.id}
                scope="col"
                align="right"
                sx={{ minWidth: 110, maxWidth: 220, whiteSpace: 'normal' }}
              >
                {project.name}
              </TableCell>
            ))}
            <TableCell scope="col" align="right">Total</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {matrix.resources.map((person) => {
            const cells = new Map(person.cells.map((cell) => [cell.project_id, cell.allocation_pct]));
            return (
              <TableRow key={person.id} hover>
                <PersonCell person={person} />
                {matrix.projects.map((project) => (
                  <TableCell key={project.id} align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {cells.has(project.id) ? `${cells.get(project.id)}%` : '—'}
                  </TableCell>
                ))}
                <TotalCell person={person} />
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

AllocationMatrix.propTypes = {
  matrix: PropTypes.shape({
    on: PropTypes.string.isRequired,
    projects: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.number, name: PropTypes.string })).isRequired,
    resources: PropTypes.arrayOf(PropTypes.object).isRequired,
  }).isRequired,
};

/**
 * "Who is allocated to which project?": a person-by-project matrix of allocation percent on
 * a chosen day (today by default). On phones the matrix scrolls sideways inside its own
 * container while the person column stays in place.
 *
 * @returns {JSX.Element} The section.
 */
export default function AllocationSection() {
  const [day, setDay] = useState('');
  return (
    <InsightSection
      id={SECTION_IDS.allocation}
      title="Who is allocated to which project?"
      description="Each person's share of their time per project on the chosen day, against their capacity."
      label="the allocation matrix"
      path="/insights/allocation"
      query={{ on: day }}
      isEmpty={(data) => !data.projects?.length}
      emptyMessage={(data) => `Nobody is allocated to a project on ${formatDate(data.on)}.`}
      controls={(
        <TextField
          type="date"
          size="small"
          label="On date"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          helperText={day ? undefined : 'Today'}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: DATE_MIN, max: DATE_MAX } }}
        />
      )}
    >
      {(data) => <AllocationMatrix matrix={data} />}
    </InsightSection>
  );
}
