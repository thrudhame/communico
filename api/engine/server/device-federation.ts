// Publication-derived subscriptions and immutable per-destination causal chains.
import type { Conn } from '#engine/store/db.ts';
import { domainOf } from '#engine/ids.ts';
import { enqueueEdu } from '#engine/server/delivery.ts';

function wirePayload(raw: string): Record<string, unknown> {
  const payload = JSON.parse(raw);
  delete payload.generation;
  return payload;
}

/** Called in the same server transaction as all-room relationship changes. */
export async function reconcileDeviceSubscriptions(
  tx: Conn,
  subjects: string[],
  localServers: string[],
): Promise<void> {
  if (!localServers.length) return;
  for (const subject of subjects) {
    const domain = domainOf(subject);
    const peers = (await tx.query(
      "SELECT observer FROM device_tracking WHERE subject=? AND scope='keys' AND end_seq IS NULL",
      [subject],
    )).map((r) => String(r.observer));
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
    const prior = await tx.query(
      'SELECT * FROM device_subscriptions WHERE subject=?',
      [subject],
    );
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
        'SELECT stream_id,payload FROM device_changes WHERE subject=? ORDER BY stream_id DESC LIMIT 1',
        [subject],
      ))[0];
      const stream = latest ? Number(latest.stream_id) : 0;
      // Empty, deleted ID is an invalidation-only reset, never a real device.
      // Stock receivers resnapshot on prev_id=[], including an empty account.
      const payload = latest
        ? wirePayload(String(latest.payload))
        : { device_id: '', deleted: true };
      await enqueueEdu(
        tx,
        'device-reset:' + JSON.stringify([subject, destination, epoch]),
        destination,
        'm.device_list_update',
        {
          ...payload,
          user_id: subject,
          stream_id: stream,
          prev_id: [],
        },
      );
      const signing = (await tx.query(
        'SELECT payload FROM public_signing_keys WHERE subject=?',
        [subject],
      ))[0];
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
        'INSERT INTO device_subscriptions VALUES(?,?,1,?,?,NULL) ON CONFLICT(subject,destination) DO UPDATE SET active=1,epoch=excluded.epoch,queued_stream=excluded.queued_stream',
        [subject, destination, epoch, stream],
      );
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
  const subscriptions = await tx.query(
    'SELECT destination,queued_stream FROM device_subscriptions WHERE subject=? AND active=1',
    [subject],
  );
  for (const row of subscriptions) {
    if (stream <= Number(row.queued_stream)) continue;
    await enqueueEdu(
      tx,
      'device-change:' + JSON.stringify([subject, stream]),
      String(row.destination),
      'm.device_list_update',
      {
        ...wirePayload(raw),
        user_id: subject,
        stream_id: stream,
        prev_id: [Number(row.queued_stream)],
      },
    );
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
  const { kind: _kind, ...publicKeys } = payload;
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
