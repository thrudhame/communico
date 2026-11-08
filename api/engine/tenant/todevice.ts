// Inbox, send receipts and issued acknowledgments belong to the tenant file.
import type { Conn } from '#engine/store/db.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { deviceById, devicesOfUser } from '#engine/tenant/devices.ts';
import {
  bounded,
  current,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
} from '#engine/tenant/e2ee.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import { encodeStreamToken, type StreamToken } from '#engine/client/tokens.ts';
import { encodeEnvelope } from '#engine/federation-envelope.ts';

const args = (d: DeviceIdentity) => [d.localpart, d.deviceId, d.generation];
export type Message = { user: string; id: string; content: Json };
/** Queue pressure is temporary, unlike a permanently oversized wire object. */
export class InboxFullError extends MatrixError {
  constructor() {
    super(413, 'M_TOO_LARGE', 'device inbox is full');
  }
}
export type DeliveryPolicy = { enabled: boolean; maxBytes: number };
export function validateMessages(body: unknown, limits: KeyLimits): Message[] {
  bounded(body, limits.maxrequestbytes);
  const messages = object(object(body, 'body').messages, 'messages');
  const result: Message[] = [];
  for (const [user, devices] of Object.entries(messages)) {
    if (!/^@[^:]+:.+$/.test(user)) {
      throw new MatrixError(400, 'M_BAD_JSON', 'invalid recipient');
    }
    for (const [id, value] of Object.entries(object(devices, 'devices'))) {
      if (!id.length) {
        throw new MatrixError(400, 'M_BAD_JSON', 'invalid device');
      }
      const content = object(value, 'content');
      bounded(content, limits.maxkeybytes);
      result.push({ user, id, content });
    }
  }
  limitEntries(result.length, limits.maxkeys);
  return result;
}

export async function inboxHead(conn: Conn): Promise<number> {
  const rows = await conn.query(
    "SELECT value FROM counters WHERE name='to_device'",
  );
  return rows.length ? Number(rows[0].value) : 0;
}
export async function insertMessage(
  conn: Conn,
  d: DeviceIdentity,
  source: string,
  event: Json,
  limits: KeyLimits,
): Promise<void> {
  bounded([event], limits.maxrequestbytes);
  const owner = args(d);
  if (
    (await conn.query(
      'SELECT 1 FROM to_device_inbox WHERE localpart=? AND device_id=? AND generation=? AND source_id=?',
      [...owner, source],
    )).length
  ) return;
  const count = await conn.query(
    'SELECT COUNT(*) AS n FROM to_device_inbox WHERE localpart=? AND device_id=? AND generation=?',
    owner,
  );
  if (Number(count[0].n) >= limits.maxinboxmessages) throw new InboxFullError();
  const pos = await nextCounter(conn, 'to_device');
  await conn.execute('INSERT INTO to_device_inbox VALUES(?,?,?,?,?,?)', [
    ...owner,
    pos,
    source,
    JSON.stringify(event),
  ]);
}

export async function sendMessages(
  conn: Conn,
  d: DeviceIdentity,
  server: string,
  type: string,
  txn: string,
  source: string,
  messages: Message[],
  limits: KeyLimits,
  delivery: DeliveryPolicy,
): Promise<void> {
  await current(conn, d);
  const receipt = [...args(d), type, txn];
  if (
    (await conn.query(
      'SELECT 1 FROM to_device_transactions WHERE localpart=? AND device_id=? AND generation=? AND event_type=? AND txn_id=?',
      receipt,
    )).length
  ) return;
  let fanout = 0;
  const remote = new Map<string, Record<string, Record<string, Json>>>();
  for (const m of messages) {
    const destination = domainOf(m.user);
    if (destination !== server) {
      let users = remote.get(destination);
      if (!users) {
        users = Object.create(null);
        remote.set(destination, users!);
      }
      if (!Object.hasOwn(users!, m.user)) users![m.user] = Object.create(null);
      users![m.user][m.id] = m.content;
      continue;
    }
    const lp = localpartOf(m.user);
    const targets = m.id === '*'
      ? await devicesOfUser(conn, lp)
      : [await deviceById(conn, m.id, lp)];
    for (const target of targets) {
      if (target === null) continue;
      limitEntries(++fanout, limits.maxkeys);
      await insertMessage(
        conn,
        {
          localpart: lp,
          deviceId: target.device_id,
          generation: target.generation,
        },
        source,
        { sender: '@' + d.localpart + ':' + server, type, content: m.content },
        limits,
      );
    }
  }
  for (const [destination, users] of remote) {
    if (!delivery.enabled) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'federation is disabled');
    }
    const sender = '@' + d.localpart + ':' + server;
    const content = { sender, type, message_id: source, messages: users };
    // Use the widest interoperable timestamp so every accepted EDU fits alone.
    bounded(
      JSON.parse(
        encodeEnvelope(server, Number.MAX_SAFE_INTEGER, [], [{
          edu_type: 'm.direct_to_device',
          content,
        }]),
      ),
      delivery.maxBytes,
    );
    bounded(content, limits.maxrequestbytes);
    const pending = await conn.query(
      'SELECT COUNT(*) AS n FROM to_device_intents',
    );
    limitEntries(Number(pending[0].n) + 1, limits.maxinboxmessages);
    const own = await conn.query(
      'SELECT COUNT(*) AS n FROM to_device_intents WHERE sender=?',
      [sender],
    );
    limitEntries(Number(own[0].n) + 1, limits.maxkeys);
    await conn.execute(
      'INSERT INTO to_device_intents(source_id,destination,payload,sender) VALUES(?,?,?,?)',
      [
        source + ':' + destination,
        destination,
        JSON.stringify(content),
        sender,
      ],
    );
  }
  await conn.execute(
    'INSERT INTO to_device_transactions VALUES(?,?,?,?,?)',
    receipt,
  );
}

