# ACME Project Tracker API

One Lambda (`backend/tracker`) serves every endpoint below.

| Where | Base URL |
| --- | --- |
| AWS (CloudFront) | `https://<distribution>/api/tracker` |
| Local (dev proxy) | `http://localhost:3001/api/tracker` |

The Lambda accepts paths with or without the `/api/tracker` prefix. The dev proxy strips it, while CloudFront and the Function URL pass it through.

## Conventions

- **Authentication.** Every endpoint needs `Authorization: Bearer <access token>`, except `GET /health`, `POST /auth/login` and `POST /auth/refresh`. Access tokens last 30 minutes and refresh tokens 7 days. A refresh token is refused where an access token is expected, and the reverse.
  - **The database decides, on every request.** After checking the token, the API re-reads the user (one primary-key query). The role comes from that row, never from the token. A role change made through the API (`PUT /auth/users/{id}`) also adds one to the user's `token_version`, which revokes every token they hold: on their next authenticated request the old token gets 401 `token_revoked` (the refresh token is revoked too), and after they sign in again their new role and its permissions apply. A deleted or deactivated user's token gets 401 `invalid_token`.
  - **Revocation.** Both tokens carry the user's `token_version` as the claim `ver`. When it no longer matches the row the answer is 401 `token_revoked`. The version is bumped when a password changes (the user's own change or an admin reset), when the role changes, when the account is deactivated, and by `POST /auth/logout`. A token without `ver` is refused.
  - **Temporary passwords.** While a user's `must_change_password` is true, every route except `GET /auth/me`, `POST /auth/change-password` and `POST /auth/logout` answers 403 `password_change_required`. That includes `POST /auth/refresh`: a valid refresh token gets the same 403 and no new tokens, so a session on a temporary password lasts at most the 30 minutes of its access token. Refresh works again with the tokens `POST /auth/change-password` returns.
- **Roles.** The roles rank viewer < contributor < manager < admin. Unless an endpoint says otherwise, GET needs viewer, POST and PUT need contributor, and DELETE needs manager. Everything under `/auth/users` needs admin. The exceptions, each for a stated reason:

  | Route | Needs | Why |
  | --- | --- | --- |
  | `POST /auth/logout`, `POST /auth/change-password` | viewer | everyone manages their own session and password |
  | `GET /auth/users/options` | contributor | people who can edit a project must be able to pick its owner; it returns names only |
  | `DELETE /deliverables/{id}/dependencies/{depends_on_id}` | contributor | it edits a deliverable and deletes no record |
- **Lists.** Lists return `{"items": [...], "total": n, "limit": n, "offset": n}`. Every list takes:
  - `limit`: default 50, capped at 100.
  - `offset`: default 0.
  - `sort`: a column from the endpoint's sort list, or `id`; prefix `-` for descending.
  - `q`: a case-insensitive "contains" search, on endpoints that list search columns.
  - The filters listed for the endpoint. All filters are exact matches unless noted, and an empty filter value is ignored.
- **Bodies.** Request bodies are JSON objects of at most 256 KB (413 `payload_too_large` above that). JSON nested too deeply to parse is 400 `malformed_json`. Unknown fields and read-only fields (`id`, `created_at`, `updated_at`, `completed_at`, `created_by`) are ignored.
  - **PUT is a partial update.** Send only the fields that change. The merged record is validated, so `end_date` is also checked against the stored `start_date`.
  - Send `null` (or `""`) to clear an optional field.
- **Lost updates: `expected_updated_at`.** Any PUT may carry `expected_updated_at`, the `updated_at` the client read. If the row has changed since (compared as instants, under the row lock the update takes anyway), the answer is 409 `stale_record` and nothing is written. Without the field there is no check. A value that is not an ISO 8601 timestamp with an offset is a 400 on `expected_updated_at`. Every update sets a new `updated_at`.
- **Running a POST once: `Idempotency-Key`.** A POST from a signed-in user may carry the header `Idempotency-Key` (8 to 128 characters of `A-Z a-z 0-9 _ -`; anything else is a 400 on `Idempotency-Key`).
  - The first request claims the key and stores its status and body in the same transaction as its writes. A repeat by the same user on the same path returns that stored response, with the header `Idempotent-Replayed: true`, without running again (even if the body differs). A duplicate sent while the first is still running waits for it, then replays.
  - The same key on another path or from another user is 409 `idempotency_key_reused`.
  - A request that fails stores nothing, so it can be retried with its key. Keys are kept for 24 hours.
  - The session routes (`/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password`) ignore the header: a response that holds tokens is never stored.
