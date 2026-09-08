// api/engine/config.ts — server identity config, read once.
// SERVER_NAME is the single source (M0: default '8008' port, DNS name from
// env; F1: native base32 name beside it in the tenant row). Dev default
// 'localhost'.
function readServerName(): string {
  return Deno.env.get('SERVER_NAME') ?? 'localhost';
}

export const SERVER_NAME: string = readServerName();

export function appPort(): number {
  return Number(Deno.env.get('APP_A_PORT') ?? '8008');
}
