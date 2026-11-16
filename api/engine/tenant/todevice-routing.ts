// Owner-local to-device source intent. Semantic link exchange is composed by
// facade/todevice.ts; this module never opens another file or does network I/O.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from './accountdata.ts';
import { type DeviceIdentity, devicesOfUser } from './devices.ts';
import type { Json, KeyLimits } from './e2ee.ts';
import {
  type AuthorityIdentity,
  registryDevice,
  tenantAuthority,
} from './session-authority.ts';
import { insertMessage, type Message, targetSelectors } from './todevice.ts';

export const TO_DEVICE_ROUTING_SQL = `
CREATE TABLE to_device_admissions(kind TEXT NOT NULL,origin TEXT NOT NULL,message_id TEXT NOT NULL,payload_hash TEXT NOT NULL,PRIMARY KEY(kind,origin,message_id));
CREATE TABLE to_device_operations(operation_id TEXT PRIMARY KEY NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,sequence INTEGER NOT NULL,localpart TEXT NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(source,incarnation,sequence));
CREATE INDEX to_device_operations_source ON to_device_operations(localpart,source,incarnation,sequence);
CREATE TABLE to_device_routes(route_id TEXT PRIMARY KEY NOT NULL,localpart TEXT NOT NULL,payload_json TEXT NOT NULL,expanded INTEGER NOT NULL);
CREATE INDEX to_device_routes_pending ON to_device_routes(expanded,localpart);
CREATE TABLE to_device_targets(target_id TEXT PRIMARY KEY NOT NULL,route_id TEXT NOT NULL,localpart TEXT NOT NULL,device_id TEXT NOT NULL,device_incarnation TEXT NOT NULL,generation INTEGER NOT NULL,event_json TEXT NOT NULL,state TEXT NOT NULL);
CREATE INDEX to_device_targets_device ON to_device_targets(localpart,device_id,generation,state);
`;

type Origin = { kind: 'client' | 'federation'; origin: string; id: string };
export type ToDeviceRoute = {
  routeId: string;
  origin: Origin;
  admissionHash: string;
  localpart: string;
  recipient: string;
  owner: string;
  ownerIncarnation: string;
  sender: string;
  type: string;
  selectors: { id: string; content: Json }[];
};
export type ToDeviceTarget = {
  targetId: string;
  deviceId: string;
  deviceIncarnation: string;
  event: Json;
};
type OperationValue =
  | { kind: 'route'; value: ToDeviceRoute }
  | {
    kind: 'expansion';
    value: { routeId: string; targets: ToDeviceTarget[] };
  }
  | {
    kind: 'ack';
    value: { routeId: string; targetIds: string[] };
  }
  | {
    kind: 'cancel';
    value: { routeId: string; targetIds: string[] };
  };
export type ToDeviceOperation = OperationValue & {
  version: 1;
  operationId: string;
  source: string;
  incarnation: string;
  sequence: number;
  localpart: string;
  payloadHash: string;
};

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function collision(): never {
  throw new MatrixError(
    400,
    'M_BAD_JSON',
    'to-device operation identity changed',
  );
}

