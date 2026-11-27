// The facade owns durable demand and its receive cut. The home is the only
// network initiator; a disconnected or canceled reader cannot cancel demand.
import { Buffer } from 'node:buffer';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { mediaIssuedBy, mediaReservationExpires } from '#engine/media.ts';
import type { MediaCache } from '#engine/media/cache.ts';
import type { Capacity } from '#engine/store/capacity.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { PageLimits } from './journal.ts';
import {
  admitHomeBackedOriginal,
  bad,
  copiedMetadata,
  digest,
  diverged,
  exported,
  fingerprint,
  hashPrefix,
  type Manifest,
  manifestOf,
  openExisting,
  readExactly,
  sha256,
  sizeOf,
  syncDir,
} from './media-copy.ts';
import { integer, object, text } from './protocol.ts';
import { ReplicaCutPending, type ReplicaReadiness } from './readiness.ts';

export const MEDIA_WANT_ROUTES = [
  'media-wanted',
  'media-reply',
  'media-push',
] as const;
export type MediaWantRoute = typeof MEDIA_WANT_ROUTES[number];
export const isMediaWantRoute = (route: string): route is MediaWantRoute =>
  MEDIA_WANT_ROUTES.some((value) => value === route);

type Demand = { id: string; demand: string };
function idOf(raw: unknown): string {
  const id = text(raw);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : bad('invalid wanted media ID');
}
function demandOf(raw: unknown): Demand {
  const fields = object(raw);
  return { id: idOf(fields.id), demand: text(fields.demand) };
}
type Answer = 'absent' | 'unavailable' | { expires: number };
type Reader = { demand: string; answer?: Answer };
const unavailable = () =>
  new MatrixError(503, 'M_UNAVAILABLE', 'Media unavailable; try again later');
const stream = (id: string) => `media-want:${id}`;

export class FacadeMediaWants {
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly readers = new Map<string, Set<Reader>>();

  constructor(
    private readonly tenant: Tenant,
    private readonly root: string,
    private readonly node: string,
    private readonly limits: PageLimits,
    private readonly capacity: Capacity,
    private readonly readiness: ReplicaReadiness,
    private readonly remoteWaitMs: number,
    private readonly cache: MediaCache,
  ) {}

