import { theApp } from '#engine/app.ts';
import { ignoredSenders } from '#engine/client/ignored.ts';
import type { Viewer } from '#engine/client/render.ts';
import { captureErasureInputs } from '#engine/tenant/erasure.ts';
import { roomSource } from '#engine/store/projection-sources.ts';
import { getAll } from '#engine/store/watermark.ts';

export type DisplayProof = {
  roomRevision: string;
  projection: number;
  ignored: string;
  erasure: string;
};

/** Observe the same owners as the normal renderer. A proof is valid only if
 * all their revisions bracket rendering (or still match at a skip decision).
 * Projection includes non-feed publication effects such as live redactions. */
export async function captureDisplayProof(viewer: Viewer, joined: string[]) {
  const { store, server } = theApp();
  if (!joined.length) return () => undefined;
  const serverCut = store.serverRevision();
  if (serverCut === undefined) return () => undefined;
  const [room, projections, erasure] = await Promise.all([
    store.revisionProbe('rooms', joined),
    getAll(server, joined.map((id) => roomSource('room', id))),
    captureErasureInputs(store, viewer.tenant.serverName).catch((error) => {
      // A tenant being attached may not have an erasure owner yet. This input
      // is optional; normal rendering still resolves only its actual senders.
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }),
  ]);
  if (erasure === undefined) return () => undefined;
  const ignored = JSON.stringify([...await ignoredSenders(viewer)].sort());
  const projection = new Map(joined.map((id, i) => [id, projections[i]]));
  return (id: string): DisplayProof | undefined => {
    const roomRevision = room(id), mark = projection.get(id);
    if (
      roomRevision === undefined || mark === undefined || mark <= 0 ||
      store.serverRevision() !== serverCut || !erasure.stable()
    ) return;
    return { roomRevision, projection: mark, ignored, erasure: erasure.hash };
  };
}
