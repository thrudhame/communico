// api/engine/config.ts — required environment configuration. No in-code
// fallbacks (ruling 8): a missing value is a startup error, never a silent
// default. Reads are lazy (memoized on first use) so importing engine
// modules — in pure tests, or during main.ts's own validation pass —
// never demands environment variables to exist.

export const REQUIRED_VARS: readonly string[] = [
  'APP_PORT',
  'SERVER_NAME',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_NAME',
  'MEDIA_ROOT',
  'MEDIA_MAX_BYTES',
];

/** The names that must be in the environment; empty = all present. */
export function missingRequired(): string[] {
  return REQUIRED_VARS.filter((n) => Deno.env.get(n) === undefined);
}

/** Read a required variable, or throw naming it. */
export function required(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

let _serverName: string | undefined;

/** The homeserver's DNS name (single source since M0). */
export function serverName(): string {
  return (_serverName ??= required('SERVER_NAME'));
}

let _appPort: number | undefined;

/** The one listener's port. */
export function appPort(): number {
  return (_appPort ??= Number(required('APP_PORT')));
}
