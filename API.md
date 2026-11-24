# ACME Project Tracker API

One Lambda (`backend/tracker`) serves every endpoint below.

| Where | Base URL |
| --- | --- |
| AWS (CloudFront) | `https://<distribution>/api/tracker` |
| Local (dev proxy) | `http://localhost:3001/api/tracker` |

The Lambda accepts paths with or without the `/api/tracker` prefix. The dev proxy strips it, while CloudFront and the Function URL pass it through.

## Conventions

- **Authentication.** Every endpoint needs `Authorization: Bearer <access token>`, except `GET /health`, `POST /auth/login` and `POST /auth/refresh`. Access tokens last 30 minutes and refresh tokens 7 days. A refresh token is refused where an access token is expected, and the reverse. Role changes and deactivation take effect at the next refresh.
- **Roles.** The roles rank viewer < contributor < manager < admin. Unless an endpoint says otherwise, GET needs viewer, POST and PUT need contributor, and DELETE needs manager. Everything under `/auth/users` needs admin.
- **Lists.** Lists return `{"items": [...], "total": n, "limit": n, "offset": n}`. Every list takes:
  - `limit`: default 50, capped at 100.
  - `offset`: default 0.
  - `sort`: a column from the endpoint's sort list, or `id`; prefix `-` for descending.
  - `q`: a case-insensitive "contains" search, on endpoints that list search columns.
  - The filters listed for the endpoint. All filters are exact matches unless noted, and an empty filter value is ignored.
- **Bodies.** Request bodies are JSON objects. Unknown fields and read-only fields (`id`, `created_at`, `updated_at`, `completed_at`, `created_by`) are ignored.
  - **PUT is a partial update.** Send only the fields that change. The merged record is validated, so `end_date` is also checked against the stored `start_date`.
  - Send `null` (or `""`) to clear an optional field.
- **Formats.** Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 in UTC. Money is a JSON number with at most 2 decimal places.
- **Status codes:**

  | Code | Meaning |
  | --- | --- |
  | 200 | OK |
  | 201 | Created |
  | 204 | Deleted (empty body) |
  | 400 | Validation error or malformed input |
  | 401 | Missing, invalid or expired token |
  | 403 | Role not allowed |
  | 404 | Not found |
  | 409 | Duplicate or conflict |
  | 500 | Server error (no internals are exposed) |

  An unknown path returns 401 without a valid token and 404 with one.
- **Errors.** Every error uses the same shape. `details` lists every field problem at once:

  ```json
  {"error": {"code": "validation_error", "message": "Validation failed",
             "details": [{"field": "end_date", "message": "must be on or after start_date"}]}}
  ```

  | Code | Status |
  | --- | --- |
  | `validation_error`, `malformed_json`, `malformed_body` | 400 |
  | `missing_token`, `invalid_token`, `token_expired`, `invalid_credentials`, `account_inactive` | 401 |
  | `forbidden` | 403 |
  | `not_found`, `route_not_found` | 404 |
  | `duplicate`, `conflict`, `user_in_use` | 409 |
  | `internal_error` | 500 |

## Endpoints

