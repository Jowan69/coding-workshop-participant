import { useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tooltip from '@mui/material/Tooltip';
import HowToRegIcon from '@mui/icons-material/HowToReg';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import PersonOffIcon from '@mui/icons-material/PersonOff';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FormDialog from '../components/FormDialog';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { ROLE_LABELS, ROLE_OPTIONS } from '../utils/permissions';
import { userFields } from './userFields';

const FIELDS = userFields();
const CLOSED = { open: false, record: null };
const OWN_ROLE_REASON = 'You cannot change your own role. Ask another admin.';
const OWN_ACCOUNT_REASON = 'You cannot deactivate your own account. Ask another admin.';

/**
 * A disabled control with a tooltip saying why. Disabled elements get no pointer or focus
 * events, so the tooltip sits on a focusable wrapper: it shows on hover and on keyboard focus,
 * and screen readers read the reason as the wrapper's label.
 */
function DisabledWithReason({ reason, children }) {
  return (
    <Tooltip title={reason}>
      <Box component="span" tabIndex={0} sx={{ display: 'inline-flex', borderRadius: 1 }}>
        {children}
      </Box>
    </Tooltip>
  );
}

DisabledWithReason.propTypes = {
  reason: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};

function RoleSelect({ account, disabled, onChange }) {
  return (
    <Select
      size="small"
      value={account.role}
      onChange={(event) => onChange(account, event.target.value)}
      disabled={disabled}
      inputProps={{ 'aria-label': `Role of ${account.full_name}` }}
      sx={{ minWidth: 150 }}
    >
      {ROLE_OPTIONS.map((option) => (
        <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
      ))}
    </Select>
  );
}

RoleSelect.propTypes = {
  account: PropTypes.shape({ full_name: PropTypes.string, role: PropTypes.string }).isRequired,
  disabled: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
};

/**
 * User accounts (admins only; the route enforces it): create with a role, change a role,
 * deactivate and reactivate. An admin cannot demote or deactivate themselves, so those
 * controls are disabled on their own row with a tooltip that says why; the API refuses it too.
 *
 * @returns {JSX.Element} The users page.
 */
export default function UsersPage() {
  const { user: me } = useAuth();
  const list = useApiList('/auth/users');
  const { create, update } = useApiMutation('/auth/users', { label: 'User' });
  const [creating, setCreating] = useState(false);
  const [deactivation, setDeactivation] = useState(CLOSED);
  const [savingId, setSavingId] = useState(null);

  const isMe = (account) => account.id === me?.id;

  const save = async (account, body, message) => {
    setSavingId(account.id);
    try {
      await update(account.id, body, message);
      list.reload();
    } finally {
      setSavingId(null);
    }
  };

  const changeRole = (account, role) => {
    if (role === account.role) return;
    save(account, { role }, `${account.full_name} is now ${ROLE_LABELS[role]}`).catch(() => {});
  };

  const reactivate = (account) => {
    save(account, { is_active: true }, `${account.full_name} can sign in again`).catch(() => {});
  };

  const handleDeactivate = async () => {
    const account = deactivation.record;
    await save(account, { is_active: false }, `${account.full_name} was deactivated`);
  };

  const handleCreate = async (payload) => {
    await create(payload, `${payload.full_name} can now sign in`);
    list.reload();
  };

  const columns = [
    {
      key: 'full_name',
      label: 'Name',
      render: (account) => (
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          <span>{account.full_name}</span>
          {isMe(account) && <Chip size="small" variant="outlined" label="You" />}
        </Box>
      ),
    },
    { key: 'email', label: 'Email' },
    {
      key: 'role',
      label: 'Role',
      render: (account) => {
        const select = (
          <RoleSelect
            account={account}
            disabled={isMe(account) || savingId === account.id}
            onChange={changeRole}
          />
        );
        return isMe(account)
          ? <DisabledWithReason reason={OWN_ROLE_REASON}>{select}</DisabledWithReason>
          : select;
      },
    },
    {
      key: 'is_active',
      label: 'Status',
      render: (account) => <StatusChip status={account.is_active ? 'user_active' : 'inactive'} />,
    },
  ];

  const rowActions = (account) => {
    if (isMe(account)) {
      return (
        <DisabledWithReason reason={OWN_ACCOUNT_REASON}>
          <IconButton aria-label={`Deactivate ${account.full_name}`} disabled>
            <PersonOffIcon />
          </IconButton>
        </DisabledWithReason>
      );
    }
    if (account.is_active) {
      return (
        <Tooltip title="Deactivate" describeChild>
          <IconButton
            aria-label={`Deactivate ${account.full_name}`}
            color="error"
            disabled={savingId === account.id}
            onClick={() => setDeactivation({ open: true, record: account })}
          >
            <PersonOffIcon />
          </IconButton>
        </Tooltip>
      );
    }
    return (
      <Tooltip title="Reactivate" describeChild>
        <IconButton
          aria-label={`Reactivate ${account.full_name}`}
          disabled={savingId === account.id}
          onClick={() => reactivate(account)}
        >
          <HowToRegIcon />
        </IconButton>
      </Tooltip>
    );
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts and roles. Role changes and deactivation reach a signed-in person within 30 minutes."
        actions={(
          <Button variant="contained" startIcon={<PersonAddIcon />} onClick={() => setCreating(true)}>
            New user
          </Button>
        )}
      />
      <DataList
        ariaLabel="Users"
        columns={columns}
        rows={list.items}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        total={list.total}
        page={list.page}
        rowsPerPage={list.rowsPerPage}
        onPageChange={list.setPage}
        onRowsPerPageChange={list.setRowsPerPage}
        rowActions={rowActions}
        emptyState={{
          title: 'No users yet',
          message: 'Create an account for each person who needs to sign in.',
          action: { label: 'New user', onClick: () => setCreating(true) },
        }}
      />
      <FormDialog
        open={creating}
        title="New user"
        fields={FIELDS}
        onSubmit={handleCreate}
        onClose={() => setCreating(false)}
        submitLabel="Create user"
      />
      <ConfirmDialog
        open={deactivation.open}
        title={deactivation.record ? `Deactivate ${deactivation.record.full_name}?` : 'Deactivate user?'}
        message="They will not be able to sign in, and if they are signed in now they are signed out within 30 minutes. You can reactivate the account at any time."
        confirmLabel="Deactivate"
        destructive
        onConfirm={handleDeactivate}
        onClose={() => setDeactivation((current) => ({ ...current, open: false }))}
      />
    </>
  );
}
