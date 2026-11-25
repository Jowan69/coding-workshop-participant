# Testing

How the ACME Project Tracker is tested, the latest results, the manual checklists and the known gaps. Architecture and setup are in the [README](README.md); the API contract is in [API.md](API.md).

## Commands

Run from the repository root.

| Command | What it runs | Needs |
| --- | --- | --- |
| `./bin/test-backend.sh` | ruff, bandit (same scope as CI), then pytest with coverage. Fails below 80% (`pyproject.toml`). | PostgreSQL on `localhost:5432`; `PGPASSWORD` defaults to `postgres123`. The script creates and resets the `acme_test` database and its own `.venv`. |
| `npm test --prefix frontend` | Vitest with React Testing Library, in jsdom | `npm ci --prefix frontend` |
| `npm run test:coverage --prefix frontend` | The same tests with v8 coverage. Fails below 70% of lines (`vite.config.js`). The HTML report goes to `frontend/coverage/`, which git ignores. | as above |
| `npm run lint --prefix frontend` | ESLint, including the React Hooks and React Compiler rules | as above |
| `npm run build --prefix frontend` | Production build | as above |
| `./bin/smoke-test.sh [BASE_URL]` | curl checks against a running API: health, `Cache-Control`, sign-in for each role, every list, 401, 403, a JSON 404 and every insight. For an `https://` URL it also checks the edge: security headers, the Content-Security-Policy, a compressed main script and `/projects` returning the app. | A deployed API. The default is `http://localhost:3001`. For AWS pass the CloudFront URL and export `SEED_PASSWORD` (`terraform -chdir=infra output -raw demo_password`). `SPA_REWRITE=0` skips the `/projects` check. |
| `./bin/warm-up.sh [BASE_URL]` | Polls `/health` until a paused Aurora resumes, then signs in and lists one page, printing each step's time | as above |

Pass extra pytest arguments through, for example `./bin/test-backend.sh -k hardening`. Judge the script by its exit code, not by piping it into `tail`.

**CI.** [.github/workflows/tests.yml](.github/workflows/tests.yml) runs on every push and pull request: `./bin/test-backend.sh` against a PostgreSQL 16 service on Python 3.10 and 3.13, and for the frontend `npm ci`, lint, tests with coverage and the build. The backend job checks the repository out with its history (`fetch-depth: 0`), because the migration tests read the previous schema from an earlier commit.

## What each suite covers

### Backend: 1003 tests in `tests/backend/`

These are integration tests. Each one calls the Lambda's `handler(event)` with a Function URL (payload v2) event against a real PostgreSQL database, with no database mocks. Every test runs inside a transaction that is rolled back afterwards, so the seeded demo data stays intact. Tests that use the `api` fixture run twice: once with the local path (`/projects`) and once with the cloud path (`/api/tracker/projects`). A few tests marked `no_rollback` use separate connections and threads, because what they prove (commits, row locks, concurrent requests) cannot happen inside one transaction; they delete what they create.

