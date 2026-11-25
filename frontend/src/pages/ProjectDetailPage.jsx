import PropTypes from 'prop-types';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import AsOfNote from '../components/AsOfNote';
import BudgetBar from '../components/BudgetBar';
import PageHeader from '../components/PageHeader';
import ProgressBar from '../components/ProgressBar';
import StatusChip from '../components/StatusChip';
import { useApiGet } from '../hooks/useApiGet';
import { useIsDesktop } from '../hooks/useIsDesktop';
import { formatDate, formatPercent } from '../utils/format';
import BudgetTab from './BudgetTab';
import DeliverablesTab from './DeliverablesTab';
import { isProjectOverdue } from './projectFields';
import TeamTab from './TeamTab';

const TABS = [
  { value: 'deliverables', label: 'Deliverables', Panel: DeliverablesTab },
  { value: 'team', label: 'Team', Panel: TeamTab },
  { value: 'budget', label: 'Budget', Panel: BudgetTab },
];

function BackLink() {
  return (
    <Link
      component={RouterLink}
      to="/projects"
      underline="hover"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mb: 1 }}
    >
      <ArrowBackIcon fontSize="small" aria-hidden="true" />
      All projects
    </Link>
  );
}

function ProjectNotFound() {
  return (
    <>
      <BackLink />
      <PageHeader title="Project not found" />
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}>
        <SearchOffIcon aria-hidden="true" sx={{ fontSize: 48, color: 'text.secondary' }} />
        <Typography variant="body1" sx={{ mt: 1 }}>
          There is no project at this address. It may have been deleted, or the link may be wrong.
        </Typography>
        <Button component={RouterLink} to="/projects" variant="contained" sx={{ mt: 2 }}>
          Go to projects
        </Button>
      </Paper>
    </>
  );
}

function Fact({ label, children }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography component="dt" variant="body2" color="text.secondary">{label}</Typography>
      <Box
        component="dd"
        sx={{
          m: 0, mt: 0.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1,
          '& > *': { minWidth: 0 },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

Fact.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};

function ProjectSummary({ project }) {
  const isDesktop = useIsDesktop();
  const done = project.deliverable_counts?.done ?? 0;
  const total = project.deliverables_total ?? 0;

  return (
    <Paper
      component="section"
      aria-label="Project summary"
      variant="outlined"
      sx={{ p: { xs: 2, md: 3 }, mb: 3 }}
    >
      {project.description && (
        <Typography variant="body1" sx={{ mb: 2, whiteSpace: 'pre-line' }}>
          {project.description}
        </Typography>
      )}
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: isDesktop ? 'repeat(4, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))',
          gap: 2,
        }}
      >
        <Fact label="Status">
          <StatusChip status={project.status} />
          {isProjectOverdue(project) && <StatusChip status="overdue" />}
        </Fact>
        <Fact label="Start">
          <Typography variant="body1">{formatDate(project.start_date)}</Typography>
        </Fact>
        <Fact label="Deadline">
          <Typography variant="body1">{formatDate(project.end_date)}</Typography>
        </Fact>
        <Fact label="Owner">
          <Typography variant="body1" color={project.owner_name ? 'text.primary' : 'text.secondary'}>
            {project.owner_name ?? 'No owner'}
          </Typography>
        </Fact>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: isDesktop ? '1fr 1fr' : '1fr',
          gap: isDesktop ? 4 : 2,
          mt: 3,
        }}
      >
        <ProgressBar
          value={project.percent_complete}
          label="Complete"
          showLabel
          valueText={`${formatPercent(project.percent_complete)} (${done} of ${total} deliverables done)`}
        />
        <BudgetBar
          planned={project.budget_planned}
          spent={project.budget_spent}
          label="Budget used"
          showLabel
        />
      </Box>
      <AsOfNote date={project.as_of} />
    </Paper>
  );
}

ProjectSummary.propTypes = {
  project: PropTypes.shape({
    description: PropTypes.string,
    status: PropTypes.string.isRequired,
    start_date: PropTypes.string,
    end_date: PropTypes.string,
    owner_name: PropTypes.string,
    is_overdue: PropTypes.bool,
    as_of: PropTypes.string,
    percent_complete: PropTypes.number,
    deliverables_total: PropTypes.number,
    deliverable_counts: PropTypes.object,
    budget_planned: PropTypes.number,
    budget_spent: PropTypes.number,
  }).isRequired,
};

function ProjectDetail({ projectId }) {
  const isDesktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const project = useApiGet(`/projects/${projectId}`);

  const current = TABS.find((tab) => tab.value === params.get('tab')) ?? TABS[0];
  // Filters belong to one tab ("q" searches deliverables on one and budget entries on
  // another), so switching tabs keeps only the tab itself.
  const selectTab = (event, value) => setParams({ tab: value });

  if (project.error?.status === 404) return <ProjectNotFound />;
  if (project.error) {
    return (
      <>
        <BackLink />
        <PageHeader title="Project" />
        <Alert
          severity="error"
          action={(
            <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={project.reload}>
              Retry
            </Button>
          )}
        >
          <AlertTitle>Could not load the project</AlertTitle>
          {project.error.message}
        </Alert>
      </>
    );
  }
  if (!project.data) {
    return (
      <Box aria-busy="true">
        <BackLink />
        <LinearProgress aria-label="Loading project" sx={{ mb: 2 }} />
        <Skeleton variant="text" width="40%" sx={{ fontSize: '2rem' }} />
        <Skeleton variant="rounded" height={180} sx={{ mt: 2 }} />
      </Box>
    );
  }

  const data = project.data;
  const { Panel } = current;
  return (
    <>
      <BackLink />
      <PageHeader title={data.name} description={data.department} />
      <ProjectSummary project={data} />
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs
          value={current.value}
          onChange={selectTab}
          aria-label="Project sections"
          variant={isDesktop ? 'standard' : 'fullWidth'}
        >
          {TABS.map((tab) => (
            <Tab
              key={tab.value}
              value={tab.value}
              label={tab.label}
              id={`project-tab-${tab.value}`}
              aria-controls={`project-panel-${tab.value}`}
            />
          ))}
        </Tabs>
      </Box>
      <Box
        role="tabpanel"
        id={`project-panel-${current.value}`}
        aria-labelledby={`project-tab-${current.value}`}
      >
        <Panel project={data} onProjectChange={project.reload} />
      </Box>
    </>
  );
}

ProjectDetail.propTypes = {
  projectId: PropTypes.number.isRequired,
};

/**
 * One project: a summary header (status, dates, owner, progress and budget) and tabs for its
 * deliverables, team and budget. The tab lives in the URL (`?tab=team`), so a reload or a
 * shared link opens the same tab. An unknown id shows a not-found state.
 *
 * @returns {JSX.Element} The project page.
 */
export default function ProjectDetailPage() {
  const { id } = useParams();
  if (!/^\d+$/.test(id ?? '')) return <ProjectNotFound />;
  // A new id starts fresh rather than showing the previous project while loading.
  return <ProjectDetail key={id} projectId={Number(id)} />;
}
