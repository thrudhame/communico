import { assert, assertEquals } from '@std/assert';
import { adminHandler } from '#root/api/admin/index.ts';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';

const { matrix, registerTestUser: register, test } = httpSuite('HTTP reports');
type Json = Record<string, unknown>;
async function call(path: string, token: string, body: unknown = {}) {
  const response = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function admin(operation: string, body: Json = {}) {
  const response = await adminHandler(theApp())(
    new Request('http://x/v1/reports/' + operation, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}
const rp = (id: string) => 'rooms/' + encodeURIComponent(id);
async function fixture(label: string) {
  const user = await register(label, 'pw');
  const token = user.access_token as string;
  const created = await call('createRoom', token, { preset: 'public_chat' });
  assertEquals(created.status, 200);
  const room = created.body.room_id as string;
  const response = await matrix(
    new Request(
      'http://x/_matrix/client/v3/' + rp(room) +
        '/send/m.room.message/report-event',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token },
        body: JSON.stringify({ msgtype: 'm.text', body: 'reported event' }),
      },
    ),
  );
  assertEquals(response.status, 200);
  return {
    user,
    token,
    room,
    event: (await response.json()).event_id as string,
  };
}

test('event reason and score are optional; private admins can read stored submissions', async () => {
  const f = await fixture('report-event');
  const path = rp(f.room) + '/report/' + encodeURIComponent(f.event);
  assertEquals(await call(path, f.token), { status: 200, body: {} });
  assertEquals(
    (await call(path, f.token, { reason: 'abuse', score: -100 })).status,
    200,
  );
  const listed = await admin('list', { kind: 'event' });
  assertEquals(listed.status, 200);
  const reports = listed.body.result.reports;
  assertEquals(reports.length, 2);
  assertEquals(reports[0].reporter, f.user.user_id);
  assertEquals(reports[0].eventId, f.event);
  assertEquals(reports[0].reason, null);
  assertEquals(reports[0].score, null);
  assertEquals(reports[1].reason, 'abuse');
  assertEquals(reports[1].score, -100);
  assertEquals(Object.hasOwn(reports[1], 'content'), false);
});

test('event reporting needs current join, correct room and visible target', async () => {
  const f = await fixture('report-auth');
  const other = await register('report-outsider', 'pw');
  const path = rp(f.room) + '/report/' + encodeURIComponent(f.event);
  const outsider = await call(path, other.access_token as string);
  assertEquals([outsider.status, outsider.body.errcode], [404, 'M_NOT_FOUND']);
  const second = await call('createRoom', f.token);
  assertEquals(
    (await call(
      rp(second.body.room_id as string) + '/report/' +
        encodeURIComponent(f.event),
      f.token,
    )).status,
    404,
  );
  assertEquals(
    (await call(rp(f.room) + '/report/$missing', f.token)).status,
    404,
  );
  assertEquals((await call(rp(f.room) + '/leave', f.token)).status, 200);
  assertEquals((await call(path, f.token)).status, 404);
});

test('room reports do not require membership; user reports do not require shared rooms', async () => {
  const f = await fixture('report-room');
  const other = await register('report-independent', 'pw');
  const token = other.access_token as string;
  assertEquals(
    (await call(rp(f.room) + '/report', token, { reason: '' })).status,
    200,
  );
  assertEquals(
    (await call(
      'users/' + encodeURIComponent(f.user.user_id) + '/report',
      token,
      { reason: 'abuse' },
    )).status,
    200,
  );
  for (
    const id of ['@unknown:' + other.home_server, '@foreign:elsewhere.test']
  ) {
    assertEquals(
      await call('users/' + encodeURIComponent(id) + '/report', token, {
        reason: 'abuse',
      }),
      { status: 200, body: {} },
    );
  }
  assertEquals(
    (await admin('list', { kind: 'user' })).body.result.reports.length,
    1,
  );
  assertEquals(
    (await call('rooms/!unknown:test/report', token, { reason: 'abuse' }))
      .status,
    404,
  );
});

test('report bodies are typed and authentication is required', async () => {
  const f = await fixture('report-input');
  const path = rp(f.room) + '/report/' + encodeURIComponent(f.event);
  for (
    const body of [null, [], 1, { reason: null }, { score: 'bad' }, {
      score: 1.5,
    }, { score: true }]
  ) {
    assertEquals(
      (await call(path, f.token, body)).status,
      400,
      JSON.stringify(body),
    );
  }
  for (
    const suffix of [
      rp(f.room) + '/report',
      'users/' + encodeURIComponent(f.user.user_id) + '/report',
    ]
  ) {
    assertEquals((await call(suffix, f.token)).status, 400);
    assertEquals((await call(suffix, f.token, { reason: 1 })).status, 400);
    assertEquals((await call(suffix, '', { reason: 'abuse' })).status, 401);
  }
  const response = await matrix(
    new Request('http://x/v1/reports/list', { method: 'POST', body: '{}' }),
  );
  assertEquals(response.status, 404);
  await response.body?.cancel();
});

test('admin pages, resolves idempotently and validates filters', async () => {
  const first = await admin('list', { limit: 1 });
  const data = first.body.result;
  assertEquals(data.reports.length, 1);
  assert(typeof data.next === 'number');
  const next = (await admin('list', { from: data.next, limit: 1 })).body.result;
  assert(next.reports[0].id > data.reports[0].id);
  const id = data.reports[0].id;
  const resolved = await admin('resolve', { id, resolution: 'reviewed' });
  assertEquals(resolved.status, 200);
  assertEquals(resolved.body.result.resolution, 'reviewed');
  assert(typeof resolved.body.result.resolvedMs === 'number');
  const repeat = await admin('resolve', { id, resolution: 'replacement' });
  assertEquals(repeat.body.result, resolved.body.result);
  const closed =
    (await admin('list', { status: 'resolved' })).body.result.reports;
  assertEquals(closed.length, 1);
  assertEquals(closed[0].id, id);
  const open = (await admin('list', { status: 'open' })).body.result.reports;
  assert(open.every((report: Json) => report.id !== id));
  assertEquals((await admin('resolve', { id: 999999 })).status, 404);
  for (
    const bad of [{ kind: 'bogus' }, { kind: ['event'] }, { status: 'bogus' }, {
      limit: 0,
    }, {
      from: -1,
    }]
  ) {
    assertEquals((await admin('list', bad)).status, 400);
  }
});
