import { createHash, X509Certificate } from 'node:crypto';
import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';
import type { PeerRow, PendingRow } from '#engine/federation/peers.ts';
export {
  addBlock,
  listBlocks,
  removeBlock,
} from '#root/tools/federation-block.ts';

export const addPeer = (
  opts: {
    name: string;
    host: string | null;
    port: number | null;
    trust: 'ca' | 'pinned' | 'keyname';
    pin?: string | null;
    addedBy: string;
    note?: string | null;
  },
) => adminRequest('federation-peer/add', opts);
export const removePeer = (name: string) =>
  adminRequest<boolean>('federation-peer/remove', { name });
export const listPeers = () => adminRequest<PeerRow[]>('federation-peer/list');
export const listPending = () =>
  adminRequest<PendingRow[]>('federation-peer/pending');
export const approvePending = (
  name: string,
  host: string | null,
  port: number | null,
) => adminRequest('federation-peer/approve', { name, host, port });
export const rejectPending = (name: string, block: boolean) =>
  adminRequest('federation-peer/reject', { name, block });

export function spkiSha256OfCertPem(pem: string): string {
  const x = new X509Certificate(pem);
  return createHash('sha256').update(
    x.publicKey.export({ type: 'spki', format: 'der' }),
  ).digest('hex');
}

function usage(): never {
  console.error(
    'usage: deno task federation-peer -- add <name> [host:port] [--trust ca|pinned|keyname] [--pin <hex>|--cert <pem>] [--note <text>] | remove <name> | list | pending | approve <name> [host:port] | reject <name> [--block]',
  );
  Deno.exit(2);
}

function parseHostPort(raw: string | undefined) {
  if (raw === undefined) return { host: null, port: null };
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return { host: raw, port: null };
  const port = Number(raw.slice(idx + 1));
  return !Number.isInteger(port)
    ? { host: raw, port: null }
    : { host: raw.slice(0, idx), port };
}

function renderPeer(p: PeerRow): string {
  const addr = p.host !== null ? `${p.host}:${p.port}` : '(ladder)';
  const pin = p.pin_spki_sha256 !== null
    ? ` pin=${p.pin_spki_sha256.slice(0, 16)}...`
    : '';
  const note = p.note !== null ? ` note="${p.note}"` : '';
  return `${p.name}  ${addr}  trust=${p.trust}${pin}  added_by=${p.added_by}${note}`;
}

if (import.meta.main) {
  await runCli(async () => {
    const [cmd, ...rest] = cliArgs();
    const flags: Record<string, string> = {}, positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith('--')) {
        flags[a] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')
          ? rest[++i]
          : 'true';
      } else positionals.push(a);
    }
    if (cmd === 'add') {
      const name = positionals[0];
      if (name === undefined) usage();
      const trust =
        (flags['--trust'] !== undefined ? flags['--trust'] : 'ca') as PeerRow[
          'trust'
        ];
      if (!['ca', 'pinned', 'keyname'].includes(trust)) usage();
      let pin: string | null = null;
      if (flags['--cert'] !== undefined) {
        pin = spkiSha256OfCertPem(await Deno.readTextFile(flags['--cert']));
      } else if (flags['--pin'] !== undefined) pin = flags['--pin'];
      await addPeer({
        name,
        ...parseHostPort(positionals[1]),
        trust,
        pin,
        addedBy: 'operator',
        note: flags['--note'] !== undefined ? flags['--note'] : null,
      });
      console.log(`added ${name}`);
    } else if (cmd === 'remove') {
      const name = positionals[0];
      if (name === undefined) usage();
      if (!await removePeer(name)) {
        console.error(`${name} not on the roster`);
        Deno.exit(1);
      }
      console.log(`removed ${name}`);
    } else if (cmd === 'list') {
      for (const peer of await listPeers()) console.log(renderPeer(peer));
    } else if (cmd === 'pending') {
      for (const p of await listPending()) {
        console.log(
          `${p.name}  ${p.kind}  verified=${p.verified}  count=${p.count}  last=${
            new Date(p.last_ms).toISOString()
          }${p.detail !== null ? ` - ${p.detail}` : ''}`,
        );
      }
    } else if (cmd === 'approve') {
      const name = positionals[0];
      if (name === undefined) usage();
      const addr = parseHostPort(positionals[1]);
      await approvePending(name, addr.host, addr.port);
      console.log(`approved ${name}`);
    } else if (cmd === 'reject') {
      const name = positionals[0];
      if (name === undefined) usage();
      const block = rest.includes('--block');
      await rejectPending(name, block);
      console.log(`rejected ${name}${block ? ' (blocked)' : ''}`);
    } else usage();
  });
}
