// Private child observations, not an application API. Records stay in the pipe
// and in memory; diagnostics must never print their credential-bearing payloads.
import { assert, assertEquals } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };
import {
  type Cut,
  LinkError,
  type LinkRecord,
  type Stream,
} from '#engine/facade/protocol.ts';
import type { Journal } from '#engine/facade/journal.ts';
import { bounded, pause } from './server-process.ts';
import { childDiagnostics } from './child-diagnostics.ts';

export const observationPrefix = 'facade-test: ';
export type ObservationScope = Stream & { peer: string; after?: number };
export type FacadeObservation =
  | { kind: 'applied'; peer: string; record: LinkRecord }
  | { kind: 'pairing'; id: string; state: 'paired' | 'revoked' }
  | { kind: 'listener'; port: number }
  | { kind: 'fence'; id: string }
  | { kind: 'egress'; destination: string; txnId: string; body: string }
  | {
    kind: 'health';
    pairing: string;
    online: boolean;
    stream?: string;
    sequence?: number;
    hash?: string;
  }
  | { kind: 'publication'; name: string; state: 'armed' | 'held' | 'released' }
  | {
    kind: 'failure' | 'blocked';
    operation: string;
    error: string;
    scope?: ObservationScope;
  };

export type PublicationCommand =
  | { action: 'hold' | 'release'; name: string }
  | { action: 'fence'; id: string };

export function facadeFailure(
  operation: string,
  error: unknown,
  scope?: ObservationScope,
): FacadeObservation {
  return {
    kind: error instanceof LinkError && error.code === 'LINK_UNAVAILABLE'
      ? 'blocked'
      : 'failure',
    operation,
    error: error instanceof LinkError
      ? error.code
      : error instanceof Error
      ? error.name
      : 'unknown error',
    ...(scope ? { scope } : {}),
  };
}

type FailureReporter = (
  operation: string,
  error: unknown,
  scope?: ObservationScope,
) => void;

export function applicationScope(
  peer: string,
  stream: Stream,
  after?: number,
): ObservationScope {
  return {
    peer,
    source: stream.source,
    incarnation: stream.incarnation,
    stream: stream.stream,
    after,
  };
}
const publications = new Map<
  string,
  ReturnType<typeof Promise.withResolvers<void>>
>();
let publicationEvent: ((event: FacadeObservation) => void) | undefined;

/** Used only by private mutation-proof source overlays, outside transactions.
 * Normal product modules never import this helper. */
export async function beforeFacadePublication(name: string) {
  const held = publications.get(name);
  if (!held) return;
  publicationEvent!({ kind: 'publication', name, state: 'held' });
  await held.promise;
}

export function publicationCommand(
  command: PublicationCommand,
  emit: (event: FacadeObservation) => void,
) {
  publicationEvent = emit;
  if (command.action === 'fence') {
    emit({ kind: 'fence', id: command.id });
    return;
  }
  if (command.action === 'hold') {
    if (publications.has(command.name)) {
      throw new Error('publication already held');
    }
    publications.set(command.name, Promise.withResolvers<void>());
    emit({ kind: 'publication', name: command.name, state: 'armed' });
  } else {
    const held = publications.get(command.name);
    if (!held) throw new Error('publication was not held');
    publications.delete(command.name);
    held.resolve();
    emit({ kind: 'publication', name: command.name, state: 'released' });
  }
}

/** Retained completions close the arm/capture race without a timer or a retrying
 * predicate. A caller must match its exact record/fact, then assert the consumer. */
export function observeJournalApplication(
  apply: Journal['apply'],
  completed: (peer: string, record: LinkRecord) => void,
  failure: FailureReporter,
): Journal['apply'] {
  return async function (this: Journal, ...args) {
    const [peer, stream, handler] = args;
    let committed: LinkRecord | undefined;
    let after: number | undefined;
    try {
      after = (await this.heads(peer, 'in', stream)).applied.sequence;
      args[2] = async (conn, record) => {
        committed = undefined;
        const result = await handler(conn, record);
        committed = record;
        return result;
      };
      const result = await apply.apply(this, args);
      if (result && committed) completed(peer, committed);
      return result;
    } catch (error) {
      failure(
        'journal apply ' + stream.stream,
        error,
        applicationScope(peer, stream, after),
      );
      throw error;
    }
  };
}

