CREATE TABLE IF NOT EXISTS users (
  user_id text PRIMARY KEY,
  display_name text
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token text PRIMARY KEY,
  user_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS room_directory (
  room_id text PRIMARY KEY,
  db_name text NOT NULL,
  room_version text NOT NULL
);
-- branch_name: x* extremity branch currently holding this event's commit
-- (phase-1 step 1.3 sanctioned addition for the send endpoint's
-- extremities -> event_ids lookup; stale after branch deletion, filtered
-- against live dolt.branches at query time).
CREATE TABLE IF NOT EXISTS event_index (
  event_id text PRIMARY KEY,
  room_id text NOT NULL,
  commit_hash text NOT NULL,
  branch_name text
);
INSERT INTO users VALUES ('@dev:localhost', 'Dev User')
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO access_tokens VALUES ('devtoken', '@dev:localhost')
  ON CONFLICT (token) DO NOTHING;
