import { useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import HowToRegIcon from '@mui/icons-material/HowToReg';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import LockResetIcon from '@mui/icons-material/LockReset';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import PersonOffIcon from '@mui/icons-material/PersonOff';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useNotify } from '../context/notification-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useClearFilters, useFilterParams } from '../hooks/useFilterParams';
import { request } from '../services/apiClient';
import { ROLE_LABELS, ROLE_OPTIONS } from '../utils/permissions';
import { expecting } from '../utils/staleness';
import { ACTIVE_FILTER_OPTIONS } from '../utils/status';
import { resetPasswordFields } from './passwordFields';
import { userFields } from './userFields';

const FIELDS = userFields();
const RESET_FIELDS = resetPasswordFields();
const FILTER_NAMES = ['q', 'role', 'is_active'];
const FILTER_SPECS = [
  { name: 'role', label: 'Role', options: ROLE_OPTIONS },
  { name: 'is_active', label: 'Status', options: ACTIVE_FILTER_OPTIONS },
];
const CLOSED = { open: false, record: null };
/** The sortable columns (API sort keys); the cells are added in the component. */
const SORT_COLUMNS = [
  { key: 'full_name', label: 'Name', sortKey: 'full_name' },
  { key: 'email', label: 'Email', sortKey: 'email' },
  { key: 'role', label: 'Role', sortKey: 'role' },
];
const LIST_OPTIONS = { columns: SORT_COLUMNS, defaultSort: 'email' };
/** What granting each role lets a person do; shown before the change is made. */
const ROLE_GRANTS = {
  viewer: 'A viewer can read everything and change nothing.',
  contributor: 'A contributor can create and edit projects, deliverables, people, allocations and budget entries.',
  manager: 'A manager can create, edit and delete projects, deliverables, people, allocations and budget entries.',
  admin: 'An admin can create, edit and delete every record, and manage accounts: create and delete '
    + 'users, change anyone\'s role, reset passwords and deactivate or unlock accounts.',
};
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
 * User accounts (admins only; the route enforces it): search and filter by role and status,
 * create with a role, change a role, deactivate and reactivate, reset a password to a
 * temporary one, unlock an account that sign-in throttling has locked, and delete an account
 * that owns nothing. A role change, a reset and a deactivation each end that person's
 * sessions at once. An admin cannot demote, deactivate, reset or delete themselves here: those
 * controls are disabled or absent on their own row; the API refuses it too.
 *
 * @returns {JSX.Element} The users page.
 */