  private async locked<T>(id: string, write: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id);
    const next = previous ? previous.catch(() => {}).then(write) : write();
    this.lanes.set(id, next);
    try {
      return await next;
    } finally {
      if (this.lanes.get(id) === next) this.lanes.delete(id);
    }
  }

  private part(id: string) {
    return `${this.root}/${id}.wanted.part`;
  }

  async open(id: string) {
    return await this.locked(id, async () => {
      // A process can stop after installing the file but before committing its
      // backing and clearing the staged cut. Never serve across that cut.
      if ((await this.tenant.tx((tx) => tx.media.wanted(id)))?.manifest) {
        return null;
      }
      return await this.cache.openOriginal(id);
    });
  }

  private async staged(id: string) {
    const want = await this.tenant.tx((tx) => tx.media.wanted(id));
    const saved = want?.manifest
      ? object(JSON.parse(want.manifest))
      : undefined;
    return {
      want,
      pairing: saved ? text(saved.pairing) : undefined,
      manifest: saved
        ? manifestOf(saved.manifest, this.tenant.serverName, idOf)
        : undefined,
    };
  }

  async read(id: string, pairing: string, signal: AbortSignal): Promise<void> {
    const remote = AbortSignal.timeout(this.remoteWaitMs);
    let reader: Reader | undefined;
    let readers: Set<Reader> | undefined;
    try {
      await this.readiness.wait(
        async (observe) => {
          observe(pairing, stream(id));
          return await this.locked(id, async () => {
            const { want, manifest, pairing: owner } = await this.staged(id);
            if (
              want && manifest && owner === pairing &&
              want.bytes === manifest.size
            ) {
              await this.apply(pairing, manifest);
              return;
            }
            const row = await this.tenant.tx((tx) => tx.media.byId(id));
            if (row?.state === 'uploaded' && !manifest) {
              using lease = await this.cache.openOriginal(id);
              if (lease) return;
            }
            if (
              mediaIssuedBy(id, this.node) &&
              !await this.tenant.tx(async (tx) =>
                await tx.media.backing(id) ||
                await tx.media.exportConfirmation(id)
              )
            ) throw unavailable();
            if (reader?.answer === 'absent') {
              throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
            }
            if (reader?.answer === 'unavailable') throw unavailable();
            if (reader?.answer) {
              if (Date.now() >= reader.answer.expires) throw unavailable();
              throw new MatrixError(
                504,
                'M_NOT_YET_UPLOADED',
                'Content is not yet available',
              );
            }
            if (!reader) {
              const demand = crypto.randomUUID();
              if (
                sizeOf([{ id, demand }]) > this.limits.maxBytes
              ) throw unavailable();
              const held = want ??
                await this.tenant.tx((tx) => tx.media.want(id, demand));
              reader = { demand: held.demand };
              readers = this.readers.get(id) ?? new Set<Reader>();
              readers.add(reader);
              this.readers.set(id, readers);
            }
            throw new ReplicaCutPending(pairing, stream(id), true);
          });
        },
        signal,
        remote,
      );
    } catch (error) {
      if (error instanceof ReplicaCutPending) throw unavailable();
      throw error;
    } finally {
      if (reader) readers?.delete(reader);
      if (readers?.size === 0 && this.readers.get(id) === readers) {
        this.readers.delete(id);
      }
    }
  }

  async exchange(
    route: MediaWantRoute,
    pairing: string,
    body: Record<string, unknown>,
  ) {
    if (route === 'media-wanted') {
      const after = body.after === '' ? '' : idOf(body.after);
      const rows = await this.tenant.tx((tx) =>
        tx.media.listWanted(
          after,
          Math.min(integer(body.maxItems, 1), this.limits.maxItems),
        )
      );
      const wanted: Demand[] = [];
      const maxBytes = Math.min(
        integer(body.maxBytes, 1),
        this.limits.maxBytes,
      );
      let bytes = sizeOf(wanted);
      for (const row of rows) {
        bytes += sizeOf(row) + (wanted.length ? 1 : 0);
        if (bytes > maxBytes) {
          if (!wanted.length) bad('wanted media cannot fit link page budget');
          break;
        }
        wanted.push(row);
      }
      return { wanted };
    }
    const { id, demand } = demandOf(body);
    return await this.locked(id, async () => {
      const held = await this.staged(id);
      if (held.want?.demand !== demand) return { superseded: true };
      if (route === 'media-reply') {
        if (body.state !== 'uploaded') {
          let answer: Answer = body.state === 'pending'
            ? { expires: integer(body.expires) }
            : body.state === 'absent'
            ? 'absent'
            : body.state === 'unavailable'
            ? 'unavailable'
            : bad('invalid media reply state');
          if (
            held.manifest || await this.tenant.tx((tx) => tx.media.byId(id))
          ) {
            // A negative answer cannot erase previously verified knowledge.
            answer = 'unavailable';
          }
          if (answer !== 'unavailable') {
            await this.tenant.tx((tx) => tx.media.finishWant(id));
          }
          for (const reader of this.readers.get(id) ?? []) {
            if (reader.demand === demand) reader.answer = answer;
          }
          this.readiness.applied(pairing, stream(id));
          return {};
        }
        if (sizeOf(body.manifest) > this.limits.maxBytes) {
          bad('manifest exceeds link budget');
        }
        const manifest = manifestOf(
          body.manifest,
          this.tenant.serverName,
          idOf,
        );
        if (manifest.id !== id) return diverged('media reply ID changed');
        const mark = fingerprint(manifest);
        if (held.manifest && fingerprint(held.manifest) !== mark) {
          return diverged('wanted manifest changed');
        }
        const bytes = held.want.bytes;
        await this.tenant.tx(async (tx) => {
          const backing = await tx.media.backing(id);
          const confirmed = await tx.media.exportConfirmation(id);
          const local = await tx.media.byId(id);
          if (backing && backing.fingerprint !== mark) {
            diverged('wanted backing changed');
          }
          if (confirmed && confirmed !== mark) {
            diverged('wanted confirmation changed');
          }
          if (
            local &&
            canonicalJson(local) !== canonicalJson(copiedMetadata(manifest))
          ) diverged('wanted media metadata changed');
          if (mediaIssuedBy(id, this.node) && !local) {
            diverged('unknown facade-issued media');
          }
          await tx.media.stageWant(
            id,
            canonicalJson({ pairing, manifest }),
            bytes,
          );
        });
        if (bytes === manifest.size) {
          await this.publish(pairing, manifest);
          return { complete: true };
        }
        return { offset: bytes };
      }
      const m = held.manifest;
      if (
        !m || held.pairing !== pairing ||
        fingerprint(m) !== digest(body.fingerprint)
      ) {
        return diverged('wanted chunk has no matching manifest');
      }
      const chunk = object(body.chunk);
      const offset = integer(chunk.offset);
      const base64 = text(chunk.base64);
      if (sizeOf(chunk) > this.limits.maxBytes) {
        return bad('wanted chunk exceeds link budget');
      }
      const bytes = Buffer.from(base64, 'base64');
      if (
        offset !== held.want.bytes || !bytes.length ||
        bytes.length > m.size - offset || bytes.toString('base64') !== base64 ||
        sha256(bytes) !== digest(chunk.sha256)
      ) {
        return diverged('invalid wanted media chunk');
      }
      const part = this.part(id);
      await this.capacity.ensureDirectory(this.root);
      const space = await this.capacity.reserveStaging(part, bytes.length);
      try {
        using file = await Deno.open(part, {
          create: true,
          mode: 0o600,
          read: true,
          write: true,
        });
        if ((await file.stat()).size < offset) {
          await this.tenant.tx((tx) =>
            tx.media.stageWant(id, held.want!.manifest!, 0)
          );
          return diverged('wanted stage lost its durable prefix');
        }
        await file.truncate(offset);
        await file.seek(offset, Deno.SeekMode.Start);
        for (let written = 0; written < bytes.length;) {
          const count = await file.write(bytes.subarray(written));
          if (count <= 0) throw new Error('short wanted media write');
          written += count;
        }
        await file.sync();
        if (!offset) await syncDir(this.root);
      } finally {
        space.release();
      }
      const end = offset + bytes.length;
      if (end === m.size) {
        const done = this.readiness.receiving(pairing, stream(id));
        try {
          await this.tenant.tx((tx) =>
            tx.media.stageWant(id, held.want!.manifest!, end)
          );
          await this.apply(pairing, m);
        } finally {
          done();
        }
        return { complete: true };
      }
      await this.tenant.tx((tx) =>
        tx.media.stageWant(id, held.want!.manifest!, end)
      );
      return { offset: end };
    }).catch((error) => {
      // An apply/admission failure is not absence and does not consume demand.
      for (const reader of this.readers.get(id) ?? []) {
        if (reader.demand === demand) reader.answer = 'unavailable';
      }
      this.readiness.applied(pairing, stream(id));
      throw error;
    });
  }

  private async publish(pairing: string, manifest: Manifest) {
    const done = this.readiness.receiving(pairing, stream(manifest.id));
    try {
      await this.apply(pairing, manifest);
    } finally {
      done();
    }
  }

  private async apply(pairing: string, m: Manifest) {
    // Once the complete receive cut is durable, this is purely local work. A
    // request cancellation or link disconnect is not an input to publication.
    const final = `${this.root}/${m.id}`;
    const part = this.part(m.id);
    using _pin = this.cache.pinOriginal(m.id);
    await this.capacity.ensureDirectory(this.root);
    await this.capacity.withMetadata(final, 1, async (space) => {
      space.track(part);
      using existing = await openExisting(final);
      if (existing) {
        if (
          (await existing.stat()).size !== m.size ||
          (await hashPrefix(existing, m.size)).digest('hex') !== m.sha256
        ) {
          diverged('wanted publication conflicts with an existing file');
        }
      } else {
        using file = m.size ? await openExisting(part) : await Deno.open(part, {
          create: true,
          truncate: true,
          write: true,
          mode: 0o600,
        });
        if (
          !file || (await file.stat()).size !== m.size ||
          (m.size
              ? (await hashPrefix(file, m.size)).digest('hex')
              : sha256('')) !== m.sha256
        ) {
          return;
        }
        if (!m.size) await file.sync();
        await Deno.link(part, final);
      }
      await Deno.remove(part).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await syncDir(this.root);
    });
    using published = await openExisting(final);
    if (!published) {
      await this.tenant.tx(async (tx) => {
        const want = await tx.media.wanted(m.id);
        await tx.media.stageWant(m.id, want!.manifest!, 0);
      });
      return diverged('whole wanted media digest or size changed');
    }
    await this.tenant.tx(async (tx) => {
      if (!await tx.media.byId(m.id)) {
        await tx.media.insertCopy(copiedMetadata(m));
      }
      await tx.media.recordBacking(m.id, pairing, fingerprint(m));
      await tx.media.finishWant(m.id);
    });
    await admitHomeBackedOriginal(
      this.cache,
      copiedMetadata(m),
      this.tenant.serverName,
      pairing,
      fingerprint(m),
    );
    this.readiness.applied(pairing, stream(m.id));
  }
}

