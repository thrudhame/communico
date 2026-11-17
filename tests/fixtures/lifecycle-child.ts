// Test-only controls, env-gated in a child entrypoint that production never
// imports. No test trigger is reachable from an HTTP/admin route.
import { theApp } from '#engine/app.ts';

const barrier = Deno.env.get('DENO_COMMUNICO_TEST_EXIT_BARRIER');
if (barrier) {
  const exit = Deno.exit;
  Deno.exit = (code) => {
    console.log('test: exit deferred');
    const timer = setInterval(() => {
      try {
        Deno.lstatSync(barrier);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      clearInterval(timer);
      exit(code);
    }, 10);
    return undefined as never;
  };
}
// Keep the runtime's automatic Unix-listener drop from supplying application
// cleanup. Fatal exit must release the name through the socket's own lifetime.
if (Deno.env.get('DENO_COMMUNICO_TEST_HOLD_ADMIN_ABORT') === '1') {
  Deno.serve = new Proxy(Deno.serve, {
    apply(serve, receiver, args) {
      if (args[0]?.transport === 'unix') {
        args[0] = { ...args[0], signal: undefined };
        console.log('test: admin automatic abort held');
      }
      return Reflect.apply(serve, receiver, args);
    },
  });
}
await import('#root/main.ts');

const trigger = Deno.env.get('DENO_COMMUNICO_TEST_FATAL_TRIGGER');
if (trigger) {
  const mode = Deno.env.get('DENO_COMMUNICO_TEST_FATAL_MODE');
  const timer = setInterval(() => {
    try {
      Deno.lstatSync(trigger);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    clearInterval(timer);
    if (mode === 'hang' || mode === 'second') {
      theApp().store.close = () => {
        console.log('test: store close held');
        return new Promise<void>(() => {});
      };
    }
    if (mode === 'second') {
      setTimeout(() => {
        void Promise.reject(new Error('second fatal-test-rejection'));
      }, 50);
    }
    void Promise.reject(new Error('fatal-test-rejection'));
  }, 10);
}
