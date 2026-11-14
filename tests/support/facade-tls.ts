import { join } from 'node:path';
import { certificatePin } from '#engine/facade/identity.ts';

/** Real, independent link identities; every file stays under disk-backed TMPDIR. */
export async function facadeTls() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-tls-' });
  async function openssl(...args: string[]) {
    const result = await new Deno.Command('openssl', {
      args,
      cwd: dir,
      stdout: 'null',
      stderr: 'piped',
    }).output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
  }
  const pem = (name: string) => Deno.readTextFile(join(dir, name));
  try {
    await openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '1',
      '-subj',
      '/CN=facade-test-ca',
    );
    for (const name of ['home', 'facade', 'wrong']) {
      await openssl(
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        name + '.key',
        '-out',
        name + '.csr',
        '-subj',
        '/CN=localhost',
      );
      await Deno.writeTextFile(
        join(dir, name + '.ext'),
        'subjectAltName=' + (name === 'wrong'
          ? 'DNS:unrelated.test'
          : 'DNS:localhost,IP:127.0.0.1') +
          '\nextendedKeyUsage=serverAuth,clientAuth\n',
      );
      await openssl(
        'x509',
        '-req',
        '-in',
        name + '.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        name + '.crt',
        '-days',
        '1',
        '-extfile',
        name + '.ext',
      );
      await Deno.chmod(join(dir, name + '.key'), 0o600);
    }
    const ca = [await pem('ca.crt')];
    const identity = async (name: string) => ({
      cert: await pem(name + '.crt'),
      key: await pem(name + '.key'),
      ca,
    });
    const home = await identity('home');
    const facade = await identity('facade');
    const wrong = await identity('wrong');
    return {
      dir,
      home,
      facade,
      wrong,
      homePin: certificatePin(home.cert),
      facadePin: certificatePin(facade.cert),
      wrongPin: certificatePin(wrong.cert),
      close: () => Deno.remove(dir, { recursive: true }),
    };
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}
