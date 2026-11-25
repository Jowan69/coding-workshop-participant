-- ACME project tracker schema.
-- Idempotent: acme.core.db.ensure_schema() applies it under an advisory lock whenever its
-- checksum differs from the one recorded in schema_meta.

CREATE TABLE IF NOT EXISTS schema_meta (
    id         smallint PRIMARY KEY CHECK (id = 1),
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
    full_name     varchar(120) NOT NULL,
    password_hash text NOT NULL,
    role          varchar(20) NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer', 'contributor', 'manager', 'admin')),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

CREATE TABLE IF NOT EXISTS resources (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name    varchar(120) NOT NULL,
    email        varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
    job_title    varchar(120),
    department   varchar(100),
    capacity_pct integer NOT NULL DEFAULT 100 CHECK (capacity_pct BETWEEN 1 AND 100),
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_department_idx ON resources (department);
CREATE INDEX IF NOT EXISTS resources_is_active_idx ON resources (is_active);

CREATE TABLE IF NOT EXISTS projects (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           varchar(150) NOT NULL UNIQUE,
    department     varchar(100) NOT NULL,
    description    varchar(2000),
    status         varchar(20) NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'cancelled')),
    start_date     date NOT NULL,
    end_date       date NOT NULL,
    budget_planned numeric(14, 2) NOT NULL DEFAULT 0 CHECK (budget_planned >= 0),
    owner_id       bigint REFERENCES users (id) ON DELETE RESTRICT,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT projects_dates_ordered CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS projects_owner_id_idx ON projects (owner_id);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status);
CREATE INDEX IF NOT EXISTS projects_department_idx ON projects (department);
CREATE INDEX IF NOT EXISTS projects_end_date_idx ON projects (end_date);

