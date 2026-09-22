import pgpkg from 'pg';
import { config } from './config.ts';

const { Client } = pgpkg;

function cfg() {
  const db = config().db;
  return {
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.pass,
  };
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

/** The server-level database (room registry, event index). */
export function serverDb(): string {
  return config().db.name;
}

export async function branchNameFor(eventId: string): Promise<string> {
  const data = new TextEncoder().encode(eventId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'x' + hex.slice(0, 16);
}