function messageHash(
  sender: string,
  type: string,
  server: string,
  messages: Message[],
) {
  return digest({
    sender,
    type,
    server,
    messages: [...messages].sort((a, b) => {
      const left = canonicalJson([a.user, a.id]),
        right = canonicalJson([b.user, b.id]);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  });
}

/** Old F1/standalone receipts retain their original expansion semantics. A
 * routed admission also retains its immutable decoded message hash, even when
 * its original selector produced no local targets. */
export async function checkToDeviceReplay(
  conn: Conn,
  origin: string,
  id: string,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
): Promise<void> {
  const [held] = await conn.query(
    "SELECT payload_hash FROM to_device_admissions WHERE kind='federation' AND origin=? AND message_id=?",
    [origin, id],
  );
  if (
    held && held.payload_hash !== messageHash(sender, type, server, messages)
  ) collision();
}

async function appendOperation(
  conn: Conn,
  identity: AuthorityIdentity,
  localpart: string,
  operation: OperationValue,
): Promise<ToDeviceOperation> {
  const sequence = await nextCounter(
    conn,
    canonicalJson(['to-device', identity.node, identity.incarnation]),
  );
  const body = {
    version: 1 as const,
    operationId: canonicalJson([
      identity.node,
      identity.incarnation,
      'to-device',
      sequence,
    ]),
    source: identity.node,
    incarnation: identity.incarnation,
    sequence,
    localpart,
    ...operation,
  };
  const fact: ToDeviceOperation = { ...body, payloadHash: digest(body) };
  await conn.execute(
    'INSERT INTO to_device_operations VALUES(?,?,?,?,?,?,?,?)',
    [
      fact.operationId,
      fact.source,
      fact.incarnation,
      fact.sequence,
      fact.localpart,
      fact.kind,
      fact.payloadHash,
      canonicalJson(fact),
    ],
  );
  return fact;
}

/** A selector is expanded once by its destination registry, not by a stale
 * public copy. The immutable device incarnation remains the target after
 * deletion, replacement, lost responses and replay. */
async function expandRoute(
  conn: Conn,
  identity: AuthorityIdentity,
  route: ToDeviceRoute,
  limits: KeyLimits,
) {
  if (
    route.owner !== identity.node ||
    route.ownerIncarnation !== identity.incarnation
  ) return;
  const [held] = await conn.query(
    'SELECT expanded FROM to_device_routes WHERE route_id=?',
    [route.routeId],
  );
  if (!held || Number(held.expanded) === 1) return;
  const localpart = localpartOf(route.recipient);
  if (
    identity.node !== 'home' && !(await conn.query(
      'SELECT 1 FROM account_auth_snapshots WHERE localpart=?',
      [localpart],
    )).length
  ) return; // Missing scope is pending, never proof of absence.
  const targets: ToDeviceTarget[] = [];
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (user && Number(user.deactivated) === 0) {
    const devices = await devicesOfUser(conn, localpart);
    for (
      const selector of targetSelectors(route.selectors.map((selector) => ({
        ...selector,
        user: route.recipient,
      })))
    ) {
      for (const device of devices) {
        if (!selector.wildcard && device.device_id !== selector.id) continue;
        const creation = await registryDevice(
          conn,
          localpart,
          device.device_id,
        );
        if (
          !creation || creation.node !== identity.node ||
          creation.incarnation !== identity.incarnation
        ) continue;
        if (
          (await conn.query(
            "SELECT 1 FROM authority_facts WHERE localpart=? AND kind='delete' AND json_extract(payload,'$.target')=?",
            [localpart, creation.id],
          )).length
        ) continue;
        const [mapping] = await conn.query(
          'SELECT incarnation FROM authority_devices WHERE localpart=? AND device_id=? AND generation=?',
          [localpart, device.device_id, device.generation],
        );
        if (mapping?.incarnation !== creation.id) continue;
        const target: ToDeviceTarget = {
          targetId: digest([route.routeId, creation.id]),
          deviceId: device.device_id,
          deviceIncarnation: creation.id,
          event: {
            sender: route.sender,
            type: route.type,
            content: selector.content,
          },
        };
        await insertMessage(
          conn,
          {
            localpart,
            deviceId: device.device_id,
            generation: device.generation,
          },
          target.targetId,
          target.event,
          limits,
        );
        await conn.execute(
          'INSERT INTO to_device_targets VALUES(?,?,?,?,?,?,?,?)',
          [
            target.targetId,
            route.routeId,
            localpart,
            target.deviceId,
            target.deviceIncarnation,
            device.generation,
            canonicalJson(target.event),
            'pending',
          ],
        );
        targets.push(target);
      }
    }
  }
  await appendOperation(conn, identity, route.localpart, {
    kind: 'expansion',
    value: { routeId: route.routeId, targets },
  });
  await conn.execute(
    'UPDATE to_device_routes SET expanded=1 WHERE route_id=?',
    [route.routeId],
  );
}

/** Called in the existing send/receive transaction before its receipt commits.
 * Remote destinations remain the existing reliable-EDU/egress owner's work. */
export async function routeToDeviceMessages(
  conn: Conn,
  origin: Origin,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
  limits: KeyLimits,
  sourceLocalpart?: string,
): Promise<boolean> {
  const identity = await tenantAuthority(conn);
  if (!identity) return false;
  const admissionHash = messageHash(sender, type, server, messages);
  const [admission] = await conn.query(
    'SELECT payload_hash FROM to_device_admissions WHERE kind=? AND origin=? AND message_id=?',
    [origin.kind, origin.origin, origin.id],
  );
  if (admission) {
    if (admission.payload_hash !== admissionHash) collision();
  } else {
    await conn.execute('INSERT INTO to_device_admissions VALUES(?,?,?,?)', [
      origin.kind,
      origin.origin,
      origin.id,
      admissionHash,
    ]);
  }
  const users = new Map<string, Message[]>();
  for (const message of messages) {
    if (domainOf(message.user) !== server) continue;
    let selected = users.get(message.user);
    if (!selected) users.set(message.user, selected = []);
    selected.push(message);
  }
  for (const [recipient, selected] of users) {
    const localpart = sourceLocalpart ?? localpartOf(recipient);
    for (
      const owner of [
        { node: 'home', incarnation: identity.homeIncarnation },
        { node: identity.edgeNode, incarnation: identity.edgeIncarnation },
      ]
    ) {
      const route: ToDeviceRoute = {
        routeId: digest([origin, recipient, owner]),
        origin,
        admissionHash,
        localpart,
        recipient,
        owner: owner.node,
        ownerIncarnation: owner.incarnation,
        sender,
        type,
        selectors: selected.map(({ id, content }) => ({ id, content }))
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      };
      const encoded = canonicalJson(route);
      const [held] = await conn.query(
        'SELECT payload_json FROM to_device_routes WHERE route_id=?',
        [route.routeId],
      );
      if (held) {
        if (held.payload_json !== encoded) collision();
      } else {
        await conn.execute('INSERT INTO to_device_routes VALUES(?,?,?,0)', [
          route.routeId,
          localpart,
          encoded,
        ]);
        await appendOperation(conn, identity, localpart, {
          kind: 'route',
          value: route,
        });
      }
      await expandRoute(conn, identity, route, limits);
    }
  }
  return true;
}

export async function captureToDeviceOperations(
  conn: Conn,
  localpart: string,
): Promise<ToDeviceOperation[]> {
  const identity = await tenantAuthority(conn);
  if (!identity) return [];
  for (
    const row of await conn.query(
      'SELECT payload_json FROM to_device_routes WHERE expanded=0 AND localpart=?',
      [localpart],
    )
  ) {
    await expandRoute(
      conn,
      identity,
      JSON.parse(String(row.payload_json)),
      config().e2ee,
    );
  }
  return (await conn.query(
    'SELECT payload_json FROM to_device_operations WHERE localpart=? AND source=? AND incarnation=? ORDER BY sequence',
    [localpart, identity.node, identity.incarnation],
  )).map((row) => JSON.parse(String(row.payload_json)) as ToDeviceOperation);
}

/** Publication positions are local. Only the exact targets in the actually
 * issued prefix become exportable ACK facts, in the transaction deleting them. */
export async function acknowledgeToDeviceTargets(
  conn: Conn,
  device: DeviceIdentity,
  cut: number,
): Promise<boolean> {
  const identity = await tenantAuthority(conn);
  if (!identity) return false;
  const rows = await conn.query(
    "SELECT t.target_id,t.route_id,r.payload_json FROM to_device_inbox i JOIN to_device_targets t ON t.target_id=i.source_id JOIN to_device_routes r ON r.route_id=t.route_id WHERE i.localpart=? AND i.device_id=? AND i.generation=? AND i.msg_pos<=? AND t.state='pending'",
    [device.localpart, device.deviceId, device.generation, cut],
  );
  return await finishTargets(conn, identity, rows, 'ack');
}

/** Lifecycle removal cancels its old incarnation's obligations; it is never a
 * client ACK and can never attach accepted material to a replacement device. */
export async function cancelToDeviceTargets(
  conn: Conn,
  localpart: string,
  deviceId: string,
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) return;
  const rows = await conn.query(
    "SELECT t.target_id,t.route_id,r.payload_json FROM to_device_targets t JOIN to_device_routes r ON r.route_id=t.route_id WHERE t.localpart=? AND t.device_id=? AND t.state='pending'",
    [localpart, deviceId],
  );
  await finishTargets(conn, identity, rows, 'cancel');
}

async function finishTargets(
  conn: Conn,
  identity: AuthorityIdentity,
  rows: Record<string, unknown>[],
  kind: 'ack' | 'cancel',
): Promise<boolean> {
  const routes = new Map<string, { route: ToDeviceRoute; ids: string[] }>();
  for (const row of rows) {
    const route: ToDeviceRoute = JSON.parse(String(row.payload_json));
    if (
      route.owner !== identity.node ||
      route.ownerIncarnation !== identity.incarnation
    ) continue;
    let group = routes.get(route.routeId);
    if (!group) routes.set(route.routeId, group = { route, ids: [] });
    group.ids.push(String(row.target_id));
  }
  for (const { route, ids } of routes.values()) {
    for (const id of ids) {
      await conn.execute(
        "UPDATE to_device_targets SET state=? WHERE target_id=? AND state='pending'",
        [kind, id],
      );
    }
    await appendOperation(conn, identity, route.localpart, {
      kind,
      value: { routeId: route.routeId, targetIds: ids.sort() },
    });
  }
  return routes.size > 0;
}
