import { useState } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';
import RefreshIcon from '@mui/icons-material/Refresh';
import SubdirectoryArrowRightIcon from '@mui/icons-material/SubdirectoryArrowRight';
import InsightSection from '../../components/InsightSection';
import StatusChip from '../../components/StatusChip';
import { useApiGet } from '../../hooks/useApiGet';
import { useIsDesktop } from '../../hooks/useIsDesktop';
import { SECTION_IDS } from '../../utils/dashboardSections';
import { chainRows } from '../../utils/dependencyTree';
import { formatDate } from '../../utils/format';

const PROJECT_QUERY = { sort: 'name', limit: 100 };

function BlockedMarker({ names }) {
  return (
    <Chip
      size="small"
      color="overdue"
      variant="outlined"
      icon={<BlockIcon aria-hidden="true" />}
      label={`Blocked by ${names.join(', ')}`}
      sx={{ maxWidth: '100%' }}
    />
  );
}

BlockedMarker.propTypes = {
  names: PropTypes.arrayOf(PropTypes.string).isRequired,
};

function ChainList({ chain }) {
  const isDesktop = useIsDesktop();
  const byId = new Map(chain.items.map((item) => [item.id, item]));
  const indent = isDesktop ? 4 : 2;

  return (
    <Box component="ul" aria-label={`Dependency chain of ${chain.project_name}`} sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {chainRows(chain.items).map(({ item, level }) => {
        const blockers = item.blocked_by_upstream
          ? item.upstream_ids.map((id) => byId.get(id)).filter((up) => up?.status === 'blocked').map((up) => up.title)
          : [];
        return (
          <Box
            component="li"
            key={item.id}
            aria-level={level + 1}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 1,
              py: 1,
              pl: level * indent,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            {level > 0 && (
              <SubdirectoryArrowRightIcon aria-hidden="true" fontSize="small" sx={{ color: 'text.secondary', mt: 0.25 }} />
            )}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{item.title}</Typography>
              <StatusChip status={item.status} />
              <Typography variant="caption" color="text.secondary">{`Due ${formatDate(item.due_date)}`}</Typography>
              {item.blocked_by_upstream && <BlockedMarker names={blockers} />}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

ChainList.propTypes = {
  chain: PropTypes.shape({
    project_name: PropTypes.string.isRequired,
    items: PropTypes.arrayOf(PropTypes.shape({
      id: PropTypes.number.isRequired,
      title: PropTypes.string.isRequired,
      status: PropTypes.string.isRequired,
      due_date: PropTypes.string,
      depth: PropTypes.number.isRequired,
      depends_on_ids: PropTypes.arrayOf(PropTypes.number).isRequired,
      upstream_ids: PropTypes.arrayOf(PropTypes.number).isRequired,
      blocked_by_upstream: PropTypes.bool.isRequired,
    })).isRequired,
  }).isRequired,
};

function LongestChain({ chain }) {
  const byId = new Map(chain.items.map((item) => [item.id, item.title]));
  const links = chain.longest_chain.length - 1;
  if (links < 1) {
    return (
      <Typography variant="body2" color="text.secondary">
        No deliverable in this project depends on another.
      </Typography>
    );
  }
  return (
    <Typography variant="body2">
      <Box component="span" sx={{ fontWeight: 600 }}>Longest chain: </Box>
      {`${chain.longest_chain.map((id) => byId.get(id)).join(' → ')} (${links} ${links === 1 ? 'link' : 'links'})`}
    </Typography>
  );
}

LongestChain.propTypes = {
  chain: PropTypes.shape({
    items: PropTypes.arrayOf(PropTypes.object).isRequired,
    longest_chain: PropTypes.arrayOf(PropTypes.number).isRequired,
  }).isRequired,
};

function ProjectsUnavailable({ projects }) {
  if (projects.loading) return <Skeleton variant="rounded" height={48} data-testid="section-loading" />;
  if (projects.error) {
    return (
      <Alert
        severity="error"
        action={(
          <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={projects.reload}>
            Retry
          </Button>
        )}
      >
        {`Could not load the projects to choose from. ${projects.error.message}`}
      </Alert>
    );
  }
  return <Typography color="text.secondary">No projects yet, so no dependencies to show.</Typography>;
}

ProjectsUnavailable.propTypes = {
  projects: PropTypes.shape({
    loading: PropTypes.bool,
    error: PropTypes.shape({ message: PropTypes.string }),
    reload: PropTypes.func,
  }).isRequired,
};

/**
 * "What is holding up each deliverable?": one project's dependency chain as an indented list,
 * each deliverable under the one it waits for, with a marker where something upstream is
 * blocked, plus the longest chain. A picker chooses the project (the first by name at first).
 *
 * @returns {JSX.Element} The section.
 */
export default function DependencySection() {
  const projects = useApiGet('/projects', PROJECT_QUERY);
  const [chosen, setChosen] = useState('');
  const options = projects.data?.items ?? [];
  const selected = options.some((project) => project.id === chosen) ? chosen : (options[0]?.id ?? '');

  return (
    <InsightSection
      id={SECTION_IDS.dependencies}
      title="What is holding up each deliverable?"
      description="Each deliverable sits under the one it waits for. A marker shows when something upstream is blocked."
      label="the dependency chain"
      path={selected ? '/insights/dependencies' : null}
      query={{ project_id: selected }}
      isEmpty={(data) => data.items.length === 0}
      emptyMessage={(data) => `${data.project_name} has no deliverables yet.`}
      idle={<ProjectsUnavailable projects={projects} />}
      controls={options.length > 0 && (
        <TextField
          select
          size="small"
          label="Project"
          value={selected}
          onChange={(event) => setChosen(event.target.value)}
          sx={{ minWidth: 220, maxWidth: '100%' }}
        >
          {options.map((project) => (
            <MenuItem key={project.id} value={project.id}>{project.name}</MenuItem>
          ))}
        </TextField>
      )}
    >
      {(data) => (
        <>
          <LongestChain chain={data} />
          <ChainList chain={data} />
        </>
      )}
    </InsightSection>
  );
}
