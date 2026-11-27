import type { Database } from '#engine/store/db.ts';
import {
  type Cidr,
  cidrContains,
  parseCidr,
  parseIp,
} from '#engine/preview/cidr.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

// Synapse's URL-preview exclusions, independent of configurable preview and
// Location policy. A facade must not make private-network connections even if
// the operator changes those lists.
const defaults = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '169.254.0.0/16',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fe80::/10',
  'fc00::/7',
  'fec0::/10',
  '2001:db8::/32',
  'ff00::/8',
].map((text) => parseCidr(text)!);

function addressOf(raw: string): string {
  const ip = parseIp(raw);
  if (!ip) throw new Error('invalid home link address');
  if (ip.version === 4 || ip.addr >> 32n === 0xffffn) {
    return [24n, 16n, 8n, 0n].map((shift) => (ip.addr >> shift) & 255n)
      .join('.');
  }
  return Array.from(
    { length: 8 },
    (_, index) => ((ip.addr >> BigInt((7 - index) * 16)) & 65535n).toString(16),
  ).join(':');
}

export class MediaEgress {
  private readonly excluded: Cidr[];
  private readonly home = new Set<string>();
  private readonly recorded = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly db: Database, extra: string[]) {
    this.excluded = [
      ...defaults,
      ...extra.map((cidr) => {
        const parsed = parseCidr(cidr);
        if (!parsed) throw new Error('invalid facade home CIDR');
        return parsed;
      }),
    ];
  }

  async load(): Promise<void> {
    for (
      const row of await this.db.query(
        'SELECT address FROM facade_home_addresses',
      )
    ) {
      const address = addressOf(String(row.address));
      this.home.add(address);
      this.recorded.add(address);
    }
  }

  // Publish the denial synchronously before joining the durable write, so a
  // concurrent DNS result cannot race the first authenticated observation.
  observe(raw: string): Promise<void> {
    const address = addressOf(raw);
    this.home.add(address);
    if (this.recorded.has(address)) return Promise.resolve();
    let work = this.pending.get(address);
    if (work === undefined) {
      work = this.db.execute(
        'INSERT INTO facade_home_addresses(address) VALUES (?) ON CONFLICT DO NOTHING',
        [address],
      ).then(() => {
        this.recorded.add(address);
      }).finally(() => this.pending.delete(address));
      this.pending.set(address, work);
    }
    return work;
  }

  readonly check = (ip: string): void => {
    if (
      !parseIp(ip) || this.home.has(addressOf(ip)) ||
      this.excluded.some((range) => cidrContains(range, ip))
    ) {
      throw new UpstreamError('validation', {
        phase: 'egress-policy',
        reason: 'address blocked by facade outbound policy',
      });
    }
  };
}
