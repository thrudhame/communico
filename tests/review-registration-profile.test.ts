import { assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';

Deno.test('review registration: device labels do not become public profile names', async () => {
  const http = await startHttp();
  const call = async (
    path: string,
    body?: Record<string, unknown>,
    token?: string,
  ) => {
    const response = await http.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const input = {
      username: 'profile',
      password: 'pw',
      device_id: 'labelled',
      initial_device_display_name: 'Desktop on Linux',
    };
    const challenge = await call('register', input);
    const registered = await call('register', {
      ...input,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    const profile = await call(
      'profile/' + encodeURIComponent(registered.body.user_id) + '/displayname',
    );
    assertEquals(profile.body.displayname, 'profile');
    const device = await call(
      'devices/labelled',
      undefined,
      registered.body.access_token,
    );
    assertEquals(device.body.display_name, 'Desktop on Linux');
  } finally {
    await http.close();
  }
});
