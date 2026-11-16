// Publication-derived subscriptions and immutable per-destination causal chains.
import type { Conn } from '#engine/store/db.ts';
import { domainOf } from '#engine/ids.ts';
import { enqueueEdu } from '#engine/server/delivery.ts';
import { publicSigningPayload } from '#engine/e2ee-signing.ts';
import { canonicalJson } from '#engine/canonical.ts';

function publicationCollision(): never {
  throw new Error('device publication collision');
}

/** Exact identities and predecessor edges own publication, never a numeric
 * high-water mark. An unknown predecessor can arrive after its descendant. */
async function retainPublication(
  tx: Conn,
  subject: string,
  destination: string,
  epoch: number,
  source: string,
  content: Record<string, unknown>,
): Promise<boolean> {
  const stream = content.stream_id, prev = content.prev_id;
  if (
    !Number.isSafeInteger(stream) || Number(stream) < 0 ||
    !Array.isArray(prev) || new Set(prev).size !== prev.length ||
    prev.some((id) => !Number.isSafeInteger(id) || id < 0 || id === stream)
  ) publicationCollision();
  const encoded = canonicalJson(content);
  const [prior] = await tx.query(
    'SELECT content FROM device_publications WHERE subject=? AND destination=? AND epoch=? AND stream_id=?',
    [subject, destination, epoch, Number(stream)],
  );
  if (prior) {
    if (canonicalJson(JSON.parse(String(prior.content))) !== encoded) {
      publicationCollision();
    }
    return false;
  }
  for (const previous of prev) {
    const cycle = await tx.query(
      'WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT e.previous_id FROM device_publication_predecessors e JOIN ancestors a ON e.stream_id=a.id WHERE e.subject=? AND e.destination=? AND e.epoch=?) SELECT 1 FROM ancestors WHERE id=? LIMIT 1',
      [previous, subject, destination, epoch, Number(stream)],
    );
    if (cycle.length) publicationCollision();
  }
  await tx.execute('INSERT INTO device_publications VALUES(?,?,?,?,?,?,0)', [
    subject,
    destination,
    epoch,
    Number(stream),
    source,
    encoded,
  ]);
  for (const previous of prev) {
    await tx.execute(
      'INSERT INTO device_publication_predecessors VALUES(?,?,?,?,?)',
      [
        subject,
        destination,
        epoch,
        Number(stream),
        previous,
      ],
    );
    await tx.execute(
      'DELETE FROM device_publication_frontier WHERE subject=? AND destination=? AND epoch=? AND stream_id=?',
      [
        subject,
        destination,
        epoch,
        previous,
      ],
    );
  }
  if (
    !(await tx.query(
      'SELECT 1 FROM device_publication_predecessors WHERE subject=? AND destination=? AND epoch=? AND previous_id=? LIMIT 1',
      [subject, destination, epoch, Number(stream)],
    )).length
  ) {
    await tx.execute(
      'INSERT INTO device_publication_frontier VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
      [subject, destination, epoch, Number(stream)],
    );
  }
  return true;
}

function wirePayload(raw: string): Record<string, unknown> {
  const payload = JSON.parse(raw);
  return Object.fromEntries(
    ['device_id', 'deleted', 'device_display_name', 'keys']
      .filter((key) => Object.hasOwn(payload, key)).map((
        key,
      ) => [key, payload[key]]),
  );
}

/** Subscription activation and restore use the same durable full-reset owner. */
async function queueDeviceReset(
  tx: Conn,
  subject: string,
  destination: string,
  epoch: number,
  stream: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const source = 'device-reset:' +
    JSON.stringify([subject, destination, epoch]);
  const content = {
    ...payload,
    user_id: subject,
    stream_id: stream,
    prev_id: [],
  };
  if (
    await retainPublication(tx, subject, destination, epoch, source, content)
  ) {
    await enqueueEdu(tx, source, destination, 'm.device_list_update', content);
  }
  const signing =
    (await tx.query('SELECT payload FROM public_signing_keys WHERE subject=?', [
      subject,
    ]))[0];
  if (signing) {
    await enqueueEdu(
      tx,
      'signing-reset:' + JSON.stringify([subject, destination, epoch]),
      destination,
      'm.signing_key_update',
      { ...JSON.parse(String(signing.payload)), user_id: subject },
    );
  }
  await tx.execute(
    'INSERT INTO device_subscriptions VALUES(?,?,1,?,?,NULL) ON CONFLICT(subject,destination) DO UPDATE SET active=1,epoch=excluded.epoch,queued_stream=excluded.queued_stream,sent_stream=NULL',
    [subject, destination, epoch, stream],
  );
}

