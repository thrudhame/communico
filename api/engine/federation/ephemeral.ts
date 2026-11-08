// Connect local producers to the existing per-destination EDU queues.
// Asynchronous destination lookup cannot overwrite a newer queued change.
import type { Database as Db } from '#engine/store/db.ts';
import { onEphemeral } from '#engine/server/ephemeral.ts';
import { onTypingChange, typingSeq } from '#engine/typing.ts';
import type { EduQueues } from '#engine/federation/edus.ts';
import { domainOf } from '#engine/federation/pdu.ts';

export function wireEphemeral(
  server: Db,
  self: string,
  queues: EduQueues,
): () => Promise<void> {
  const pending = new Set<Promise<void>>();
  const run = (fn: () => Promise<void>) => {
    const task = fn().catch((error) =>
      console.error('EDU queue error:', error)
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const destinations = async (roomId: string): Promise<string[]> => {
    const rows = await server.query(
      "SELECT user FROM memberships WHERE room=? AND membership='join'",
      [roomId],
    );
    return [...new Set(rows.map((r) => domainOf(String(r.user))))].filter((d) =>
      d !== self
    );
  };
  const untype = onTypingChange((roomId, userId, typing) => {
    if (domainOf(userId) !== self) return;
    const seq = typingSeq();
    run(async () => {
      for (const d of await destinations(roomId)) {
        queues.queueTyping(d, roomId, userId, typing, seq);
      }
    });
  });
  const unstream = onEphemeral((db, change) => {
    if (db.path !== server.path) return;
    if (change.kind === 'receipt') {
      if (
        change.receiptType !== 'm.read' || domainOf(change.row.userId) !== self
      ) return;
      run(async () => {
        for (const d of await destinations(change.roomId)) {
          queues.queueReceipt(d, {
            roomId: change.roomId,
            userId: change.row.userId,
            eventId: change.row.eventId,
            ts: change.row.ts,
            threadId: null,
          }, change.row.seq);
        }
      });
    } else {
      if (domainOf(change.userId) !== self) return;
      run(async () => {
        const rooms = await server.query(
          "SELECT room FROM memberships WHERE user=? AND membership='join'",
          [change.userId],
        );
        const targets = new Set<string>();
        for (const room of rooms) {
          for (const d of await destinations(String(room.room))) {
            targets.add(d);
          }
        }
        for (const d of targets) {
          queues.queuePresence(d, {
            user_id: change.userId,
            presence: change.row.presence,
            status_msg: change.row.statusMsg,
            last_active_ago: Math.max(0, Date.now() - change.row.lastActiveMs),
            currently_active: change.row.presence === 'online' &&
              Date.now() - change.row.lastActiveMs < 60_000,
          }, change.row.seq);
        }
      });
    }
  });
  return async () => {
    untype();
    unstream();
    await Promise.all(pending);
  };
}