export type MediaPush = (
  route: MediaWantRoute,
  fields: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

export class HomeMediaWants {
  constructor(private readonly tenant: Tenant, private readonly root: string) {}

  async reconcile(
    push: MediaPush,
    limits: PageLimits,
    failed: (error: unknown) => void,
    signal: AbortSignal,
  ) {
    let after = '';
    for (;;) {
      const { wanted } = await push(
        'media-wanted',
        { after, ...limits },
        signal,
      );
      if (
        !Array.isArray(wanted) || wanted.length > limits.maxItems ||
        sizeOf(wanted) > limits.maxBytes
      ) return bad('invalid wanted media page');
      if (!wanted.length) return;
      for (const raw of wanted) {
        const demand = demandOf(raw);
        if (demand.id <= after) diverged('unordered wanted media page');
        after = demand.id;
        try {
          await this.reply(demand, push, limits, signal);
        } catch (error) {
          signal.throwIfAborted();
          failed(error);
        }
      }
    }
  }

  private async reply(
    demand: Demand,
    push: MediaPush,
    limits: PageLimits,
    signal: AbortSignal,
  ) {
    const { id } = demand;
    const { row, copy } = await this.tenant.tx(async (tx) => ({
      row: await tx.media.byId(id),
      copy: await tx.media.homeCopy(id),
    }));
    const reply = (fields: Record<string, unknown>) =>
      push('media-reply', { ...demand, ...fields }, signal);
    if (!row) {
      await reply({ state: copy ? 'unavailable' : 'absent' });
      return;
    }
    if (row.state === 'pending') {
      const expires = mediaReservationExpires(row);
      await reply(
        Date.now() < expires
          ? { state: 'pending', expires }
          : { state: 'absent' },
      );
      return;
    }
    using file = await openExisting(`${this.root}/${id}`);
    if (!file) {
      await reply({ state: 'unavailable' });
      return;
    }
    const size = (await file.stat()).size;
    if (row.size_bytes !== null && row.size_bytes !== size) {
      await reply({ state: 'unavailable' });
      return;
    }
    const hash = (await hashPrefix(file, size, signal)).digest('hex');
    const manifest = exported(
      { ...row, size_bytes: size, sha256: hash },
      this.tenant.serverName,
      idOf,
    );
    if (
      copy && (!copy.complete || copy.fingerprint !== fingerprint(manifest))
    ) {
      await reply({ state: 'unavailable' });
      return;
    }
    const initial = await reply({ state: 'uploaded', manifest });
    if (initial.superseded === true || initial.complete === true) return;
    let offset = integer(initial.offset);
    while (offset < size) {
      signal.throwIfAborted();
      const chunk = { offset, sha256: sha256(''), base64: '' };
      const length = Math.min(
        size - offset,
        Math.floor((limits.maxBytes - sizeOf(chunk)) / 4) * 3,
      );
      if (length <= 0) return bad('wanted media chunk cannot fit link budget');
      await file.seek(offset, Deno.SeekMode.Start);
      const bytes = Buffer.alloc(length);
      await readExactly(file, bytes);
      const result = await push('media-push', {
        ...demand,
        fingerprint: fingerprint(manifest),
        chunk: {
          ...chunk,
          sha256: sha256(bytes),
          base64: bytes.toString('base64'),
        },
      }, signal);
      offset += length;
      if (
        result.superseded === true ||
        (result.complete === true && offset === size)
      ) return;
      if (offset === size || result.offset !== offset) {
        return diverged('wanted cut acknowledgement changed');
      }
    }
    return diverged('invalid wanted cut');
  }
}
