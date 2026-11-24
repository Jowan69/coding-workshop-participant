import PropTypes from 'prop-types';
import { formatPercent } from '../utils/format';
import ProgressBar from './ProgressBar';

/** Above this total a person is booked for more than full time. */
const FULL_TIME_PCT = 100;

/**
 * A person's total allocation as a bar. Above 100% it switches to the warning style: an amber
 * bar and the words "over-allocated", so the state never relies on colour alone.
 *
 * @param {object} props Component props.
 * @param {number|null} props.value Total allocation in percent of full time.
 * @param {string} props.name Person's name, for the accessible label.
 * @returns {JSX.Element} The bar.
 */
export default function AllocationBar({ value, name }) {
  const over = Number(value) > FULL_TIME_PCT;
  return (
    <ProgressBar
      value={value}
      label={`${name} allocation today`}
      color={over ? 'warning' : 'primary'}
      valueText={over ? `${formatPercent(value)}, over-allocated` : undefined}
    />
  );
}

AllocationBar.propTypes = {
  value: PropTypes.number,
  name: PropTypes.string.isRequired,
};