### Health and authentication

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/health` | public | (none) |
| POST | `/auth/login` | public | (none) |
| POST | `/auth/refresh` | public | (none) |
| GET | `/auth/me` | viewer | (none) |
| GET | `/auth/users` | admin | filters `role`, `is_active`; `q` on email, full_name; sort `email` (default), `full_name`, `role`, `created_at` |
| POST | `/auth/users` | admin | (none) |
| GET | `/auth/users/{id}` | admin | (none) |
| PUT | `/auth/users/{id}` | admin | (none) |
| DELETE | `/auth/users/{id}` | admin | (none) |

- **`GET /health`** runs `SELECT 1` against the database and returns `{"status": "ok", "database": "ok"}`.
- **`POST /auth/login`** takes `{"email", "password"}` and returns `{"access_token", "refresh_token", "token_type": "Bearer", "expires_in": 1800, "user"}`.
  - An unknown email and a wrong password get the same 401 (`invalid_credentials`).
  - An inactive account gets 401 `account_inactive`, but only after the correct password.
- **`POST /auth/refresh`** takes `{"refresh_token"}`. It re-reads the user, so it returns the current role, and an inactive or deleted user gets a 401.
- **`GET /auth/me`** returns the current user. Password hashes are never returned by any endpoint.
- **User fields:**

  | Field | Rules |
  | --- | --- |
  | `email` | required, unique (409), stored lower-case |
  | `full_name` | required, at most 120 characters |
  | `password` | required on create, 8 to 128 characters; send it in a PUT to change it |
  | `role` | required: `viewer`, `contributor`, `manager` or `admin` |
  | `is_active` | true or false |
- **Admin limits:** admins cannot change their own role, deactivate themselves, or delete themselves (400).
- **Deleting a user** who owns projects or recorded budget entries returns 409 `user_in_use`; deactivate the account instead.

### Projects

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/projects` | viewer | filters `status`, `department`, `owner_id`; `q` on name, description; sort `name` (default), `end_date`, `status` |
| POST | `/projects` | contributor | (none) |
| GET | `/projects/{id}` | viewer | (none) |
| PUT | `/projects/{id}` | contributor | (none) |
| DELETE | `/projects/{id}` | manager | (none) |

**Fields:**

| Field | Rules |
| --- | --- |
| `name` | required, unique (409), at most 150 characters |
| `department` | required, at most 100 characters |
| `description` | at most 2000 characters |
| `status` | `planned` (default), `active`, `on_hold`, `completed` or `cancelled` |
| `start_date` | required |
| `end_date` | required (the deadline), on or after `start_date` |
| `budget_planned` | 0 or more, default 0 |
| `owner_id` | an existing user id |

- **Every project read** (list, single read, create and update responses) includes three computed fields:
  - `percent_complete`: done deliverables ÷ all deliverables × 100, to one decimal place (0 with no deliverables)
  - `budget_spent`: the sum of the project's budget entries
  - `owner_name`: the owner's full name, or null without an owner (only admins can read `/auth/users`)
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
| DELETE | `/deliverables/{id}/dependencies/{depends_on_id}` | manager | (none) |

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
- **`GET /deliverables/{id}/dependencies`** lists the deliverables this one depends on in `items`, and the ones that depend on it in `dependents`. Each entry has `id`, `project_id`, `title`, `status` and `due_date`.
- **`POST /deliverables/{id}/dependencies`** takes `{"depends_on_id"}` and returns 201 with the linked deliverable.
  - A self-link, a deliverable from another project, or a link that would create a cycle returns 400, with a message saying which.
  - An existing link returns 409.
- **`DELETE /deliverables/{id}/dependencies/{depends_on_id}`** removes the link. It returns 404 if there was no such link.

### Resources

| Method | Path | Minimum role | Filters, search, sort |
| --- | --- | --- | --- |
| GET | `/resources` | viewer | filters `department`, `is_active` (`true`/`false`); `q` on full_name, email, job_title; sort `full_name` (default), `department`, `capacity_pct` |
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
| `department` | at most 100 characters |
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
| GET | `/budgets` | viewer | filters `project_id`, `category`, `spent_from` (on or after), `spent_to` (on or before); sort `-spent_on` (default), `spent_on`, `amount`, `category` |
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

## Demo data

A fresh database is seeded with demo data. Each table is seeded only when it is empty, and every date is relative to today.

- **Users:** `admin@acme.test` (admin), `manager@acme.test` (manager), `lead@acme.test` (contributor) and `viewer@acme.test` (viewer). Their password is `SEED_PASSWORD`; the Terraform default is `AcmeDemo-2026`.
- **Projects**, each in a different state:
  - Customer Portal Revamp: healthy
  - Data Center Migration: past its deadline
  - Mobile Banking App: behind schedule, with a blocked deliverable and a three-link dependency chain
  - Brand Refresh Campaign: over budget
  - ERP Finance Upgrade: completed
  - Market Expansion Study: planned
- **People:** Aisha Khan and Farid Haddad are booked above 100%.
