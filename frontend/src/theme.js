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

/**
 * Long unbroken values (a 150-character name, an email, a description without spaces) must
 * wrap inside their box instead of widening the page. Three rules, set once here:
 *
 * - `body` inherits `overflow-wrap: break-word` to all text, which wraps wherever a box has a
 *   width to wrap at. Flex and grid children need `min-width: 0` for that (their automatic
 *   minimum is the longest word), which the layout components set.
 * - Table cells, headings, dialog titles and menu items use `anywhere`, which also lets a
 *   table column or a flex item shrink below its longest word.
 * - Table headings do not wrap, so a column never gets narrower than its label.
 */
const WRAP_ANYWHERE = { overflowWrap: 'anywhere' };

/** For a chip whose label is user text (a reason, deliverable names): wrap, never truncate. */
export const WRAPPING_CHIP_SX = {
  maxWidth: '100%',
  height: 'auto',
  '& .MuiChip-label': { whiteSpace: 'normal', overflowWrap: 'anywhere', py: 0.25 },
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
        body: { overflowWrap: 'break-word' },
        // One visible focus ring for keyboard users everywhere, never removed.
        ':focus-visible': {
          outline: `3px solid ${FOCUS_RING}`,
          outlineOffset: 2,
        },
        // InputBase removes the outline on :focus. Outlined fields still show focus with their
        // border, but borderless selects (deliverable status, rows per page) would show nothing.
        '.MuiInputBase-root:not(.MuiOutlinedInput-root) .MuiSelect-select:focus-visible': {
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
        root: WRAP_ANYWHERE,
        head: {
          fontWeight: 600,
          color: base.palette.text.secondary,
          backgroundColor: '#f8fafc',
          whiteSpace: 'nowrap',
        },
      },
    },
    MuiTypography: {
      styleOverrides: {
        h1: WRAP_ANYWHERE,
        h2: WRAP_ANYWHERE,
        h3: WRAP_ANYWHERE,
        h4: WRAP_ANYWHERE,
        h5: WRAP_ANYWHERE,
        h6: WRAP_ANYWHERE,
        subtitle1: WRAP_ANYWHERE,
        subtitle2: WRAP_ANYWHERE,
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
      },
    },
    MuiAutocomplete: {
      styleOverrides: {
        option: WRAP_ANYWHERE,
      },
    },
    MuiChip: {
      styleOverrides: {
        // A chip never grows wider than its container; its label then truncates or, with
        // WRAPPING_CHIP_SX, wraps.
        root: { fontWeight: 600, maxWidth: '100%' },
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
      styleOverrides: { root: { fontSize: '1.25rem', fontWeight: 600, overflowWrap: 'anywhere' } },
    },
  },
});

export default theme;
