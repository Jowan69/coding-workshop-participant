import PropTypes from 'prop-types';
import Typography from '@mui/material/Typography';
import { formatDate } from '../utils/format';

/**
 * Says which day "overdue" was judged on. The API decides what is overdue with the
 * database's date (UTC), the same clock for every list, page and Dashboard section, so near
 * midnight it can differ from the date on the viewer's own clock.
 *
 * @param {object} props Component props.
 * @param {string|null} [props.date] The API's `as_of` date (`YYYY-MM-DD`); nothing is shown
 *   without it.
 * @returns {JSX.Element|null} The note.
 */
export default function AsOfNote({ date }) {
  if (!date) return null;
  return (
    <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
      {`Overdue as of ${formatDate(date)} (UTC)`}
    </Typography>
  );
}

AsOfNote.propTypes = {
  date: PropTypes.string,
};
