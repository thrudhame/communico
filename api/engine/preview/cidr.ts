// api/engine/preview/cidr.ts — IPv4/IPv6 CIDR parse + containment.
// Parsed at config load (malformed → ConfigError); the guard reuses
// contains() per resolved address. No baked-in ranges — the operator's
// list is the whole policy (Synapse DEFAULT_IP_RANGE_BLOCKLIST is the
// defaults-file content, not code).

export type Cidr = {
  version: 4 | 6;
  network: bigint;
  prefix: number;
};

function parseIpv4(addr: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8n) + BigInt(o);
  }
  return n;
}

function parseHextets(s: string): number[] | null {
  if (s.length === 0) return [];
  const parts = s.split(':');
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}

function hextetsToBig(h: number[]): bigint {
  let n = 0n;
  for (const x of h) n = (n << 16n) + BigInt(x);
  return n;
}

function parseIpv6(addr: string): bigint | null {
  if (addr.includes('.')) return null;
  const sides = addr.split('::');
  if (sides.length > 2) return null;
  if (sides.length === 1) {
    const h = parseHextets(sides[0]);
    if (h === null || h.length !== 8) return null;
    return hextetsToBig(h);
  }
  const left = parseHextets(sides[0]);
  const right = parseHextets(sides[1]);
  if (left === null || right === null) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  const zeros: number[] = [];
  for (let i = 0; i < fill; i++) zeros.push(0);
  return hextetsToBig([...left, ...zeros, ...right]);
}

function maskOf(version: 4 | 6, prefix: number): bigint {
  const bits = version === 4 ? 32 : 128;
  if (prefix === 0) return 0n;
  const allOnes = (1n << BigInt(bits)) - 1n;
  return (allOnes << BigInt(bits - prefix)) & allOnes;
}

export function parseIp(
  raw: string,
): { version: 4 | 6; addr: bigint } | null {
  const v4 = parseIpv4(raw);
  if (v4 !== null) return { version: 4, addr: v4 };
  const v6 = parseIpv6(raw);
  if (v6 !== null) return { version: 6, addr: v6 };
  return null;
}

export function parseCidr(raw: string): Cidr | null {
  const slash = raw.lastIndexOf('/');
  if (slash < 0) return null;
  const addr = raw.slice(0, slash);
  const prefixStr = raw.slice(slash + 1);
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  const v4 = parseIpv4(addr);
  if (v4 !== null) {
    if (prefix > 32) return null;
    const mask = maskOf(4, prefix);
    return { version: 4, network: v4 & mask, prefix };
  }
  const v6 = parseIpv6(addr);
  if (v6 !== null) {
    if (prefix > 128) return null;
    const mask = maskOf(6, prefix);
    return { version: 6, network: v6 & mask, prefix };
  }
  return null;
}

export function cidrContains(cidr: Cidr, ip: string): boolean {
  const parsed = parseIp(ip);
  if (parsed === null) return false;
  if (parsed.version !== cidr.version) return false;
  const mask = maskOf(cidr.version, cidr.prefix);
  return (parsed.addr & mask) === cidr.network;
}
