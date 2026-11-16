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
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
} from './e2ee.ts';
import {
  type AuthorityFact,
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

export const TO_DEVICE_ADMISSION_POLICY_SQL = `
ALTER TABLE to_device_admissions ADD COLUMN policy TEXT NOT NULL DEFAULT 'routed' CHECK(policy IN ('legacy','routed'));
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
export type ToDeviceIngressReceipt = {
  policy: 'legacy' | 'routed';
  messageId: string;
  messageHash: string;
  routes: ToDeviceRoute[];
};
export type ToDeviceTarget = {
  targetId: string;
  deviceId: string;
  deviceIncarnation: string;
  event: Json;
  creation?: AuthorityFact;
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

export function toDeviceMessageHash(
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

/** One logical receipt owns the hash and expansion policy across direct receive,
 * semantic import and old F1 receipts. A legacy receipt has no recoverable old
 * hash; bind its first retained evidence without ever expanding it again. */
async function admit(
  conn: Conn,
  origin: Origin,
  hash: string,
  policy: 'legacy' | 'routed',
): Promise<{ policy: 'legacy' | 'routed'; fresh: boolean }> {
  const [held] = await conn.query(
    'SELECT payload_hash,policy FROM to_device_admissions WHERE kind=? AND origin=? AND message_id=?',
    [origin.kind, origin.origin, origin.id],
  );
  if (held) {
    if (held.payload_hash !== hash) collision();
    return { policy: held.policy as 'legacy' | 'routed', fresh: false };
  }
  // Earlier semantic readers retained route hashes but not the logical receipt.
  // Compare those as well, including routes for a different recipient.
  for (
    const row of await conn.query(
      "SELECT payload_json FROM to_device_routes WHERE json_extract(payload_json,'$.origin.kind')=? AND json_extract(payload_json,'$.origin.origin')=? AND json_extract(payload_json,'$.origin.id')=?",
      [origin.kind, origin.origin, origin.id],
    )
  ) {
    if (
      (JSON.parse(String(row.payload_json)) as ToDeviceRoute).admissionHash !==
        hash
    ) collision();
  }
  if (
    origin.kind === 'federation' && (await conn.query(
      'SELECT 1 FROM inbound_to_device WHERE origin=? AND message_id=?',
      [origin.origin, origin.id],
    )).length
  ) policy = 'legacy';
  await conn.execute(
    'INSERT INTO to_device_admissions(kind,origin,message_id,payload_hash,policy) VALUES(?,?,?,?,?)',
    [
      origin.kind,
      origin.origin,
      origin.id,
      hash,
      policy,
    ],
  );
  return { policy, fresh: true };
}

export async function checkToDeviceReplay(
  conn: Conn,
  origin: string,
  id: string,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
): Promise<void> {
  await admit(
    conn,
    { kind: 'federation', origin, id },
    toDeviceMessageHash(sender, type, server, messages),
    'legacy',
  );
}

/** A mailbox child references the exact semantic routes committed by the
 * receiving registry. A partial import is not a new expansion authority. */
export async function captureIngressToDevice(
  conn: Conn,
  origin: string,
  id: string,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
): Promise<ToDeviceIngressReceipt> {
  const identity = await tenantAuthority(conn);
  if (!identity) pending('receiving owner authority');
  const messageHash = toDeviceMessageHash(sender, type, server, messages);
  const [admission] = await conn.query(
    "SELECT payload_hash,policy FROM to_device_admissions WHERE kind='federation' AND origin=? AND message_id=?",
    [origin, id],
  );
  if (!admission || admission.payload_hash !== messageHash) collision();
  const receipt: ToDeviceIngressReceipt = {
    policy: admission.policy as ToDeviceIngressReceipt['policy'],
    messageId: id,
    messageHash,
    routes: [],
  };
  if (receipt.policy === 'legacy') return receipt;
  const rows = await conn.query(
    "SELECT payload_json,expanded FROM to_device_routes WHERE json_extract(payload_json,'$.origin.kind')='federation' AND json_extract(payload_json,'$.origin.origin')=? AND json_extract(payload_json,'$.origin.id')=? ORDER BY route_id",
    [origin, id],
  );
  receipt.routes = rows.map((row) => JSON.parse(String(row.payload_json)));
  if (
    receipt.routes.length !== new Set(
          messages.filter((m) => domainOf(m.user) === server).map((m) =>
            m.user
          ),
        ).size * 2
  ) {
    pending('complete signed semantic routes');
  }
  validateIngressToDevice(origin, id, sender, type, server, messages, receipt);
  for (const row of rows) {
    const route: ToDeviceRoute = JSON.parse(String(row.payload_json));
    if (
      route.owner === identity.node &&
      (route.ownerIncarnation !== identity.incarnation ||
        Number(row.expanded) !== 1)
    ) {
      pending('receiving owner expansion');
    }
  }
  return receipt;
}

/** Home validates the frozen manifest against original authenticated input.
 * It never derives new owners from the current control or runs the full EDU. */
function validateIngressToDevice(
  origin: string,
  id: string,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
  receipt: ToDeviceIngressReceipt,
) {
  if (
    !receipt || receipt.messageId !== id ||
    receipt.messageHash !==
      toDeviceMessageHash(sender, type, server, messages) ||
    !['legacy', 'routed'].includes(receipt.policy) ||
    !Array.isArray(receipt.routes)
  ) collision();
  if (receipt.policy === 'legacy') {
    if (receipt.routes.length) collision();
    return;
  }
  const users = new Map<string, Message[]>();
  for (const message of messages) {
    if (domainOf(message.user) !== server) continue;
    const selected = users.get(message.user) ?? [];
    selected.push(message);
    users.set(message.user, selected);
  }
  if (receipt.routes.length !== users.size * 2) collision();
  const seen = new Set<string>();
  for (const route of receipt.routes) {
    const selected = users.get(route.recipient);
    if (
      !selected || seen.has(route.routeId) ||
      route.origin.kind !== 'federation' || route.origin.origin !== origin ||
      route.origin.id !== id || route.admissionHash !== receipt.messageHash ||
      route.sender !== sender || route.type !== type ||
      route.localpart !== localpartOf(route.recipient) ||
      !route.owner || !route.ownerIncarnation ||
      route.routeId !==
        digest([route.origin, route.recipient, {
          node: route.owner,
          incarnation: route.ownerIncarnation,
        }]) ||
      canonicalJson(route.selectors) !==
        canonicalJson(
          selected.map(({ id, content }) => ({ id, content }))
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
    ) collision();
    seen.add(route.routeId);
  }
  for (const user of users.keys()) {
    const routes = receipt.routes.filter((route) => route.recipient === user);
    if (
      routes.length !== 2 || routes.filter((route) =>
          route.owner === 'home'
        ).length !== 1 ||
      new Set(routes.map((route) => route.owner)).size !== 2
    ) collision();
  }
}

export async function completeIngressToDevice(
  conn: Conn,
  origin: string,
  id: string,
  sender: string,
  type: string,
  server: string,
  messages: Message[],
  receipt: ToDeviceIngressReceipt,
): Promise<void> {
  validateIngressToDevice(origin, id, sender, type, server, messages, receipt);
  const identity = await tenantAuthority(conn);
  if (!identity || identity.node !== 'home') pending('home owner authority');
  if (receipt.policy !== 'routed') collision();
  if (!receipt.routes.length) {
    await admit(
      conn,
      { kind: 'federation', origin, id },
      receipt.messageHash,
      'routed',
    );
  }
  const [admission] = await conn.query(
    "SELECT payload_hash,policy FROM to_device_admissions WHERE kind='federation' AND origin=? AND message_id=?",
    [origin, id],
  );
  if (!admission) pending('signed semantic routes');
  if (admission.payload_hash !== receipt.messageHash) collision();
  if (
    admission.policy === 'legacy' && !(await conn.query(
      'SELECT 1 FROM inbound_to_device WHERE origin=? AND message_id=?',
      [origin, id],
    )).length
  ) pending('original legacy completion');
  for (const route of receipt.routes) {
    const [held] = await conn.query(
      'SELECT payload_json,expanded FROM to_device_routes WHERE route_id=?',
      [route.routeId],
    );
    if (!held) pending('signed semantic routes');
    if (canonicalJson(route) !== held.payload_json) collision();
    if (
      route.owner === 'home' &&
      (route.ownerIncarnation !== identity.incarnation ||
        Number(held.expanded) !== 1)
    ) {
      pending('home owner expansion');
    }
  }
  await conn.execute(
    'INSERT INTO inbound_to_device VALUES(?,?) ON CONFLICT(origin,message_id) DO NOTHING',
    [origin, id],
  );
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
  const [admission] = await conn.query(
    'SELECT policy FROM to_device_admissions WHERE kind=? AND origin=? AND message_id=?',
    [route.origin.kind, route.origin.origin, route.origin.id],
  );
  if (admission?.policy === 'legacy') {
    await conn.execute(
      'UPDATE to_device_routes SET expanded=1 WHERE route_id=?',
      [route.routeId],
    );
    return;
  }
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
          creation,
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
  policy?: 'legacy',
): Promise<boolean> {
  const identity = await tenantAuthority(conn);
  const admissionHash = toDeviceMessageHash(sender, type, server, messages);
  const admission = await admit(
    conn,
    origin,
    admissionHash,
    identity && policy !== 'legacy' ? 'routed' : 'legacy',
  );
  if (!identity || admission.policy === 'legacy') return false;
  // Imported selectors remain the durable obligation. A second ingress cannot
  // reconstruct a new destination set from its current registry/control map.
  if (!admission.fresh) {
    if (origin.kind === 'federation') {
      const covered = new Set<string>();
      for (
        const row of await conn.query(
          "SELECT payload_json,expanded FROM to_device_routes WHERE json_extract(payload_json,'$.origin.kind')=? AND json_extract(payload_json,'$.origin.origin')=? AND json_extract(payload_json,'$.origin.id')=?",
          [origin.kind, origin.origin, origin.id],
        )
      ) {
        const route: ToDeviceRoute = JSON.parse(String(row.payload_json));
        if (
          route.owner === identity.node &&
          route.ownerIncarnation === identity.incarnation &&
          Number(row.expanded) === 1
        ) covered.add(route.recipient);
      }
      // One imported recipient proves the message hash, not completion of all
      // receiving-owner work. Keep a direct retry pending until its original
      // routes actually arrive and apply; never rebuild from current control.
      for (const message of messages) {
        if (domainOf(message.user) === server && !covered.has(message.user)) {
          pending('retained recipient routes');
        }
      }
    }
    return true;
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

/** Auth readiness discharges the recipient's dependency, regardless of which
 * sender owns the retained route stream. Expansion keeps its original identity
 * and is atomic with the snapshot installation; an expanded selector is final. */
export async function resumePendingToDeviceRoutes(
  conn: Conn,
  recipient: string,
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) return;
  for (
    const row of await conn.query(
      "SELECT payload_json FROM to_device_routes WHERE expanded=0 AND json_extract(payload_json,'$.recipient')=?",
      [recipient],
    )
  ) {
    await expandRoute(
      conn,
      identity,
      JSON.parse(String(row.payload_json)),
      config().e2ee,
    );
  }
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

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value) collision();
  return value;
}

/** The destination attests the exact creation it expanded. A sender may deliver
 * to a local account outside its own replicated scope; learning that disposition
 * must not require importing the recipient's account/session authority. */
function creationOf(raw: unknown): AuthorityFact {
  const row = object(raw, 'to-device target creation');
  const node = requiredText(row.node),
    incarnation = requiredText(row.incarnation);
  if (
    row.kind !== 'device' || !Number.isSafeInteger(row.seq) ||
    Number(row.seq) < 1
  ) collision();
  const fact: AuthorityFact = {
    id: canonicalJson([node, incarnation, row.seq]),
    node,
    incarnation,
    seq: Number(row.seq),
    localpart: requiredText(row.localpart),
    kind: 'device',
    deviceId: requiredText(row.deviceId),
  };
  if (canonicalJson(fact) !== canonicalJson(raw)) collision();
  return fact;
}

/** Decode an immutable operation, not a row clone. No local generation or
 * publication position exists on this wire. */
function operationOf(raw: unknown, server: string): ToDeviceOperation {
  const row = object(raw, 'to-device operation');
  const source = requiredText(row.source),
    incarnation = requiredText(row.incarnation);
  const localpart = requiredText(row.localpart), sequence = row.sequence;
  if (
    row.version !== 1 || !Number.isSafeInteger(sequence) || Number(sequence) < 1
  ) collision();
  const input = object(row.value, 'to-device operation value');
  let operation: OperationValue;
  if (row.kind === 'route') {
    const origin = object(input.origin, 'to-device origin');
    if (origin.kind !== 'client' && origin.kind !== 'federation') collision();
    if (!Array.isArray(input.selectors)) collision();
    limitEntries(input.selectors.length, config().e2ee.maxkeys);
    const selectors = input.selectors.map((raw) => {
      const selector = object(raw, 'to-device selector');
      const content = object(selector.content, 'to-device content');
      bounded(content, config().e2ee.maxkeybytes);
      return { id: requiredText(selector.id), content };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (new Set(selectors.map(({ id }) => id)).size !== selectors.length) {
      collision();
    }
    const value: ToDeviceRoute = {
      routeId: requiredText(input.routeId),
      origin: {
        kind: origin.kind,
        origin: requiredText(origin.origin),
        id: requiredText(origin.id),
      },
      admissionHash: requiredText(input.admissionHash),
      localpart,
      recipient: requiredText(input.recipient),
      owner: requiredText(input.owner),
      ownerIncarnation: requiredText(input.ownerIncarnation),
      sender: requiredText(input.sender),
      type: requiredText(input.type),
      selectors,
    };
    if (
      !/^[a-f0-9]{64}$/.test(value.admissionHash) ||
      !/^@[^:]+:.+$/.test(value.recipient) ||
      domainOf(value.recipient) !== server ||
      !/^@[^:]+:.+$/.test(value.sender) ||
      domainOf(value.sender) !== value.origin.origin ||
      (value.origin.kind === 'client'
        ? value.origin.origin !== server ||
          localpartOf(value.sender) !== localpart
        : localpartOf(value.recipient) !== localpart) ||
      value.routeId !==
        digest([value.origin, value.recipient, {
          node: value.owner,
          incarnation: value.ownerIncarnation,
        }])
    ) collision();
    operation = { kind: 'route', value };
  } else if (row.kind === 'expansion') {
    if (!Array.isArray(input.targets)) collision();
    const targets = input.targets.map((raw) => {
      const target = object(raw, 'to-device target');
      const event = object(target.event, 'to-device event');
      bounded([event], config().e2ee.maxrequestbytes);
      return {
        targetId: requiredText(target.targetId),
        deviceId: requiredText(target.deviceId),
        deviceIncarnation: requiredText(target.deviceIncarnation),
        event,
        ...(Object.hasOwn(target, 'creation')
          ? { creation: creationOf(target.creation) }
          : {}),
      };
    });
    if (
      new Set(targets.map(({ targetId }) => targetId)).size !== targets.length
    ) collision();
    operation = {
      kind: 'expansion',
      value: { routeId: requiredText(input.routeId), targets },
    };
  } else if (row.kind === 'ack' || row.kind === 'cancel') {
    if (!Array.isArray(input.targetIds)) collision();
    const targetIds = input.targetIds.map(requiredText).sort();
    if (new Set(targetIds).size !== targetIds.length || !targetIds.length) {
      collision();
    }
    operation = {
      kind: row.kind,
      value: { routeId: requiredText(input.routeId), targetIds },
    };
  } else collision();
  const body = {
    version: 1 as const,
    operationId: canonicalJson([source, incarnation, 'to-device', sequence]),
    source,
    incarnation,
    sequence: Number(sequence),
    localpart,
    ...operation,
  };
  const fact: ToDeviceOperation = { ...body, payloadHash: digest(body) };
  if (canonicalJson(fact) !== canonicalJson(raw)) collision();
  return fact;
}

function pending(message: string): never {
  throw new MatrixError(
    503,
    'M_UNAVAILABLE',
    'to-device operation awaits ' + message,
  );
}

/** The authenticated adapter supplies the current source. Retain foreign
 * expansion/ACK facts as evidence only; only this file's own registry can insert
 * or delete its inbox. Fact, local expansion and local source intent share the
 * caller's transaction, so a link ACK cannot outrun destination application. */
export async function importToDeviceOperation(
  conn: Conn,
  raw: unknown,
  expected: { source: string; incarnation: string; localpart: string },
  server: string,
): Promise<void> {
  const fact = operationOf(raw, server), identity = await tenantAuthority(conn);
  if (!identity) pending('authority');
  const owners = [{ node: 'home', incarnation: identity.homeIncarnation }, {
    node: identity.edgeNode,
    incarnation: identity.edgeIncarnation,
  }];
  if (
    fact.source !== expected.source ||
    fact.incarnation !== expected.incarnation ||
    fact.localpart !== expected.localpart ||
    !owners.some((owner) =>
      owner.node === fact.source && owner.incarnation === fact.incarnation
    )
  ) collision();
  if (fact.kind === 'route') {
    await admit(conn, fact.value.origin, fact.value.admissionHash, 'routed');
  }
  const encoded = canonicalJson(fact);
  const [held] = await conn.query(
    'SELECT payload_json FROM to_device_operations WHERE operation_id=? OR (source=? AND incarnation=? AND sequence=?)',
    [fact.operationId, fact.source, fact.incarnation, fact.sequence],
  );
  if (held) {
    if (held.payload_json !== encoded) collision();
    return;
  }
  if (fact.kind === 'route') {
    const route = fact.value;
    if (
      !owners.some((owner) =>
        owner.node === route.owner &&
        owner.incarnation === route.ownerIncarnation
      )
    ) collision();
    const [prior] = await conn.query(
      'SELECT payload_json FROM to_device_routes WHERE route_id=?',
      [route.routeId],
    );
    if (prior) {
      if (prior.payload_json !== canonicalJson(route)) collision();
    } else {
      await conn.execute('INSERT INTO to_device_routes VALUES(?,?,?,0)', [
        route.routeId,
        route.localpart,
        canonicalJson(route),
      ]);
    }
  } else {
    const [row] = await conn.query(
      'SELECT payload_json FROM to_device_routes WHERE route_id=?',
      [fact.value.routeId],
    );
    if (!row) pending('route');
    const route: ToDeviceRoute = JSON.parse(String(row.payload_json));
    if (
      route.localpart !== fact.localpart || route.owner !== fact.source ||
      route.ownerIncarnation !== fact.incarnation
    ) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'to-device disposition differs from destination owner',
      );
    }
    const [expanded] = await conn.query(
      "SELECT payload_json FROM to_device_operations WHERE kind='expansion' AND json_extract(payload_json,'$.value.routeId')=?",
      [route.routeId],
    );
    if (fact.kind === 'expansion') {
      if (
        expanded &&
        canonicalJson(
            (JSON.parse(String(expanded.payload_json)) as ToDeviceOperation)
              .value,
          ) !== canonicalJson(fact.value)
      ) collision();
      const devices = new Set<string>();
      for (const target of fact.value.targets) {
        const selector = route.selectors.find(({ id }) =>
          id === target.deviceId
        ) ??
          (route.selectors.length === 1 && route.selectors[0].id === '*'
            ? route.selectors[0]
            : undefined);
        const event = {
          sender: route.sender,
          type: route.type,
          content: selector?.content,
        };
        if (
          !selector || devices.has(target.deviceId) ||
          target.targetId !==
            digest([route.routeId, target.deviceIncarnation]) ||
          canonicalJson(event) !== canonicalJson(target.event)
        ) {
          throw new MatrixError(
            400,
            'M_BAD_JSON',
            'to-device target differs from selector',
          );
        }
        devices.add(target.deviceId);
        const [heldCreation] = await conn.query(
          "SELECT node,incarnation,payload FROM authority_facts WHERE id=? AND localpart=? AND kind='device'",
          [target.deviceIncarnation, localpartOf(route.recipient)],
        );
        // Old retained source facts can use an already authenticated creation;
        // new expansions carry it as immutable disposition evidence only.
        const creation = target.creation ?? (heldCreation
          ? creationOf(JSON.parse(String(heldCreation.payload)))
          : undefined);
        if (!creation) pending('target incarnation');
        if (
          creation.id !== target.deviceIncarnation ||
          creation.localpart !== localpartOf(route.recipient) ||
          creation.node !== fact.source ||
          creation.incarnation !== fact.incarnation ||
          creation.deviceId !== target.deviceId ||
          (heldCreation &&
            canonicalJson(creation) !==
              canonicalJson(JSON.parse(String(heldCreation.payload))))
        ) {
          throw new MatrixError(
            400,
            'M_BAD_JSON',
            'to-device target differs from destination registry',
          );
        }
      }
    } else {
      if (!expanded) pending('expansion');
      const expansion = JSON.parse(String(expanded.payload_json)) as Extract<
        ToDeviceOperation,
        { kind: 'expansion' }
      >;
      const targets = new Set(
        expansion.value.targets.map(({ targetId }) => targetId),
      );
      if (fact.value.targetIds.some((id) => !targets.has(id))) {
        throw new MatrixError(
          400,
          'M_BAD_JSON',
          'to-device target differs from expansion',
        );
      }
    }
  }
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
      encoded,
    ],
  );
  if (fact.kind === 'route') {
    await expandRoute(conn, identity, fact.value, config().e2ee);
  }
}