- **Formats.** Dates are `YYYY-MM-DD`, from `2000-01-01` to `2100-12-31` (a field error outside that, in bodies and in query parameters). Timestamps are ISO 8601 in UTC. Money is a JSON number with at most 2 decimal places.
- **Text.** A control character (NUL and the like) in a text field is a field error on that field. Line breaks and tabs are allowed in the multi-line fields only (every `description`). The same applies to `q` and to text filters.
- **The clock.** "Today" is the database's `CURRENT_DATE`, and the connection is set to UTC. Every "overdue" in every response is judged on that date, which comes back as `as_of`.
- **Caching.** Every response carries `Cache-Control: no-store`.
- **Time limit.** A query the database cancels after 15 seconds is a 503 `query_timeout` with `Retry-After`; the request may be sent again.
- **Status codes:**

  | Code | Meaning |
  | --- | --- |
  | 200 | OK |
  | 201 | Created |
  | 204 | Deleted (empty body) |
  | 400 | Validation error or malformed input |
  | 401 | Missing, invalid, expired or revoked token; wrong credentials |
  | 403 | Role not allowed, or a temporary password must be changed first |
  | 404 | Not found |
  | 409 | Duplicate or conflict; `stale_record` (changed by someone else); `idempotency_key_reused` |
  | 413 | Request body over 256 KB |
  | 429 | Too many failed sign-ins for this email (with `Retry-After`) |
  | 500 | Server error (no internals are exposed) |
  | 503 | The database took too long (`query_timeout`, with `Retry-After`) |

  An unknown path returns 401 without a valid token and 404 with one.
- **Errors.** Every error uses the same shape. `details` lists every field problem at once:

  ```json
  {"error": {"code": "validation_error", "message": "Validation failed",
             "details": [{"field": "end_date", "message": "must be on or after start_date"}]}}
  ```

  | Code | Status |
  | --- | --- |
  | `validation_error`, `malformed_json`, `malformed_body` | 400 |
  | `missing_token`, `invalid_token`, `token_expired`, `token_revoked`, `invalid_credentials`, `account_inactive` | 401 |
  | `forbidden`, `password_change_required` | 403 |
  | `not_found`, `route_not_found` | 404 |
  | `duplicate`, `conflict`, `user_in_use`, `stale_record`, `idempotency_key_reused` | 409 |
  | `payload_too_large` | 413 |
  | `too_many_attempts` | 429 |
  | `internal_error` | 500 |
  | `query_timeout` | 503 |

## Endpoints