export default function UsersPage() {
  const { user: me } = useAuth();
  const filters = useFilterParams(FILTER_NAMES);
  const clearFilters = useClearFilters(FILTER_NAMES);
  const list = useApiList('/auth/users', filters, LIST_OPTIONS);
  const { create, update, remove } = useApiMutation('/auth/users', {
    label: 'User', onStale: list.reload,
  });
  const notify = useNotify();
  const [creating, setCreating] = useState(false);
  const [deactivation, setDeactivation] = useState(CLOSED);
  const [reset, setReset] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);
  const [roleChange, setRoleChange] = useState({ ...CLOSED, role: null });
  const [savingId, setSavingId] = useState(null);

  const isMe = (account) => account.id === me?.id;
  const hasFilters = FILTER_NAMES.some((name) => filters[name]);

  const save = async (account, body, message) => {
    setSavingId(account.id);
    try {
      await update(account.id, expecting(account, body), message);
      list.reload();
    } finally {
      setSavingId(null);
    }
  };

  // Choosing a role only asks; the change is made when the admin confirms it.
  const changeRole = (account, role) => {
    if (role === account.role) return;
    setRoleChange({ open: true, record: account, role });
  };

  const handleRoleChange = async () => {
    const { record: account, role } = roleChange;
    await save(account, { role }, `${account.full_name} is now ${ROLE_LABELS[role]}`);
  };

  const reactivate = (account) => {
    save(account, { is_active: true }, `${account.full_name} can sign in again`).catch(() => {});
  };

  const handleDeactivate = async () => {
    const account = deactivation.record;
    await save(account, { is_active: false }, `${account.full_name} was deactivated`);
  };

  const handleCreate = async (payload, context) => {
    await create(payload, `${payload.full_name} can now sign in`, context);
    list.reload();
  };

  const handleReset = async (payload) => {
    const account = reset.record;
    await update(
      account.id,
      expecting(account, { password: payload.password }),
      `${account.full_name} must choose a new password at their next sign-in`,
    );
    list.reload();
  };

  const handleDelete = async () => {
    const account = deletion.record;
    await remove(account.id, `${account.full_name} was deleted`);
    list.reload();
  };

  const unlock = async (account) => {
    setSavingId(account.id);
    try {
      await request(`/auth/users/${account.id}/lockout`, { method: 'DELETE' });
      notify(`${account.full_name} can try to sign in again`, 'success');
      list.reload();
    } catch (error) {
      notify(error?.message || 'Could not unlock the account. Please try again.', 'error');
    } finally {
      setSavingId(null);
    }
  };

  const columns = [
    {
      key: 'full_name',
      label: 'Name',
      sortKey: 'full_name',
      render: (account) => (
        <Box
          component="span"
          sx={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, maxWidth: '100%' }}
        >
          <Box component="span" sx={{ minWidth: 0 }}>{account.full_name}</Box>
          {isMe(account) && <Chip size="small" variant="outlined" label="You" />}
        </Box>
      ),
    },
    { key: 'email', label: 'Email', sortKey: 'email' },
    {
      key: 'role',
      label: 'Role',
      sortKey: 'role',
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
      render: (account) => (
        <Box component="span" sx={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          <StatusChip status={account.is_active ? 'user_active' : 'inactive'} />
          {account.is_locked && <StatusChip status="locked" />}
          {account.must_change_password && (
            <Chip size="small" variant="outlined" label="Temporary password" />
          )}
        </Box>
      ),
    },
  ];

  const activation = (account) => {
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

  const rowActions = (account) => {
    if (isMe(account)) {
      // Your own password is changed from the account menu, and you cannot delete yourself.
      return (
        <DisabledWithReason reason={OWN_ACCOUNT_REASON}>
          <IconButton aria-label={`Deactivate ${account.full_name}`} disabled>
            <PersonOffIcon />
          </IconButton>
        </DisabledWithReason>
      );
    }
    return (
      <>
        {account.is_locked && (
          <Tooltip title="Unlock sign-in" describeChild>
            <IconButton
              aria-label={`Unlock ${account.full_name}`}
              disabled={savingId === account.id}
              onClick={() => unlock(account)}
            >
              <LockOpenIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Reset password" describeChild>
          <IconButton
            aria-label={`Reset password of ${account.full_name}`}
            disabled={savingId === account.id}
            onClick={() => setReset({ open: true, record: account })}
          >
            <LockResetIcon />
          </IconButton>
        </Tooltip>
        {activation(account)}
        <Tooltip title="Delete user" describeChild>
          <IconButton
            aria-label={`Delete ${account.full_name}`}
            color="error"
            disabled={savingId === account.id}
            onClick={() => setDeletion({ open: true, record: account })}
          >
            <DeleteOutlinedIcon />
          </IconButton>
        </Tooltip>
      </>
    );
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts and roles. A role change, a password reset or a deactivation signs that person out at once."
        actions={(
          <Button variant="contained" startIcon={<PersonAddIcon />} onClick={() => setCreating(true)}>
            New user
          </Button>
        )}
      />
      <FilterBar
        ariaLabel="Filter users"
        search={{ label: 'Search by name or email' }}
        filters={FILTER_SPECS}
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
        sort={list.sort}
        onSortChange={list.setSort}
        sortChoices={list.sortChoices}
        rowActions={rowActions}
        emptyState={hasFilters ? {
          title: 'No users match these filters',
          message: 'Try a different search, or clear the filters to see every account.',
          action: { label: 'Clear filters', onClick: clearFilters },
        } : {
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
        message="They are signed out at once and cannot sign in again until you reactivate the account, which you can do at any time."
        confirmLabel="Deactivate"
        destructive
        onConfirm={handleDeactivate}
        onClose={() => setDeactivation((current) => ({ ...current, open: false }))}
      />
      <ConfirmDialog
        open={roleChange.open}
        title={roleChange.record
          ? `Make ${roleChange.record.full_name} ${ROLE_LABELS[roleChange.role]}?`
          : 'Change role?'}
        message={roleChange.record ? (
          <>
            {`${roleChange.record.full_name} changes from ${ROLE_LABELS[roleChange.record.role]} to ${ROLE_LABELS[roleChange.role]} and is signed out, so the new role applies when they sign in again.`}
            <Box component="span" sx={{ display: 'block', mt: 1 }}>{ROLE_GRANTS[roleChange.role]}</Box>
          </>
        ) : ''}
        confirmLabel={roleChange.role ? `Make ${ROLE_LABELS[roleChange.role]}` : 'Change role'}
        onConfirm={handleRoleChange}
        onClose={() => setRoleChange((current) => ({ ...current, open: false }))}
      />
      <FormDialog
        open={reset.open}
        title={reset.record ? `Reset password of ${reset.record.full_name}` : 'Reset password'}
        fields={RESET_FIELDS}
        onSubmit={handleReset}
        onClose={() => setReset((current) => ({ ...current, open: false }))}
        submitLabel="Set temporary password"
      />
      <ConfirmDialog
        open={deletion.open}
        title={deletion.record ? `Delete ${deletion.record.full_name}?` : 'Delete user?'}
        message="The account is permanently deleted. A user who owns projects or recorded budget entries cannot be deleted: deactivate them instead."
        confirmLabel="Delete user"
        destructive
        onConfirm={handleDelete}
        onClose={() => setDeletion((current) => ({ ...current, open: false }))}
      />
    </>
  );
}
