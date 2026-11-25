import PropTypes from 'prop-types';
import { useAuth } from '../context/auth-context';
import { useNotify } from '../context/notification-context';
import { changePasswordFields } from '../pages/passwordFields';
import FormDialog from './FormDialog';

const FIELDS = changePasswordFields();

/**
 * "Change password" from the account menu: the current password, then the new one twice.
 * On success the session gets fresh tokens (the user stays signed in; other devices are
 * signed out). A wrong current password or a refused new one shows next to its field.
 *
 * @param {object} props Component props.
 * @param {boolean} props.open Whether the dialog is shown.
 * @param {() => void} props.onClose Called to close the dialog.
 * @returns {JSX.Element} The dialog.
 */
export default function ChangePasswordDialog({ open, onClose }) {
  const { changePassword } = useAuth();
  const notify = useNotify();

  const handleSubmit = async (payload) => {
    await changePassword(payload.current_password, payload.new_password);
    notify('Password changed. Other devices were signed out.', 'success');
  };

  return (
    <FormDialog
      open={open}
      title="Change password"
      fields={FIELDS}
      onSubmit={handleSubmit}
      onClose={onClose}
      submitLabel="Change password"
    />
  );
}

ChangePasswordDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
