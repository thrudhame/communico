import { assert, assertEquals } from '@std/assert';
import { adminCall } from './admin-client.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { bounded } from './helpers/server-process.ts';
import { facadeTls } from './support/facade-tls.ts';

for (const listener of ['client', 'federation']) {
  Deno.test(`facade startup: occupied ${listener} listener is terminal after enrollment`, async () => {
    const tls = await facadeTls();
    const occupied = Deno.serve(
      { hostname: '0.0.0.0', port: 0, onListen() {} },
      () => new Response('occupied'),
    );
    const config = (side: string) => tls.dir + '/' + side + '.toml';
    const socket = (side: string) => tls.dir + '/' + side + '.sock';
    const bundlefile = tls.dir + '/bundle.json';
    const common = (side: string) =>
      `[server]\nname="logical.test"\nrole="${side}"\nport=${
        side === 'facade' && listener === 'client' ? occupied.addr.port : 0
      }\n[store]\ndir="${tls.dir}/${side}-store"\n[media]\nroot="${tls.dir}/${side}-media"\n[admin]\nsocket="${
        socket(side)
      }"\n`;
    await Deno.writeTextFile(
      config('facade'),
      common('facade') +
        `[federation]\nenabled=${
          listener === 'federation'
        }\nport=${occupied.addr.port}\ncert="${tls.dir}/facade.crt"\nkey="${tls.dir}/facade.key"\n` +
        `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/facade.crt"\nlinkkey="${tls.dir}/facade.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n`,
    );
    let edge: Awaited<ReturnType<typeof facadeProcess>> | undefined;
    let home: Awaited<ReturnType<typeof facadeProcess>> | undefined;
    try {
      edge = await facadeProcess(
        config('facade'),
        'facade: link/local admin ready',
      );
      const linkPort = await edge.port('link');
      assertEquals(
        (await adminCall(socket('facade'), 'facade/initialize')).status,
        200,
      );
      await Deno.writeTextFile(
        config('home'),
        common('home') +
          `[federation]\nenabled=false\n[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:${linkPort}"\nlinkport=0\nlinkcert="${tls.dir}/home.crt"\nlinkkey="${tls.dir}/home.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\nnodes=["edge_a"]\npairfile="${bundlefile}"\npollseconds=1\nreconnectmaxseconds=1\n`,
      );
      home = await facadeProcess(config('home'), 'federation: disabled');
      assertEquals(
        (await adminCall(socket('home'), 'facade/pair', {
          node: 'edge_a',
          url: `https://127.0.0.1:${linkPort}`,
          facadePin: tls.facadePin,
          expires: Date.now() + 60000,
          bundlefile,
        })).status,
        200,
      );
      // A composition failure can interrupt the admin response. The process's
      // terminal outcome, not any particular request response, is the contract.
      const accepted = adminCall(socket('facade'), 'facade/accept', {
        bundlefile,
      }).catch(() => null);
      const result = await bounded(edge.result(), 10000);
      await accepted;
      assertEquals(result.code, 1, result.stdout + result.stderr);
      assert(result.stderr.includes('AddrInUse'), result.stderr);
      assert(result.stderr.includes('fatal:'), result.stderr);
    } finally {
      await home?.dispose();
      await edge?.dispose();
      await occupied.shutdown();
      await tls.close();
    }
  });
}
