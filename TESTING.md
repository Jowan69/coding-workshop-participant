# Testing

How the ACME Project Tracker is tested, the latest results, a manual end-to-end checklist and the known gaps. Architecture and setup are in the [README](README.md); the API contract is in [API.md](API.md).

## Commands

Run from the repository root.

| Command | What it runs | Needs |
| --- | --- | --- |
| `./bin/test-backend.sh` | ruff, bandit (same scope as CI), then pytest with coverage. Fails below 80% (`pyproject.toml`). | PostgreSQL on `localhost:5432`; `PGPASSWORD` defaults to `postgres123`. The script creates and resets the `acme_test` database and its own `.venv`. |
| `npm test --prefix frontend` | Vitest with React Testing Library, in jsdom | `npm install --prefix frontend` |
| `npm run test:coverage --prefix frontend` | The same tests with v8 coverage. Fails below 70% of lines (`vite.config.js`). The HTML report goes to `frontend/coverage/`, which git ignores. | as above |
| `npm run lint --prefix frontend` | ESLint, including the React Hooks and React Compiler rules | as above |
| `npm run build --prefix frontend` | Production build | as above |
| `./bin/smoke-test.sh [BASE_URL]` | curl checks against a running API: health, sign-in for each role, every list, 401, 403, a JSON 404 and every insight | A deployed API. The default is `http://localhost:3001`; for AWS, pass the CloudFront URL. |
| `./bin/warm-up.sh [BASE_URL]` | Polls `/health` until a paused Aurora resumes, then signs in and lists one page, printing each step's time | as above |

Pass extra pytest arguments through, for example `./bin/test-backend.sh -k hardening`. Judge the script by its exit code, not by piping it into `tail`.

## What each suite covers

### Backend: 492 tests in `tests/backend/`

These are integration tests. Each one calls the Lambda's `handler(event)` with a Function URL (payload v2) event against a real PostgreSQL database, with no database mocks. Every test runs inside a transaction that is rolled back afterwards, so the seeded demo data stays intact. Tests that use the `api` fixture run twice: once with the local path (`/projects`) and once with the cloud path (`/api/tracker/projects`).

| File | Tests | Covers |
| --- | ---: | --- |
| `test_http.py` | 42 | Event parsing, base64 and malformed JSON (400), prefix stripping, routing, JSON encoding, the error envelope, mapping database errors to 400 or 409, a 500 that hides internals, one log line per request without the token |
| `test_auth_core.py` | 31 | scrypt hashing, JWT issue and verify, expiry, wrong signing key, access and refresh tokens swapped, unknown role in a token, role ranking |
| `test_auth.py` | 50 | Login (unknown email and wrong password give the same 401), inactive accounts, refresh re-reading role and status, `/auth/me`, user admin, admins unable to demote, deactivate or delete themselves, 409 `user_in_use`, 403 for every non-admin role |
| `test_hardening.py` | 26 | Checked against the real router: only `/health`, `/auth/login` and `/auth/refresh` are public; every route's role follows the method rule; every private route answers 401 without a token and 403 below its minimum role; an unsigned token claiming admin is refused; no non-admin can change their own role; a request that fails after writing rolls the write back; no user response contains a password or hash; non-ASCII digits in the query give a 400 |
| `test_projects.py` | 70 | CRUD, field validation with every error at once, date order, unknown owner (400, not a foreign-key 500), duplicate name (409), 404, filters, search, sort, pagination limits, computed `percent_complete`, `budget_spent` and `owner_name`, cascade delete |
| `test_deliverables.py` | 26 | CRUD, `completed_at` set and cleared, `project_id` that cannot change, dependency rules: self-link, cross-project link and cycle (400), duplicate link (409), missing link (404), `dependents` |
| `test_resources.py` | 38 | CRUD, unique email, capacity range, `allocation_today_pct`, unassigning deliverables on delete |
| `test_allocations.py` | 28 | CRUD, ranges and date order, the over-allocation warning (peak inside the period, exactly at capacity is not over) |
| `test_budgets.py` | 28 | CRUD, amount rules (greater than 0, two decimals), `created_by` taken from the token, date-range filters, `/budgets/summary` (400, 404, no planned budget) |
| `test_insights.py` | 90 | Every insight rule in API.md, on the seed and on crafted data: health, behind schedule, forecast, the over-allocation window, dependency depth and blocked-by-upstream, burn gap, summary counts |
| `test_db.py` | 11 | Connection reuse, one reconnect after `OperationalError` (Aurora resuming), SSL outside local, schema applied once by checksum under the advisory lock |
| `test_seed.py` | 12 | The demo story, seeding only empty tables, no users without `SEED_PASSWORD` |
| `test_validation.py` | 40 | Field coercion: strings, emails, integers (booleans rejected), money, dates, enums, query parameters |

### Frontend: 224 tests in 20 files next to the code

Component and page tests render with the app's real providers (`src/TestProviders.jsx`). The API client is mocked at `request()`, and the phone layout is simulated through `window.innerWidth`.