export function observeJournalCompletion(
  complete: Journal['complete'],
  completed: (peer: string, record: LinkRecord) => void,
  failure: FailureReporter,
): Journal['complete'] {
  return async function (this: Journal, peer, stream, cut, result) {
    let after: number | undefined;
    try {
      after = (await this.heads(peer, 'in', stream)).applied.sequence;
      const heads = await complete.call(this, peer, stream, cut, result);
      const page = await this.page(peer, 'in', stream, cut.sequence - 1, {
        maxItems: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
      const record = page.records[0];
      if (!record || record.hash !== cut.hash) {
        throw new Error('completed record disappeared');
      }
      completed(peer, record);
      return heads;
    } catch (error) {
      failure(
        'journal complete ' + stream.stream,
        error,
        applicationScope(peer, stream, after),
      );
      throw error;
    }
  };
}

export class FacadeHealthConnections<Owner> extends Map<AbortSignal, {
  owner: Owner;
  pairing: string;
  heads: Map<string, Cut>;
}> {
  connected(
    owner: Owner,
    pairing: string,
    signal: AbortSignal,
    offline: () => void,
  ) {
    if (signal.aborted || this.has(signal)) return;
    this.set(signal, { owner, pairing, heads: new Map() });
    signal.addEventListener('abort', () => {
      this.delete(signal);
      if (
        ![...this].some(([signal, connection]) =>
          !signal.aborted && connection.owner === owner &&
          connection.pairing === pairing
        )
      ) offline();
    }, { once: true });
  }
}

export class FacadeObservations {
  private readonly history: FacadeObservation[] = [];
  private readonly waiting = new Set<{
    matches(event: FacadeObservation): boolean;
    failureMatches(scope: ObservationScope): boolean;
    resolve(event: FacadeObservation): void;
    reject(error: Error): void;
  }>();
  private failure: Error | undefined;

  private recovered(scope: ObservationScope): boolean {
    const after = scope.after;
    return after !== undefined &&
      this.history.some((event) =>
        event.kind === 'applied' && event.peer === scope.peer &&
        event.record.source === scope.source &&
        event.record.incarnation === scope.incarnation &&
        event.record.stream === scope.stream && event.record.sequence > after
      );
  }

  accept(event: FacadeObservation) {
    if (event.kind === 'failure') {
      const error = new Error(`${event.operation}: ${event.error}`);
      if (!event.scope) this.close(error);
      else {
        this.history.push(event);
        if (this.recovered(event.scope)) return;
        for (const pending of this.waiting) {
          if (pending.failureMatches(event.scope)) {
            this.waiting.delete(pending);
            pending.reject(error);
          }
        }
      }
      return;
    }
    this.history.push(event);
    for (const pending of this.waiting) {
      if (pending.matches(event)) {
        this.waiting.delete(pending);
        pending.resolve(event);
      }
    }
  }

  close(error: Error) {
    this.failure ??= error;
    for (const pending of this.waiting) pending.reject(this.failure);
    this.waiting.clear();
  }

  mark() {
    return this.history.length;
  }

  wait(
    matches: (event: FacadeObservation) => boolean,
    after = 0,
    failureMatches: (scope: ObservationScope) => boolean = () => false,
  ) {
    if (this.failure) return Promise.reject(this.failure);
    const history = this.history.slice(after);
    const held = history.find(matches);
    if (held) return Promise.resolve(held);
    // A later durable completion supersedes an earlier rejected attempt. If
    // this caller's fact is still missing, retain and surface its own refusal.
    const refusal = history.find((event) =>
      event.kind === 'failure' && event.scope && failureMatches(event.scope) &&
      !this.recovered(event.scope)
    );
    if (refusal && (refusal.kind === 'failure')) {
      return Promise.reject(
        new Error(`${refusal.operation}: ${refusal.error}`),
      );
    }
    return new Promise<FacadeObservation>((resolve, reject) => {
      this.waiting.add({ matches, failureMatches, resolve, reject });
    });
  }

  async applied(
    stream: string,
    matches: (record: LinkRecord) => boolean = () => true,
    after = 0,
  ): Promise<LinkRecord> {
    const event = await this.wait(
      (event) =>
        event.kind === 'applied' && event.record.stream === stream &&
        matches(event.record),
      after,
      (scope) => scope.stream === stream,
    );
    assert(event.kind === 'applied');
    return event.record;
  }

  async fact(
    identity: Stream & { peer: string },
    matches: (record: LinkRecord) => boolean,
    after = 0,
  ): Promise<LinkRecord> {
    const event = await this.wait(
      (event) =>
        event.kind === 'applied' && event.peer === identity.peer &&
        event.record.source === identity.source &&
        event.record.incarnation === identity.incarnation &&
        event.record.stream === identity.stream && matches(event.record),
      after,
      (scope) =>
        scope.peer === identity.peer && scope.source === identity.source &&
        scope.incarnation === identity.incarnation &&
        scope.stream === identity.stream,
    );
    assert(event.kind === 'applied');
    return event.record;
  }

  async tail(peer: string, streams: readonly (Stream & { received: Cut })[]) {
    await Promise.all(streams.map(async (stream) => {
      assert(
        stream.received.sequence > 0,
        'finite tail has no received record',
      );
      await this.fact(
        { peer, ...stream },
        (record) =>
          record.sequence === stream.received.sequence &&
          record.hash === stream.received.hash,
      );
    }));
  }
}

export async function facadeProcess(
  config: string,
  ready: string,
  heldPublications: string[] = [],
) {
  const observations = new FacadeObservations();
  const initialHolds = new Set(heldPublications);
  const diagnostics = await childDiagnostics();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      ...metadata.tasks.start.split(' ').slice(1, -1),
      'tests/fixtures/facade-child.ts',
    ],
    env: {
      COMMUNICO_CONFIG: config,
      DENO_NO_PROMPT: '1',
      FACADE_TEST_HOLDS: JSON.stringify(heldPublications),
    },
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const commands = child.stdin.getWriter();
  const send = (command: PublicationCommand) =>
    commands.write(new TextEncoder().encode(JSON.stringify(command) + '\n'));
  let out = '', err = '', ended = false;
  const read = async (
    body: ReadableStream<Uint8Array>,
    save: (text: string) => void,
    structured = false,
  ) => {
    let tail = '';
    for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
      tail += chunk;
      for (;;) {
        const newline = tail.indexOf('\n');
        if (newline < 0) break;
        const line = tail.slice(0, newline);
        tail = tail.slice(newline + 1);
        if (structured && line.startsWith(observationPrefix)) {
          observations.accept(JSON.parse(line.slice(observationPrefix.length)));
        } else save(line + '\n');
      }
    }
    // An interrupted private record is no more public than a complete one.
    if (tail && !(structured && tail.startsWith(observationPrefix))) save(tail);
  };
  const output = Promise.all([
    child.status,
    read(child.stdout, (text) => {
      out += text;
      diagnostics.stdout(text);
    }, true),
    read(child.stderr, (text) => {
      err += text;
      diagnostics.stderr(text);
    }),
  ]).then(([status]) => {
    ended = true;
    observations.close(
      new Error(`facade child exited (${status.code})\n${out}\n${err}`),
    );
    return status;
  }, (error) => {
    observations.close(
      error instanceof Error ? error : new Error('child output failed'),
    );
    throw error;
  });
  let commandsClosed = false;
  const closeCommands = async () => {
    if (commandsClosed) return;
    commandsClosed = true;
    try {
      await commands.close();
    } catch (error) {
      if (
        !(error instanceof Deno.errors.BrokenPipe) &&
        !(error instanceof Deno.errors.BadResource)
      ) throw error;
    }
  };
  const dispose = async () => {
    await closeCommands();
    if (!ended) {
      child.kill('SIGKILL');
      await bounded(output);
    }
  };
  try {
    // Listener startup retains the existing local-process startup check.
    const deadline = Date.now() + 20000;
    while (!out.includes(ready)) {
      assert(!ended, out + '\n' + err);
      assert(Date.now() < deadline, 'runtime observation deadline');
      await pause(10);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    diagnostics,
    observations,
    listening: (port: number) =>
      observations.wait((event) =>
        event.kind === 'listener' && event.port === port
      ),
    async fence() {
      const id = crypto.randomUUID();
      const mark = observations.mark();
      await send({ action: 'fence', id });
      await observations.wait(
        (event) => event.kind === 'fence' && event.id === id,
        mark,
      );
    },
    async holdPublication(name: string) {
      const initial = initialHolds.delete(name);
      const mark = initial ? 0 : observations.mark();
      if (!initial) await send({ action: 'hold', name });
      await observations.wait(
        (event) =>
          event.kind === 'publication' && event.name === name &&
          event.state === 'armed',
        mark,
      );
      return {
        held: () =>
          observations.wait(
            (event) =>
              event.kind === 'publication' && event.name === name &&
              event.state === 'held',
            mark,
          ),
        async release() {
          await send({ action: 'release', name });
          await observations.wait(
            (event) =>
              event.kind === 'publication' && event.name === name &&
              event.state === 'released',
            mark,
          );
        },
      };
    },
    async stop() {
      await closeCommands();
      if (!ended) child.kill('SIGTERM');
      const status = await bounded(output);
      assertEquals(status.code, 0, out + '\n' + err);
      assert(out.includes('shutdown: store closed'));
    },
    dispose,
  };
}
