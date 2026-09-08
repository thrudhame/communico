// complement/tls-stub.ts — the M0 :8448 federation stub. Serves TLS with
// the container's Complement-CA-signed (or self-signed) cert and returns
// 404 M_UNRECOGNIZED for every path (federation is M5; the handshake must
// succeed so Complement fails fast on 404s, not on timeouts).
// Env: TLS_CERT_FILE, TLS_KEY_FILE (written by entrypoint.sh).
const certFile = Deno.env.get('TLS_CERT_FILE') ?? '/run/complement/server.crt';
const keyFile = Deno.env.get('TLS_KEY_FILE') ?? '/run/complement/server.key';

const cert = await Deno.readTextFile(certFile);
const key = await Deno.readTextFile(keyFile);

Deno.serve(
  {
    port: 8448,
    cert,
    key,
    onListen: () => console.log('tls-stub: :8448 (TLS, 404 for every path)'),
  },
  () =>
    Response.json({ errcode: 'M_UNRECOGNIZED', error: 'federation is M5' }, {
      status: 404,
    }),
);
