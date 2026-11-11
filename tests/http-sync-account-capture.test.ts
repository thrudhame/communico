import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { setRuleEnabled } from '#engine/tenant/pushrules.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP sync account capture');

suite.test('post-capture writes stay pending instead of mixing newer bodies with an older cursor', async () => {
  const user = await suite.registerTestUser('account-cut', 'pw');
  const app = theApp(), lp = 'account-cut';
  const request = (path: string, body?: unknown) =>
    suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token! },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const created = await request('createRoom', {});
  assertEquals(created.status, 200);
  const room = String((await created.json()).room_id);
  await putAccountData(app.tenant, lp, '', 'u.global', { n: 1 });
  await putAccountData(app.tenant, lp, room, 'u.room', { n: 1 });
  const original = app.tenant.tx;
  let injected = false;
  app.tenant.tx = async (fn) => {
    let capturedMax = false;
    const result = await original((tx) =>
      fn({
        ...tx,
        accountData: {
          ...tx.accountData,
          maxSeq: (localpart) => {
            if (localpart === lp) capturedMax = true;
            return tx.accountData.maxSeq(localpart);
          },
        },
      })
    );
    if (capturedMax && !injected) {
      injected = true;
      // This is outside the completed read transaction, before rendering.
      await putAccountData(app.tenant, lp, '', 'u.global', { n: 2 });
      await putAccountData(app.tenant, lp, room, 'u.room', { n: 2 });
      await setRuleEnabled(app.tenant, lp, 'override', '.m.rule.master', true);
    }
    return result;
  };
  let initial: Json;
  try {
    const response = await request('sync?timeout=0');
    assertEquals(response.status, 200);
    initial = await response.json();
  } finally {
    app.tenant.tx = original;
  }
  assert(injected);
  const global = (body: Json) => (body.account_data as Json).events as Json[];
  const roomData = (body: Json) =>
    (((body.rooms as Json).join as Json)[room] as Json).account_data as {
      events: Json[];
    };
  const master = (body: Json) => {
    const event = global(body).find((e) => e.type === 'm.push_rules')!;
    return (((event.content as Json).global as Json).override as Json[])
      .find((r) => r.rule_id === '.m.rule.master')!.enabled;
  };
  assertEquals(global(initial!).find((e) => e.type === 'u.global')?.content, {
    n: 1,
  });
  assertEquals(
    roomData(initial!).events.find((e) => e.type === 'u.room')?.content,
    { n: 1 },
  );
  assertEquals(master(initial!), false);
  const nextResponse = await request(
    'sync?timeout=0&since=' + initial!.next_batch,
  );
  assertEquals(nextResponse.status, 200);
  const next = await nextResponse.json() as Json;
  assertEquals(global(next).find((e) => e.type === 'u.global')?.content, {
    n: 2,
  });
  assertEquals(
    roomData(next).events.find((e) => e.type === 'u.room')?.content,
    { n: 2 },
  );
  assertEquals(master(next), true);
  const quietResponse = await request(
    'sync?timeout=0&since=' + next.next_batch,
  );
  assertEquals(quietResponse.status, 200);
  const quiet = await quietResponse.json() as Json;
  assertEquals(global(quiet), []);
  assertEquals(((quiet.rooms as Json).join as Json)[room], undefined);
});
