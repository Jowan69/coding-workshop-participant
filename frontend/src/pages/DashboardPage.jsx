import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import PageHeader from '../components/PageHeader';
import { RefreshContext } from '../context/refresh-context';
import { formatTime } from '../utils/format';
import AllocationSection from './dashboard/AllocationSection';
import AtRiskSection from './dashboard/AtRiskSection';
import BudgetSection from './dashboard/BudgetSection';
import DeliverablesSection from './dashboard/DeliverablesSection';
import DependencySection from './dashboard/DependencySection';
import OverAllocatedSection from './dashboard/OverAllocatedSection';
import ProjectStatusSection from './dashboard/ProjectStatusSection';
import SummaryTiles from './dashboard/SummaryTiles';

/** How often the Dashboard reloads itself while its tab is visible. */
export const AUTO_REFRESH_MS = 60000;

/**
 * The Dashboard: headline counts, then one section per business question in a fixed order:
 * status, risk, allocation, deliverables, over-allocation, dependencies and budget. Every
 * section loads on its own, so a slow or failing one never holds up the rest.
 *
 * Freshness: the header shows when data last arrived ("Updated 14:05") and a Refresh button.
 * The page also reloads every minute while its tab is visible, and at once when a tab that
 * was hidden for longer than that is shown again. Sections keep their answers on screen while
 * they reload.
 *
 * @returns {JSX.Element} The dashboard page.
 */
export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const lastRefresh = useRef(0);

  const refreshNow = useCallback(() => {
    lastRefresh.current = Date.now();
    setRefreshKey((key) => key + 1);
  }, []);
  const onLoaded = useCallback(() => setUpdatedAt(new Date()), []);

  useEffect(() => {
    lastRefresh.current = Date.now();
    const isVisible = () => document.visibilityState === 'visible';
    const tick = () => {
      if (isVisible()) refreshNow();
    };
    const onVisibilityChange = () => {
      if (isVisible() && Date.now() - lastRefresh.current >= AUTO_REFRESH_MS) refreshNow();
    };
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshNow]);

  const refresh = useMemo(() => ({ refreshKey, onLoaded }), [refreshKey, onLoaded]);

  return (
    <RefreshContext.Provider value={refresh}>
      <PageHeader
        title="Dashboard"
        description="Project health, deadline risk, people and budget across ACME, as of today."
        actions={(
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
            <Typography variant="body2" color="text.secondary" data-testid="dashboard-updated">
              {updatedAt ? `Updated ${formatTime(updatedAt)}` : 'Loading…'}
            </Typography>
            <Button variant="outlined" startIcon={<RefreshIcon />} onClick={refreshNow}>
              Refresh
            </Button>
          </Box>
        )}
      />
      <SummaryTiles />
      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 3 }}>
        <ProjectStatusSection />
        <AtRiskSection />
        <AllocationSection />
        <DeliverablesSection />
        <OverAllocatedSection />
        <DependencySection />
        <BudgetSection />
      </Box>
    </RefreshContext.Provider>
  );
}
