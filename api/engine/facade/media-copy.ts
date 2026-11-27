// A separate typed pull stream over the enrolled home link. Only metadata and
// verified progress cuts live in the database; the staged bytes live on disk.
import { Buffer } from 'node:buffer';
import type { MediaCache } from '#engine/media/cache.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { mediaIssuedBy } from '#engine/media.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { ExportRow, MediaRow } from '#engine/tenant/media.ts';
import type { PageLimits } from './journal.ts';
import { integer, LinkError, object, text } from './protocol.ts';

export const MEDIA_COPY_ROUTES = [
  'media-manifests',
  'media-chunk',
  'media-applied',
] as const;
export type MediaCopyRoute = typeof MEDIA_COPY_ROUTES[number];
export function isMediaCopyRoute(route: string): route is MediaCopyRoute {
  return MEDIA_COPY_ROUTES.some((candidate) => candidate === route);
}

export type Manifest = {
  origin: string;
  id: string;
  owner: string;
  // Origin-only media follows the existing client, legacy, and S2S policy.
  access: 'origin-media-v1';
  contentType: string | null;
  filename: string | null;
  size: number;
  sha256: string;
  created: number;
  uploaded: number;
};
const encoder = new TextEncoder();
export const sizeOf = (value: unknown) =>
  encoder.encode(canonicalJson(value)).length;
export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const emptyDigest = sha256('');
export const fingerprint = (manifest: Manifest) =>
  sha256(canonicalJson(manifest));
export const diverged = (why: string): never => {
  throw new LinkError('LINK_DIVERGED', why);
};
export const bad = (why: string): never => {
  throw new LinkError('LINK_BAD_RECORD', why, 400);
};

export function digest(raw: unknown): string {
  const value = text(raw);
  if (!/^[a-f0-9]{64}$/.test(value)) bad('invalid media digest');
  return value;
}

function idOf(raw: unknown, node: string): string {
  const id = text(raw);
  if (!mediaIssuedBy(id, node)) bad('media ID not issued by source');
  return id;
}

export function manifestOf(
  raw: unknown,
  origin: string,
  parseId: (raw: unknown) => string,
): Manifest {
  const m = object(raw);
  if (m.origin !== origin || m.access !== 'origin-media-v1') {
    bad('wrong media origin or access policy');
  }
  const optionalText = (value: unknown) =>
    value === null || typeof value === 'string'
      ? value
      : bad('invalid media metadata text');
  const contentType = optionalText(m.contentType);
  if (contentType !== null) {
    try {
      new Headers({ 'content-type': contentType });
    } catch {
      bad('invalid media content type');
    }
  }
  return {
    origin,
    id: parseId(m.id),
    owner: text(m.owner),
    access: 'origin-media-v1',
    contentType,
    filename: optionalText(m.filename),
    size: integer(m.size),
    sha256: digest(m.sha256),
    created: integer(m.created),
    uploaded: integer(m.uploaded),
  };
}

export function exported(
  row: ExportRow,
  origin: string,
  parseId: (raw: unknown) => string,
): Manifest {
  return manifestOf(
    {
      origin,
      id: row.media_id,
      owner: row.localpart,
      access: 'origin-media-v1',
      contentType: row.content_type,
      filename: row.filename,
      size: row.size_bytes,
      sha256: row.sha256,
      created: row.created_ms,
      uploaded: row.uploaded_ms,
    },
    origin,
    parseId,
  );
}

export async function readExactly(file: Deno.FsFile, bytes: Uint8Array) {
  let read = 0;
  while (read < bytes.length) {
    const n = await file.read(bytes.subarray(read));
    if (!n) diverged('media file ended below its durable size');
    read += n!;
  }
}

export async function admitHomeBackedOriginal(
  cache: MediaCache,
  row: MediaRow,
  server: string,
  pairing: string,
  mark: string,
) {
  if (row.size_bytes === null) return;
  const size = row.size_bytes;
  await cache.verifyOriginal(
    row.media_id,
    pairing,
    row.created_ms,
    async (file) =>
      (await file.stat()).size === size && fingerprint(exported(
          {
            ...row,
            sha256: (await hashPrefix(file, size)).digest('hex'),
          },
          server,
          (id) => text(id),
        )) === mark,
  );
}

export function copiedMetadata(m: Manifest): MediaRow {
  return {
    media_id: m.id,
    localpart: m.owner,
    state: 'uploaded',
    content_type: m.contentType,
    filename: m.filename,
    size_bytes: m.size,
    created_ms: m.created,
    uploaded_ms: m.uploaded,
  };
}

export class FacadeMediaExports {
  constructor(
    private readonly tenant: Tenant,
    private readonly node: string,
    private readonly limits: PageLimits,
    private readonly cache: MediaCache,
  ) {}

