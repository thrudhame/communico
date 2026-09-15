CREATE TABLE events (
  event_id       text PRIMARY KEY,
  type           text NOT NULL,
  state_key      text,
  sender         text NOT NULL,
  origin_ts      bigint NOT NULL,
  depth          bigint NOT NULL,
  prev_events    jsonb NOT NULL DEFAULT '[]',
  auth_events    jsonb NOT NULL DEFAULT '[]',
  hashes         jsonb NOT NULL DEFAULT '{}',
  signatures     jsonb NOT NULL DEFAULT '{}',
  rejected       boolean NOT NULL DEFAULT FALSE,
  -- M3: soft-failed events (S8 check 6) persist but are not extremities
  -- for authoring and are excluded from the client-visible timeline.
  soft_failed    boolean NOT NULL DEFAULT FALSE,
  canonical_json text NOT NULL
);
CREATE TABLE state (
  type      text NOT NULL,
  state_key text NOT NULL,
  event_id  text NOT NULL,
  content   jsonb NOT NULL,
  PRIMARY KEY (type, state_key)
);
