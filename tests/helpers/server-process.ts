import { assert, assertEquals } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };

export const pause = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

function close(conn: Deno.Conn) {
  try {
    conn.close();
  } catch (e) {
    if (!(e instanceof Deno.errors.BadResource)) throw e;
  }
}

export async function bounded<T>(promise: Promise<T>, ms = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('server process deadline')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function serverProcess(
  options: { grace?: number; dir?: string } = {},
) {
  const dir = options.dir ?? await Deno.makeTempDir({ prefix: 'life-' });
  const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = probe.addr.port;
  probe.close();
  const socket = `${dir}/admin.sock`;
  const config = `${dir}/config.toml`;
  await Deno.writeTextFile(
    config,
    `[server]\nport=${port}\nshutdowngraceseconds=${
      options.grace ?? 10
    }\n[store]\ndir="${dir}/store"\n[media]\nroot="${dir}/media"\n[admin]\nsocket="${socket}"\n[federation]\nenabled=false\n`,
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: metadata.tasks.start.split(' ').slice(1),
    env: { COMMUNICO_CONFIG: config, DENO_NO_PROMPT: '1' },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let stdout = '', stderr = '', ended = false;
  const collect = async (
    stream: ReadableStream<Uint8Array>,
    write: (s: string) => void,
  ) => {
    for await (const text of stream.pipeThrough(new TextDecoderStream())) {
      write(text);
    }
  };
  const output = Promise.all([
    child.status,
    collect(child.stdout, (s) => stdout += s),
    collect(child.stderr, (s) => stderr += s),
  ]).then(([status]) => {
    ended = true;
    return { ...status, stdout, stderr };
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + '/_matrix/client/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const waitLog = async (text: string) => {
    const end = Date.now() + 15000;
    while (!stdout.includes(text) && !stderr.includes(text)) {
      assert(!ended && Date.now() < end, `${text}: ${stdout}\n${stderr}`);
      await pause(10);
    }
  };
  const dispose = async () => {
    if (!ended) {
      child.kill('SIGKILL');
      await bounded(output);
    }
    if (!options.dir) await Deno.remove(dir, { recursive: true });
  };
  try {
    const end = Date.now() + 15000;
    for (;;) {
      try {
        assertEquals((await api('versions')).status, 200);
        break;
      } catch {
        assert(!ended && Date.now() < end, `${stdout}\n${stderr}`);
        await pause(25);
      }
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dir, socket, config, port, child, output, api, waitLog, dispose };
}

export async function partialRequest(
  address: { socket: string } | { port: number },
  path: string,
  body: string,
  headers = '',
) {
  const conn = 'socket' in address
    ? await Deno.connect({ transport: 'unix', path: address.socket })
    : await Deno.connect({ hostname: '127.0.0.1', port: address.port });
  const bytes = new TextEncoder().encode(body);
  const split = Math.max(1, Math.floor(bytes.length / 2));
  const write = async (data: Uint8Array) => {
    let n = 0;
    while (n < data.length) n += await conn.write(data.subarray(n));
  };
  await write(
    new TextEncoder().encode(
      `POST ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: ${bytes.length}\r\n${headers}\r\n`,
    ),
  );
  await write(bytes.subarray(0, split));
  return {
    conn,
    async finish() {
      await write(bytes.subarray(split));
      const reader = conn.readable.getReader();
      let response = '';
      try {
        for (;;) {
          const { value, done } = await bounded(reader.read());
          if (done) break;
          response += new TextDecoder().decode(value);
        }
      } finally {
        reader.releaseLock();
        close(conn);
      }
      return response;
    },
  };
}
