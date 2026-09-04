import { assert, assertEquals } from '@std/assert';
import { createRoom } from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { eventIdFor } from '../api/engine/eventid.ts';
import { getFacadeFor } from '../api/engine/facade.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t6:localhost';

// A wire pdu exactly as a browser peer mints it (content-hash id over
// the unsigned fields, room_id = the server room's id).
async function makePdu(
  prevs: string[],
  body: string,
  ts: number,
): Promise<Record<string, unknown>> {
  const unsigned: Record<string, unknown> = {
    type: 'm.room.message',
    room_id: ROOM,
    sender: '@carol:browser',
    content: { body, msgtype: 'm.text' },
    prev_events: prevs,
    origin_server_ts: ts,
    depth: 0,
  };
  const event_id = await eventIdFor(unsigned);
  return { event_id, ...unsigned };
}

Deno.test('lite-hat facade: bad / known / held+drain / fork / heal', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '10', '@dev:localhost');
  const facade = (await getFacadeFor(ROOM))!;
  const room = facade.getRoom()!;

  // open-scan mirrored the genesis events
  assertEquals(await facade.eventCount(room), 2);
  assertEquals(facade.engineName, 'doltgres');
  const tip = await latestExtremityEventId(ROOM);
  assert(await facade.hasEvent(room, tip));

  // bad: tampered id fails recomputation
  const bad = await makePdu([tip], 'bad', 1000);
  bad.event_id = '$' + 'A'.repeat(43);
  const rb = await facade.ingestRemote(room, bad);
  assert(rb.bad, 'tampered id must be bad');
  assertEquals(await facade.badEvents(room), 1);
  assertEquals(await facade.eventCount(room), 2, 'bad event must not land');

  // apply a well-formed remote event (prev = current tip)
  const e1 = await makePdu([tip], 'remote-1', 2000);
  const r1 = await facade.ingestRemote(room, e1);
  assert(r1.applied, 'well-formed event must apply');
  assert(await facade.hasEvent(room, e1.event_id as string));

  // known: same pdu again
  const rk = await facade.ingestRemote(room, e1);
  assert(rk.known, 're-delivery must be known');
  assertEquals(await facade.eventCount(room), 3);

  // held: unknown prev — then the prev arrives and the drain applies it
  const e2 = await makePdu([e1.event_id as string], 'remote-2', 4000);
  const e3 = await makePdu([e2.event_id as string], 'remote-3', 5000);
  const rh = await facade.ingestRemote(room, e3);
  assert(rh.held, 'unknown prev must hold');
  assert(!(await facade.hasEvent(room, e3.event_id as string)));
  const r2 = await facade.ingestRemote(room, e2);
  assert(r2.applied);
  assert(
    await facade.hasEvent(room, e3.event_id as string),
    'drain must apply the held event once its prev lands',
  );

  // an event whose prev never resolves stays held without breaking drains
  const orphan = await makePdu(['$' + 'B'.repeat(43)], 'orphan', 5500);
  assert((await facade.ingestRemote(room, orphan)).held);

  // fork: a local (CS-hat) send consumes the tip; a remote event off the
  // OLD tip must still land (prev branch re-materialized, MS0 route)
  const local = await ingestEvent(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'local', msgtype: 'm.text' },
    prev_events: [e3.event_id as string],
    origin_ts: 6000,
  });
  await facade.noteApplied(local.event_id);
  assert(await facade.hasEvent(room, local.event_id));
  const forkEvt = await makePdu([e3.event_id as string], 'fork-off-stale-tip', 7000);
  const rf = await facade.ingestRemote(room, forkEvt);
  assert(rf.applied, 'stale-prev event must land via re-materialization');
  const exts = await facade.extremities(room);
  assertEquals(exts.length, 2, 'fork must yield two extremities');

  // heal: a remote 2-prev event over both tips rides the merge driver
  const heal = await makePdu(exts.map((e) => e.eventId), 'heal', 8000);
  const rh2 = await facade.ingestRemote(room, heal);
  assert(rh2.applied);
  assertEquals(await facade.merges(room), 1);
  assertEquals((await facade.extremities(room)).length, 1, 'healed');

  // allEvents serves the full mirror (delta source)
  const all = await facade.allEvents(room);
  assert(all.some((p) => p.event_id === heal.event_id));
  assertEquals(await facade.eventCount(room), 2 + 1 + 2 + 1 + 1 + 1);
});
