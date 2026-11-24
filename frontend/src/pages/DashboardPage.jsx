import Box from '@mui/material/Box';
import PageHeader from '../components/PageHeader';
import AllocationSection from './dashboard/AllocationSection';
import AtRiskSection from './dashboard/AtRiskSection';
import BudgetSection from './dashboard/BudgetSection';
import DeliverablesSection from './dashboard/DeliverablesSection';
import DependencySection from './dashboard/DependencySection';
import OverAllocatedSection from './dashboard/OverAllocatedSection';
import ProjectStatusSection from './dashboard/ProjectStatusSection';
import SummaryTiles from './dashboard/SummaryTiles';

/**
 * The Dashboard: headline counts, then one section per business question in a fixed order:
 * status, risk, allocation, deliverables, over-allocation, dependencies and budget. Every
 * section loads on its own, so a slow or failing one never holds up the rest.
 *
 * @returns {JSX.Element} The dashboard page.
 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Project health, deadline risk, people and budget across ACME, as of today."
      />
      <SummaryTiles />
      <Box sx={{ display: 'grid', gap: 3 }}>
        <ProjectStatusSection />
        <AtRiskSection />
        <AllocationSection />
        <DeliverablesSection />
        <OverAllocatedSection />
        <DependencySection />
        <BudgetSection />
      </Box>
    </>
  );
}
