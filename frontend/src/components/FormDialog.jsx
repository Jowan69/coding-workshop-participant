import { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useIsDesktop } from '../hooks/useIsDesktop';
import { createIdempotencyKey } from '../services/apiClient';
import { DATE_MAX, DATE_MIN, formatDate } from '../utils/format';
import { STALE_MESSAGE } from '../utils/staleness';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Input types passed straight to the TextField; everything else is a plain text box. */
const NATIVE_TYPES = new Set(['number', 'date', 'email', 'password']);

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function toFormValues(fields, initialValues = {}) {
  return Object.fromEntries(fields.map((field) => {
    const value = initialValues[field.name] ?? field.defaultValue;
    return [field.name, value === null || value === undefined ? '' : String(value)];
  }));
}

/** Passwords keep their surrounding spaces (the API does not strip them); the rest is trimmed. */
function clean(field, raw) {
  const text = String(raw ?? '');
  return field.type === 'password' ? text : text.trim();
}

function decimalPlaces(text) {
  const [, fraction = ''] = String(text).split('.');
  return fraction.length;
}

/**
 * Check one field. Returns an error message, or null when the value is acceptable.
 *
 * @param {object} field Field spec.
 * @param {string} raw Current form value.
 * @param {Object<string, string>} values All form values, for cross-field rules.
 * @returns {string|null} Error message.
 */
function validateField(field, raw, values) {
  if (isBlank(raw)) return field.required ? `${field.label} is required` : null;
  const value = clean(field, raw);
  if (field.minLength && value.length < field.minLength) {
    return `${field.label} must be at least ${field.minLength} characters`;
  }
  if (field.maxLength && value.length > field.maxLength) {
    return `${field.label} must be at most ${field.maxLength} characters`;
  }
  if (field.type === 'email' && !EMAIL_RE.test(value)) {
    return `${field.label} must be a valid email address`;
  }
  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return `${field.label} must be a number`;
    if (field.min !== undefined && number < field.min) {
      return `${field.label} must be at least ${field.min}`;
    }
    if (field.max !== undefined && number > field.max) {
      return `${field.label} must be at most ${field.max}`;
    }
    if (field.decimals !== undefined && decimalPlaces(value) > field.decimals) {
      return field.decimals === 0
        ? `${field.label} must be a whole number`
        : `${field.label} can have at most ${field.decimals} decimal places`;
    }
  }
  if (field.type === 'date') {
    if (!DATE_RE.test(value)) return `${field.label} must be a valid date`;
    if (value < DATE_MIN || value > DATE_MAX) {
      return `${field.label} must be between ${formatDate(DATE_MIN)} and ${formatDate(DATE_MAX)}`;
    }
  }
  return field.validate?.(value, values) ?? null;
}

function validateAll(fields, values) {
  return Object.fromEntries(
    fields
      .map((field) => [field.name, validateField(field, values[field.name], values)])
      .filter(([, message]) => message),
  );
}

/**
 * The typed value to send. The form holds strings, so a select or picker option is mapped
 * back to its own value (the API rejects "7" for an id and "true" for a boolean).
 */
function typedValue(field, value) {
  if (field.type === 'number') return Number(value);
  if (field.type === 'select' || (field.type === 'autocomplete' && !field.freeSolo)) {
    const option = (field.options ?? []).find(
      (item) => typeof item === 'object' && String(item.value) === value,
    );
    return option ? option.value : value;
  }
  return value;
}

/**
 * The request body: typed values; a blank field is sent as null only if it started non-blank
 * (the user cleared it), otherwise left out so the API applies its default. With
 * `changesOnly` (an edit) only the fields the user changed are included.
 */
function toPayload(fields, values, initial, changesOnly) {
  const payload = {};
  fields.forEach((field) => {
    const value = clean(field, values[field.name]);
    if (changesOnly && value === clean(field, initial[field.name])) return;
    if (value === '') {
      if (initial[field.name] !== '') payload[field.name] = null;
      return;
    }
    payload[field.name] = typedValue(field, value);
  });
  return payload;
}