  async exchange(
    route: MediaCopyRoute,
    pairing: string,
    body: Record<string, unknown>,
  ) {
    if (route === 'media-manifests') {
      const after = body.after === '' ? '' : idOf(body.after, this.node);
      const maxBytes = Math.min(
        integer(body.maxBytes, 1),
        this.limits.maxBytes,
      );
      const rows = await this.tenant.tx((tx) =>
        tx.media.pendingExports(
          this.node,
          pairing,
          after,
          Math.min(integer(body.maxItems, 1), this.limits.maxItems),
        )
      );
      const manifests: Manifest[] = [];
      let bytes = sizeOf(manifests);
      for (const row of rows) {
        const manifest = exported(
          row,
          this.tenant.serverName,
          (raw) => idOf(raw, this.node),
        );
        bytes += sizeOf(manifest) + (manifests.length ? 1 : 0);
        if (bytes > maxBytes) {
          if (!manifests.length) bad('media manifest exceeds link page budget');
          break;
        }
        manifests.push(manifest);
      }
      return { manifests };
    }
    const id = idOf(body.id, this.node);
    const expected = digest(body.fingerprint);
    const check = (row: ExportRow | null) => {
      if (!row) return diverged('unknown media export');
      const m = exported(
        row,
        this.tenant.serverName,
        (raw) => idOf(raw, this.node),
      );
      if (fingerprint(m) !== expected) {
        diverged('media export fingerprint changed');
      }
      return m;
    };
    if (route === 'media-applied') {
      // The exact object result belongs to the current authenticated pairing.
      const m = await this.tenant.tx(async (tx) => {
        const m = check(await tx.media.exportById(this.node, id));
        if (!await tx.media.confirmExport(id, pairing, expected)) {
          diverged('media confirmation changed');
        }
        return m;
      });
      await admitHomeBackedOriginal(
        this.cache,
        copiedMetadata(m),
        this.tenant.serverName,
        pairing,
        expected,
      );
      return { applied: { id, fingerprint: expected } };
    }
    const m = check(
      await this.tenant.tx((tx) => tx.media.exportById(this.node, id)),
    );
    const offset = integer(body.offset);
    if (offset >= m.size) bad('media range outside manifest');
    const header = {
      id,
      fingerprint: expected,
      offset,
      sha256: emptyDigest,
      base64: '',
    };
    const encodedBudget =
      Math.min(integer(body.maxBytes, 1), this.limits.maxBytes) -
      sizeOf(header);
    const length = Math.min(m.size - offset, Math.floor(encodedBudget / 4) * 3);
    if (length <= 0) bad('media chunk cannot fit link page budget');
    using lease = await this.cache.openOriginal(id);
    if (!lease) {
      throw new LinkError('LINK_UNAVAILABLE', 'Media bytes unavailable', 503);
    }
    const { file } = lease;
    if ((await file.stat()).size !== m.size) {
      diverged('media source size changed');
    }
    await file.seek(offset, Deno.SeekMode.Start);
    const bytes = Buffer.alloc(length);
    await readExactly(file, bytes);
    return {
      chunk: {
        ...header,
        sha256: sha256(bytes),
        base64: bytes.toString('base64'),
      },
    };
  }
}