/** Called in the same server transaction as all-room relationship changes. */
export async function reconcileDeviceSubscriptions(
  tx: Conn,
  subjects: string[],
  localServers: string[],
): Promise<void> {
  if (!localServers.length) return;
  for (let offset = 0; offset < subjects.length; offset += 256) {
    const batch = subjects.slice(offset, offset + 256);
    const placeholders = batch.map(() => '?').join(',');
    const tracking = await tx.query(
      `SELECT subject,observer FROM device_tracking WHERE subject IN (${placeholders}) AND scope='keys' AND end_seq IS NULL`,
      batch,
    );
    const subscriptions = await tx.query(
      `SELECT * FROM device_subscriptions WHERE subject IN (${placeholders})`,
      batch,
    );
    const peersBySubject = new Map<string, string[]>();
    const priorBySubject = new Map<string, typeof subscriptions>();
    for (const row of tracking) {
      const key = String(row.subject);
      if (!peersBySubject.has(key)) peersBySubject.set(key, []);
      peersBySubject.get(key)!.push(String(row.observer));
    }
    for (const row of subscriptions) {
      const key = String(row.subject);
      if (!priorBySubject.has(key)) priorBySubject.set(key, []);
      priorBySubject.get(key)!.push(row);
    }
    for (const subject of batch) {
      const domain = domainOf(subject);
      const peers = peersBySubject.get(subject) ?? [];
      if (domain === null || !localServers.includes(domain)) {
        if (peers.some((p) => localServers.includes(domainOf(p)!))) {
          await tx.execute(
            "INSERT INTO remote_device_users VALUES(?,NULL,1,0,0,0,'[]','[]') ON CONFLICT DO NOTHING",
            [subject],
          );
        }
        continue;
      }
      const destinations = new Set(
        peers.map(domainOf).filter((d): d is string =>
          d !== null && !localServers.includes(d)
        ),
      );
      const prior = priorBySubject.get(subject) ?? [];
      for (const old of prior) {
        if (!destinations.has(String(old.destination))) {
          await tx.execute(
            'UPDATE device_subscriptions SET active=0 WHERE subject=? AND destination=?',
            [subject, old.destination],
          );
        }
      }
      for (const destination of destinations) {
        const old = prior.find((r) => r.destination === destination);
        if (old && Number(old.active) === 1) continue;
        const epoch = old ? Number(old.epoch) + 1 : 1;
        const latest = (await tx.query(
          'SELECT stream_id,payload FROM device_changes WHERE subject=? ORDER BY seq DESC LIMIT 1',
          [subject],
        ))[0];
        const stream = latest ? Number(latest.stream_id) : 0;
        // Empty, deleted ID is an invalidation-only reset, never a real device.
        // Stock receivers resnapshot on prev_id=[], including an empty account.
        const payload = latest
          ? wirePayload(String(latest.payload))
          : { device_id: '', deleted: true };
        await queueDeviceReset(
          tx,
          subject,
          destination,
          epoch,
          stream,
          payload,
        );
      }
    }
  }
}

/** Tenant snapshots/tombstones are projected once, with the subscription cut. */
export async function fanoutDeviceChange(
  tx: Conn,
  subject: string,
  stream: number,
  raw: string,
): Promise<void> {
  const payload = JSON.parse(raw);
  const reset = payload.kind === 'restore_reset' ||
    payload.kind === 'semantic_reset';
  const subscriptions = await tx.query(
    'SELECT destination,queued_stream,epoch FROM device_subscriptions WHERE subject=? AND active=1',
    [subject],
  );
  for (const row of subscriptions) {
    if (reset) {
      await queueDeviceReset(
        tx,
        subject,
        String(row.destination),
        Number(row.epoch) + 1,
        stream,
        wirePayload(raw),
      );
      continue;
    }
    const destination = String(row.destination), epoch = Number(row.epoch);
    const [prior] = await tx.query(
      'SELECT content FROM device_publications WHERE subject=? AND destination=? AND epoch=? AND stream_id=?',
      [subject, destination, epoch, stream],
    );
    // Immutable F2 wire evidence carries its original predecessors. Standalone
    // serial changes join this destination's observed frontier. A retry without
    // explicit evidence uses its retained predecessors, not today's frontier.
    const prev = payload.wire
      ? payload.wire.prevIds
      : prior
      ? JSON.parse(String(prior.content)).prev_id
      : (await tx.query(
        'SELECT stream_id FROM device_publication_frontier WHERE subject=? AND destination=? AND epoch=? ORDER BY stream_id',
        [subject, destination, epoch],
      )).map((tip) => Number(tip.stream_id));
    if (payload.wire && payload.wire.streamId !== stream) {
      publicationCollision();
    }
    // A serial subscription may have only its retained scalar baseline before
    // the first post-upgrade publication enters the new ledger.
    const predecessors = !payload.wire && !prior && !prev.length
      ? [Number(row.queued_stream)]
      : prev;
    const source = 'device-change:' + JSON.stringify([subject, epoch, stream]);
    const content = {
      ...wirePayload(raw),
      user_id: subject,
      stream_id: stream,
      prev_id: predecessors,
    };
    if (
      !await retainPublication(tx, subject, destination, epoch, source, content)
    ) continue;
    await enqueueEdu(tx, source, destination, 'm.device_list_update', content);
    await tx.execute(
      'UPDATE device_subscriptions SET queued_stream=? WHERE subject=? AND destination=?',
      [stream, subject, row.destination],
    );
  }
}

/** Keep current public material and immutable fanout in the same projection cut. */
export async function fanoutSigningChange(
  tx: Conn,
  subject: string,
  pos: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const publicKeys = publicSigningPayload(payload);
  await tx.execute(
    'INSERT INTO public_signing_keys VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET source_pos=excluded.source_pos,payload=excluded.payload',
    [subject, pos, JSON.stringify(publicKeys)],
  );
  for (
    const row of await tx.query(
      'SELECT destination FROM device_subscriptions WHERE subject=? AND active=1',
      [subject],
    )
  ) {
    await enqueueEdu(
      tx,
      'signing-change:' + JSON.stringify([subject, pos]),
      String(row.destination),
      'm.signing_key_update',
      { ...publicKeys, user_id: subject },
    );
  }
}
