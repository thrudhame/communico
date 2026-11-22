import { DiagnosticCommand } from '#tests/helpers/child-diagnostics.ts';
import { assertEquals } from '@std/assert';

Deno.test('pending journal receive retains its shared fence when no admission predicate is retained', async () => {
  // The subprocess exposes V8's collector only for this ownership regression.
  // A separate weak control proves collection actually ran across a task turn.
  const journal =
    new URL('../api/engine/facade/journal.ts', import.meta.url).href;
  const protocol =
    new URL('../api/engine/facade/protocol.ts', import.meta.url).href;
  const script = `
    import { Journal, receivedFence } from ${JSON.stringify(journal)};
    import { recordHash } from ${JSON.stringify(protocol)};
    import { assertEquals } from '@std/assert';
    const stream = { source: 'home', incarnation: 'home-1', stream: 'control' };
    const body = { ...stream, sequence: 1, type: 'control', version: 1,
      operationId: 'pending-gc', previous: '', payload: {} };
    const pending = Promise.withResolvers();
    const db = { path: 'pending-journal-gc', tx: () => pending.promise };
    const receive = new Journal(db, [{ type: 'control', version: 1 }])
      .receive('home', [{ ...body, hash: recordHash(body) }]);
    const handled = receive.catch(error => error.message);
    const control = new WeakRef({ collect: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    gc();
    assertEquals(control.deref(), undefined, 'the control must be collected');
    const check = receivedFence(db);
    const during = check('home', stream);
    pending.reject(new Error('expected rollback'));
    assertEquals(await handled, 'expected rollback');
    assertEquals(during, false, 'a pending owner must not lose its fence');
    assertEquals(check('home', stream), false, 'rollback invalidates the pending cut');
    assertEquals(receivedFence(db)('home', stream), true);
  `;
  const result = await new DiagnosticCommand(Deno.execPath(), {
    args: ['eval', '--v8-flags=--expose-gc', script],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
});
