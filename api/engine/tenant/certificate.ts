// The identity key stays inside the server. Exclusive creation protects existing
// files, including concurrent operator requests, without an overwrite window.
async function removeOwned(path: string, original: Deno.FileInfo) {
  try {
    const info = await Deno.lstat(path);
    if (info.ino === original.ino && info.dev === original.dev) {
      await Deno.remove(path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function writeCertificate(
  privateKey: CryptoKey,
  nativeName: string,
  certPath: string,
  keyPath: string,
) {
  const der = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', privateKey),
  );
  const base64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    base64.match(/.{1,64}/g)!.join('\n')
  }\n-----END PRIVATE KEY-----\n`;
  const created: { path: string; file: Deno.FsFile; info: Deno.FileInfo }[] =
    [];
  let complete = false;
  try {
    for (const [path, mode] of [[certPath, 0o644], [keyPath, 0o600]] as const) {
      let file;
      try {
        file = await Deno.open(path, { createNew: true, write: true, mode });
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new Error(`refusing to overwrite existing ${path}`);
        }
        throw error;
      }
      created.push({ path, file, info: await file.stat() });
    }
    let keyData = new TextEncoder().encode(pem);
    while (keyData.length) {
      keyData = keyData.subarray(await created[1].file.write(keyData));
    }
    await created[1].file.sync();
    const output = await new Deno.Command('openssl', {
      args: [
        'req',
        '-x509',
        '-key',
        keyPath,
        '-subj',
        `/CN=${nativeName}`,
        '-days',
        '3650',
      ],
      stderr: 'null',
    }).output();
    if (!output.success) throw new Error('openssl failed to issue the cert');
    // Write through the reserved descriptor, never reopen an output pathname.
    let data = output.stdout;
    while (data.length) data = data.subarray(await created[0].file.write(data));
    await created[0].file.sync();
    await created[1].file.sync();
    complete = true;
    return { certPath, keyPath, nativeName };
  } finally {
    for (const entry of created) {
      entry.file.close();
      if (!complete) {
        await removeOwned(entry.path, entry.info);
      }
    }
  }
}
