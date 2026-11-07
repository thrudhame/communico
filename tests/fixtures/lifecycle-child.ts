// A real main.ts child with a test-only final-process-exit barrier. It does not
// alter listener/store cleanup; it keeps the old process alive to prove that
// its eventual exit cannot unlink a replacement server's socket.
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
await import('../../main.ts');