function FieldInput({ field, value, error, disabled, onChange, inputRef, autoFocus }) {
  const common = {
    label: field.label,
    required: Boolean(field.required),
    error: Boolean(error),
    helperText: error || field.helperText || ' ',
    disabled,
    fullWidth: true,
    inputRef,
    autoFocus,
  };

  if (field.type === 'autocomplete') {
    const options = field.options ?? [];
    if (field.freeSolo) {
      return (
        <Autocomplete
          freeSolo
          options={options.map((option) => (typeof option === 'string' ? option : option.label))}
          inputValue={value}
          onInputChange={(event, next) => onChange(next ?? '')}
          disabled={disabled}
          renderInput={(params) => <TextField {...params} {...common} name={field.name} />}
        />
      );
    }
    const selected = options.find((option) => String(option.value) === value) ?? null;
    return (
      <Autocomplete
        options={options}
        value={selected}
        onChange={(event, option) => onChange(option ? String(option.value) : '')}
        getOptionLabel={(option) => option.label}
        isOptionEqualToValue={(option, current) => option.value === current.value}
        disabled={disabled}
        renderInput={(params) => <TextField {...params} {...common} name={field.name} />}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <TextField
        {...common}
        select
        name={field.name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {!field.required && <MenuItem value=""><em>None</em></MenuItem>}
        {(field.options ?? []).map((option) => (
          <MenuItem key={option.value} value={String(option.value)}>{option.label}</MenuItem>
        ))}
      </TextField>
    );
  }

  let htmlInput = {};
  if (field.type === 'number') {
    htmlInput = { min: field.min, max: field.max, step: field.step ?? 'any', inputMode: 'decimal' };
  } else if (field.type === 'date') {
    htmlInput = { min: DATE_MIN, max: DATE_MAX };
  } else if (field.type === 'password') {
    // A new password for someone else: never let the browser fill in the admin's own.
    htmlInput = { autoComplete: field.autoComplete ?? 'new-password', maxLength: field.maxLength };
  } else if (field.type === 'email') {
    htmlInput = { autoComplete: 'off' };
  }
  return (
    <TextField
      {...common}
      name={field.name}
      type={NATIVE_TYPES.has(field.type) ? field.type : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      multiline={Boolean(field.multiline)}
      minRows={field.multiline ? (field.minRows ?? 3) : undefined}
      slotProps={{
        htmlInput,
        inputLabel: field.type === 'date' ? { shrink: true } : undefined,
      }}
    />
  );
}

const optionShape = PropTypes.oneOfType([
  PropTypes.string,
  PropTypes.shape({
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.number, PropTypes.bool]).isRequired,
    label: PropTypes.string.isRequired,
  }),
]);

const fieldShape = PropTypes.shape({
  name: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  type: PropTypes.oneOf([
    'text', 'number', 'date', 'email', 'password', 'select', 'autocomplete',
  ]).isRequired,
  required: PropTypes.bool,
  options: PropTypes.arrayOf(optionShape),
  freeSolo: PropTypes.bool,
  multiline: PropTypes.bool,
  minRows: PropTypes.number,
  minLength: PropTypes.number,
  maxLength: PropTypes.number,
  min: PropTypes.number,
  max: PropTypes.number,
  step: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  decimals: PropTypes.number,
  validate: PropTypes.func,
  helperText: PropTypes.string,
  autoComplete: PropTypes.string,
  defaultValue: PropTypes.oneOfType([PropTypes.string, PropTypes.number, PropTypes.bool]),
  half: PropTypes.bool,
});

FieldInput.propTypes = {
  field: fieldShape.isRequired,
  value: PropTypes.string.isRequired,
  error: PropTypes.string,
  disabled: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  inputRef: PropTypes.func.isRequired,
  autoFocus: PropTypes.bool,
};

