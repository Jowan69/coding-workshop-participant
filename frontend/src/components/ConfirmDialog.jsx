import { useId, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';

/**
 * Ask before an irreversible action. While `onConfirm` runs, both buttons are disabled and the
 * dialog cannot be dismissed. The dialog closes itself only if `onConfirm` resolves.
 *
 * @param {object} props Component props.
 * @param {boolean} props.open Whether the dialog is shown.
 * @param {string} props.title Question, e.g. "Delete project?".
 * @param {React.ReactNode} props.message What will happen.
 * @param {string} [props.confirmLabel] Confirm button text.
 * @param {boolean} [props.destructive] Red confirm button.
 * @param {() => (Promise<void>|void)} props.onConfirm Action to run.
 * @param {() => void} props.onClose Called to close the dialog.
 * @returns {JSX.Element} The dialog.
 */
export default function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', destructive = false, onConfirm, onClose,
}) {
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const messageId = useId();

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // The caller reports the failure (e.g. a snackbar); keep the dialog open to retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText id={messageId}>{message}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          onClick={handleConfirm}
          disabled={busy}
          variant="contained"
          color={destructive ? 'error' : 'primary'}
        >
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

ConfirmDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  message: PropTypes.node.isRequired,
  confirmLabel: PropTypes.string,
  destructive: PropTypes.bool,
  onConfirm: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
