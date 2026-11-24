import PropTypes from 'prop-types';
import { Link as RouterLink } from 'react-router-dom';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import InsightSection from '../../components/InsightSection';
import StatusChip from '../../components/StatusChip';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { daysBetween, formatDate } from '../../utils/format';
import { REASON_META } from '../../utils/status';

function ReasonChip({ reason }) {
  const meta = REASON_META[reason.code];
  const icon = meta ? <meta.icon aria-hidden="true" /> : undefined;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={meta?.color ?? 'default'}
      icon={icon}
      label={reason.message}
      sx={{ maxWidth: '100%' }}
    />
  );
}

ReasonChip.propTypes = {
  reason: PropTypes.shape({ code: PropTypes.string, message: PropTypes.string }).isRequired,
};

function Forecast({ project }) {
  const deadline = formatDate(project.end_date);
  if (!project.forecast_end_date) {
    return (
      <Typography variant="body2" color="text.secondary">
        {`No forecast until a deliverable is done · deadline ${deadline}`}
      </Typography>
    );
  }
  const late = daysBetween(project.end_date, project.forecast_end_date);
  let verdict = 'on or before the deadline';
  if (late > 0) verdict = `${late} ${late === 1 ? 'day' : 'days'} after the deadline`;
  return (
    <Typography variant="body2">
      <Box component="span" sx={{ fontWeight: 600 }}>
        {`Forecast finish ${formatDate(project.forecast_end_date)}`}
      </Box>
      {` (${verdict}) · deadline ${deadline}`}
    </Typography>
  );
}

Forecast.propTypes = {
  project: PropTypes.shape({
    end_date: PropTypes.string,
    forecast_end_date: PropTypes.string,
  }).isRequired,
};

function AtRiskList({ items }) {
  return (
    <Box component="ul" aria-label="At-risk projects" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1.5 }}>
      {items.map((project) => (
        <Paper component="li" key={project.id} variant="outlined" sx={{ p: 2, display: 'grid', gap: 1 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
              <Link component={RouterLink} to={`/projects/${project.id}`} underline="hover">
                {project.name}
              </Link>
            </Typography>
            <StatusChip status={project.health} />
          </Box>
          <Box component="ul" aria-label={`Why ${project.name} is at risk`} sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {project.reasons.map((reason) => (
              <Box component="li" key={reason.code} sx={{ maxWidth: '100%' }}>
                <ReasonChip reason={reason} />
              </Box>
            ))}
          </Box>
          <Forecast project={project} />
        </Paper>
      ))}
    </Box>
  );
}

AtRiskList.propTypes = {
  items: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.number.isRequired,
    name: PropTypes.string.isRequired,
    health: PropTypes.string.isRequired,
    reasons: PropTypes.arrayOf(PropTypes.object).isRequired,
  })).isRequired,
};

/**
 * "Which projects are at risk?": open projects that are not on track, why, and when they
 * will finish at the current pace.
 *
 * @returns {JSX.Element} The section.
 */
export default function AtRiskSection() {
  return (
    <InsightSection
      id={SECTION_IDS.atRisk}
      title="Which projects are at risk?"
      description="Past the deadline, a deliverable overdue or blocked, or time running well ahead of the work done. The forecast extends the current pace."
      label="at-risk projects"
      path="/insights/at-risk"
      isEmpty={(data) => data.items.length === 0}
      emptyMessage="No project is at risk: every open project is on track."
    >
      {(data) => <AtRiskList items={data.items} />}
    </InsightSection>
  );
}
