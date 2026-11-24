import { assertEquals } from '@std/assert';
import { capabilities } from '#engine/facade/capabilities.ts';

Deno.test('F2 room event polling reuses client room admission', () => {
  const request = new Request(
    'https://facade.test/_matrix/client/v3/events?room_id=' +
      encodeURIComponent('!held:logical.test'),
  );
  const f2 = capabilities('facade', 'f2');
  let required: string | undefined;
  assertEquals(
    f2.gate(request, (scope) => {
      required = scope;
      return true;
    }),
    null,
  );
  assertEquals(required, 'clientrooms');
  assertEquals(f2.gate(request, () => false)?.status, 503);
  assertEquals(
    capabilities('facade', 'f1').gate(request, () => true)?.status,
    404,
  );
  assertEquals(
    f2.gate(new Request(request.url, { method: 'POST' }), () => true)?.status,
    405,
  );
});

Deno.test('F2 global event polling is unsupported before auth or replica admission', async () => {
  const f2 = capabilities('facade', 'f2');
  for (const suffix of ['', '?room_id=']) {
    let admitted = false;
    const response = f2.gate(
      new Request('https://facade.test/_matrix/client/v3/events' + suffix),
      () => {
        admitted = true;
        return true;
      },
    );
    assertEquals(response?.status, 404);
    assertEquals(await response?.json(), {
      errcode: 'M_UNRECOGNIZED',
      error: 'Unrecognized request',
    });
    assertEquals(admitted, false);
  }
});
