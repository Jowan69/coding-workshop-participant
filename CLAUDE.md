# ACME Project Tracker: working agreement

Citi coding workshop, individual build, ONE day. A stand-alone web app that gives ACME Inc. visibility into project status, deadline risk, resource allocation, deliverables, dependencies and budget. Graded on Implementation, Design, Code, Testing and Experience (docs/full-stack.md is the rubric). Working and deployed beats complete: every phase must end deployable.

## Hard rules
- Never run `git commit`, `git push`, `./bin/deploy-backend.sh`, `./bin/deploy-frontend.sh`, `./bin/start-dev.sh`, `./bin/cleanup-environment.sh` or `terraform plan/apply/destroy`. The human does these.
- Required stack only. Frontend: React, Material UI, react-responsive. Backend: Python on Lambda, psycopg 3, PyJWT. Database: PostgreSQL. No FastAPI, Flask, ORM, pydantic, MongoDB, TypeScript or CSS framework.
- Stay inside the phase you were given. No extra features, no speculative abstractions.
- Do not modify the workshop's own files in docs/, data/, backend/_examples, infra/eks.tf or infra/documentdb.tf.
- End every task with: files changed, commands run with their results, what you could not verify, and what the human must do next.

## Roles (decided, do not change)
One global role per user, ranked viewer < contributor < manager < admin.

| Role | Who at ACME | Can |
| --- | --- | --- |
| viewer | Stakeholder | read everything |
| contributor | Team lead | read, create, update |
| manager | Project manager | read, create, update, delete |
| admin | PMO admin | all of that, plus manage users and roles |

The backend enforces this on every request: GET needs viewer, POST and PUT need contributor, DELETE needs manager, anything under /auth/users needs admin. The UI hides what a role cannot do, but the API is the control.

Exceptions to the method rule, each named in `tests/backend/test_hardening.py` (add a route there or the test fails):
- `POST /auth/logout` and `POST /auth/change-password` need viewer: everyone manages their own session and password.
- `GET /auth/users/options` needs contributor: people who can edit a project must be able to pick its owner (names only).
- `DELETE /deliverables/{id}/dependencies/{depends_on_id}` needs contributor: removing a dependency link edits a deliverable and deletes no record.

The role always comes from the user's database row, re-read on every authenticated request, never from the token.

## Architecture
- ONE Lambda: `backend/tracker/`, with `function.py` (exports `handler`) and `requirements.txt`. Every extra Lambda adds a CloudFront behaviour and a slow deploy, so the domains are modules inside one service, not separate services.
- Our code lives in the package `backend/tracker/acme/`:
  - `acme/core/`: config.py, db.py, http.py, validation.py, auth.py, crud.py, passwords.py (the one password policy), idempotency.py (Idempotency-Key)
  - `acme/domains/`: auth.py, projects.py, deliverables.py, resources.py, allocations.py, budgets.py, insights.py, insights_sql.py, dependency_chain.py (in-memory dependency traversal), departments.py (one spelling per department)
  - `acme/schema.sql`, `acme/seed.py`
