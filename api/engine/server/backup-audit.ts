import type { CapturedFile, CapturedStore } from '#engine/store/inspect.ts';
import { keyFor } from '#engine/store/layout.ts';
import {
  auditFailure,
  counterCeiling,
  counters,
  nonnegative,
  scan,
} from '#engine/backup/checks.ts';
import type { Manifest } from '#engine/backup/manifest.ts';

const roomWatermarks = ['room:', 'push-context:', 'client-room-rules:'];

export async function auditServer(
  snapshot: CapturedStore,
  server: CapturedFile,
  databases: Manifest['databases'],
) {
  return await snapshot.read(server, async (db) => {
    const heads = await counters(db);
    for (
      const [counter, table, column] of [
        ['events', 'feed', 'seq'],
        ['events', 'event_index', 'seq'],
        ['events', 'memberships', 'seq'],
        ['events', 'prejoin_memberships', 'seq'],
        ['devices', 'device_changes', 'seq'],
        ['devices', 'device_notices', 'seq'],
        ['notifications', 'notifications', 'seq'],
        ['notifications', 'notification_changes', 'seq'],
        ['presence', 'presence', 'seq'],
        ['receipts', 'receipts', 'seq'],
        ['reliable-edus', 'edu_outbox', 'enqueue_pos'],
      ]
    ) await counterCeiling(db, heads, counter, table, column);
    const registered = new Set<string>();
    const sourceHeads = new Map<string, number>();
    for (const file of databases) {
      if (file.kind === 'rooms') {
        for (const prefix of roomWatermarks) {
          sourceHeads.set(prefix + file.id, file.heads.changes);
        }
      } else if (file.kind === 'tenants') {
        for (
          const [suffix, name] of [
            ['accounts', 'account_changes'],
            ['e2ee', 'e2ee_changes'],
            ['public-signing', 'e2ee_changes'],
            ['pushers', 'pusher_changes'],
          ]
        ) {
          sourceHeads.set(
            'tenant:' + file.id + ':' + suffix,
            file.heads['source:' + name] ?? 0,
          );
        }
      }
    }
    for (const row of await db.query('SELECT room_id,file_key FROM rooms')) {
      const id = String(row.room_id);
      if (
        !databases.some((f) => f.kind === 'rooms' && f.id === id) ||
        row.file_key !== await keyFor(id)
      ) auditFailure('registered room missing or misrouted');
      registered.add(id);
    }
    for (
      const row of await db.query('SELECT source,position FROM watermarks')
    ) {
      const source = String(row.source),
        position = nonnegative(row.position, 'invalid watermark');
      const head = sourceHeads.get(source);
      heads['watermark:' + source] = position;
      if (head === undefined) {
        // Completed room unlink precedes removal of these orphan watermarks.
        if (
          roomWatermarks.some((prefix) =>
            source.startsWith(prefix) &&
            !registered.has(source.slice(prefix.length))
          )
        ) continue;
        auditFailure('watermark has no captured source');
      }
      if (position > head) auditFailure('watermark ahead of captured source');
    }
    const rooms = new Map(
      snapshot.files.filter((f) => f.kind === 'rooms').map((f) => [f.id, f]),
    );
    for (
      const [table, column] of [
        ['event_index', 'room'],
        ['feed', 'room'],
        ['outbox', 'room'],
        ['memberships', 'room'],
        ['redactions', 'room'],
        ['relations', 'room'],
        ['search', 'room'],
      ]
    ) {
      for (
        const row of await db.query(
          `SELECT DISTINCT ${column} AS room FROM ${table}`,
        )
      ) {
        if (!rooms.has(String(row.room))) {
          auditFailure('projection room has no captured source');
        }
      }
    }
    for (const room of rooms.values()) {
      await snapshot.read(room, async (source) => {
        // Server projections may lag room truth, but may never name absent
        // source events/change positions.
        for (const table of ['event_index', 'feed', 'outbox']) {
          for await (
            const row of scan(db, table, 'event,pos', 'room=?', [room.id])
          ) {
            const held = await source.query(
              'SELECT event FROM changes WHERE pos=?',
              [row.pos],
            );
            if (held.length !== 1 || held[0].event !== row.event) {
              auditFailure('projection source reference: ' + table);
            }
          }
        }
        for (
          const table of ['memberships', 'redactions', 'relations', 'search']
        ) {
          for await (
            const row of scan(db, table, 'event', 'room=?', [room.id])
          ) {
            if (
              !(await source.query('SELECT id FROM events WHERE id=?', [
                row.event,
              ])).length
            ) auditFailure('projection event reference: ' + table);
          }
        }
        for await (
          const row of scan(db, 'feed', 'event,stay', 'room=?', [room.id])
        ) {
          if (
            !(await source.query(
              'SELECT event FROM positions WHERE event=? AND segment=?',
              [row.event, row.stay],
            )).length
          ) auditFailure('feed position reference');
        }
      });
    }
    let historicalUnheldReceipts = 0;
    for (const tenant of snapshot.files.filter((f) => f.kind === 'tenants')) {
      await snapshot.read(tenant, async (source) => {
        for await (
          const intent of scan(
            source,
            'to_device_intents',
            'source_id,destination',
            'projected=1',
          )
        ) {
          const queued = await db.query(
            'SELECT source FROM edu_outbox WHERE source=? AND destination=?',
            [
              'tenant:' + tenant.id + ':to-device:' + intent.source_id,
              intent.destination,
            ],
          );
          if (!queued.length) {
            auditFailure('projected reliable intent has no server obligation');
          }
        }
        for (
          const { room_id } of await source.query(
            'SELECT DISTINCT room_id FROM transactions WHERE completed=1',
          )
        ) {
          const room = rooms.get(String(room_id));
          if (room === undefined) {
            const [{ n }] = await source.query(
              'SELECT COUNT(*) AS n FROM transactions WHERE completed=1 AND room_id=?',
              [room_id],
            );
            historicalUnheldReceipts += Number(n);
          } else {await snapshot.read(room, async (r) => {
              for await (
                const receipt of scan(
                  source,
                  'transactions',
                  'event_id',
                  'completed=1 AND room_id=?',
                  [room_id],
                )
              ) {
                if (
                  !(await r.query('SELECT id FROM events WHERE id=?', [
                    receipt.event_id,
                  ])).length
                ) auditFailure('completed receipt has no held event');
              }
            });}
        }
        for await (
          const receipt of scan(
            source,
            'transactions',
            'room_id,event_id,pending_pdu,completed',
            'completed!=1',
          )
        ) {
          if (receipt.completed !== 0 || receipt.pending_pdu === null) {
            auditFailure('invalid prepared receipt');
          }
          const pdu = JSON.parse(String(receipt.pending_pdu));
          if (
            pdu.event_id !== receipt.event_id ||
            pdu.room_id !== receipt.room_id
          ) auditFailure('prepared receipt PDU mismatch');
        }
      });
    }
    return { heads, historicalUnheldReceipts };
  });
}
