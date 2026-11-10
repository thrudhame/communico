// api/engine/room/schema.ts - room schema v2 (design R1-R11): immutable
// events and their edges, mutable status, immutable state groups with
// bounded delta chains, event-state refs, publications, segments and
// positions, extremities, waits and the change log. The store owns the id
// row and the meta table; this provider owns everything else. `materialize`
// is the only writer of the state-group/publication/pointer tables (R7).
import type { SchemaProvider } from '#engine/store/create.ts';
import { rebuildTopology, TOPOLOGY_SQL } from './topology.ts';

export const ROOM_SCHEMA_SQL = `
CREATE TABLE events(
  id TEXT PRIMARY KEY NOT NULL,
  pdu TEXT NOT NULL,
  type TEXT NOT NULL,
  state_key TEXT,
  sender TEXT NOT NULL,
  depth INTEGER NOT NULL,
  origin_ts INTEGER NOT NULL
);
CREATE INDEX events_type ON events(type, state_key);
CREATE INDEX events_sender ON events(sender);
CREATE INDEX events_depth ON events(depth);
CREATE INDEX events_origin_ts ON events(origin_ts);

CREATE TABLE event_status(
  event TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  standing TEXT NOT NULL,
  grounding TEXT NOT NULL,
  origin TEXT,
  received_ts INTEGER NOT NULL
);

CREATE TABLE prev_edges(
  event TEXT NOT NULL REFERENCES events(id),
  prev TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY(event, prev)
);
CREATE INDEX prev_edges_reverse ON prev_edges(prev, event);

CREATE TABLE auth_edges(
  event TEXT NOT NULL REFERENCES events(id),
  auth TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY(event, auth)
);
CREATE INDEX auth_edges_reverse ON auth_edges(auth, event);

CREATE TABLE state_groups(
  id INTEGER PRIMARY KEY,
  parent INTEGER REFERENCES state_groups(id),
  depth INTEGER NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE state_entries(
  grp INTEGER NOT NULL REFERENCES state_groups(id),
  type TEXT NOT NULL,
  state_key TEXT NOT NULL,
  event TEXT,
  PRIMARY KEY(grp, type, state_key)
);

CREATE TABLE event_state(
  event TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  before_group INTEGER REFERENCES state_groups(id),
  after_group INTEGER REFERENCES state_groups(id),
  provenance TEXT NOT NULL,
  CHECK(provenance IN ('dag', 'imported', 'none')),
  CHECK((before_group IS NULL) = (provenance = 'none')),
  CHECK((before_group IS NULL) = (after_group IS NULL))
);

CREATE TABLE segments(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  prev INTEGER REFERENCES segments(id),
  opened_by TEXT REFERENCES events(id),
  opening_group INTEGER REFERENCES state_groups(id),
  current_group INTEGER REFERENCES state_groups(id),
  status TEXT NOT NULL
);

CREATE TABLE positions(
  segment INTEGER NOT NULL REFERENCES segments(id),
  offset INTEGER NOT NULL,
  event TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY(segment, offset)
);
CREATE UNIQUE INDEX positions_event ON positions(event);

CREATE TABLE extremities(
  stay INTEGER NOT NULL REFERENCES segments(id),
  event TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY(stay, event)
);

CREATE TABLE waits(
  missing TEXT NOT NULL,
  waiting TEXT NOT NULL,
  kind TEXT NOT NULL,
  since INTEGER NOT NULL,
  expires INTEGER,
  state TEXT NOT NULL,
  PRIMARY KEY(missing, waiting, kind)
);
CREATE INDEX waits_waiting ON waits(waiting);
CREATE INDEX waits_expires ON waits(expires);

CREATE TABLE changes(
  pos INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  event TEXT,
  data TEXT NOT NULL
);

CREATE TABLE publications(
  stay INTEGER NOT NULL REFERENCES segments(id),
  change_pos INTEGER NOT NULL REFERENCES changes(pos),
  grp INTEGER NOT NULL REFERENCES state_groups(id),
  PRIMARY KEY(stay, change_pos)
);
`;

export const roomSchema: SchemaProvider = {
  version: 2,
  apply: async (db) => {
    await db.exec(ROOM_SCHEMA_SQL + TOPOLOGY_SQL);
  },
  migrations: {
    1: async (conn) => {
      await conn.exec(TOPOLOGY_SQL);
      await rebuildTopology(conn);
    },
  },
};
