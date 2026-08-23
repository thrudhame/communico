CREATE TABLE events (
  event_id       text PRIMARY KEY,
  type           text NOT NULL,
  state_key      text,
  sender         text NOT NULL,
  origin_ts      bigint NOT NULL,
  canonical_json jsonb NOT NULL
);
CREATE TABLE state (
  type      text NOT NULL,
  state_key text NOT NULL,
  event_id  text NOT NULL,
  content   jsonb NOT NULL,
  PRIMARY KEY (type, state_key)
);
