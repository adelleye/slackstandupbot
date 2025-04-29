-- Enable necessary extensions if needed (e.g., for uuid generation, though not used here)
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Workspace table to store team-level settings
CREATE TABLE workspaces (
    id bigserial PRIMARY KEY,
    slack_team_id text UNIQUE NOT NULL,
    summary_channel text,           -- Channel ID where summaries are posted
    is_active boolean DEFAULT true, -- Whether the bot is active in this workspace
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Users table to store individual user preferences
CREATE TABLE users (
    id bigserial PRIMARY KEY,
    slack_user_id text UNIQUE NOT NULL, -- Slack's unique user identifier (e.g., U123ABC456)
    workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tz text NOT NULL,                 -- User's preferred timezone (e.g., 'America/New_York')
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Schedules table for individual stand-up timings
CREATE TABLE schedules (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    next_run_at timestamptz NOT NULL, -- The next time the stand-up DM should be sent (UTC)
    questions jsonb,                  -- Optional: Store custom questions if needed
    is_active boolean DEFAULT true,   -- Whether this schedule is currently active
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Answers table to store submitted stand-up responses
CREATE TABLE answers (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    submitted_at timestamptz DEFAULT now(),
    yesterday text,
    today text,
    blockers text
);

-- Optional: Table to track posted summaries and prevent duplicates
CREATE TABLE summaries_posted (
    id bigserial PRIMARY KEY,
    workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    summary_date date NOT NULL, -- The date (YYYY-MM-DD) the summary is for
    posted_at timestamptz DEFAULT now(),
    UNIQUE(workspace_id, summary_date) -- Ensure only one summary per workspace per day
);

-- Indexes for common query patterns
CREATE INDEX idx_users_workspace_id ON users(workspace_id);
CREATE INDEX idx_schedules_user_id ON schedules(user_id);
CREATE INDEX idx_schedules_workspace_id ON schedules(workspace_id);
CREATE INDEX idx_schedules_next_run_at ON schedules(next_run_at) WHERE is_active = true; -- Important for scheduler query
CREATE INDEX idx_answers_user_id ON answers(user_id);
CREATE INDEX idx_answers_workspace_id ON answers(workspace_id);
CREATE INDEX idx_answers_submitted_at ON answers(submitted_at); -- For querying answers by date range
CREATE INDEX idx_summaries_posted_workspace_date ON summaries_posted(workspace_id, summary_date);

-- Optional: Trigger to update 'updated_at' columns automatically
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_timestamp_workspaces
BEFORE UPDATE ON workspaces
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_users
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_schedules
BEFORE UPDATE ON schedules
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp(); 