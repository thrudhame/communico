// api/engine/config.ts — server identity config, read once.
// SERVER_NAME is the single source (M0: default '8008' port, DNS name from
// env; F1: native base32 name beside it). Dev default 'localhost'.
function readServerName(): string {
  return Deno.env.get('SERVER_NAME') ?? 'localhost';
}

export const SERVER_NAME: string = readServerName();

export function appPort(): number {
  return Number(Deno.env.get('APP_A_PORT') ?? '80');
}

// F0->F1 seam (recorded, never a path): the browser sends unsigned PDUs
// in F0; the server accepts `signatures: {}` from `doltlite` engines
// behind ALLOW_UNSIGNED_LITE=1 — OFF in the M0 image, dual-accept
// (verify-if-present) during F1, DELETED at F1's end.
export function allowUnsignedLite(): boolean {
  return Deno.env.get('ALLOW_UNSIGNED_LITE') === '1';
}
