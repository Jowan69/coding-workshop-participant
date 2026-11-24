import { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useIsDesktop } from '../hooks/useIsDesktop';

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
  if (field.type === 'date' && !DATE_RE.test(value)) return `${field.label} must be a valid date`;
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
 * (the user cleared it), otherwise left out so the API applies its default.
 */
function toPayload(fields, values, initial) {
  const payload = {};
  fields.forEach((field) => {
    const value = clean(field, values[field.name]);
    if (value === '') {
      if (initial[field.name] !== '') payload[field.name] = null;
      return;
    }
    payload[field.name] = typedValue(field, value);
  });
  return payload;
}

function FieldInput({ field, value, error, disabled, onChange, inputRef }) {
  const common = {
    label: field.label,
    required: Boolean(field.required),
    error: Boolean(error),
    helperText: error || field.helperText || ' ',
    disabled,
    fullWidth: true,
    inputRef,
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
  } else if (field.type === 'password') {
    // A new password for someone else: never let the browser fill in the admin's own.
    htmlInput = { autoComplete: 'new-password' };
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
};

/**
 * A create or edit form in a dialog, built from a field spec. Validates before submit and
 * shows each error next to its field, maps the API's field errors onto the same fields, and
 * disables everything while saving. Full-screen on phones.
 *
 * @param {object} props Component props.
 * @param {boolean} props.open Whether the dialog is shown; opening resets the form.
 * @param {string} props.title Dialog title, e.g. "New project".
 * @param {object[]} props.fields Field specs: name, label, type (text, number, date, email,
 *   password, select, autocomplete), required, options (select and picker options are sent
 *   with their own type), freeSolo, multiline, minLength, maxLength, min, max, decimals,
 *   validate(value, values) and half (half width on desktop).
 * @param {object} [props.initialValues] Record being edited.
 * @param {(payload: object) => Promise<void>} props.onSubmit Saves; reject with an ApiError to
 *   show its errors. The dialog closes when it resolves.
 * @param {() => void} props.onClose Called to close the dialog.
 * @param {string} [props.submitLabel] Submit button text.
 * @returns {JSX.Element} The dialog.
 */
export default function FormDialog({
  open, title, fields, initialValues, onSubmit, onClose, submitLabel = 'Save',
}) {
  const isDesktop = useIsDesktop();
  const titleId = useId();
  const inputRefs = useRef({});
  const [initial, setInitial] = useState(() => toFormValues(fields, initialValues));
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [focusTarget, setFocusTarget] = useState(null);

  // Reset the form each time the dialog opens (adjusting state during render).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const fresh = toFormValues(fields, initialValues);
      setInitial(fresh);
      setValues(fresh);
      setErrors({});
      setFormError(null);
      setFocusTarget(null);
    }
  }

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

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError(null);
    const clientErrors = validateAll(fields, values);
    if (Object.keys(clientErrors).length > 0) {
      showErrors(clientErrors);
      return;
    }
    setFocusTarget(null);
    setSaving(true);
    try {
      await onSubmit(toPayload(fields, values, initial));
      onClose();
    } catch (error) {
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
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
        {formError && <Alert severity="error" sx={{ mb: 2 }}>{formError}</Alert>}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: isDesktop ? '1fr 1fr' : '1fr',
            columnGap: 2,
            rowGap: 1,
          }}
        >
          {fields.map((field) => (
            <Box key={field.name} sx={{ gridColumn: field.half && isDesktop ? 'auto' : '1 / -1' }}>
              <FieldInput
                field={field}
                value={values[field.name] ?? ''}
                error={errors[field.name]}
                disabled={saving}
                onChange={(value) => setValue(field.name, value)}
                inputRef={(element) => { inputRefs.current[field.name] = element; }}
              />
            </Box>
          ))}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </DialogActions>
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
};
