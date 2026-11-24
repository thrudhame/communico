// Test-only entrypoint: production never imports it. Observe existing owner
// completions after their transactions, without changing product scheduling.
import { Journal } from '#engine/facade/journal.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { AuthLinkHealth } from '#engine/facade/auth.ts';
import { FacadeKeys } from '#engine/facade/control.ts';
import { DirectoryReplicas } from '#engine/facade/directory.ts';
import { HomeEgress } from '#engine/facade/home-egress.ts';
import { RoomReplicas } from '#engine/facade/replication.ts';
import { InboxWorker } from '#engine/facade/worker.ts';
import { ActivityExchange } from '#engine/facade/activity.ts';
import { noticeHeads } from '#engine/facade/notices.ts';
import { observeFixtureListeners } from '#tests/helpers/fixture-listeners.ts';
import {
  type Cut,
  type LinkRecord,
  object,
  text,
} from '#engine/facade/protocol.ts';
import {
  applicationScope,
  beforeFacadePublication,
  facadeFailure,
  FacadeHealthConnections,
  type FacadeObservation,
  observationPrefix,
  type ObservationScope,
  observeActivityApplication,
  observeActivityCapture,
  observeJournalApplication,
  observeJournalCompletion,
  publicationCommand,
} from '#tests/helpers/facade-process.ts';

const encoder = new TextEncoder();
observeFixtureListeners();
function emit(event: FacadeObservation) {
  const bytes = encoder.encode(
    observationPrefix + JSON.stringify(event) + '\n',
  );
  let written = 0;
  while (written < bytes.length) {
    written += Deno.stdout.writeSync(bytes.subarray(written));
  }
}
function failure(
  operation: string,
  error: unknown,
  scope?: ObservationScope,
) {
  emit(facadeFailure(operation, error, scope));
}

// Domain validation can refuse before entering Journal.apply/complete. Observe
// the inbox owner's complete failure boundary, not only its transaction subset.
const inboxFailed = InboxWorker.prototype.failed;
InboxWorker.prototype.failed = function (error, stream, after) {
  // Independent streams may legitimately await their control/history facts.
  // Retain that typed retry observation without declaring a terminal refusal.
  failure(
    'inbox ' + (stream?.stream ?? 'scan'),
    error,
    stream ? applicationScope(this.peer, stream, after) : undefined,
  );
  inboxFailed.call(this, error, stream, after);
};

for (const name of JSON.parse(Deno.env.get('FACADE_TEST_HOLDS') ?? '[]')) {
  publicationCommand({ action: 'hold', name }, emit);
}

// Bind completion, not a predicate retry against an incompletely started public
// listener. The normal local-process startup check remains in the parent.
Deno.serve = new Proxy(Deno.serve, {
  apply(target, receiver, args) {
    const server = Reflect.apply(target, receiver, args);
    if ('port' in server.addr) {
      emit({ kind: 'listener', port: server.addr.port });
    }
    return server;
  },
});

// The proof controller is a private pipe. It does not add HTTP routes, settings
// or filesystem triggers to either runtime role.
void (async () => {
  let tail = '';
  for await (
    const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
  ) {
    tail += chunk;
    for (;;) {
      const newline = tail.indexOf('\n');
      if (newline < 0) break;
      const line = tail.slice(0, newline);
      tail = tail.slice(newline + 1);
      publicationCommand(JSON.parse(line), emit);
    }
  }
})().catch((error) => failure('publication control', error));

const emitted = new Set<string>();
const applied = new Map<string, { pairing: string; cut: Cut }>();
// Observe completed reconciliation independently of the product's readiness
// predicate. If a mutation omits its effect, the original strict-auth consumer
// must fail, rather than our observer hiding that failure by waiting for ready().
const connections = new FacadeHealthConnections<AuthLinkHealth>();
const declarations = new Map<AuthLinkHealth, Map<string, Map<string, Cut>>>();
function healthChanged() {
  for (const [signal, connection] of connections) {
    if (signal.aborted) continue;
    for (const [stream, { pairing, cut }] of applied) {
      const head = connection.heads.get(stream);
      const declared = declarations.get(connection.owner)?.get(pairing)?.get(
        stream,
      );
      if (
        connection.pairing === pairing && declared?.sequence === cut.sequence &&
        declared.hash === cut.hash && head?.sequence === declared.sequence &&
        head.hash === declared.hash
      ) {
        emit({ kind: 'health', pairing, stream, online: true, ...cut });
      }
    }
  }
}
function completed(peer: string, record: LinkRecord) {
  const key = JSON.stringify([
    peer,
    record.source,
    record.incarnation,
    record.hash,
  ]);
  if (emitted.has(key)) return;
  emitted.add(key);
  emit({ kind: 'applied', peer, record });
  if (peer === 'home' && record.stream.startsWith('auth:')) {
    applied.set(record.stream, {
      pairing: record.incarnation,
      cut: { sequence: record.sequence, hash: record.hash },
    });
    healthChanged();
  }
}