### Health and authentication

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/health` | public | (none) |
| POST | `/auth/login` | public | (none) |
| POST | `/auth/refresh` | public | (none) |
| POST | `/auth/logout` | viewer | (none) |
| POST | `/auth/change-password` | viewer | (none) |
| GET | `/auth/me` | viewer | (none) |
| GET | `/auth/users/options` | contributor | (none) |
| GET | `/auth/users` | admin | filters `role`, `is_active`; `q` on email, full_name; sort `email` (default), `full_name`, `role`, `created_at` |
| POST | `/auth/users` | admin | (none) |
| GET | `/auth/users/{id}` | admin | (none) |
| PUT | `/auth/users/{id}` | admin | (none) |
| DELETE | `/auth/users/{id}` | admin | (none) |
| DELETE | `/auth/users/{id}/lockout` | admin | (none) |

- **`GET /health`** runs `SELECT 1` against the database and returns `{"status": "ok", "database": "ok"}`.
- **`POST /auth/login`** takes `{"email", "password"}` and returns `{"access_token", "refresh_token", "token_type": "Bearer", "expires_in": 1800, "user"}`. `user` holds `id`, `email`, `full_name`, `role`, `is_active` and `must_change_password`.
  - An unknown email and a wrong password get the same 401 (`invalid_credentials`).
  - An inactive account gets 401 `account_inactive`, but only after the correct password.
  - **Throttling.** Failures are counted per submitted email (lower-cased). After 5 failures within 15 minutes, every sign-in for that email answers 429 `too_many_attempts` with a `Retry-After` header (seconds) and the message "Too many attempts. Try again in N minutes.", whether or not the account exists or the password is right, until the oldest of those five failures is 15 minutes old. Attempts made while locked are not counted. A successful sign-in clears the email's failures. An admin can lift a lock with `DELETE /auth/users/{id}/lockout`.
- **`POST /auth/refresh`** takes `{"refresh_token"}` and returns the same shape as login. It re-reads the user, so it returns the current role. An inactive or deleted user gets 401 `invalid_token`, a revoked token 401 `token_revoked`, and an access token sent here 401 "Expected a refresh token". A user whose `must_change_password` is true gets 403 `password_change_required`, checked after those 401s.
- **`POST /auth/logout`** (any signed-in role) ends every session of the caller: all their access and refresh tokens stop working. It returns 204.
- **`POST /auth/change-password`** (any signed-in role) takes `{"current_password", "new_password"}`.
  - A wrong current password is a 400 with a field error on `current_password`; a new password that breaks the policy, or equals the current one, is a 400 on `new_password`.
  - On success it revokes every token issued so far, clears `must_change_password` and returns fresh tokens in the same shape as login, so the caller stays signed in.
  - If the account was deleted while the request was on its way, the answer is 401 `invalid_token`.
- **`GET /auth/me`** returns the current user, with `must_change_password`. Password hashes are never returned by any endpoint.
- **`GET /auth/users/options`** (contributor and above) returns `{"items": [{"id", "full_name"}], ...}`: the active users only, by name, for pickers such as a project's owner.
- **`DELETE /auth/users/{id}/lockout`** (admin) forgets the failed sign-ins recorded for that user's email. It returns 204, or 404 for an unknown user.
- **Password policy.** One rule set applies wherever a password is set (create user, admin reset, change-password). The field error names the rule that failed:
  - 10 to 128 characters;
  - at least one letter and one digit;
  - not containing the email's local part (the part before `@`) or the full name, ignoring case, with or without the spaces. There is no minimum length: a one or two character email name or full name is refused like any other;
  - not one of a built-in list of common passwords that would otherwise pass.
- **User fields:**

  | Field | Rules |
  | --- | --- |
  | `email` | required, unique (409), stored lower-case |
  | `full_name` | required, at most 120 characters |
  | `password` | required on create and subject to the password policy; send it in a PUT to reset it |
  | `role` | required: `viewer`, `contributor`, `manager` or `admin` |
  | `is_active` | true or false |
  | `must_change_password` | read-only: true after an admin reset, until the user changes the password |
  | `is_locked` | read-only: true while sign-in is throttled for this email |
- **Admin reset.** A `password` in `PUT /auth/users/{id}` is a temporary password: it sets `must_change_password`, and the user must change it (`POST /auth/change-password`) before doing anything else.
- **What ends a user's sessions.** A reset, a role change and a deactivation each revoke every token of that user at once.
- **Admin limits:** admins cannot change their own role, deactivate themselves, or delete themselves (400).
- **Deleting a user** who owns projects or recorded budget entries returns 409 `user_in_use`; deactivate the account instead.

### Projects

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/projects` | viewer | filters `status`, `department` (ignoring case), `owner_id`; `q` on name, description; sort `name` (default), `end_date`, `status` |
| POST | `/projects` | contributor | (none) |
| GET | `/projects/{id}` | viewer | (none) |
| PUT | `/projects/{id}` | contributor | (none) |
| DELETE | `/projects/{id}` | manager | (none) |

**Fields:**

| Field | Rules |
| --- | --- |
| `name` | required, unique whatever the case (409 on `name`: "Apollo" and "APOLLO" are one name), at most 150 characters |
| `department` | required, at most 100 characters; stored in the spelling that already exists (see below) |
| `description` | at most 2000 characters |
| `status` | `planned` (default), `active`, `on_hold`, `completed` or `cancelled` |
| `start_date` | required |
| `end_date` | required (the deadline), on or after `start_date` |
| `budget_planned` | 0 or more, default 0 |
| `owner_id` | an existing user id, or null for no owner; a create without the field makes the creator the owner |

