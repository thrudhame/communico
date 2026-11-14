// Optional standard OpenPGP; passphrases cross stdin, never argv or a shell.
// GnuPG 2.4: MDC is always used (force-mdc is obsolete since 2.2.8). Decrypted
// bytes stay private and unusable until both GnuPG and the plaintext digest pass.
import { dirname, join } from '@std/path';
import { type FileHandle, open } from 'node:fs/promises';
import { openRegularFile } from '#engine/store/files.ts';
import type { Config } from '#engine/config.ts';
import {
  describePayload,
  type Payload,
  payloadPath,
  rootDirectory,
} from './manifest.ts';

async function agent(
  home: string,
  operation: '--launch' | '--kill',
): Promise<void> {
  const result = await new Deno.Command('gpgconf', {
    args: ['--homedir', home, operation, 'gpg-agent'],
    stdout: 'null',
    stderr: 'null',
  }).output();
  if (!result.success) {
    throw new Error('OpenPGP private agent ' + operation + ' failed');
  }
}

async function readPassphrase(path: string) {
  const { file, stat } = await openRegularFile(path);
  let bytes: Uint8Array | undefined;
  try {
    if (stat.uid !== Deno.uid() || (stat.mode & 0o077) !== 0) {
      throw new Error(
        'backup passphrase source must be private and owned by this user',
      );
    }
    bytes = await file.readFile();
    return { bytes, file, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    bytes?.fill(0);
    try {
      await file.close();
    } catch (close) {
      throw new AggregateError(
        [error, close],
        'passphrase validation and close failed',
      );
    }
    throw error;
  }
}

export async function openCipher(
  options: Config['backup'],
  workspace: string,
): Promise<PayloadCipher | null> {
  if (!options.encrypt) return null;
  if (options.passphrasefile === '') {
    throw new Error('backup encryption requires a passphrase file');
  }
  const captured = await readPassphrase(options.passphrasefile);
  const passphrase = captured.bytes;
  if (passphrase.length === 0 || passphrase[0] === 10 || passphrase[0] === 13) {
    passphrase.fill(0);
    await captured.file.close();
    throw new Error('backup passphrase first line must not be empty');
  }
  let home: string | undefined;
  let directory: FileHandle | undefined;
  let agentHome: string | undefined;
  try {
    // Check the optional dependency before a backup starts pausing admission.
    const version = await new Deno.Command('gpg', {
      args: ['--no-options', '--version'],
      stdout: 'null',
      stderr: 'null',
    }).output();
    if (!version.success) throw new Error('backup encryption requires GnuPG');
    home = await Deno.makeTempDir({ dir: workspace, prefix: '.gpg-' });
    // Standard Unix sockets cannot contain a long operator/workspace path.
    // Keep the real home private on disk and address it through our live
    // directory descriptor for every GnuPG subprocess, including its agent.
    // The descriptor stays open until that one private agent is reaped.
    directory = await open(home, 'r');
    agentHome = '/proc/' + Deno.pid + '/fd/' + directory.fd;
    // GnuPG requests its private agent even with loopback and caching disabled
    // (e.g. S2K calibration). Launch and reap only the agent for our own home.
    await agent(agentHome, '--launch');
    return new PayloadCipher(
      home,
      agentHome,
      directory,
      passphrase,
      captured.identity,
      captured.file,
    );
  } catch (error) {
    passphrase.fill(0);
    try {
      if (agentHome !== undefined) await agent(agentHome, '--kill');
    } finally {
      try {
        await directory?.close();
      } finally {
        try {
          if (home !== undefined) await Deno.remove(home, { recursive: true });
        } finally {
          await captured.file.close();
        }
      }
    }
    throw error;
  }
}

export class PayloadCipher {
  private closed = false;
  constructor(
    private home: string,
    private agentHome: string,
    private directory: FileHandle,
    private passphrase: Uint8Array,
    private source: { dev: number; ino: number },
    private passphraseFile: FileHandle,
  ) {}

  isPassphraseSource(file: Pick<Deno.FileInfo, 'dev' | 'ino'>): boolean {
    // The source descriptor remains owned until close(), so a pathname change
    // cannot turn this exclusion into a check of another file or reused inode.
    return file.dev === this.source.dev && file.ino === this.source.ino;
  }

  private async run(
    source: string,
    destination: string,
    decrypt: boolean,
  ): Promise<void> {
    if (this.closed) throw new Error('backup cipher is closed');
    const file = await Deno.open(destination, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    let complete = false;
    try {
      const child = new Deno.Command('gpg', {
        args: [
          '--no-options',
          '--homedir',
          this.agentHome,
          '--batch',
          '--no-tty',
          '--no-autostart',
          '--pinentry-mode',
          'loopback',
          '--passphrase-fd',
          '0',
          '--status-fd',
          '2',
          '--output',
          '-',
          '--no-symkey-cache',
          '--no-auto-key-retrieve',
          '--no-auto-key-import',
          ...(decrypt ? ['--decrypt'] : [
            '--cipher-algo',
            'AES256',
            '--compress-algo',
            'none',
            '--symmetric',
          ]),
          '--',
          source,
        ],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const send = (async () => {
        const input = child.stdin.getWriter();
        try {
          await input.write(this.passphrase);
          await input.close();
        } finally {
          input.releaseLock();
        }
      })();
      const copy = child.stdout.pipeTo(
        new WritableStream<Uint8Array>({
          async write(bytes) {
            let offset = 0;
            while (offset < bytes.length) {
              const count = await file.write(bytes.subarray(offset));
              if (count <= 0) throw new Error('short OpenPGP output write');
              offset += count;
            }
          },
        }),
      );
      // Drain every pipe and reap the one child even after an I/O failure. Raw
      // GnuPG diagnostics (which can contain paths) are never returned to clients.
      const results = await Promise.allSettled([
        send,
        copy,
        new Response(child.stderr).arrayBuffer(),
        child.status,
      ]);
      const status = results[3];
      if (
        results.some((result) => result.status === 'rejected') ||
        status.status !== 'fulfilled' || !status.value.success
      ) {
        throw new Error(
          'OpenPGP ' + (decrypt ? 'decryption/integrity' : 'encryption') +
            ' failed',
        );
      }
      const diagnostics = results[2];
      if (diagnostics.status !== 'fulfilled') {
        throw new Error('OpenPGP status missing');
      }
      const lines = new TextDecoder().decode(diagnostics.value).split('\n');
      const info = lines.map((line) =>
        line.match(
          decrypt
            ? /^\[GNUPG:\] DECRYPTION_INFO (\d+) (\d+)(?: (\d+))?$/
            : /^\[GNUPG:\] BEGIN_ENCRYPTION (\d+) (\d+)(?: (\d+))?$/,
        )
      ).find((match) => match !== null);
      if (
        !info || info[2] !== '9' ||
        (info[1] === '0' && (info[3] === undefined || info[3] === '0')) ||
        !lines.includes(
          '[GNUPG:] ' + (decrypt ? 'DECRYPTION_OKAY' : 'END_ENCRYPTION'),
        )
      ) {
        throw new Error('OpenPGP AES256 integrity-protected payload required');
      }
      await file.sync();
      complete = true;
    } finally {
      file.close();
      if (!complete) await Deno.remove(destination);
    }
  }

  async encrypt(root: string, payload: Payload): Promise<Payload> {
    payloadPath(payload.path);
    const actual = await describePayload(root, payload.path);
    if (actual.size !== payload.size || actual.sha256 !== payload.sha256) {
      throw new Error('backup plaintext changed before encryption');
    }
    const path = payload.path + '.gpg';
    await this.run(join(root, payload.path), join(root, path), false);
    const stored = await describePayload(root, path);
    return {
      ...payload,
      stored: { path, size: stored.size, sha256: stored.sha256 },
    };
  }

  async decrypt(
    root: string,
    payload: Payload,
    candidate: string,
  ): Promise<void> {
    payloadPath(payload.path);
    if (payload.stored.path !== payload.path + '.gpg') {
      throw new Error('OpenPGP payload path mismatch');
    }
    const encrypted = await describePayload(root, payload.stored.path);
    if (
      encrypted.size !== payload.stored.size ||
      encrypted.sha256 !== payload.stored.sha256
    ) throw new Error('backup ciphertext digest mismatch');
    const destination = join(candidate, payload.path);
    await rootDirectory(dirname(destination));
    await this.run(join(root, payload.stored.path), destination, true);
    let verified = false;
    try {
      const plaintext = await describePayload(candidate, payload.path);
      if (
        plaintext.size !== payload.size || plaintext.sha256 !== payload.sha256
      ) throw new Error('backup plaintext digest mismatch');
      verified = true;
    } finally {
      if (!verified) await Deno.remove(destination);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.passphrase.fill(0);
    try {
      await agent(this.agentHome, '--kill');
    } finally {
      try {
        await this.directory.close();
      } finally {
        try {
          await this.passphraseFile.close();
        } finally {
          await Deno.remove(this.home, { recursive: true });
        }
      }
    }
  }
}