// Preserve the finite prefix argument and observe only the last installed fact,
// never the superseded prefix receipts or an uncommitted transaction attempt.
ActivityExchange.prototype.apply = observeActivityApplication(
  ActivityExchange.prototype.apply,
  (pairing, snapshot, appliedMs) =>
    emit({ kind: 'activity', pairing, snapshot, appliedMs }),
);
ActivityExchange.prototype.capture = observeActivityCapture(
  ActivityExchange.prototype.capture,
  emit,
);

Journal.prototype.apply = observeJournalApplication(
  Journal.prototype.apply,
  completed,
  failure,
);
// Keep the durable receipt visible without entering the application's write
// transaction or changing how the replica evaluates readiness.
const directoryApply = DirectoryReplicas.prototype.apply;
DirectoryReplicas.prototype.apply = async function (...args) {
  await beforeFacadePublication('apply:' + args[1].stream);
  return await directoryApply.apply(this, args);
};
const roomApply = RoomReplicas.prototype.apply;
RoomReplicas.prototype.apply = async function (...args) {
  await beforeFacadePublication('apply:' + args[1].stream);
  return await roomApply.apply(this, args);
};

// Hold publication of already committed bytes outside every transaction. The
// private proof controller arms this before its source mutation. No product
// module imports a gate and no public endpoint is added.
const page = Journal.prototype.page;
Journal.prototype.page = async function (...args) {
  const result = await page.apply(this, args);
  if (args[1] === 'out' && result.records.length) {
    await beforeFacadePublication('stream:' + args[2].stream);
  }
  return result;
};
const cosign = FacadeKeys.prototype.cosign;
FacadeKeys.prototype.cosign = async function (...args) {
  const signature = await cosign.apply(this, args);
  await beforeFacadePublication('key-roster');
  return signature;
};
const dispatch = HomeEgress.prototype.dispatch;
HomeEgress.prototype.dispatch = async function (...args) {
  const result = await dispatch.apply(this, args);
  emit({ kind: 'egress', ...args[0] });
  return result;
};
Journal.prototype.complete = observeJournalCompletion(
  Journal.prototype.complete,
  completed,
  failure,
);
// A cold restart can already hold the required completion. Observe its durable
// record through the real journal owner, never open a competing store instance.
const streams = Journal.prototype.streams;
Journal.prototype.streams = async function (peer, direction) {
  const heads = await streams.call(this, peer, direction);
  if (direction === 'in') {
    for (const stream of heads) {
      if (!stream.applied.sequence) continue;
      const page = await this.page(
        peer,
        'in',
        stream,
        stream.applied.sequence - 1,
        {
          maxItems: 1,
          maxBytes: Number.MAX_SAFE_INTEGER,
        },
      );
      const record = page.records[0];
      if (record?.hash === stream.applied.hash) completed(peer, record);
    }
  }
  return heads;
};

const pairingComplete = Pairings.prototype.complete;
Pairings.prototype.complete = async function (...args) {
  try {
    await beforeFacadePublication('enrollment');
    const result = await pairingComplete.apply(this, args);
    emit({ kind: 'pairing', id: args[0], state: 'paired' });
    return result;
  } catch (error) {
    failure('pairing complete', error);
    throw error;
  }
};
const retire = Pairings.prototype.retire;
Pairings.prototype.retire = async function (...args) {
  try {
    await beforeFacadePublication('revocation');
    await retire.apply(this, args);
    emit({
      kind: 'pairing',
      id: text(object(object(args[0]).body).pairing),
      state: 'revoked',
    });
  } catch (error) {
    failure('pairing retire', error);
    throw error;
  }
};

const connected = AuthLinkHealth.prototype.connected;
AuthLinkHealth.prototype.connected = function (pairing, signal) {
  connected.call(this, pairing, signal);
  connections.connected(this, pairing, signal, () => {
    emit({ kind: 'health', pairing, online: false });
  });
  healthChanged();
};
const reconciliation = AuthLinkHealth.prototype.reconciliation;
AuthLinkHealth.prototype.reconciliation = function () {
  const observe = reconciliation.call(this);
  const captured = [...connections].filter(([, connection]) =>
    connection.owner === this
  );
  return (...args) => {
    observe(...args);
    const [pairing, raw] = args;
    let pairings = declarations.get(this);
    if (!pairings) declarations.set(this, pairings = new Map());
    let declared = pairings.get(pairing);
    if (!declared) pairings.set(pairing, declared = new Map());
    const heads = noticeHeads(raw);
    for (const entry of heads) {
      const prior = declared.get(entry.stream);
      if (!prior || entry.head.sequence >= prior.sequence) {
        declared.set(entry.stream, entry.head);
      }
    }
    for (const [signal, connection] of captured) {
      if (
        signal.aborted || connection.pairing !== pairing ||
        connections.get(signal) !== connection
      ) continue;
      for (const entry of heads) {
        const prior = connection.heads.get(entry.stream);
        if (!prior || entry.head.sequence >= prior.sequence) {
          connection.heads.set(entry.stream, entry.head);
        }
      }
    }
    healthChanged();
  };
};

await import('#root/main.ts');
