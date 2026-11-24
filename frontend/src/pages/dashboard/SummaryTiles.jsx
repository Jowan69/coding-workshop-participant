import PropTypes from 'prop-types';
import { Link as RouterLink } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import FolderIcon from '@mui/icons-material/Folder';
import GroupsIcon from '@mui/icons-material/Groups';
import MoneyOffIcon from '@mui/icons-material/MoneyOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useApiGet } from '../../hooks/useApiGet';
import { SECTION_IDS, sectionHeadingId } from '../../utils/dashboardSections';

/**
 * The headline counts. Active projects opens the filtered Projects list; the others jump to
 * the Dashboard section that lists exactly those items. `tone` colours a non-zero count.
 */
const TILES = [
  { key: 'active_projects', label: 'Active projects', icon: FolderIcon, to: '/projects?status=active' },
  { key: 'at_risk_projects', label: 'Projects at risk', icon: WarningAmberIcon, section: SECTION_IDS.atRisk, tone: 'atRisk' },
  { key: 'overdue_deliverables', label: 'Overdue deliverables', icon: EventBusyIcon, section: SECTION_IDS.deliverables, tone: 'overdue' },
  { key: 'over_allocated_people', label: 'Over-allocated people', icon: GroupsIcon, section: SECTION_IDS.overAllocated, tone: 'atRisk' },
  { key: 'over_budget_projects', label: 'Projects over budget', icon: MoneyOffIcon, section: SECTION_IDS.budget, tone: 'overdue' },
];

const GRID_SX = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 2,
  mb: 3,
};

/** Scroll a section into view and move keyboard focus to its heading. */
function jumpTo(sectionId) {
  const heading = document.getElementById(sectionHeadingId(sectionId));
  if (!heading) return;
  heading.closest('section')?.scrollIntoView?.({ block: 'start' });
  heading.focus({ preventScroll: true });
}

function Tile({ tile, count }) {
  const Icon = tile.icon;
  const tone = count > 0 && tile.tone ? `${tile.tone}.main` : 'text.primary';
  const linkProps = tile.to
    ? { component: RouterLink, to: tile.to }
    : { onClick: () => jumpTo(tile.section) };
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardActionArea {...linkProps} sx={{ height: '100%' }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography
              component="span"
              variant="h3"
              sx={{ color: tone, fontVariantNumeric: 'tabular-nums' }}
            >
              {count}
            </Typography>
            <Icon aria-hidden="true" sx={{ color: tone }} />
          </Box>
          <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
            {tile.label}
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

Tile.propTypes = {
  tile: PropTypes.shape({
    key: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    icon: PropTypes.elementType.isRequired,
    to: PropTypes.string,
    section: PropTypes.string,
    tone: PropTypes.string,
  }).isRequired,
  count: PropTypes.number.isRequired,
};

/**
 * Five headline counts from /insights/summary, each a way into the matching list. Loads on
 * its own, with skeleton tiles while loading and an error with Retry.
 *
 * @returns {JSX.Element} The tiles.
 */
export default function SummaryTiles() {
  const { data, loading, error, reload } = useApiGet('/insights/summary');

  if (error) {
    return (
      <Alert
        severity="error"
        sx={{ mb: 3 }}
        action={(
          <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={reload}>
            Retry
          </Button>
        )}
      >
        <AlertTitle>Could not load the headline counts</AlertTitle>
        {error.message}
      </Alert>
    );
  }

  return (
    <Box component="section" aria-label="Headline counts" aria-busy={loading || undefined} sx={GRID_SX}>
      {TILES.map((tile) => (
        loading || !data
          ? <Skeleton key={tile.key} variant="rounded" height={104} data-testid="tile-loading" />
          : <Tile key={tile.key} tile={tile} count={data[tile.key] ?? 0} />
      ))}
    </Box>
  );
}