| Area | Files | Covers |
| --- | --- | --- |
| API client | `services/apiClient.test.js` | Token attached; on a 401, one refresh and one retry; one shared refresh for concurrent 401s; a refused refresh signs out; a retry still refused after a refresh signs out; a refresh that cannot reach the server keeps the session; no refresh when signed out or signing in; network failure; non-JSON bodies; error normalisation with field errors and default messages for 400, 403, 404 and 409 |
| Session expiry, end to end in jsdom | `AppSession.test.jsx` | The real client against a stubbed `fetch`: an expired token is refreshed and the page loads; a refused refresh lands on the sign-in page |
| Shell and routing | `App.test.jsx`, `context/AuthContext.test.jsx`, `pages/LoginPage.test.jsx` | Signed-out redirect, navigation per role, not-allowed and not-found pages, skip link, phone navigation drawer, sign in and sign out, login errors |
| Pages | `ProjectsPage`, `ProjectDetailPage`, `ResourcesPage`, `UsersPage`, `DependenciesDialog`, `DashboardPage`, `dashboard/DashboardSections` | Loading, empty and error states with Retry; controls a role cannot use are not rendered; create, edit and delete with confirmation; server field errors on the right field; a refused status change keeps the saved value; a 404 on delete keeps the dialog open; the over-allocation warning; every Dashboard section and its states; long chips wrap at 360px |
| Kit components | `DataList`, `FormDialog`, `FilterBar`, `BudgetSummary`, `StatusChip` | Table on desktop and cards on phones, pagination, client validation before submit, disabled while saving, full-screen dialogs on phones, status shown with icon and words |
| Utilities | `format`, `permissions`, `dependencyTree` | Formatting, the role matrix, building the dependency tree |

## Latest results

Run on 2026-11-24 on the development VM (Python 3.10.12, Node 22.23.5).

| Check | Result |
| --- | --- |
| `./bin/test-backend.sh` | ruff: all checks passed. bandit: no issues. pytest: **492 passed** in 4.5 s. |
| `npm test --prefix frontend` (with coverage) | **224 passed** in 20 files |
| `npm run lint --prefix frontend` | No problems |
| `npm run build --prefix frontend` | Built. Vite warns that the single bundle is over 500 kB (235 kB gzipped). |
| `./bin/smoke-test.sh` (local stack) | **27 checks passed** |
| `./bin/warm-up.sh` (local stack) | Healthy on the first attempt; sign-in and one list answered |

### Backend coverage (statements and branches)

| File | Stmts | Miss | Branch | BrPart | Cover |
| --- | ---: | ---: | ---: | ---: | ---: |
| `acme/core/auth.py` | 77 | 0 | 14 | 0 | 100% |
| `acme/core/config.py` | 26 | 0 | 2 | 0 | 100% |
| `acme/core/crud.py` | 162 | 1 | 46 | 2 | 99% |
| `acme/core/db.py` | 73 | 0 | 12 | 0 | 100% |
| `acme/core/http.py` | 195 | 0 | 46 | 0 | 100% |
| `acme/core/validation.py` | 172 | 2 | 82 | 3 | 98% |
| `acme/domains/__init__.py` | 8 | 0 | 2 | 0 | 100% |
| `acme/domains/allocations.py` | 18 | 0 | 2 | 0 | 100% |
| `acme/domains/auth.py` | 68 | 0 | 24 | 0 | 100% |
| `acme/domains/budgets.py` | 26 | 0 | 6 | 0 | 100% |
| `acme/domains/deliverables.py` | 62 | 0 | 18 | 0 | 100% |
| `acme/domains/insights.py` | 110 | 0 | 24 | 0 | 100% |
| `acme/domains/insights_sql.py` | 37 | 0 | 0 | 0 | 100% |
| `acme/domains/projects.py` | 19 | 0 | 0 | 0 | 100% |
| `acme/domains/resources.py` | 8 | 0 | 0 | 0 | 100% |
| `acme/seed.py` | 86 | 1 | 20 | 1 | 98% |
| `function.py` | 11 | 0 | 0 | 0 | 100% |
| **Total** | **1158** | **4** | **298** | **6** | **99.3%** |

Lines: 1154 of 1158 (99.7%). The four uncovered lines are the `sort=id` branch, a non-finite-number guard that JSON parsing already prevents, an unknown-field-kind guard and a seed skip for a missing project.

### Frontend coverage

| Folder | Stmts | Branch | Funcs | Lines |
| --- | ---: | ---: | ---: | ---: |
| `src` (App) | 92.3% | 100% | 80% | 91.7% |
| `src/components` | 97.6% | 92.0% | 98.0% | 98.0% |
| `src/context` | 88.2% | 78.3% | 90.0% | 96.4% |
| `src/hooks` | 92.8% | 90.0% | 91.8% | 92.6% |
| `src/pages` | 97.0% | 90.8% | 94.4% | 98.0% |
| `src/pages/dashboard` | 98.3% | 90.2% | 100% | 99.4% |
| `src/services` | 97.9% | 95.6% | 100% | 98.8% |
| `src/utils` | 98.7% | 93.0% | 100% | 98.4% |
| **All files** | **96.9%** (1301/1343) | **91.3%** (904/990) | **96.2%** (457/475) | **97.8%** (1176/1203) |

