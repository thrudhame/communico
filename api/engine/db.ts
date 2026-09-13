import pgpkg from 'pg';
import { required } from './config.ts';

const { Client } = pgpkg;

// Lazy (memoized on first connect): importing this module in pure tests
// never demands the environment (ruling 8 — no fallbacks in code).
let _cfg: {
  host: string;
  port: number;
  user: string;
  password: string;
} | undefined;

function cfg() {
  return (_cfg ??= {
    host: required('DB_HOST'),
    port: Number(required('DB_PORT')),
    user: required('DB_USER'),
    password: required('DB_PASS'),
  });
}

export function ident(s: string): string {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`bad identifier: ${s}`);
  return s;
}

export async function withDb<T>(
  database: string,
  fn: (c: pgpkg.Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ ...cfg(), database });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let _serverDb: string | undefined;

/** The server-level database (room registry, event index). */
export function serverDb(): string {
  return (_serverDb ??= required('DB_NAME'));
}

export async function branchNameFor(eventId: string): Promise<string> {
  const data = new TextEncoder().encode(eventId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'x' + hex.slice(0, 16);
}