/** The receiving tenant owns logical dedup and captured device expansion together. */
export async function receiveMessages(
  conn: Conn,
  origin: string,
  id: string,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
  limits: KeyLimits,
): Promise<void> {
  if (
    (await conn.query(
      'SELECT 1 FROM inbound_to_device WHERE origin=? AND message_id=?',
      [origin, id],
    )).length
  ) return;
  for (const m of messages) {
    if (domainOf(m.user) !== server) continue;
    const lp = localpartOf(m.user);
    const targets = m.id === '*'
      ? await devicesOfUser(conn, lp)
      : [await deviceById(conn, m.id, lp)];
    for (const target of targets) {
      if (target === null) continue;
      // Wire entries are sender-bounded before this transaction. Wildcard
      // expansion belongs to the local device owner, not that wire budget.
      await insertMessage(
        conn,
        {
          localpart: lp,
          deviceId: target.device_id,
          generation: target.generation,
        },
        JSON.stringify(['federation', origin, id]),
        { sender, type, content: m.content },
        limits,
      );
    }
  }
  await conn.execute('INSERT INTO inbound_to_device VALUES(?,?)', [origin, id]);
}

/** Only an issued full token for this incarnation can advance the durable ack. */
export async function acknowledge(
  conn: Conn,
  d: DeviceIdentity,
  since: StreamToken | null,
): Promise<number> {
  await current(conn, d);
  const owner = args(d);
  const rows = await conn.query(
    'SELECT msg_pos FROM device_ack WHERE localpart=? AND device_id=? AND generation=?',
    owner,
  );
  let ack = rows.length ? Number(rows[0].msg_pos) : 0;
  if (since !== null) {
    const pools = await conn.query(
      "SELECT value FROM counters WHERE name='key_pools'",
    );
    if (since.kSeq > (pools.length ? Number(pools[0].value) : 0)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'future key-pool token');
    }
    if (since.mSeq > await inboxHead(conn)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'future inbox token');
    }
    const proof = await conn.query(
      'SELECT to_msg_pos FROM sync_deliveries WHERE localpart=? AND device_id=? AND generation=? AND token_hash=?',
      [...owner, await hashToken(encodeStreamToken(since))],
    );
    if (proof.length) ack = Math.max(ack, Number(proof[0].to_msg_pos));
  }
  await conn.execute(
    'INSERT INTO device_ack VALUES(?,?,?,?) ON CONFLICT(localpart,device_id,generation) DO UPDATE SET msg_pos=excluded.msg_pos',
    [...owner, ack],
  );
  await conn.execute(
    'DELETE FROM to_device_inbox WHERE localpart=? AND device_id=? AND generation=? AND msg_pos<=?',
    [...owner, ack],
  );
  await conn.execute(
    'DELETE FROM sync_deliveries WHERE localpart=? AND device_id=? AND generation=? AND to_msg_pos<=?',
    [...owner, ack],
  );
  return ack;
}

export async function pendingMessages(
  conn: Conn,
  d: DeviceIdentity,
): Promise<boolean> {
  return (await conn.query(
    'SELECT 1 FROM to_device_inbox WHERE localpart=? AND device_id=? AND generation=? LIMIT 1',
    args(d),
  )).length > 0;
}

/** Read and persist the issued cut in one transaction before HTTP can return it. */
export async function deliverMessages(
  conn: Conn,
  d: DeviceIdentity,
  token: StreamToken,
  limits: KeyLimits,
): Promise<{ events: Json[]; token: StreamToken }> {
  await current(conn, d);
  const owner = args(d);
  const head = await inboxHead(conn);
  const rows = await conn.query(
    'SELECT msg_pos,event_json FROM to_device_inbox WHERE localpart=? AND device_id=? AND generation=? AND msg_pos<=? ORDER BY msg_pos LIMIT 100',
    [...owner, head],
  );
  const events: Json[] = [];
  let cut = head;
  for (const row of rows) {
    const event = JSON.parse(String(row.event_json));
    // A valid individual message always fits. Aggregate responses are byte-limited too.
    if (
      events.length &&
      new TextEncoder().encode(JSON.stringify([...events, event])).length >
        limits.maxrequestbytes
    ) {
      cut = Number(rows[events.length - 1].msg_pos);
      break;
    }
    events.push(event);
  }
  if (events.length === 100) cut = Number(rows[99].msg_pos);
  const next = { ...token, mSeq: cut };
  const ack = await conn.query(
    'SELECT msg_pos FROM device_ack WHERE localpart=? AND device_id=? AND generation=?',
    owner,
  );
  if (cut > (ack.length ? Number(ack[0].msg_pos) : 0)) {
    const hash = await hashToken(encodeStreamToken(next));
    await conn.execute(
      'INSERT INTO sync_deliveries VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
      [...owner, hash, cut],
    );
    // The just-issued token survives even when several proofs have the same cut.
    // Evicted tokens replay from the durable ack, never acknowledge unseen data.
    const obsolete = await conn.query(
      'SELECT token_hash FROM sync_deliveries WHERE localpart=? AND device_id=? AND generation=? AND token_hash!=? ORDER BY to_msg_pos DESC,token_hash LIMIT -1 OFFSET ?',
      [...owner, hash, Math.max(0, limits.maxkeys - 1)],
    );
    for (const proof of obsolete) {
      await conn.execute(
        'DELETE FROM sync_deliveries WHERE localpart=? AND device_id=? AND generation=? AND token_hash=?',
        [...owner, String(proof.token_hash)],
      );
    }
  }
  return { events, token: next };
}
