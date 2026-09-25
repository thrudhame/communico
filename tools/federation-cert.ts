// tools/federation-cert.ts — write the federation TLS certificate for the
// operator: a self-signed Ed25519 pair from the tenant (signing) key via
// the openssl CLI — the TLS key IS the identity key (concilium astra).
// Non-destructive: refuses to overwrite existing files. Key written
// mode 0600.
import { config } from '#engine/config.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { exportPrivateKeyPkcs8 } from '#engine/signing-primitives.js';

function pemOf(der: Uint8Array, label: string): string {
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g);
  return `-----BEGIN ${label}-----\n${
    lines !== null ? lines.join('\n') : ''
  }\n-----END ${label}-----\n`;
}

export async function writeFederationCert(): Promise<void> {
  const fed = config().federation;
  const certPath = fed.cert;
  const keyPath = fed.key;
  let existing = null;
  try {
    existing = await Deno.lstat(certPath);
  } catch { /* absent — good */ }
  if (existing !== null) {
    console.error(`refusing to overwrite existing ${certPath}`);
    Deno.exit(1);
  }
  let existingKey = null;
  try {
    existingKey = await Deno.lstat(keyPath);
  } catch { /* absent — good */ }
  if (existingKey !== null) {
    console.error(`refusing to overwrite existing ${keyPath}`);
    Deno.exit(1);
  }
  const tenant = await getTenantKey();
  const pkcs8 = await exportPrivateKeyPkcs8(tenant.privateKey);
  const work = await Deno.makeTempFile();
  await Deno.writeTextFile(work, pemOf(pkcs8, 'PRIVATE KEY'));
  // openssl per the tool's design
  const out = await new Deno.Command('openssl', {
    args: [
      'req',
      '-x509',
      '-key',
      work,
      '-subj',
      `/CN=${tenant.nativeName}`,
      '-days',
      '3650',
      '-out',
      certPath,
    ],
    stderr: 'null',
  }).output();
  if (!out.success) throw new Error('openssl failed to issue the cert');
  // the private key goes to fed.key, mode 0600
  await Deno.copyFile(work, keyPath);
  await Deno.chmod(keyPath, 0o600);
  await Deno.remove(work);
  console.log(
    `wrote ${certPath} + ${keyPath} for CN=${tenant.nativeName} (Ed25519, self-signed, 10 y)`,
  );
}

if (import.meta.main) {
  await writeFederationCert();
}
