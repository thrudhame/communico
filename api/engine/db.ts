import pgpkg from 'pg';

const { Client } = pgpkg;

const CFG = {
  host: Deno.env.get('DB_HOST') ?? '127.0.0.1',
  port: Number(Deno.env.get('DB_PORT') ?? '5432'),
  user: Deno.env.get('DB_USER') ?? 'root',
  password: Deno.env.get('DB_PASS') ?? 'secret',
};

export function ident(s: string): string {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`bad identifier: ${s}`);
  return s;
}

export async function withDb<T>(
  database: string,
  fn: (c: pgpkg.Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ ...CFG, database });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export const SERVER_DB = Deno.env.get('DB_NAME') ?? 'postgres';

export async function branchNameFor(eventId: string): Promise<string> {
  const data = new TextEncoder().encode(eventId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'x' + hex.slice(0, 16);
}
