import PropTypes from 'prop-types';
import Chip from '@mui/material/Chip';
import { STATUS_META, statusLabel } from '../utils/status';

/**
 * A status shown as colour, icon and label together, so it never relies on colour alone.
 *
 * @param {object} props Component props.
 * @param {string} props.status API status value, e.g. "on_hold" or "overdue".
 * @param {'small'|'medium'} [props.size] Chip size.
 * @returns {JSX.Element} The chip.
 */
export default function StatusChip({ status, size = 'small' }) {
  const meta = STATUS_META[status];
  const icon = meta ? <meta.icon aria-hidden="true" /> : undefined;
  return (
    <Chip
      size={size}
      color={meta?.color ?? 'default'}
      icon={icon}
      label={statusLabel(status)}
    />
  );
}

StatusChip.propTypes = {
  status: PropTypes.string.isRequired,
  size: PropTypes.oneOf(['small', 'medium']),
};
