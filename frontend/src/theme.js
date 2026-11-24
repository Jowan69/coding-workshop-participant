import { createTheme } from '@mui/material/styles';

/**
 * Status colours. Each one passes WCAG AA (4.5:1) against white text, and the UI never shows
 * a status by colour alone: StatusChip always adds an icon and a label.
 */
export const STATUS_COLORS = {
  onTrack: '#2e7d32',
  atRisk: '#b45309',
  overdue: '#c62828',
  done: '#455a64',
};

const FOCUS_RING = '#f5a623';
const FONT_STACK = [
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  'system-ui',
  '-apple-system',
  'sans-serif',
].join(',');

const base = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1f4e79', contrastText: '#ffffff' },
    secondary: { main: '#00695c', contrastText: '#ffffff' },
    error: { main: STATUS_COLORS.overdue },
    warning: { main: STATUS_COLORS.atRisk },
    success: { main: STATUS_COLORS.onTrack },
    background: { default: '#f4f6f9', paper: '#ffffff' },
    text: { primary: '#1c2733', secondary: '#4a5868' },
    divider: '#dde3ea',
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: FONT_STACK,
    h1: { fontSize: '2rem', fontWeight: 600, lineHeight: 1.25 },
    h2: { fontSize: '1.625rem', fontWeight: 600, lineHeight: 1.3 },
    h3: { fontSize: '1.375rem', fontWeight: 600, lineHeight: 1.35 },
    h4: { fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.4 },
    h5: { fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.4 },
    h6: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.5 },
    subtitle1: { fontSize: '1rem', fontWeight: 500 },
    subtitle2: { fontSize: '0.875rem', fontWeight: 600 },
    body1: { fontSize: '1rem', lineHeight: 1.5 },
    body2: { fontSize: '0.875rem', lineHeight: 1.5 },
    caption: { fontSize: '0.75rem', lineHeight: 1.4 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
});

const augment = (name) => base.palette.augmentColor({
  color: { main: STATUS_COLORS[name], contrastText: '#ffffff' },
  name,
});

/** The one Material UI theme for the app. */
const theme = createTheme(base, {
  palette: {
    onTrack: augment('onTrack'),
    atRisk: augment('atRisk'),
    overdue: augment('overdue'),
    done: augment('done'),
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        // One visible focus ring for keyboard users everywhere, never removed.
        ':focus-visible': {
          outline: `3px solid ${FOCUS_RING}`,
          outlineOffset: 2,
        },
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            transitionDuration: '0.01ms !important',
          },
        },
      },
    },
    MuiButtonBase: {
      styleOverrides: {
        root: {
          '&.Mui-focusVisible': {
            outline: `3px solid ${FOCUS_RING}`,
            outlineOffset: 2,
          },
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'primary' },
    },
    MuiPaper: {
      styleOverrides: {
        outlined: { borderColor: base.palette.divider },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          fontWeight: 600,
          color: base.palette.text.secondary,
          backgroundColor: '#f8fafc',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600 },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { height: 8, borderRadius: 4, backgroundColor: '#e3e8ee' },
        bar: { borderRadius: 4 },
      },
    },
    MuiDialogTitle: {
      defaultProps: { component: 'h2' },
      styleOverrides: { root: { fontSize: '1.25rem', fontWeight: 600 } },
    },
  },
});

export default theme;
