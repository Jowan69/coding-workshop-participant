import PropTypes from 'prop-types';
import Typography from '@mui/material/Typography';
import { formatCurrency } from '../utils/format';
import ProgressBar from './ProgressBar';

/**
 * Spent against planned as a bar, e.g. "$120,000 of $100,000 (120%)". The bar turns red past
 * 100%. Without a planned budget it says how much was spent instead.
 *
 * @param {object} props Component props.
 * @param {number|null} props.planned Planned budget.
 * @param {number|null} props.spent Amount spent; null or undefined shows an em dash.
 * @param {string} props.label Accessible name, e.g. "Website budget used".
 * @param {boolean} [props.showLabel] Also show the label above the bar.
 * @returns {JSX.Element} The bar or a sentence.
 */
export default function BudgetBar({ planned, spent, label, showLabel = false }) {
  if (spent === null || spent === undefined) {
    return <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  const plannedAmount = Number(planned ?? 0);
  if (!(plannedAmount > 0)) {
    return <Typography variant="body2">{`${formatCurrency(spent)} spent, no budget set`}</Typography>;
  }
  const percent = (Number(spent) / plannedAmount) * 100;
  return (
    <ProgressBar
      value={percent}
      label={label}
      showLabel={showLabel}
      valueText={`${formatCurrency(spent)} of ${formatCurrency(plannedAmount)} (${Math.round(percent)}%)`}
    />
  );
}

BudgetBar.propTypes = {
  planned: PropTypes.number,
  spent: PropTypes.number,
  label: PropTypes.string.isRequired,
  showLabel: PropTypes.bool,
};