| File | Tests | Covers |
| --- | ---: | --- |
| `test_http.py` | 42 | Event parsing, base64 and malformed JSON (400), prefix stripping, routing, JSON encoding, the error envelope, mapping database errors to 400 or 409, a 500 that hides internals, one log line per request without the token |
| `test_auth_core.py` | 31 | scrypt hashing, JWT issue and verify, expiry, wrong signing key, access and refresh tokens swapped, unknown role in a token, role ranking |
| `test_auth.py` | 50 | Login (unknown email and wrong password give the same 401), inactive accounts, refresh re-reading role and status, `/auth/me`, user admin, admins unable to demote, deactivate or delete themselves, 409 `user_in_use`, 403 for every non-admin role |
| `test_sessions.py` | 184 | Part B. The role comes from the database on every request (with the row changed directly in SQL, so without the version bump that a role change through the API adds, demotion, promotion, deactivation and deletion apply to a token already issued; one primary-key query). Revocation through `token_version`: both tokens carry `ver`, tokens without it are refused, and a reset, a role change, a deactivation, a password change and `/auth/logout` each revoke. `/auth/change-password` for every role, with the wrong-current-password field error, and a 401 (not a 500) when the account is deleted between authentication and the handler. The password policy, rule by rule, in create, reset and change; one and two character email names and full names are refused like longer ones, in any case, and an empty name refuses nothing. Temporary passwords: only three routes answer until it is changed; a valid refresh token gets 403 `password_change_required` (a revoked or inactive one still 401), and refresh works again after the change. Throttling: the failed attempt survives the 401 (also checked from a second connection), the sixth attempt is a 429 with `Retry-After` even with the right password, per email and case-insensitive, the window passing, clean-up after 24 hours, admin unlock |
| `test_demo_credentials.py` | 29 | Part C. The schema checksum covers a SHA-256 of `SEED_PASSWORD` and never contains it; a rotated password takes effect on the next cold start and revokes the demo sessions; other users are never touched; the Terraform variable, local value and sensitive output; no cloud password in API.md; the scripts refuse a remote URL without `SEED_PASSWORD` and fall back only for localhost |
| `test_write_integrity.py` | 102 | Part D. Idempotency keys: a repeat replays the stored response, other paths and other users get 409, a failed request stores nothing, malformed keys, expiry, the session routes never store a response, and six concurrent identical POSTs on separate connections create one row (with a control: six rows without the key). Lost updates: a stale `expected_updated_at` is a 409 on every resource, timestamps compare as instants, and the check waits for a writer holding the row. Ownership: the creator owns a new project; `/auth/users/options` |
| `test_hostile_data.py` | 117 | Part E. The dependency insight on 40 deliverables that each depend on all earlier ones answers within a second, with two queries; the traversal on diamonds, cycles, a runaway cycle (work budget) and a 5,000-long chain. The 15-second statement timeout and the 503 for a cancelled query, not retried. Bodies nested too deep (400) and over 256 KB (413). `is_overdue` and `as_of` on deliverables and projects, agreeing with the Dashboard, on a UTC clock. Project names and departments ignoring case. Dates outside 2000 to 2100. Control characters in every text field, in `q` and in text filters |
| `test_interface_rules.py` | 17 | Part F. Contributors may remove a dependency link, and it is the only DELETE below manager; `Cache-Control: no-store` on every kind of response; "Expected a refresh token" |
| `test_gaps.py` | 26 | Part A. Budget entries searchable by description; `/insights/project-status?status=`; `forecast_end_date` on every item |
| `test_schema_migration.py` | 16 | The schema and seed of the previous version, read from git (see [The migration baseline](#the-migration-baseline)), are built in a scratch database, then today's `schema.sql` is applied over them twice and today's seed is run: row counts unchanged, new columns present. The same with case-variant project names planted first: the oldest keeps its name and the newer ones are renamed with their id before the unique index is created. Four more plant projects that already hold the generated names (a chain nine candidates deep, the exact generated name, 150-character names, two sets of variants that meet): the rename skips to a free name, renames nobody else, deletes nothing, stays within 150 characters, and the second application changes no row. Nine more test the choice of the baseline commit on throwaway repositories |
| `test_tooling.py` | 19 | The dev proxy forwards `Idempotency-Key`; the Terraform files attach the managed security headers policy and compression to both kinds of behaviour, gate the rewrite function and keep `custom_error_response` out; `upload-frontend.sh` (run with a stand-in `aws`) sets `Cache-Control` per kind of file and still deletes; the smoke test's edge checks pass and fail correctly (run with a stand-in `curl`); the tests workflow, including the backend job's checkout with history; the lockfile is tracked and matches `package.json`; the README's known gaps |
| `test_hardening.py` | 27 | Checked against the real router: only `/health`, `/auth/login` and `/auth/refresh` are public; every route's role follows the method rule, with each exception named; every private route answers 401 without a token and 403 below its minimum role; an unsigned token claiming admin is refused; no non-admin can change their own role; a request that fails after writing rolls the write back; no user response contains a password or hash; non-ASCII digits in the query give a 400 |
| `test_projects.py` | 70 | CRUD, field validation with every error at once, date order, unknown owner (400, not a foreign-key 500), duplicate name (409), 404, filters, search, sort, pagination limits, computed `percent_complete`, `budget_spent` and `owner_name`, cascade delete |
| `test_deliverables.py` | 26 | CRUD, `completed_at` set and cleared, `project_id` that cannot change, dependency rules: self-link, cross-project link and cycle (400), duplicate link (409), missing link (404), `dependents` |
| `test_resources.py` | 38 | CRUD, unique email, capacity range, `allocation_today_pct`, unassigning deliverables on delete |
| `test_allocations.py` | 28 | CRUD, ranges and date order, the over-allocation warning (peak inside the period, exactly at capacity is not over) |
| `test_budgets.py` | 28 | CRUD, amount rules (greater than 0, two decimals), `created_by` taken from the token, date-range filters, `/budgets/summary` (400, 404, no planned budget) |
| `test_insights.py` | 90 | Every insight rule in API.md, on the seed and on crafted data: health, behind schedule, forecast, the over-allocation window, dependency depth and blocked-by-upstream, burn gap, summary counts. Unchanged by the new dependency traversal |
| `test_db.py` | 11 | Connection reuse, one reconnect after `OperationalError` (Aurora resuming), SSL outside local, schema applied once by checksum under the advisory lock |
| `test_seed.py` | 12 | The demo story, seeding only empty tables, no users without `SEED_PASSWORD` |
| `test_validation.py` | 40 | Field coercion: strings, emails, integers (booleans rejected), money, dates, enums, query parameters |

### The migration baseline

`test_schema_migration.py` migrates from the previous version of `schema.sql` and `seed.py` to the one in the working tree. It takes the previous version from git and chooses the commit itself, so the old-to-new migration is what runs both before and after a schema change is committed:

| State of `schema.sql` and `seed.py` | Baseline | When |
| --- | --- | --- |
| Either differs from `HEAD`, staged or not | `HEAD` | While a change is being written: `HEAD` still holds the previous schema |
| Both match `HEAD` | `HEAD^` | Once the change is committed, and so in CI: `HEAD` is now the new schema and its parent holds the previous one |
| Both match `HEAD`, and `HEAD^` holds the same two files | The nearest earlier commit where either file differs | After later commits that touched neither file (documentation, frontend): the test still migrates from the version before the last schema change |

- Both files always come from the one chosen commit, never the schema from one and the seed from another.
- Only these two files decide. Edits to other files, untracked files and a re-saved but identical file leave the tree "matching `HEAD`".
- The parent is the first parent, so for a pull request (GitHub tests the merge commit) the baseline is the target branch.
- The tests are skipped only where the source is not a git checkout at all, such as an unpacked archive. In a checkout that lacks the baseline commit (a shallow clone) the seven tests that read it fail, naming `fetch-depth: 0`; they are never skipped there. `test_tooling.py` checks that the workflow asks for the history.
- Nine tests cover the choice itself, on throwaway repositories built in pytest's temporary directory: an unstaged change, a staged change and a change to the seed alone (`HEAD`, for both files); a clean tree (`HEAD^`); edits to other files; a commit that changed only the seed; commits that touched neither file (stepped over); a one-commit clone (fails when clean, works with an uncommitted change); and that in this repository, in whatever state, the baseline is never the same schema and seed as the ones under test.

### Frontend: 458 tests in 30 files next to the code

Component and page tests render with the app's real providers (`src/TestProviders.jsx`). The API client is mocked at `request()`, and the phone layout is simulated through `window.innerWidth`.

| Area | Files | Covers |
| --- | --- | --- |
| API client | `services/apiClient.test.js`, `services/authApi.test.js` | Token attached; on a 401, one refresh and one retry; one shared refresh for concurrent 401s; a refused refresh signs out and records why; error normalisation. Phase 6: an `Idempotency-Key` on every POST and the same key on the retry after a refresh; the 30-second timeout, its message, retry and the caller's own abort; `Retry-After`; `password_change_required`; sign-out calls `/auth/logout` and clears storage even when it fails; change-password replaces the tokens |
| Session journeys in jsdom | `AppSession.test.jsx`, `AppAccount.test.jsx`, `AppLazy.test.jsx` | The real client against a stubbed `fetch`: an expired token is refreshed; a refused or revoked one lands on the sign-in page, which says "Your session ended. Sign in again." Sign out; change password from the account menu; a temporary password blocks every route until it is changed; lazy-loaded pages show a loading state |
| Shell and routing | `App.test.jsx`, `context/AuthContext.test.jsx`, `pages/LoginPage.test.jsx`, `utils/pathRedirect.test.js`, `utils/spaRewrite.test.js` | Signed-out redirect, navigation per role, not-allowed and not-found pages, skip link, phone navigation drawer; login errors, focus moved to the error, the throttling message, the demo list in development only; `/projects/5` becoming `/#/projects/5`; the CloudFront Function itself |
| Pages | `ProjectsPage`, `ProjectDetailPage`, `ResourcesPage`, `UsersPage`, `DependenciesDialog`, `DashboardPage`, `dashboard/DashboardSections` | Loading, empty and error states with Retry; controls a role cannot use are not rendered; create, edit and delete with confirmation; server field errors on the right field. Phase 6: search and filters on Budget, Team and Users; sorting and paging in the URL, restored by reload and the back button; the owner picker; edits that send only changed fields with `expected_updated_at`, and Reload on `stale_record`; overdue taken from the API with its "as of" note; reset password, delete user, unlock, role-change confirmation; the Dashboard's status toggle, Forecast column, "Updated HH:MM", Refresh and 60-second auto-refresh |
| Kit components | `DataList`, `FormDialog`, `ConfirmDialog`, `FilterBar`, `BudgetSummary`, `StatusChip` | Table on desktop and cards on phones, pagination, sortable headers with `aria-sort` and the phone Sort select; client validation; two clicks in one tick send one request; disabled until the dialog has closed; one idempotency key per opening; "Discard changes?"; focus on the first field; date limits |
| Long values | `wrapping.test.jsx` | The theme and layout rules that let 150-character unbroken values wrap (jsdom has no layout engine, so the real check is the browser sweep below) |
| Utilities and build | `format`, `permissions`, `dependencyTree`, `sorting`, `passwordRules`, `csp.test.js` | Formatting, the role matrix, the dependency tree, sort helpers, the password rules, the exact Content-Security-Policy and that it is injected in production builds only |

### Existing tests changed in phase 6

An existing test was changed only where phase 6 changes the rule it checks:

| Test | Rule that changed |
| --- | --- |
| `test_auth_core.py::test_access_token_round_trip` | Tokens carry `ver` (B2) |
| `test_hardening.py` method rule and password check | Four named role exceptions (B2, B3, D4, F2); user objects carry the flag `must_change_password` (B5) |
| `test_db.py` checksum tests | The checksum covers a SHA-256 of `SEED_PASSWORD` (C2) |
| `test_projects.py::test_create_project` | The creator owns a new project (D4) |
| `test_deliverables.py::test_add_and_remove_a_dependency` | Contributors may remove a link (F2) |
| `UsersPage` create-user test | The 10-character password policy (B4) |
| `LoginPage` demo list test | Shown in development only (C4) |
| Form POST assertions in `ProjectsPage`, `ProjectDetailPage`, `ResourcesPage`, `UsersPage`; three `FormDialog` tests | Form POSTs carry an idempotency key (D2); a new project's owner defaults to the signed-in user (D4) |
| Edit assertions in `ProjectsPage`, `ResourcesPage` | An edit sends only the changed fields (D3) |
| Overdue fixtures in `ProjectsPage`, `ProjectDetailPage` | The API decides what is overdue (E4) |
| `UsersPage` role change; `DependenciesDialog` removal by contributors | A role change is confirmed first (F7); contributors may remove a link (F2) |
| `DashboardPage`, `DashboardSections` section title and empty text | The section is retitled and defaults to active projects (A4) |
| Five routing tests in `App.test.jsx` | Pages are lazy-loaded, so the tests wait for them (G2) |

The shared test setup also changed, before any feature work: `src/setupTests.js` now lets React finish rendering after each `findBy`, `waitFor` and user-event call. Without it about one run in four failed a different test on this VM, because Testing Library's zero-delay timer and React's scheduler have no fixed order in Node (a list's loading skeleton was found instead of its rows). No test's assertions were changed for this.

## Latest results

Run on 2026-11-25 on the development VM (Python 3.10.12, Node 22.23.5, PostgreSQL 18.7).

| Check | Result |
| --- | --- |
| `./bin/test-backend.sh` | ruff: all checks passed. bandit: no issues. pytest: **1003 passed** in 39 s. |
| The same pytest suite on Python 3.13.18 (the Lambda runtime) | **1003 passed** |
| `npm run test:coverage --prefix frontend` | **458 passed** in 30 files |
| `npm run lint --prefix frontend` | No problems |
| `npm run build --prefix frontend` | Built. Pages are separate chunks; the entry script is 630 kB (201 kB gzipped, down from 235 kB). Vite still warns that it is over 500 kB. |
| `npm ci` from the committed lockfile, in a clean directory | Installs the same 292 package versions the checks ran against |
| `terraform fmt -check` and `terraform validate` in `infra/` | Clean; valid |
| `./bin/smoke-test.sh` (local stack) | **28 checks passed** (the edge checks apply to `https://` only) |
| `./bin/warm-up.sh` (local stack) | Healthy on the first attempt; sign-in and one list answered |

### Backend coverage (statements and branches)

| File | Stmts | Miss | Branch | BrPart | Cover |
| --- | ---: | ---: | ---: | ---: | ---: |
| `acme/core/auth.py` | 94 | 0 | 24 | 0 | 100% |
| `acme/core/config.py` | 26 | 0 | 2 | 0 | 100% |
| `acme/core/crud.py` | 185 | 1 | 58 | 2 | 99% |
| `acme/core/db.py` | 80 | 0 | 12 | 0 | 100% |
| `acme/core/http.py` | 216 | 0 | 54 | 0 | 100% |
| `acme/core/idempotency.py` | 38 | 0 | 10 | 0 | 100% |
| `acme/core/passwords.py` | 23 | 0 | 14 | 0 | 100% |
| `acme/core/validation.py` | 189 | 2 | 90 | 3 | 98% |
| `acme/domains/__init__.py` | 8 | 0 | 2 | 0 | 100% |
| `acme/domains/allocations.py` | 18 | 0 | 2 | 0 | 100% |
| `acme/domains/auth.py` | 147 | 1 | 46 | 1 | 99% |
| `acme/domains/budgets.py` | 26 | 0 | 6 | 0 | 100% |
| `acme/domains/deliverables.py` | 63 | 0 | 18 | 0 | 100% |
| `acme/domains/departments.py` | 13 | 0 | 4 | 0 | 100% |
| `acme/domains/dependency_chain.py` | 95 | 0 | 44 | 0 | 100% |
| `acme/domains/insights.py` | 114 | 0 | 24 | 0 | 100% |
| `acme/domains/insights_sql.py` | 43 | 0 | 0 | 0 | 100% |
| `acme/domains/projects.py` | 27 | 0 | 4 | 0 | 100% |
| `acme/domains/resources.py` | 13 | 0 | 2 | 0 | 100% |
| `acme/seed.py` | 98 | 0 | 28 | 0 | 100% |
| `function.py` | 11 | 0 | 0 | 0 | 100% |
| **Total** | **1527** | **4** | **444** | **6** | **99.5%** |

Lines: 1523 of 1527 (99.7%). The four uncovered lines are the `sort=id` branch, a non-finite-number guard that JSON parsing already prevents, an unknown-field-kind guard, and `/auth/me` for a user deleted in the instant between authentication and the handler.

### Frontend coverage

| Folder | Stmts | Branch | Funcs | Lines |
| --- | ---: | ---: | ---: | ---: |
| `src` (App, test providers) | 96.9% | 100% | 92.9% | 95.7% |
| `src/components` | 98.0% | 93.2% | 97.5% | 98.5% |
| `src/context` | 95.0% | 89.3% | 100% | 100% |
| `src/hooks` | 96.7% | 90.5% | 100% | 96.9% |
| `src/pages` | 98.4% | 91.7% | 97.9% | 98.9% |
| `src/pages/dashboard` | 98.4% | 91.4% | 100% | 99.4% |
| `src/services` | 98.5% | 95.8% | 100% | 99.1% |
| `src/utils` | 99.1% | 92.6% | 100% | 98.9% |
| **All files** | **98.1%** (1775/1809) | **92.4%** (1208/1307) | **98.5%** (589/598) | **98.7%** (1579/1600) |

The lowest files are `components/BudgetBar.jsx` (87.5%: one line, a missing spend), `hooks/useApiList.js` (90.7%: the page controls of a list that keeps its state out of the URL, which no page uses with pagination) and `App.jsx` (90.9%: tests render `AppRoutes` inside `TestProviders` instead of the `HashRouter` wrapper).

### Regression tests checked against the old code

For the double-submit fix (D1) the tests were also run against the dialogs with the old logic put back (no ref guard, buttons re-enabled when the save resolves). Exactly the six D1 tests failed, in `ConfirmDialog.test.jsx`, `FormDialog.test.jsx` and `ProjectsPage.test.jsx`; with the fix restored they pass.

For the migration baseline, `select_baseline` was changed four ways and `test_schema_migration.py` run each time. Always `HEAD` (the old behaviour): the five clean-tree tests failed. Never `HEAD`: twelve failed. `HEAD^` without stepping over commits that left both files alone: two failed. Judging the tree by `schema.sql` alone: the two seed-only tests failed. With the code restored all 16 pass.

The state after the commit was also run for real, in a throwaway clone outside the repository in which the phase 6 working tree was committed (the repository itself was not committed to):

| Clone | Baseline chosen | `test_schema_migration.py` |
| --- | --- | --- |
| Phase 6 committed, clean tree | `HEAD^` (the phase 5 commit) | 16 passed |
| A documentation commit on top | `HEAD^^` (still the phase 5 commit) | 16 passed |
| The same, cloned with `--depth 1` (the `actions/checkout` default) | none: `HEAD^` is missing | 7 failed with the `fetch-depth: 0` message, 9 passed, 0 skipped |
| The same, cloned with full history (`fetch-depth: 0`) | `HEAD^^` | 16 passed |
| This working tree, phase 6 uncommitted | `HEAD` (the phase 5 commit) | 16 passed |

### Content-Security-Policy against the build output

`dist/index.html` was inspected after `npm run build`: the policy's meta tag is the first element of `<head>`; the page loads one module script and the favicon, both from its own origin; there are no inline scripts or event-handler attributes, no stylesheet or font from another origin, and no `eval` or `new Function` in the bundles; page chunks are same-origin dynamic imports. Styles are injected at run time by Emotion, which `style-src 'unsafe-inline'` allows. The API is called on the page's own origin in a deployed build (`connect-src 'self'`). A build made with a local `.env.local`, which points at `http://localhost:3001`, cannot call that API when served by `vite preview`: use the dev server locally.

### Responsive and accessibility sweeps

**Long unbroken values (phase 6, E1).** A script (not part of the suites) created a project, a person, a user, two linked deliverables, two allocations and a budget entry on the local stack, with 150-character names, departments, emails, job titles, roles and descriptions without spaces. Headless Firefox then opened the Dashboard, Projects (filtered and unfiltered), the project's three tabs, Resources and Users at 360 × 780 and 1280 × 900, signed in as admin, and measured the page's `scrollWidth` and looked for any element reaching past the viewport outside a scroll container. **All 16 views passed**: no sideways page scroll, with the long values on screen and wrapped. The records were then deleted by their ids.

**Phase 5 sweep.** The same tooling drove sign-in, Dashboard, Projects, a project's three tabs, Resources, Users, not-found and the phone navigation drawer, and opened the new-project, new-user, dependencies and delete dialogs. It found two problems, both fixed then (long reason chips widening the Dashboard at 360px; borderless selects without a focus ring). After the fixes all 40 checks passed: no sideways page scroll, 0 unlabelled controls, every dialog full screen on phones with its actions visible, and a focus ring on every Tab stop walked. Status is never shown by colour alone.

## Manual end-to-end checklist

Run it against the deployed app (CloudFront URL) after `./bin/warm-up.sh <url>`, or locally at `http://localhost:3000`. Where the demo password comes from is in the [README](README.md#roles-and-demo-logins).

**Manager creates, tracks and completes work**

- [ ] Sign in as `manager@acme.test`. The Dashboard opens with the summary tiles and "Updated HH:MM".
- [ ] Projects → **New project**: the cursor is in Name and Owner already shows you. Name "E2E Check", department "QA", status **Active**, start today, deadline in 30 days, budget 10000 → **Create project**. "Project created" appears and the row shows Active, 0% complete and "$0 of $10,000 (0%)" budget used.
- [ ] Submit the form again with the name "e2e check". The dialog stays open and the name field says "already exists" (409, names ignore case).
- [ ] Open the project. The header shows you as Owner. Deliverables → **New deliverable**: title "Smoke deliverable", due in 7 days → **Add deliverable**. It is listed as Not started and the header reads "0% (0 of 1 deliverables done)".
- [ ] Change its status select to **Done**. The message '"Smoke deliverable" is now done' appears and the header reads "100% (1 of 1 deliverables done)".
- [ ] Dashboard: **Active projects** is one higher than before, and "What is the status of each active project?" lists E2E Check with "1 of 1 (100%)", health On track and a Forecast, and "How are deliverables progressing?" shows "1 of 1 done". Switch the toggle to **Planned**: E2E Check is gone.
- [ ] Clean up: Projects → **Delete E2E Check** → confirm. "Project deleted" appears.

**Viewer sees no write controls**

- [ ] Sign out, then sign in as `viewer@acme.test`. The role chip reads Viewer and there is no Users link.
- [ ] Projects: no **New project**, no Edit or Delete buttons, no Actions column.
- [ ] Open Mobile Banking App. Statuses are chips, not selects. There is no **New deliverable**, no **Add person** on Team and no **Add entry** on Budget. The Dependencies button opens a read-only list.
- [ ] Resources: no **Add person** and no row actions.
- [ ] Go to `#/users` by URL. A not-allowed page appears, not the user list.
- [ ] The API agrees: `./bin/smoke-test.sh <url>` passes "viewer POST /projects is forbidden" (403).

**Long values (E1): 150 characters without a space**

Use this text wherever a field allows it (shorten it to the field's limit; for an email put it before `@example.test`):

```
Supercalifragilisticexpialidocious0123456789Supercalifragilisticexpialidocious0123456789Supercalifragilisticexpialidocious0123456789Supercalifragilistic
```

- [ ] As an admin create a project with that name, department and description, status Active and a deadline in the past; a person with that name, job title, department and email; a user with that name and email; in the project, a deliverable with that title assigned to that person, an allocation of 100% and another of 50% for that person, and a budget entry with that description.
- [ ] At **1280px** wide open Dashboard, Projects, the project (all three tabs), Resources and Users. The page never scrolls sideways; the long values wrap inside their cells, cards, chips and headings; column headings stay on one line; the Edit dialog's title wraps.
- [ ] Repeat at **360px** wide (browser device toolbar). Same result: no sideways page scroll, cards no wider than the screen. Only the allocation matrix on the Dashboard scrolls sideways, inside its own frame.
- [ ] Delete the user, the person and the project.

**Role demotion ends the old session (B)**

A role change adds one to the user's `token_version`, which revokes every token they hold. A demoted manager does not stay signed in with fewer buttons: the old session ends, and the viewer interface appears after they sign in again. Use two browsers (or a private window): the admin in one, `manager@acme.test` in the other.

- [ ] As admin, Users → change `manager@acme.test` to Viewer. The confirmation names Daniel Okafor, says they are signed out and says what a viewer can do. Confirm it.
- [ ] In the manager's browser, click something that loads data (Projects, for example). That request, their first authenticated one since the change, ends the old session. On the Dashboard the 60-second auto-refresh does the same without a click.
- [ ] The sign-in page appears and says "Your session ended. Sign in again."
- [ ] Sign in again as `manager@acme.test`, with the same password.
- [ ] The viewer interface appears, without write controls: the role chip reads Viewer, there is no Users link, and Projects has no **New project**, Edit or Delete (as in "Viewer sees no write controls" above).
- [ ] Clean up: as admin, change `manager@acme.test` back to Manager, because other parts of this checklist sign in as a manager. That is a role change too, so the manager signs in once more.

**Sessions and accounts (B)**

- [ ] Users → **Reset password** for the viewer with "Short1": the field names the rule. Set a valid temporary password. Sign in as the viewer with it: only the "Choose a new password" screen is reachable. Choose one; the Dashboard opens.
- [ ] Account menu (your name) → **Change password** with a wrong current password: the field says it is incorrect. Change it correctly: you stay signed in; another browser signed in as you is signed out.
- [ ] Sign in with a wrong password five times for one email. The sixth attempt, even with the right password, says "Too many attempts. Try again in N minutes." As admin, Users shows **Locked** on that row; **Unlock** lets them in at once.
- [ ] Users → **Delete** `manager@acme.test`: the API's reason (owns projects and budget entries) is shown and the user stays.
- [ ] Leave a tab signed in for more than 30 minutes, then click a page. It loads without asking you to sign in again (refresh and retry).

**Write integrity (D) and interface (F)**

- [ ] Double-click **Create project** as fast as you can: one project is created.
- [ ] Open the same project's Edit form in two browsers. Save a change in the first, then in the second: it says "This was changed by someone else"; **Reload** refills the form with the first browser's values.
- [ ] Type in a form and press Esc: "Discard changes?" appears. An untouched form closes at once.
- [ ] Projects: click the **Deadline** heading twice, go to page 2, reload the page, open a project and press Back: the sort and page are as you left them, and they are in the address bar.
- [ ] As `lead@acme.test` (contributor) open a deliverable's dependencies: the remove button is there and works.

**After a deploy (G)**

- [ ] `./bin/smoke-test.sh https://<distribution>.cloudfront.net` passes, including the security headers, the compressed script and `/projects`.
- [ ] Open `https://<distribution>.cloudfront.net/projects`: the app opens and the address becomes `/#/projects`.
- [ ] The browser console shows no Content-Security-Policy violation on Dashboard, Projects, a project and Users.
- [ ] The sign-in page does not list the demo accounts.

Last run: not yet run against AWS in this phase (nothing was deployed). Record the date, URL and any failures here.

## Known gaps

- **No automated end-to-end tests.** Cypress or Selenium is not set up. The checklists above are manual; the session journeys in jsdom cover sign-in, refresh, revocation and the temporary-password flow.
- **No load or performance tests.** Artillery and JMeter are not set up. `warm-up.sh` prints single-request timings only, and one test bounds the dependency insight on a dense graph at one second.
- **The edge is not tested until it is deployed.** The Terraform files, the CloudFront Function and the smoke test's edge checks are tested here with stand-ins; whether CloudFront accepts them is only known after `./bin/deploy-backend.sh`.
- **jsdom has no layout engine.** Overflow and `:focus-visible` cannot be unit-tested, so the browser sweeps above were manual tooling, run once each.
- **Demo data drifts.** Seed dates are relative to the day the database was seeded, so an older database shows different Dashboard counts from the ones in API.md. The tests seed a fresh `acme_test` on every run.