export type MediaPull = (
  route: MediaCopyRoute,
  fields: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

// Hash from the beginning when resuming. The size alone doesn't prove a cut,
// and an uncommitted tail (write before DB commit) is never trusted.
export async function hashPrefix(
  file: Deno.FsFile,
  size: number,
  signal?: AbortSignal,
) {
  const hash = createHash('sha256');
  await file.seek(0, Deno.SeekMode.Start);
  const buffer = new Uint8Array(Math.min(size, 64 * 1024));
  let remaining = size;
  while (remaining) {
    signal?.throwIfAborted();
    const bytes = buffer.subarray(0, Math.min(remaining, buffer.length));
    await readExactly(file, bytes);
    hash.update(bytes);
    remaining -= bytes.length;
  }
  return hash;
}

export async function openExisting(path: string) {
  try {
    return await Deno.open(path, { read: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return null;
  }
}

export async function syncDir(path: string) {
  using dir = await Deno.open(path, { read: true });
  await dir.sync();
}

export class HomeMediaCopies {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly tenant: Tenant, private readonly root: string) {}

  async reconcile(
    node: string,
    pull: MediaPull,
    limits: PageLimits,
    failed: (error: unknown) => void,
    signal?: AbortSignal,
  ) {
    let after = '';
    for (;;) {
      signal?.throwIfAborted();
      const { manifests: raw } = await pull('media-manifests', {
        after,
        ...limits,
      }, signal);
      if (
        !Array.isArray(raw) || raw.length > limits.maxItems ||
        sizeOf(raw) > limits.maxBytes
      ) {
        return bad('invalid media manifest page');
      }
      if (!raw.length) return;
      const manifests = raw.map((value) =>
        manifestOf(value, this.tenant.serverName, (raw) => idOf(raw, node))
      );
      for (const m of manifests) {
        if (m.id <= after) diverged('unordered media manifest page');
        after = m.id;
      }
      for (const m of manifests) {
        signal?.throwIfAborted();
        const identity = { id: m.id, fingerprint: fingerprint(m) };
        try {
          await this.copy(m, identity.fingerprint, pull, limits, signal);
          const { applied } = await pull('media-applied', identity, signal);
          if (canonicalJson(applied) !== canonicalJson(identity)) {
            diverged('invalid media applied acknowledgement');
          }
        } catch (error) {
          signal?.throwIfAborted();
          // One failed object's durable obligation remains in the next pass.
          failed(error);
        }
      }
    }
  }

  private async copy(
    m: Manifest,
    mark: string,
    pull: MediaPull,
    limits: PageLimits,
    signal?: AbortSignal,
  ) {
    // A re-enrollment or duplicate wake can never concurrently own a part.
    const previous = this.running.get(m.id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() =>
      this.stage(m, mark, pull, limits, signal)
    );
    this.running.set(m.id, job);
    try {
      await job;
    } finally {
      if (this.running.get(m.id) === job) this.running.delete(m.id);
    }
  }

  private async stage(
    m: Manifest,
    mark: string,
    pull: MediaPull,
    limits: PageLimits,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const held = await this.tenant.tx(async (tx) => {
      const copy = await tx.media.homeCopy(m.id);
      if (copy && copy.fingerprint !== mark) {
        diverged('immutable media manifest changed');
      }
      const row = await tx.media.byId(m.id);
      if (copy?.complete ? row?.state !== 'uploaded' : row !== null) {
        diverged('media copy conflicts with existing local metadata');
      }
      if (copy) return copy;
      await tx.media.beginCopy(m.id, mark, emptyDigest);
      return { complete: false, bytes: 0, sha256: emptyDigest };
    });
    const final = `${this.root}/${m.id}`;
    const part = `${final}.home-copy.part`;
    await Deno.mkdir(this.root, { recursive: true, mode: 0o700 });
    {
      using published = await openExisting(final);
      if (published) {
        // Also covers loss between linking the verified file and committing its
        // metadata, and loss of the final ACK. Never overwrite a published ID.
        if (
          (await published.stat()).size !== m.size ||
          (await hashPrefix(published, m.size, signal)).digest('hex') !==
            m.sha256
        ) {
          diverged('published media does not match its manifest');
        }
        if (held.complete) return;
      } else {
        if (held.complete) diverged('completed media is missing');
        using file = await Deno.open(part, {
          create: true,
          read: true,
          write: true,
          mode: 0o600,
        });
        let offset = held.bytes;
        let hash = (await file.stat()).size >= offset && offset <= m.size
          ? await hashPrefix(file, offset, signal)
          : null;
        if (!hash || hash.copy().digest('hex') !== held.sha256) {
          offset = 0;
          hash = createHash('sha256');
          await file.seek(0, Deno.SeekMode.Start);
        }
        await file.truncate(offset);
        if (offset !== held.bytes) {
          await file.sync();
          await this.tenant.tx((tx) =>
            tx.media.advanceCopy(m.id, 0, emptyDigest)
          );
        }
        if (offset === 0) await syncDir(this.root);
        while (offset < m.size) {
          signal?.throwIfAborted();
          const { chunk: raw } = await pull('media-chunk', {
            id: m.id,
            fingerprint: mark,
            offset,
            maxBytes: limits.maxBytes,
          }, signal);
          const chunk = object(raw);
          if (
            chunk.id !== m.id || chunk.fingerprint !== mark ||
            chunk.offset !== offset || sizeOf(chunk) > limits.maxBytes
          ) {
            diverged('media chunk range or fingerprint changed');
          }
          const base64 = text(chunk.base64);
          const bytes = Buffer.from(base64, 'base64');
          if (
            !bytes.length || bytes.length > m.size - offset ||
            bytes.toString('base64') !== base64 ||
            sha256(bytes) !== digest(chunk.sha256)
          ) {
            diverged('media chunk digest or length invalid');
          }
          for (let written = 0; written < bytes.length;) {
            const n = await file.write(bytes.subarray(written));
            if (n <= 0) throw new Error('short media copy write');
            written += n;
          }
          hash.update(bytes);
          offset += bytes.length;
          const prefix = hash.copy().digest('hex');
          if (offset === m.size && prefix !== m.sha256) {
            // No terminal result for a bad assembly. Reset only this private
            // stage so a later pull can retry every byte of the same manifest.
            await file.truncate(0);
            await file.sync();
            await this.tenant.tx((tx) =>
              tx.media.advanceCopy(m.id, 0, emptyDigest)
            );
            diverged('whole media digest changed');
          }
          await file.sync();
          await this.tenant.tx((tx) =>
            tx.media.advanceCopy(m.id, offset, prefix)
          );
        }
        if (hash.digest('hex') !== m.sha256) {
          diverged('whole media digest changed');
        }
        await file.sync();
        await Deno.link(part, final);
      }
    }
    try {
      await Deno.remove(part);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    await syncDir(this.root);
    await this.tenant.tx((tx) =>
      tx.media.finishCopy(copiedMetadata(m), m.sha256)
    );
  }
}