- `start-dev.sh` pip-installs dependencies into `backend/tracker/`. Git tracks only `function.py`, `requirements.txt` and `acme/` there.
- Requests are Lambda Function URL events (payload v2). The path is `/api/tracker/<domain>/...` in the cloud and `/<domain>/...` locally, because the dev proxy strips the prefix. The router accepts both.
- Do not add CORS headers in Python. The Function URL config and the dev proxy add them.
- Config comes from the environment: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_NAME, POSTGRES_USER, POSTGRES_PASS, IS_LOCAL (use sslmode=require when it is "false"), JWT_SECRET, SEED_PASSWORD. No secrets in code. The cloud demo password is never in the repository: Terraform generates it (`terraform output -raw demo_password`) unless `TF_VAR_demo_password` sets it; only LocalStack has a fixed one.
- The schema is `acme/schema.sql`, applied idempotently on cold start under `pg_advisory_lock`, whenever its checksum (which also covers a SHA-256 of SEED_PASSWORD) changes. Demo data is seeded only into empty tables; the four demo users' passwords follow SEED_PASSWORD.
- Schema changes are additive and idempotent, appended to the end of `schema.sql` (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE / INDEX IF NOT EXISTS`): the deployed database already holds the earlier schema and data. `tests/backend/test_schema_migration.py` applies the file over the previous version's schema, twice. It reads that version from git: `HEAD` while `schema.sql` or `seed.py` has uncommitted changes, otherwise `HEAD^` (or the nearest earlier commit where either differs), which is why CI checks out with `fetch-depth: 0`.
- Every database connection sets `timezone=UTC` and a 15 second `statement_timeout`. "Today" and "overdue" always come from the database's `CURRENT_DATE`, never from Python or the browser.

## Data model
- users: email (unique), full_name, password_hash, role, is_active, token_version (integer, default 0: the `ver` claim of every token; bumping it revokes them), must_change_password (boolean: set by an admin reset, cleared when the user changes the password)
- projects: name (unique, and unique ignoring case through the index on lower(name)), department, description, status (planned, active, on_hold, completed, cancelled), start_date, end_date (the deadline), budget_planned, owner_id -> users (the creator unless the body says otherwise)
- deliverables: project_id -> projects (cascade), title, description, status (not_started, in_progress, blocked, done), due_date, completed_at, assignee_id -> resources (set null)
- deliverable_dependencies: deliverable_id, depends_on_id (both -> deliverables, cascade), primary key on the pair, no self-reference, no cycles, same project only
- resources: full_name, email (unique), job_title, department, capacity_pct (default 100), is_active
- allocations: resource_id -> resources (cascade), project_id -> projects (cascade), allocation_pct (1 to 100), start_date, end_date, role_on_project
- budget_entries: project_id -> projects (cascade), category (labor, software, hardware, services, other), description, amount (> 0), spent_on, created_by -> users
- login_attempts: email (as submitted, lower-cased), attempted_at. Failed sign-ins, for throttling; deleted on a successful sign-in and after 24 hours.
- idempotency_keys: key (primary key), user_id -> users (cascade), method, path, status, response (jsonb), created_at. One row per POST that carried an Idempotency-Key; deleted after 24 hours.
- Every table: id (identity), created_at, updated_at. Money is numeric(14,2). The two operational tables above are the exception: they have only the columns listed (login_attempts also has an id).
- Departments are free text on projects and resources; a department that already exists in another case is stored in the existing spelling.
- An update sets `updated_at = clock_timestamp()` (not `now()`), so every update leaves a new value for `expected_updated_at` to compare.

## API contract
- Per domain: `GET /api/tracker/<domain>` (list with filters, `q`, `sort`, `limit`, `offset`), `POST /api/tracker/<domain>`, `GET`, `PUT` and `DELETE /api/tracker/<domain>/{id}`.
- Status codes: 200, 201 on create, 204 on delete with an empty body, 400 validation or malformed input, 401 missing, invalid, expired or revoked token, 403 role not allowed (or `password_change_required`), 404, 409 duplicate or conflict (also `stale_record` and `idempotency_key_reused`), 413 body over 256 KB, 429 too many failed sign-ins, 500, 503 `query_timeout`.
- Every response carries `Cache-Control: no-store`.
- PUT accepts `expected_updated_at` and answers 409 `stale_record` when the row changed since the client read it. This lives in `crud.update_row`, so every resource has it.
- A POST with an `Idempotency-Key` header runs once (`core/idempotency.py`); the session routes opt out with `idempotent=False`, because a response that holds tokens must never be stored.
- Lists return `{"items": [...], "total": n, "limit": n, "offset": n}`. Single reads return the object.
- Errors are always `{"error": {"code": "...", "message": "...", "details": [{"field": "...", "message": "..."}]}}`.
- Validate before persisting: required, type, enum, length, date order, dates between 2000-01-01 and 2100-12-31, no control characters in text (line breaks and tabs only in multi-line fields), and that referenced ids exist (a 400, never a 500 from the foreign key).
- Everything except `POST /auth/login`, `POST /auth/refresh` and `GET /health` requires `Authorization: Bearer <access token>`. A handler that must keep a write when it answers with an error (a failed login records the attempt) returns the error `Response` instead of raising: raising rolls the request's transaction back.
- Passwords go through one policy function, `core/passwords.password_problem`.

## Python conventions
- PEP 8, snake_case, type hints and docstrings on public functions. Must run on Python 3.10 (host tests) and 3.13 (Lambda).
- psycopg 3 with parameterised queries only. Build dynamic SQL with `psycopg.sql` and whitelisted identifiers, never f-strings or concatenation.
- CI runs `bandit -r ./backend` on every push and it must report nothing: no hardcoded passwords, no string-built SQL, no `assert` under backend/.
- Tests are pytest in `tests/backend/`, outside `backend/`. They append `backend/tracker` to sys.path (append, so the venv's packages win over the vendored ones), and call `handler(event)` against the local Postgres database `acme_test`, using both path styles. Run them with `./bin/test-backend.sh`.
- Log one line per request: method, path, status, duration, user id. Never log tokens or passwords.

## Frontend conventions
- React 19 with Vite, JavaScript, function components. PropTypes on every component and JSDoc on exported functions.
- Style only through Material UI components, the theme and `sx`. Use `useMediaQuery` from `react-responsive` wherever layout differs between phone and desktop.
- `HashRouter`. CloudFront never rewrites errors to index.html (`custom_error_response` stays removed). Instead a CloudFront Function on the default behaviour serves index.html for paths without a file extension, and `src/utils/pathRedirect.js` turns such a path into its hash route (/projects/5 becomes /#/projects/5).
- Route pages are lazy-loaded (`React.lazy` in `App.jsx`), so tests that render `AppRoutes` wait for the page with `findBy`.
- Folders: `src/pages`, `src/components`, `src/services`, `src/context`, `src/hooks`, `src/utils`. Never create folders named lib, assets, build, dist, env, logs, tmp or coverage: the repo .gitignore swallows them.
- API base is `${import.meta.env.VITE_API_URL || ''}/api/tracker`. One client in `src/services` owns the token, one refresh-and-retry on 401, and error normalisation.
- Every data view has loading, empty and error states. Forms validate before submit, show errors next to the field and disable while saving. Controls the role cannot use are not rendered.
- Lists keep their filters, page, page size and sort in the URL query (`useApiList` with `columns`), and sort through the API's `sort` parameter.
- Writes: `FormDialog` saves once per opening (one Idempotency-Key, reused on retry), sends only changed fields with `expected_updated_at` when editing, and offers Reload on `stale_record`. Pages pass its second `onSubmit` argument on to `useApiMutation`.
- "Overdue" is never worked out in the browser: use the API's `is_overdue` and show `as_of` (`AsOfNote`).
- The production build carries a Content-Security-Policy meta tag (`frontend/csp.js`): no inline scripts, and nothing loaded from another origin.
- Tests are Vitest with React Testing Library, next to the code as `*.test.jsx`. Run `npm test --prefix frontend`. Lint with `npm run lint --prefix frontend`.

## Definition of done for any task
Whichever of these the task touched must pass: `./bin/test-backend.sh` (ruff, bandit, pytest), `npm run lint --prefix frontend`, `npm test --prefix frontend`, `npm run build --prefix frontend`. And `git status --short` shows no vendored packages and no build output.
