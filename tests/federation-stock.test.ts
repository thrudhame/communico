// Independent stock producers, replayed through the actual response owners.
import { assert, assertEquals } from '@std/assert';
import { config } from '#engine/config.ts';
import { arrayOf, decodeJson, objectOf } from '#engine/net/json.ts';
import { keyDocument } from '#engine/federation/key-document.ts';
import {
  eventResponse,
  inviteResponse,
  knockResponse,
  leaveResponse,
  membershipTemplate,
  pduList,
  sendJoinResponse,
  sendVerdicts,
  stateIdsResponse,
  stateResponse,
  timestampResponse,
  transactionPdus,
} from '#engine/federation/responses.ts';
import {
  directoryResponse,
  hierarchyResponse,
  profileResponse,
} from '#engine/federation/discovery-response.ts';
import { publicDeviceKey, remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { claimedKey, keyId, object } from '#engine/e2ee-wire.ts';
import { publicSigning } from '#engine/e2ee-public-signing.ts';
import { mediaMultipart } from '#engine/media/multipart.ts';

type Recording = {
  producer: string;
  family: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body_base64: string;
  body_sha256: string;
  body_bytes: number;
  expected_media_sha256?: string;
  expected_media_bytes?: number;
  expected_png_dimensions?: number[];
};
const fixture = JSON.parse(
  await Deno.readTextFile('tests/fixtures/federation-stock/recordings.json'),
) as { records: Recording[] };
function bytes(record: Recording): Uint8Array {
  return Uint8Array.from(atob(record.body_base64), (c) => c.charCodeAt(0));
}
async function sha256(data: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}
function decode(record: Recording): unknown {
  return decodeJson(
    bytes(record),
    new Headers(record.headers).get('content-type'),
  );
}
function queryKeys(raw: unknown) {
  const body = object(raw, 'query'), limits = config().e2ee;
  for (
    const [user, devices] of Object.entries(object(body.device_keys, 'users'))
  ) {
    for (const [id, value] of Object.entries(object(devices, 'devices'))) {
      publicDeviceKey(value, user, id, limits);
    }
    publicSigning(
      {
        master_key: (body.master_keys as Record<string, unknown> | undefined)
          ?.[user],
        self_signing_key:
          (body.self_signing_keys as Record<string, unknown> | undefined)
            ?.[user],
      },
      user,
      limits,
    );
  }
}
function claimKeys(raw: unknown) {
  const body = object(raw, 'claim');
  for (const devices of Object.values(object(body.one_time_keys, 'users'))) {
    for (const keys of Object.values(object(devices, 'devices'))) {
      for (const [id, key] of Object.entries(object(keys, 'claimed keys'))) {
        claimedKey(key, keyId(id)[0], config().e2ee);
      }
    }
  }
}
function consume(record: Recording) {
  const raw = decode(record);
  switch (record.family) {
    case 'server-keys':
      return keyDocument(raw);
    case 'notary':
      return arrayOf(
        objectOf(raw, 'notary').server_keys,
        keyDocument,
        'notary',
      );
    case 'event':
      return eventResponse(raw);
    case 'state':
      return stateResponse(raw);
    case 'state-ids':
      return stateIdsResponse(raw);
    case 'event-auth':
      return pduList(objectOf(raw, 'event-auth').auth_chain, 'event-auth');
    case 'backfill':
      return transactionPdus(raw, 'backfill');
    case 'missing-events':
      return pduList(objectOf(raw, 'missing-events').events, 'missing-events');
    case 'timestamp':
      return timestampResponse(raw);
    case 'make-join':
    case 'make-leave':
    case 'make-knock':
      return membershipTemplate(raw, record.family, ['11']);
    case 'send-join':
      return sendJoinResponse(raw);
    case 'send-join-v1':
      return sendJoinResponse(raw, true);
    case 'invite':
      return inviteResponse(raw);
    case 'send-leave':
      return leaveResponse(raw);
    case 'send-leave-v1':
      return leaveResponse(raw, true);
    case 'send-knock':
      return knockResponse(raw);
    case 'send':
      return sendVerdicts(raw);
    case 'profile':
      return profileResponse(raw);
    case 'directory':
      return directoryResponse(raw);
    case 'hierarchy': {
      const room = decodeURIComponent(record.path.split('/').pop()!);
      return hierarchyResponse(raw, room);
    }
    case 'devices': {
      const user = decodeURIComponent(record.path.split('/').pop()!);
      return remoteDeviceSnapshot(raw, user, config().e2ee);
    }
    case 'key-query':
      return queryKeys(raw);
    case 'key-claim':
      return claimKeys(raw);
    default:
      throw new Error('missing stock fixture consumer: ' + record.family);
  }
}

Deno.test('stock federation: exact bodies retain custody and every JSON success crosses its response owner', async (t) => {
  for (const [index, record] of fixture.records.entries()) {
    await t.step(
      `${index} ${record.producer} ${record.family} ${record.status}`,
      async () => {
        const body = bytes(record);
        assertEquals(body.length, record.body_bytes);
        assertEquals(await sha256(body), record.body_sha256);
        if (record.status !== 200) return;
        if (record.family.startsWith('media-')) return;
        consume(record);
      },
    );
  }
  for (const producer of ['synapse.test', 'tuwunel.test']) {
    const successes = new Set(
      fixture.records.filter((r) => r.producer === producer && r.status === 200)
        .map((r) => r.family),
    );
    for (
      const family of [
        'server-keys',
        'event',
        'state',
        'state-ids',
        'event-auth',
        'backfill',
        'missing-events',
        'timestamp',
        'make-join',
        'send-join',
        'invite',
        'make-leave',
        'send-leave',
        'make-knock',
        'send-knock',
        'send',
        'profile',
        'directory',
        'hierarchy',
        'devices',
        'key-query',
        'key-claim',
        'media-download',
        'media-thumbnail',
      ]
    ) assert(successes.has(family), `${producer}: missing ${family} success`);
  }
  const notary = fixture.records.find((r) =>
    r.producer === 'synapse.test' && r.family === 'notary' &&
    r.status === 200 &&
    objectOf(decode(r), 'notary').server_keys instanceof Array &&
    (objectOf(decode(r), 'notary').server_keys as unknown[]).length > 0
  );
  assert(notary, 'a real nonempty Synapse notary response is required');
  const unknown = fixture.records.find((r) =>
    r.producer === 'tuwunel.test' && r.family === 'notary'
  )!;
  assertEquals(unknown.status, 404);
  assertEquals(
    objectOf(decode(unknown), 'matrix-error').errcode,
    'M_UNRECOGNIZED',
  );
});

Deno.test('stock federation: download and thumbnail MIME bodies publish exact independently decoded bytes', async (t) => {
  for (
    const record of fixture.records.filter((r) => r.family.startsWith('media-'))
  ) {
    await t.step(record.producer + ' ' + record.family, async () => {
      const chunks: Uint8Array[] = [];
      let closed = false;
      const parser = mediaMultipart(
        new Headers(record.headers).get('content-type')!,
        new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk.slice());
          },
          close() {
            closed = true;
          },
        }),
        1024 * 1024,
      );
      const writer = parser.stream.getWriter(), body = bytes(record);
      for (let i = 0; i < body.length; i += 7) {
        await writer.write(body.subarray(i, i + 7));
      }
      await writer.close();
      assert(closed);
      const payload = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.length;
      }
      assertEquals(payload.length, record.expected_media_bytes);
      assertEquals(await sha256(payload), record.expected_media_sha256);
      if (record.expected_png_dimensions) {
        const view = new DataView(payload.buffer);
        assertEquals(
          [view.getUint32(16), view.getUint32(20)],
          record.expected_png_dimensions,
        );
      }
    });
  }
});
