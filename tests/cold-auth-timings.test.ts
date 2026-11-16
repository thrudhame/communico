import { assertEquals, assertRejects } from '@std/assert';
import { ColdAuthTimings } from './helpers/cold-auth-timings.ts';

Deno.test('cold auth timings retain phase and request durations without credential bodies', async () => {
  let now = 0;
  const timings = new ColdAuthTimings(() => now);
  timings.phase('home deactivation');
  const response = { status: 200, body: { access_token: 'never-retain' } };
  await timings.request('home POST account/deactivate', () => {
    now = 4;
    return Promise.resolve(response);
  });
  now = 9;
  timings.phase('facade refusal');
  await timings.request('facade POST login', () => {
    now = 12;
    return Promise.resolve({
      status: 403,
      body: { errcode: 'M_FORBIDDEN', password: 'never-retain' },
    });
  });
  now = 15;
  assertEquals(timings.snapshot(), [{
    name: 'home deactivation',
    elapsedMs: 9,
    complete: true,
    requests: {
      'home POST account/deactivate': {
        calls: 1,
        elapsedMs: 4,
        maxMs: 4,
        status: 200,
        errcode: undefined,
        transportError: false,
      },
    },
  }, {
    name: 'facade refusal',
    elapsedMs: 6,
    complete: false,
    requests: {
      'facade POST login': {
        calls: 1,
        elapsedMs: 3,
        maxMs: 3,
        status: 403,
        errcode: 'M_FORBIDDEN',
        transportError: false,
      },
    },
  }]);
  assertEquals(
    JSON.stringify(timings.snapshot()).includes('never-retain'),
    false,
  );
});

Deno.test('cold auth timing diagnostics preserve the original transport failure', async () => {
  let now = 0;
  const timings = new ColdAuthTimings(() => now);
  timings.phase('home refusal');
  const failure = new Error('original failure');
  const observed = await assertRejects(() =>
    timings.request('home POST login', () => {
      now = 5;
      return Promise.reject(failure);
    })
  );
  assertEquals(observed, failure);
  assertEquals(timings.snapshot()[0].requests['home POST login'], {
    calls: 1,
    elapsedMs: 5,
    maxMs: 5,
    status: undefined,
    errcode: undefined,
    transportError: true,
  });
});
