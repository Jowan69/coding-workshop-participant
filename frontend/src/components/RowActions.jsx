import PropTypes from 'prop-types';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';

/**
 * The edit and delete buttons of a list row. Leave a handler out when the role cannot use it,
 * so the button is not rendered. Extra row actions go in `children`, before edit and delete.
 *
 * @param {object} props Component props.
 * @param {string} props.name What the row is, for the accessible names ("Edit Website").
 * @param {() => void} [props.onEdit] Opens the edit form.
 * @param {() => void} [props.onDelete] Asks to delete.
 * @param {React.ReactNode} [props.children] Other actions.
 * @returns {JSX.Element} The buttons.
 */
export default function RowActions({ name, onEdit, onDelete, children }) {
  return (
    <>
      {children}
      {onEdit && (
        <Tooltip title="Edit" describeChild>
          <IconButton aria-label={`Edit ${name}`} onClick={onEdit}>
            <EditOutlinedIcon />
          </IconButton>
        </Tooltip>
      )}
      {onDelete && (
        <Tooltip title="Delete" describeChild>
          <IconButton aria-label={`Delete ${name}`} color="error" onClick={onDelete}>
            <DeleteOutlinedIcon />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}

RowActions.propTypes = {
  name: PropTypes.string.isRequired,
  onEdit: PropTypes.func,
  onDelete: PropTypes.func,
  children: PropTypes.node,
};
