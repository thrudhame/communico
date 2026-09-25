// tools/federation-peer.ts — the roster and the door log review surface.
// Exported functions + a thin CLI:
//   add <name> [host:port] [--trust ca|pinned|keyname]
//     [--pin <spki-sha256-hex>|--cert <pem-file>] [--note <text>]
//   remove <name> | list | pending | approve <name> [host:port] | reject <name> [--block]
// --cert computes the SPKI SHA-256 from a certificate file (node:crypto).
import { createHash, X509Certificate } from 'node:crypto';
import {
  addBlock,
  addPeer,
  approvePending,
  listBlocks,
  listPeers,
  listPending,
  type PeerRow,
  rejectPending,
  removeBlock,
  removePeer,
} from '#engine/federation/peers.ts';

export {
  addBlock,
  addPeer,
  approvePending,
  listBlocks,
  listPeers,
  listPending,
  rejectPending,
  removeBlock,
  removePeer,
};

/** SPKI SHA-256 (hex) of a certificate file — the pin for trust 'pinned'. */
export function spkiSha256OfCertPem(pem: string): string {
  const x = new X509Certificate(pem);
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

function usage(): never {
  console.error(
    'usage: deno task federation-peer -- add <name> [host:port] [--trust ca|pinned|keyname] [--pin <hex>|--cert <pem>] [--note <text>] | remove <name> | list | pending | approve <name> [host:port] | reject <name> [--block]',
  );
  Deno.exit(2);
}

function parseHostPort(raw: string | undefined): {
  host: string | null;
  port: number | null;
} {
  if (raw === undefined) return { host: null, port: null };
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return { host: raw, port: null };
  const port = Number(raw.slice(idx + 1));
  if (!Number.isInteger(port)) return { host: raw, port: null };
  return { host: raw.slice(0, idx), port };
}

function renderPeer(p: PeerRow): string {
  const addr = p.host !== null ? `${p.host}:${p.port}` : '(ladder)';
  const pin = p.pin_spki_sha256 !== null
    ? ` pin=${p.pin_spki_sha256.slice(0, 16)}…`
    : '';
  const note = p.note !== null ? ` note="${p.note}"` : '';
  return `${p.name}  ${addr}  trust=${p.trust}${pin}  added_by=${p.added_by}${note}`;
}

if (import.meta.main) {
  const argv = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      flags[a] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')
        ? rest[++i]
        : 'true';
    } else {
      positionals.push(a);
    }
  }
  if (cmd === 'add') {
    const name = positionals[0];
    if (name === undefined) usage();
    const addr = parseHostPort(positionals[1]);
    const trust = (flags['--trust'] !== undefined ? flags['--trust'] : 'ca') as
      | 'ca'
      | 'pinned'
      | 'keyname';
    if (!['ca', 'pinned', 'keyname'].includes(trust)) usage();
    let pin: string | null = null;
    if (flags['--cert'] !== undefined) {
      pin = spkiSha256OfCertPem(
        await Deno.readTextFile(flags['--cert'] as string),
      );
    } else if (flags['--pin'] !== undefined) {
      pin = flags['--pin'];
    }
    await addPeer({
      name,
      host: addr.host,
      port: addr.port,
      trust,
      pin,
      addedBy: 'operator',
      note: flags['--note'] !== undefined ? flags['--note'] : null,
    });
    console.log(`added ${name}`);
  } else if (cmd === 'remove') {
    const name = positionals[0];
    if (name === undefined) usage();
    const ok = await removePeer(name);
    if (!ok) {
      console.error(`${name} not on the roster`);
      Deno.exit(1);
    }
    console.log(`removed ${name}`);
  } else if (cmd === 'list') {
    for (const p of await listPeers()) console.log(renderPeer(p));
  } else if (cmd === 'pending') {
    const rows = await listPending();
    for (const p of rows) {
      const detail = p.detail !== null ? ` — ${p.detail}` : '';
      console.log(
        `${p.name}  ${p.kind}  verified=${p.verified}  count=${p.count}  last=${
          new Date(p.last_ms).toISOString()
        }${detail}`,
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
  } else {
    usage();
  }
}