/**
 * A create or edit form in a dialog, built from a field spec. Validates before submit and
 * shows each error next to its field, and maps the API's field errors onto the same fields.
 * Full-screen on phones.
 *
 * Saving once: from the first click the form is disabled, and after a success it stays
 * disabled while the dialog closes, so a second click can never save twice. It is enabled
 * again when a save fails and the next time the dialog opens; a ref guards the same tick.
 * Each opening also gets one Idempotency-Key, passed to `onSubmit` and reused when the user
 * retries, so even a retry after a lost response creates one record.
 *
 * Closing: a form with unsaved edits asks "Discard changes?" before it closes by Esc, a click
 * outside or Cancel; an untouched form closes at once. It opens with focus on its first field.
 *
 * Editing (`changesOnly`): only the fields the user changed are sent, with
 * `expected_updated_at` from the record. If the API answers 409 stale_record and `onReload`
 * is given, the form says "This was changed by someone else" with a Reload button, which
 * fetches the record and refills the form with the fresh values.
 *
 * @param {object} props Component props.
 * @param {boolean} props.open Whether the dialog is shown; opening resets the form.
 * @param {string} props.title Dialog title, e.g. "New project".
 * @param {object[]} props.fields Field specs: name, label, type (text, number, date, email,
 *   password, select, autocomplete), required, options (select and picker options are sent
 *   with their own type), freeSolo, multiline, minLength, maxLength, min, max, decimals,
 *   validate(value, values) and half (half width on desktop).
 * @param {object} [props.initialValues] Record being edited.
 * @param {(payload: object, context: {idempotencyKey: string, handlesStale: boolean}) =>
 *   Promise<void>} props.onSubmit Saves; reject with an ApiError to show its errors. The
 *   dialog closes when it resolves. Pass `context` on to useApiMutation.
 * @param {() => void} props.onClose Called to close the dialog.
 * @param {string} [props.submitLabel] Submit button text.
 * @param {boolean} [props.changesOnly] Editing a record: send only the changed fields and
 *   `expected_updated_at`; an unchanged form just closes.
 * @param {() => Promise<object>} [props.onReload] Fetches the record again after a
 *   stale_record; the form is refilled with what it resolves to.
 * @returns {JSX.Element} The dialog.
 */