CREATE TABLE IF NOT EXISTS deliverables (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title        varchar(200) NOT NULL,
    description  varchar(2000),
    status       varchar(20) NOT NULL DEFAULT 'not_started'
                 CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
    due_date     date NOT NULL,
    completed_at timestamptz,
    assignee_id  bigint REFERENCES resources (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT deliverables_completed_iff_done CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deliverables_project_id_idx ON deliverables (project_id);
CREATE INDEX IF NOT EXISTS deliverables_assignee_id_idx ON deliverables (assignee_id);
CREATE INDEX IF NOT EXISTS deliverables_status_idx ON deliverables (status);
CREATE INDEX IF NOT EXISTS deliverables_due_date_idx ON deliverables (due_date);

-- Same-project and no-cycle rules are enforced by the API (acme.domains.deliverables).
CREATE TABLE IF NOT EXISTS deliverable_dependencies (
    id             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    deliverable_id bigint NOT NULL REFERENCES deliverables (id) ON DELETE CASCADE,
    depends_on_id  bigint NOT NULL REFERENCES deliverables (id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (deliverable_id, depends_on_id),
    CONSTRAINT deliverable_dependencies_not_self CHECK (deliverable_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS deliverable_dependencies_depends_on_id_idx
    ON deliverable_dependencies (depends_on_id);

CREATE TABLE IF NOT EXISTS allocations (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource_id     bigint NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
    project_id      bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    allocation_pct  integer NOT NULL CHECK (allocation_pct BETWEEN 1 AND 100),
    start_date      date NOT NULL,
    end_date        date NOT NULL,
    role_on_project varchar(100),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT allocations_dates_ordered CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS allocations_resource_id_idx ON allocations (resource_id);
CREATE INDEX IF NOT EXISTS allocations_project_id_idx ON allocations (project_id);
CREATE INDEX IF NOT EXISTS allocations_dates_idx ON allocations (start_date, end_date);

CREATE TABLE IF NOT EXISTS budget_entries (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    category    varchar(20) NOT NULL
                CHECK (category IN ('labor', 'software', 'hardware', 'services', 'other')),
    description varchar(500),
    amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
    spent_on    date NOT NULL,
    created_by  bigint REFERENCES users (id) ON DELETE RESTRICT,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_entries_project_id_idx ON budget_entries (project_id);
CREATE INDEX IF NOT EXISTS budget_entries_category_idx ON budget_entries (category);
CREATE INDEX IF NOT EXISTS budget_entries_spent_on_idx ON budget_entries (spent_on);
CREATE INDEX IF NOT EXISTS budget_entries_created_by_idx ON budget_entries (created_by);

-- ---------------------------------------------------------------------------------------
-- Phase 6 additions. Everything below is additive and idempotent (ADD COLUMN IF NOT EXISTS,
-- CREATE TABLE / INDEX IF NOT EXISTS), because the deployed database already holds the
-- tables above with data in them. tests/backend/test_schema_migration.py applies this file
-- over the previous schema, twice.
-- ---------------------------------------------------------------------------------------

-- Sessions: every token carries the user's token_version as "ver"; bumping it revokes them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
-- Set when an admin gives someone a temporary password; cleared when they change it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Failed sign-ins per submitted email (lower-cased), for throttling. Operational rows: they
-- are deleted on a successful sign-in and after 24 hours, so there is no updated_at.
CREATE TABLE IF NOT EXISTS login_attempts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email        varchar(254) NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (email, attempted_at);

-- Idempotency keys: a POST carrying an Idempotency-Key header runs once. The key is claimed
-- at the start of the request's transaction and the response stored in the same one, so a
-- repeat replays it. Operational rows, deleted after 24 hours.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key        varchar(128) PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    method     varchar(10) NOT NULL,
    path       varchar(255) NOT NULL,
    status     integer,
    response   jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS idempotency_keys_user_id_idx ON idempotency_keys (user_id);

-- Project names are unique whatever the case ("Apollo" and "APOLLO" are one name). The
-- deployed database may already hold case variants, which would make the index fail, so
-- they are renamed first. Of the projects whose names differ only by case, the oldest (the
-- lowest id) keeps its name and each newer one gets its id appended: "APOLLO" becomes
-- "APOLLO (9)". Another project may already be called "apollo (9)", so a generated name is
-- used only when no other project holds it in any case. Otherwise the next candidate is
-- tried: "APOLLO (9-2)", then "APOLLO (9-3)" and so on. The old name is cut as far as its
-- suffix needs, so every candidate fits the 150 characters of the column.
--
-- This ends without retrying. The projects to rename are listed once, from the names as
-- they are before anything is renamed, and each is renamed once. Its new name is free at
-- that moment, so a rename never causes a new clash and no other project is ever renamed.
-- The candidates for one project all differ, and the other projects (one fewer than
-- project_count) hold at most one of them each, so one of the first project_count
-- candidates is free. No row is deleted, only name and updated_at change, and a second run
-- finds nothing to rename.
DO $$
DECLARE
    duplicate     record;
    project_count bigint;
    attempt       bigint;
    suffix        text;
    candidate     text;
BEGIN
    -- No other session may add or rename a project between the checks below and the index.
    -- This is the lock CREATE INDEX takes, and the statements above already hold it until
    -- the transaction ends: asking for it here keeps the checks sound wherever they stand.
    LOCK TABLE projects IN SHARE MODE;
    SELECT count(*) INTO project_count FROM projects;

    FOR duplicate IN
        SELECT newer.id, newer.name
        FROM projects AS newer
        WHERE EXISTS (
            SELECT 1 FROM projects AS older
            WHERE lower(older.name) = lower(newer.name) AND older.id < newer.id
        )
        ORDER BY newer.id
    LOOP
        attempt := 1;
        LOOP
            suffix := CASE WHEN attempt = 1 THEN format(' (%s)', duplicate.id)
                           ELSE format(' (%s-%s)', duplicate.id, attempt) END;
            candidate := left(duplicate.name, 150 - length(suffix)) || suffix;
            EXIT WHEN NOT EXISTS (
                SELECT 1 FROM projects AS other
                WHERE other.id <> duplicate.id AND lower(other.name) = lower(candidate)
            );
            attempt := attempt + 1;
            IF attempt > project_count THEN  -- cannot happen, see above; never loop forever
                RAISE EXCEPTION 'no free name for project % among % candidates',
                    duplicate.id, project_count;
            END IF;
        END LOOP;
        UPDATE projects SET name = candidate, updated_at = clock_timestamp()
        WHERE id = duplicate.id;
    END LOOP;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS projects_name_lower_key ON projects (lower(name));