- **Departments.** Department is free text. When the department sent matches one already used by a project or a person, ignoring case, the existing spelling is stored ("engineering" becomes "Engineering"). The row being updated does not count, so the only user of a department can still correct its case.
- **Every project read** (list, single read, create and update responses) includes these computed fields:
  - `percent_complete`: done deliverables ÷ all deliverables × 100, to one decimal place (0 with no deliverables)
  - `budget_spent`: the sum of the project's budget entries
  - `owner_name`: the owner's full name, or null without an owner (only admins can read `/auth/users`)
  - `is_overdue`: the deadline is before today and the status is not `completed` or `cancelled`
  - `as_of`: the date `is_overdue` was judged on (the database's date, UTC)
- **`GET /projects/{id}`** also adds:
  - `deliverable_counts`, one count per deliverable status
  - `deliverables_total`
- **Deleting a project** also deletes its deliverables, allocations and budget entries.

### Deliverables and dependencies

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/deliverables` | viewer | filters `project_id`, `status`, `assignee_id`; `q` on title; sort `due_date` (default), `title`, `status` |
| POST | `/deliverables` | contributor | (none) |
| GET | `/deliverables/{id}` | viewer | (none) |
| PUT | `/deliverables/{id}` | contributor | (none) |
| DELETE | `/deliverables/{id}` | manager | (none) |
| GET | `/deliverables/{id}/dependencies` | viewer | (none) |
| POST | `/deliverables/{id}/dependencies` | contributor | (none) |
| DELETE | `/deliverables/{id}/dependencies/{depends_on_id}` | contributor | (none) |

**Fields:**

| Field | Rules |
| --- | --- |
| `project_id` | required, an existing project; cannot change after creation |
| `title` | required, at most 200 characters |
| `description` | at most 2000 characters |
| `status` | `not_started` (default), `in_progress`, `blocked` or `done` |
| `due_date` | required |
| `assignee_id` | an existing resource id, or null |

- **`completed_at`** is set when the status becomes `done` and cleared when it leaves `done`.
- **Every deliverable read** includes `is_overdue` (not `done` and due before today) and `as_of`, the date it was judged on (the database's date, UTC).
- **`GET /deliverables/{id}/dependencies`** lists the deliverables this one depends on in `items`, and the ones that depend on it in `dependents`. Each entry has `id`, `project_id`, `title`, `status` and `due_date`.
- **`POST /deliverables/{id}/dependencies`** takes `{"depends_on_id"}` and returns 201 with the linked deliverable.
  - A self-link, a deliverable from another project, or a link that would create a cycle returns 400, with a message saying which.
  - An existing link returns 409.
- **`DELETE /deliverables/{id}/dependencies/{depends_on_id}`** removes the link. Contributors may: it edits a deliverable and deletes no record. It returns 404 if there was no such link.

### Resources

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/resources` | viewer | filters `department` (ignoring case), `is_active` (`true`/`false`); `q` on full_name, email, job_title; sort `full_name` (default), `department`, `capacity_pct` |
| POST | `/resources` | contributor | (none) |
| GET | `/resources/{id}` | viewer | (none) |
| PUT | `/resources/{id}` | contributor | (none) |
| DELETE | `/resources/{id}` | manager | (none) |

**Fields:**

| Field | Rules |
| --- | --- |
| `full_name` | required, at most 120 characters |
| `email` | required, unique (409), stored lower-case |
| `job_title` | at most 120 characters |
| `department` | at most 100 characters; stored in the spelling that already exists (see Projects) |
| `capacity_pct` | 1 to 100, default 100 |
| `is_active` | true (default) or false |

- **Every read includes `allocation_today_pct`:** the sum of the person's allocations that cover today.
- **Deleting a resource** removes their allocations and unassigns their deliverables.

### Allocations

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/allocations` | viewer | filters `resource_id`, `project_id`, `active_on` (a date: allocations covering that day); sort `start_date` (default), `end_date`, `allocation_pct` |
| POST | `/allocations` | contributor | (none) |
| GET | `/allocations/{id}` | viewer | (none) |
| PUT | `/allocations/{id}` | contributor | (none) |
| DELETE | `/allocations/{id}` | manager | (none) |

**Fields:**

| Field | Rules |
| --- | --- |
| `resource_id` | required, an existing resource |
| `project_id` | required, an existing project |
| `allocation_pct` | required, 1 to 100 |
| `start_date` | required |
| `end_date` | required, on or after `start_date` |
| `role_on_project` | at most 100 characters |

**Over-allocation** is allowed. When the person's highest single-day total within the allocation's dates exceeds their `capacity_pct`, the POST or PUT response adds:

```json
{"warning": "over_allocated", "total_allocation_pct": 120, "capacity_pct": 100}
```

### Budgets

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/budgets` | viewer | filters `project_id`, `category`, `spent_from` (on or after), `spent_to` (on or before); `q` on description; sort `-spent_on` (default), `spent_on`, `amount`, `category` |
| GET | `/budgets/summary?project_id=` | viewer | `project_id` required |
| POST | `/budgets` | contributor | (none) |
| GET | `/budgets/{id}` | viewer | (none) |
| PUT | `/budgets/{id}` | contributor | (none) |
| DELETE | `/budgets/{id}` | manager | (none) |

**Fields:**

| Field | Rules |
| --- | --- |
| `project_id` | required, an existing project |
| `category` | required: `labor`, `software`, `hardware`, `services` or `other` |
| `description` | at most 500 characters |
| `amount` | required, greater than 0, at most 2 decimal places |
| `spent_on` | required |

- **`created_by`** always comes from the token.
- **`GET /budgets/summary`** returns `{"project_id", "project_name", "planned", "spent", "remaining", "percent_used"}`.
  - `percent_used` is null when nothing was planned.
  - A missing or non-numeric `project_id` returns 400; an unknown project returns 404.

### Insights

Read-only answers to the Dashboard's questions. Every insight is a GET, so every role (viewer and above) can call it. There are no write routes: any other method returns 404. Responses are not paginated.

| Method | Path | Minimum role | Query |
| --- | --- | --- | --- |
| GET | `/insights/project-status` | viewer | `status`: `planned`, `active` or `on_hold` (default: every open project) |
| GET | `/insights/at-risk` | viewer | (none) |
| GET | `/insights/allocation` | viewer | `on` (a date, default today) |
| GET | `/insights/deliverables` | viewer | (none) |
| GET | `/insights/over-allocated` | viewer | `from` (default today), `to` (default `from` + 90 days) |
| GET | `/insights/dependencies` | viewer | `project_id` (required) |
| GET | `/insights/budget` | viewer | (none) |
| GET | `/insights/summary` | viewer | (none) |

**Rules.** "Today" is the database's current date and comes back as `as_of`. The thresholds (20 points, 90 days) are defined once, in `acme/domains/insights_sql.py`.

| Term | Rule |
| --- | --- |
| Open project | status is not `completed` or `cancelled` |
| Overdue deliverable | not `done` and due before today |
| Time elapsed % | 100 on or after the deadline, 0 up to the start date, otherwise (today − start) ÷ (deadline − start) |
| Behind schedule | time elapsed % minus percent done is more than 20 points, both rounded to one decimal place. A project with no deliverables is never behind schedule. |
| Health | `overdue` when the deadline has passed; otherwise `at_risk` when a deliverable is overdue or blocked or the project is behind schedule; otherwise `on_track` |
| At risk | an open project whose health is not `on_track` |
| Forecast end date | start + days elapsed × total ÷ done, rounded up to a whole day; null until a deliverable is done |
| Over-allocated | the sum of a person's allocations on one day exceeds their `capacity_pct` (exactly at capacity is not over). It is evaluated at the window start and at every allocation start date inside the window. |
| Depth | links on the longest path from a deliverable that depends on nothing (depth 0) |
| Blocked by upstream | a deliverable it depends on, directly or through others, is `blocked` |
| Over budget | spent exceeds planned, so any spend without a planned budget is over |

**Responses:**
- **`GET /insights/project-status`** returns `{"as_of", "items"}`, one item per open project, worst health first. `?status=` narrows it to one open status; a closed or unknown status is a 400 on `status`. Each item has:
  - `id`, `name`, `department`, `status`, `start_date`, `end_date`
  - `days_to_deadline` (negative once the deadline has passed)
  - `deliverables_total`, `deliverables_done`
  - `percent_done` (null without deliverables), `time_elapsed_pct`
  - `health`
  - `forecast_end_date` (null until a deliverable is done)
- **`GET /insights/at-risk`** returns the same item fields for at-risk projects only, plus:
  - `reasons`: a list of `{"code", "message"}`. The codes are `deadline_passed`, `overdue_deliverables`, `blocked_deliverables` and `behind_schedule`, for example `{"code": "deadline_passed", "message": "Deadline passed 10 days ago"}`.
- **`GET /insights/allocation`** returns `{"on", "projects": [{"id", "name"}], "resources": [...]}`:
  - `projects` are the matrix's columns: every project with an allocation on that day.
  - `resources` are its rows: every active person, plus inactive people who are allocated that day. Each row has `id`, `full_name`, `capacity_pct`, `total_pct`, `over_capacity` and `cells`, a list of `{"project_id", "allocation_pct"}`.
- **`GET /insights/deliverables`** returns `{"as_of", "items"}`, one item per open project, most overdue first:
  - `project_id`, `project_name`, `project_status`
  - `total`, `counts` (one count per deliverable status), `percent_done`, `overdue`
  - `next_due`: the unfinished deliverable with the earliest due date on or after today, as `{"id", "title", "status", "due_date"}`, or null
- **`GET /insights/over-allocated`** returns `{"from", "to", "items"}`, highest peak first:
  - `resource_id`, `full_name`, `capacity_pct`
  - `peak_pct` and `peak_on` (the earliest day with that total)
  - `overlap_start`, `overlap_end`: when the allocations behind the peak all overlap. This range can begin before the window.
  - `projects`: a list of `{"project_id", "project_name", "allocation_pct"}`
  - A malformed date, or `to` before `from`, returns 400.
- **`GET /insights/dependencies?project_id=`** returns `{"project_id", "project_name", "items", "longest_chain"}`:
  - Items are ordered by depth. Each has `id`, `title`, `status`, `due_date`, `depth`, `depends_on_ids` (direct), `upstream_ids` (direct and indirect) and `blocked_by_upstream`.
  - `longest_chain` lists deliverable ids from the root to the deepest deliverable.
  - Only links inside the project are followed. The walk ends even if bad data contains a cycle.
  - It is worked out from two queries (the project's deliverables, the links between them) and a memoised traversal in memory, so its cost grows with the number of deliverables and links, not with the number of paths through them.
  - A missing or non-numeric `project_id` returns 400; an unknown project returns 404.
- **`GET /insights/budget`** returns `{"as_of", "items"}` for every project, closed ones included, highest share used first:
  - `project_id`, `project_name`, `project_status`
  - `planned`, `spent`, `remaining`
  - `percent_used` (null when nothing is planned), `over_budget`
  - `time_elapsed_pct` and `burn_gap_pts` (percent used minus time elapsed %; positive means money is going faster than the calendar)
- **`GET /insights/summary`** returns the headline counts, computed by the same queries as the sections:
  - `as_of`
  - `active_projects`: status `active`
  - `at_risk_projects`
  - `overdue_deliverables`: in open projects
  - `over_allocated_people`: in the default 90-day window
  - `over_budget_projects`

## Demo data

A fresh database is seeded with demo data. Each table is seeded only when it is empty, and every date is relative to today.

- **Users:** `admin@acme.test` (admin), `manager@acme.test` (manager), `lead@acme.test` (contributor) and `viewer@acme.test` (viewer). Their password is the Lambda's `SEED_PASSWORD`; the [README](README.md#roles-and-demo-logins) says where it comes from.
- **Projects**, each in a different state:
  - Customer Portal Revamp: healthy
  - Data Center Migration: past its deadline
  - Mobile Banking App: behind schedule, with a blocked deliverable and a three-link dependency chain
  - Brand Refresh Campaign: over budget
  - ERP Finance Upgrade: completed
  - Market Expansion Study: planned
- **People:** Aisha Khan and Farid Haddad are booked above 100%. Diego Alvarez reaches exactly 100%, which is not over-allocated.
- **Insights on the seed:** Data Center Migration is `overdue`. Mobile Banking App and Brand Refresh Campaign are `at_risk`; Brand Refresh qualifies because 62.5% of its time has elapsed with a third of its deliverables done. The summary reads 4 active projects, 3 at risk, 4 overdue deliverables, 2 over-allocated people and 1 over budget.
