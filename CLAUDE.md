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

## Architecture
- ONE Lambda: `backend/tracker/`, with `function.py` (exports `handler`) and `requirements.txt`. Every extra Lambda adds a CloudFront behaviour and a slow deploy, so the domains are modules inside one service, not separate services.
- Our code lives in the package `backend/tracker/acme/`:
  - `acme/core/`: config.py, db.py, http.py, validation.py, auth.py, crud.py
  - `acme/domains/`: auth.py, projects.py, deliverables.py, resources.py, allocations.py, budgets.py, insights.py
  - `acme/schema.sql`, `acme/seed.py`
- `start-dev.sh` pip-installs dependencies into `backend/tracker/`. Git tracks only `function.py`, `requirements.txt` and `acme/` there.
- Requests are Lambda Function URL events (payload v2). The path is `/api/tracker/<domain>/...` in the cloud and `/<domain>/...` locally, because the dev proxy strips the prefix. The router accepts both.
- Do not add CORS headers in Python. The Function URL config and the dev proxy add them.
- Config comes from the environment: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_NAME, POSTGRES_USER, POSTGRES_PASS, IS_LOCAL (use sslmode=require when it is "false"), JWT_SECRET, SEED_PASSWORD. No secrets in code.
- The schema is `acme/schema.sql`, applied idempotently on cold start under `pg_advisory_lock`. Demo data is seeded only into empty tables.

## Data model
- users: email (unique), full_name, password_hash, role, is_active
- projects: name (unique), department, description, status (planned, active, on_hold, completed, cancelled), start_date, end_date (the deadline), budget_planned, owner_id -> users
- deliverables: project_id -> projects (cascade), title, description, status (not_started, in_progress, blocked, done), due_date, completed_at, assignee_id -> resources (set null)
- deliverable_dependencies: deliverable_id, depends_on_id (both -> deliverables, cascade), primary key on the pair, no self-reference, no cycles, same project only
- resources: full_name, email (unique), job_title, department, capacity_pct (default 100), is_active
- allocations: resource_id -> resources (cascade), project_id -> projects (cascade), allocation_pct (1 to 100), start_date, end_date, role_on_project
- budget_entries: project_id -> projects (cascade), category (labor, software, hardware, services, other), description, amount (> 0), spent_on, created_by -> users
- Every table: id (identity), created_at, updated_at. Money is numeric(14,2).

## API contract
- Per domain: `GET /api/tracker/<domain>` (list with filters, `q`, `sort`, `limit`, `offset`), `POST /api/tracker/<domain>`, `GET`, `PUT` and `DELETE /api/tracker/<domain>/{id}`.
- Status codes: 200, 201 on create, 204 on delete with an empty body, 400 validation or malformed input, 401 missing, invalid or expired token, 403 role not allowed, 404, 409 duplicate or conflict, 500.
- Lists return `{"items": [...], "total": n, "limit": n, "offset": n}`. Single reads return the object.
- Errors are always `{"error": {"code": "...", "message": "...", "details": [{"field": "...", "message": "..."}]}}`.
- Validate before persisting: required, type, enum, length, date order, and that referenced ids exist (a 400, never a 500 from the foreign key).
- Everything except `POST /auth/login`, `POST /auth/refresh` and `GET /health` requires `Authorization: Bearer <access token>`.

## Python conventions
- PEP 8, snake_case, type hints and docstrings on public functions. Must run on Python 3.10 (host tests) and 3.13 (Lambda).
- psycopg 3 with parameterised queries only. Build dynamic SQL with `psycopg.sql` and whitelisted identifiers, never f-strings or concatenation.
- CI runs `bandit -r ./backend` on every push and it must report nothing: no hardcoded passwords, no string-built SQL, no `assert` under backend/.
- Tests are pytest in `tests/backend/`, outside `backend/`. They append `backend/tracker` to sys.path (append, so the venv's packages win over the vendored ones), and call `handler(event)` against the local Postgres database `acme_test`, using both path styles. Run them with `./bin/test-backend.sh`.
- Log one line per request: method, path, status, duration, user id. Never log tokens or passwords.

## Frontend conventions
- React 19 with Vite, JavaScript, function components. PropTypes on every component and JSDoc on exported functions.
- Style only through Material UI components, the theme and `sx`. Use `useMediaQuery` from `react-responsive` wherever layout differs between phone and desktop.
- `HashRouter`. CloudFront has no SPA fallback after our infra fix.
- Folders: `src/pages`, `src/components`, `src/services`, `src/context`, `src/hooks`, `src/utils`. Never create folders named lib, assets, build, dist, env, logs, tmp or coverage: the repo .gitignore swallows them.
- API base is `${import.meta.env.VITE_API_URL || ''}/api/tracker`. One client in `src/services` owns the token, one refresh-and-retry on 401, and error normalisation.
- Every data view has loading, empty and error states. Forms validate before submit, show errors next to the field and disable while saving. Controls the role cannot use are not rendered.
- Tests are Vitest with React Testing Library, next to the code as `*.test.jsx`. Run `npm test --prefix frontend`. Lint with `npm run lint --prefix frontend`.

## Definition of done for any task
Whichever of these the task touched must pass: `./bin/test-backend.sh` (ruff, bandit, pytest), `npm run lint --prefix frontend`, `npm test --prefix frontend`, `npm run build --prefix frontend`. And `git status --short` shows no vendored packages and no build output.
