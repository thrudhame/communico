import { adminRequest, runCli } from '#root/tools/admin-client.ts';

export async function writeFederationCert(): Promise<void> {
  const { certPath, keyPath, nativeName } = await adminRequest<
    { certPath: string; keyPath: string; nativeName: string }
  >('federation-cert/write');
  console.log(
    `wrote ${certPath} + ${keyPath} for CN=${nativeName} (Ed25519, self-signed, 10 y)`,
  );
}

if (import.meta.main) await runCli(writeFederationCert);
