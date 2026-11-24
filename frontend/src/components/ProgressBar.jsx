import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { formatPercent } from '../utils/format';

/**
 * A labelled percentage bar. The bar stops at 100% but the text shows the real figure, and the
 * bar turns red above 100% (e.g. a budget overspend).
 *
 * @param {object} props Component props.
 * @param {number|null} props.value Percentage; null or undefined shows an em dash.
 * @param {string} props.label Accessible name, e.g. "Mobile Banking App percent complete".
 * @param {string} [props.valueText] Visible text instead of the percentage.
 * @param {boolean} [props.showLabel] Also show the label above the bar.
 * @param {string} [props.color] Palette colour; defaults to primary, or overdue above 100%.
 * @returns {JSX.Element} The bar with its text.
 */
export default function ProgressBar({ value, label, valueText, showLabel = false, color }) {
  const number = value === null || value === undefined ? NaN : Number(value);
  if (!Number.isFinite(number)) {
    return <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  const text = valueText ?? formatPercent(number);
  const barColor = color ?? (number > 100 ? 'overdue' : 'primary');

  return (
    <Box sx={{ minWidth: 120 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
        {showLabel && <Typography variant="body2" color="text.secondary">{label}</Typography>}
        <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{text}</Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, Math.max(0, number))}
        color={barColor}
        aria-label={label}
        aria-valuetext={text}
      />
    </Box>
  );
}

ProgressBar.propTypes = {
  value: PropTypes.number,
  label: PropTypes.string.isRequired,
  valueText: PropTypes.string,
  showLabel: PropTypes.bool,
  color: PropTypes.string,
};
