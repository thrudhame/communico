// Shared IPC client. Imports configuration only, never the store/native library.
import { request } from 'node:http';
import { adminSocket } from '#engine/config.ts';

export const cliArgs = () =>
  Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;

async function send<T>(operation: string, body: unknown): Promise<T> {
  const socket = adminSocket();
  return await new Promise<T>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      socketPath: socket,
      path: `/v1/${operation}`,
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': new TextEncoder().encode(payload).length,
      },
    }, (res) => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => content += chunk);
      res.on('error', reject);
      res.on('end', () => {
        try {
          const answer = JSON.parse(content);
          if (answer.ok !== true) {
            throw new Error(
              typeof answer.error?.message === 'string'
                ? answer.error.message
                : 'invalid admin error response',
            );
          }
          if (res.statusCode !== 200) {
            throw new Error(`admin HTTP ${res.statusCode}`);
          }
          resolve(answer.result as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on(
      'error',
      (error) =>
        reject(
          new Error(
            `server is not running or its admin socket is inaccessible: ${socket} (${error.message})`,
          ),
        ),
    );
    req.setTimeout(
      30000,
      () => req.destroy(new Error(`admin request timed out: ${socket}`)),
    );
    req.end(payload);
  });
}

let reachable: Promise<unknown> | undefined;
export async function adminRequest<T>(
  operation: string,
  body: unknown = {},
): Promise<T> {
  reachable ??= send('status', {});
  await reachable;
  return await send<T>(operation, body);
}

export async function runCli(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli(() => {
    const path = adminSocket();
    // Deno's net allowlist splits commas; never turn path text into TCP grants.
    if (/[\r\n,]/.test(path)) {
      throw new Error(
        'Deno cannot scope Unix-socket permission for a path containing a comma or newline',
      );
    }
    console.log(path);
  });
}
