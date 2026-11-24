import { useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import DashboardIcon from '@mui/icons-material/Dashboard';
import FolderIcon from '@mui/icons-material/Folder';
import GroupsIcon from '@mui/icons-material/Groups';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import { useAuth } from '../context/auth-context';
import { useIsDesktop } from '../hooks/useIsDesktop';
import { ROLE_LABELS } from '../utils/permissions';

const DRAWER_WIDTH = 240;
const MAIN_ID = 'main-content';
const NAV_ID = 'main-navigation';

/** Navigation items and the permission each one needs. */
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon, action: 'read', exact: true },
  { to: '/projects', label: 'Projects', icon: FolderIcon, action: 'read' },
  { to: '/resources', label: 'Resources', icon: GroupsIcon, action: 'read' },
  { to: '/users', label: 'Users', icon: AdminPanelSettingsIcon, action: 'manageUsers' },
];

function isActive(item, pathname) {
  return item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * The signed-in shell: app bar, navigation drawer (permanent on desktop, a menu on phones) and
 * the main landmark that pages render into. Navigation the role cannot use is not rendered.
 *
 * @returns {JSX.Element} The layout with the current page.
 */
export default function AppLayout() {
  const { user, role, logout, can } = useAuth();
  const isDesktop = useIsDesktop();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  // HashRouter owns the URL hash, so the skip link moves focus itself instead of using #id.
  const skipToMain = (event) => {
    event.preventDefault();
    document.getElementById(MAIN_ID)?.focus();
  };

  const navigation = (
    <Box component="nav" aria-label="Main navigation" id={NAV_ID}>
      <Toolbar />
      <List>
        {NAV_ITEMS.filter((item) => can(item.action)).map((item) => {
          const active = isActive(item, pathname);
          return (
            <ListItem key={item.to} disablePadding>
              <ListItemButton
                component={RouterLink}
                to={item.to}
                selected={active}
                aria-current={active ? 'page' : undefined}
                onClick={() => setMenuOpen(false)}
              >
                <ListItemIcon><item.icon aria-hidden="true" /></ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </Box>
  );

  const roleLabel = ROLE_LABELS[role] ?? role;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box
        component="a"
        href={`#${MAIN_ID}`}
        onClick={skipToMain}
        sx={{
          position: 'absolute',
          left: 16,
          top: -100,
          zIndex: (theme) => theme.zIndex.tooltip + 1,
          px: 2,
          py: 1,
          bgcolor: 'background.paper',
          color: 'primary.main',
          fontWeight: 600,
          borderRadius: 1,
          boxShadow: 3,
          '&:focus': { top: 8 },
        }}
      >
        Skip to main content
      </Box>

      <AppBar
        position="fixed"
        component="header"
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {!isDesktop && (
            <IconButton
              color="inherit"
              edge="start"
              aria-label="Open navigation"
              aria-controls={NAV_ID}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" component="p" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            ACME Project Tracker
          </Typography>
          {isDesktop && (
            <Typography variant="body2" component="span" noWrap>
              {user?.full_name}
            </Typography>
          )}
          <Chip
            label={roleLabel}
            size="small"
            aria-label={`Role: ${roleLabel}`}
            sx={{ bgcolor: 'rgba(255, 255, 255, 0.18)', color: 'common.white' }}
          />
          {isDesktop ? (
            <Button color="inherit" startIcon={<LogoutIcon />} onClick={handleLogout}>
              Sign out
            </Button>
          ) : (
            <IconButton color="inherit" edge="end" aria-label="Sign out" onClick={handleLogout}>
              <LogoutIcon />
            </IconButton>
          )}
        </Toolbar>
      </AppBar>

      {isDesktop ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
          }}
        >
          {navigation}
        </Drawer>
      ) : (
        <Drawer
          variant="temporary"
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' } }}
        >
          {navigation}
        </Drawer>
      )}

      <Box
        component="main"
        id={MAIN_ID}
        tabIndex={-1}
        sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, md: 3 }, '&:focus': { outline: 'none' } }}
      >
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