The lowest file is `hooks/useFilterParams.js` at 56% of lines: no test runs the `useClearFilters` callback (lines 28 to 31). `App.jsx` is at 50% because tests render `AppRoutes` inside `TestProviders` instead of the `HashRouter` wrapper.

### Responsive and accessibility sweep

A one-off script (not part of the suites) drove headless Firefox through the running local stack at 360 × 780 and 1280 × 900, signed in as admin. It visited sign-in, Dashboard, Projects, a project's three tabs, Resources, Users, not-found and the phone navigation drawer. It also opened the new-project, new-user, dependencies and delete dialogs. On each view it measured page `scrollWidth`, listed controls without an accessible name, checked that dialogs fit with their actions visible, and walked the Tab order checking for a visible focus indicator.

It found two problems, both fixed in this phase:

- **Dashboard at 360px scrolled sideways (393px).** A long reason chip ("100% of time elapsed, 50% of deliverables done") does not wrap by default. Reason and "Blocked by" chips now wrap (`AtRiskSection.jsx`, `DependencySection.jsx`); a jsdom test checks the style.
- **Borderless selects had no visible keyboard focus.** These are the deliverable status select and rows-per-page. InputBase's `:focus { outline: 0 }` beat the theme's global ring; a theme rule restores it (`theme.js`).

After the fixes, all 40 checks passed: no sideways page scroll, 0 unlabelled controls, every dialog full screen on phones with its actions visible, and a focus ring on every Tab stop walked. Status is never shown by colour alone: every coloured state also carries words ("2 overdue", "$20,000 over", "120%", "over-allocated") or an icon and a label.

## Manual end-to-end checklist

Run it against the deployed app (CloudFront URL) after `./bin/warm-up.sh <url>`, or locally at `http://localhost:3000`. The demo password is in the [README](README.md#roles-and-demo-logins).

**Manager creates, tracks and completes work**

- [ ] Sign in as `manager@acme.test`. The Dashboard opens with the summary tiles.
- [ ] Projects → **New project**: name "E2E Check", department "QA", status **Active**, start today, deadline in 30 days, budget 10000 → **Create project**. "Project created" appears and the row shows Active, 0% complete and "$0 of $10,000 (0%)" budget used.
- [ ] Submit the form again with the same name. The dialog stays open and the name field says "already exists" (409).
- [ ] Open the project. Deliverables → **New deliverable**: title "Smoke deliverable", due in 7 days → **Add deliverable**. It is listed as Not started and the header reads "0% (0 of 1 deliverables done)".
- [ ] Change its status select to **Done**. The message '"Smoke deliverable" is now done' appears and the header reads "100% (1 of 1 deliverables done)".
- [ ] Dashboard: **Active projects** is one higher than before, and "Where does each project stand?" lists E2E Check with "1 of 1 (100%)" and health On track, and "How are deliverables progressing?" shows "1 of 1 done".
- [ ] Clean up: Projects → **Delete E2E Check** → confirm. "Project deleted" appears.

**Viewer sees no write controls**

- [ ] Sign out, then sign in as `viewer@acme.test`. The role chip reads Viewer and there is no Users link.
- [ ] Projects: no **New project**, no Edit or Delete buttons, no Actions column.
- [ ] Open Mobile Banking App. Statuses are chips, not selects. There is no **New deliverable**, no **Add person** on Team and no **Add entry** on Budget. The Dependencies button opens a read-only list.
- [ ] Resources: no **Add person** and no row actions.
- [ ] Go to `#/users` by URL. A not-allowed page appears, not the user list.
- [ ] The API agrees: `./bin/smoke-test.sh <url>` passes "viewer POST /projects is forbidden" (403).

**Session**

- [ ] Leave a tab signed in for more than 30 minutes, then click a page. It loads without asking you to sign in again (refresh and retry).

Last run: not yet run against AWS in this phase. Record the date, URL and any failures here.

## Known gaps

- **No automated end-to-end tests.** Cypress or Selenium is not set up. The checklist above is manual, and `AppSession.test.jsx` covers only the token-refresh journey in jsdom.
- **No load or performance tests.** Artillery and JMeter are not set up. `warm-up.sh` prints single-request timings only.
- **CI does not run the tests.** The workflows in `.github/workflows` run bandit, `npm audit` and Terraform checks. They do not run pytest, Vitest, ESLint or the build.
- **jsdom has no layout engine.** Overflow and `:focus-visible` cannot be unit-tested, so the responsive and accessibility sweep above was manual tooling, run once.
- **Backend tests need a local PostgreSQL.** There is no container or service in CI for them yet.
- **Demo data drifts.** Seed dates are relative to the day the database was seeded, so an older database shows different Dashboard counts from the ones in API.md. The tests seed a fresh `acme_test` on every run.