export default function FormDialog({
  open, title, fields, initialValues, onSubmit, onClose, submitLabel = 'Save',
  changesOnly = false, onReload,
}) {
  const isDesktop = useIsDesktop();
  const titleId = useId();
  const inputRefs = useRef({});
  const submitting = useRef(false);
  const idempotencyKey = useRef(null);
  const [initial, setInitial] = useState(() => toFormValues(fields, initialValues));
  const [values, setValues] = useState(initial);
  const [base, setBase] = useState(initialValues ?? null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [focusTarget, setFocusTarget] = useState(null);
  const discardTitleId = useId();
  const discardTextId = useId();

  // Reset the form each time the dialog opens (adjusting state during render).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const fresh = toFormValues(fields, initialValues);
      setInitial(fresh);
      setValues(fresh);
      setBase(initialValues ?? null);
      setErrors({});
      setFormError(null);
      setFocusTarget(null);
      setSaving(false);
      setStale(false);
      setConfirmingDiscard(false);
    }
  }

  // Each opening may save once, under its own Idempotency-Key.
  useEffect(() => {
    if (open) {
      submitting.current = false;
      idempotencyKey.current = null;
    }
  }, [open]);

  // Move focus to the first invalid field once the inputs are enabled again.
  useEffect(() => {
    if (focusTarget && !saving) inputRefs.current[focusTarget.name]?.focus();
  }, [focusTarget, saving]);

  const setValue = (name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
  };

  const showErrors = (nextErrors) => {
    setErrors(nextErrors);
    const first = fields.find((field) => nextErrors[field.name]);
    setFocusTarget(first ? { name: first.name } : null);
  };

  const dirty = fields.some(
    (field) => clean(field, values[field.name]) !== clean(field, initial[field.name]),
  );

  // Esc, a click outside and Cancel all come here: unsaved edits are never lost silently.
  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };

  const discard = () => {
    setConfirmingDiscard(false);
    onClose();
  };

  const handleReload = async () => {
    setReloading(true);
    setFormError(null);
    try {
      const record = await onReload();
      const fresh = toFormValues(fields, record);
      setBase(record);
      setInitial(fresh);
      setValues(fresh);
      setErrors({});
      setStale(false);
    } catch (error) {
      setFormError(error?.message || 'Could not reload. Please try again.');
    } finally {
      setReloading(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting.current || stale) return;
    setFormError(null);
    const clientErrors = validateAll(fields, values);
    if (Object.keys(clientErrors).length > 0) {
      showErrors(clientErrors);
      return;
    }
    setFocusTarget(null);
    const payload = toPayload(fields, values, initial, changesOnly);
    if (changesOnly) {
      if (Object.keys(payload).length === 0) {
        onClose(); // nothing was changed, so there is nothing to save
        return;
      }
      if (base?.updated_at) payload.expected_updated_at = base.updated_at;
    }
    submitting.current = true;
    setSaving(true);
    idempotencyKey.current ??= createIdempotencyKey();
    try {
      await onSubmit(payload, {
        idempotencyKey: idempotencyKey.current,
        handlesStale: Boolean(onReload),
      });
      // Still "saving": the buttons stay disabled until the dialog has closed.
      onClose();
    } catch (error) {
      submitting.current = false;
      setSaving(false);
      if (error?.code === 'stale_record' && onReload) {
        setStale(true);
        return;
      }
      const serverErrors = {};
      const otherErrors = [];
      Object.entries(error?.fieldErrors ?? {}).forEach(([name, message]) => {
        const field = fields.find((item) => item.name === name);
        if (field) serverErrors[name] = `${field.label} ${message}`;
        else otherErrors.push(`${name} ${message}`);
      });
      showErrors(serverErrors);
      if (otherErrors.length > 0 || Object.keys(serverErrors).length === 0) {
        const detail = otherErrors.length > 0 ? ` (${otherErrors.join('; ')})` : '';
        setFormError(`${error?.message || 'Could not save'}${detail}`);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      fullScreen={!isDesktop}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
      slotProps={{ paper: { component: 'form', onSubmit: handleSubmit, noValidate: true } }}
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Fields marked * are required.
        </Typography>
        {stale && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={(
              <Button color="inherit" size="small" onClick={handleReload} disabled={reloading}>
                {reloading ? 'Reloading…' : 'Reload'}
              </Button>
            )}
          >
            {`${STALE_MESSAGE}. Reload to see the latest values; your unsaved edits will be replaced.`}
          </Alert>
        )}
        {formError && <Alert severity="error" sx={{ mb: 2 }}>{formError}</Alert>}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: isDesktop ? '1fr 1fr' : '1fr',
            columnGap: 2,
            rowGap: 1,
          }}
        >
          {fields.map((field, index) => (
            <Box key={field.name} sx={{ gridColumn: field.half && isDesktop ? 'auto' : '1 / -1' }}>
              <FieldInput
                field={field}
                value={values[field.name] ?? ''}
                error={errors[field.name]}
                disabled={saving}
                onChange={(value) => setValue(field.name, value)}
                inputRef={(element) => { inputRefs.current[field.name] = element; }}
                autoFocus={index === 0}
              />
            </Box>
          ))}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={requestClose} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving || stale}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </DialogActions>
      <Dialog
        open={confirmingDiscard}
        onClose={() => setConfirmingDiscard(false)}
        aria-labelledby={discardTitleId}
        aria-describedby={discardTextId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={discardTitleId}>Discard changes?</DialogTitle>
        <DialogContent>
          <DialogContentText id={discardTextId}>
            What you changed in this form has not been saved.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmingDiscard(false)} autoFocus>Keep editing</Button>
          <Button onClick={discard} color="error" variant="contained">Discard changes</Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

FormDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  fields: PropTypes.arrayOf(fieldShape).isRequired,
  initialValues: PropTypes.object,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  submitLabel: PropTypes.string,
  changesOnly: PropTypes.bool,
  onReload: PropTypes.func,
};
