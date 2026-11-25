import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EventIcon from '@mui/icons-material/Event';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import LockClockIcon from '@mui/icons-material/LockClock';
import MoneyOffIcon from '@mui/icons-material/MoneyOff';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ReportIcon from '@mui/icons-material/Report';
import ScheduleIcon from '@mui/icons-material/Schedule';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

/**
 * Label, theme colour and icon for every status the app shows. `color` is a palette key from
 * theme.js ('default' is MUI's neutral chip). Keys are the API's values.
 */
export const STATUS_META = {
  // Delivery health
  on_track: { label: 'On track', color: 'onTrack', icon: TrendingUpIcon },
  at_risk: { label: 'At risk', color: 'atRisk', icon: WarningAmberIcon },
  overdue: { label: 'Overdue', color: 'overdue', icon: ReportIcon },
  done: { label: 'Done', color: 'done', icon: CheckCircleIcon },
  // Project status
  planned: { label: 'Planned', color: 'default', icon: EventIcon },
  active: { label: 'Active', color: 'primary', icon: PlayCircleIcon },
  on_hold: { label: 'On hold', color: 'atRisk', icon: PauseCircleIcon },
  completed: { label: 'Completed', color: 'done', icon: CheckCircleIcon },
  cancelled: { label: 'Cancelled', color: 'default', icon: BlockIcon },
  // Deliverable status ('done' is shared with health)
  not_started: { label: 'Not started', color: 'default', icon: RadioButtonUncheckedIcon },
  in_progress: { label: 'In progress', color: 'primary', icon: ScheduleIcon },
  blocked: { label: 'Blocked', color: 'overdue', icon: BlockIcon },
  // Money and people
  over_budget: { label: 'Over budget', color: 'overdue', icon: MoneyOffIcon },
  over_allocated: { label: 'Over-allocated', color: 'atRisk', icon: WarningAmberIcon },
  user_active: { label: 'Active', color: 'onTrack', icon: CheckCircleIcon },
  inactive: { label: 'Inactive', color: 'default', icon: BlockIcon },
  locked: { label: 'Locked', color: 'atRisk', icon: LockClockIcon },
};

/**
 * Theme colour and icon for each reason /insights/at-risk gives; the chip's text is the API's
 * message, e.g. "2 deliverables past due". Keys are the API's reason codes.
 */
export const REASON_META = {
  deadline_passed: { color: 'overdue', icon: EventBusyIcon },
  overdue_deliverables: { color: 'overdue', icon: ReportIcon },
  blocked_deliverables: { color: 'overdue', icon: BlockIcon },
  behind_schedule: { color: 'atRisk', icon: HourglassBottomIcon },
};

/** Project statuses in workflow order, as select options. */
export const PROJECT_STATUS_OPTIONS = ['planned', 'active', 'on_hold', 'completed', 'cancelled']
  .map((value) => ({ value, label: STATUS_META[value].label }));

/** Deliverable statuses in workflow order, as select options. */
export const DELIVERABLE_STATUS_OPTIONS = ['not_started', 'in_progress', 'blocked', 'done']
  .map((value) => ({ value, label: STATUS_META[value].label }));

/** The active filter's options; values are what the API's `is_active` filter takes. */
export const ACTIVE_FILTER_OPTIONS = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

/**
 * Human label for a status key, falling back to the key with underscores turned into spaces.
 *
 * @param {string} status API status value.
 * @returns {string} Display label.
 */
export function statusLabel(status) {
  return STATUS_META[status]?.label ?? String(status ?? '').replace(/_/g, ' ');
}
