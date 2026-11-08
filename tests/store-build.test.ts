// tests/store-build.test.ts — the store refuses a library whose stated build
// differs from the qualified pin and patch set; the product library passes.
import { assertThrows } from '@std/assert';
import {
  type BuildInfo,
  checkBuildInfo,
  EXPECTED_BUILD,
} from '#engine/store/build.ts';
import { openStore } from '#engine/store/index.ts';

function info(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    turso_version: '0.8.3',
    turso_rev: EXPECTED_BUILD.tursoRev,
    patches: [...EXPECTED_BUILD.patches],
    default_features: false,
    features: ['fts'],
    ...overrides,
  };
}

Deno.test('store build: a mismatching rev or patch set is refused', () => {
  checkBuildInfo(info()); // the qualified build passes
  assertThrows(
    () => checkBuildInfo(info({ turso_rev: '0'.repeat(40) })),
    Error,
    'native library build mismatch',
  );
  assertThrows(
    () => checkBuildInfo(info({ patches: [] })),
    Error,
    'patches',
  );
  assertThrows(
    () =>
      checkBuildInfo(
        info({ patches: ['deadbeef'.repeat(8)] }),
      ),
    Error,
    'patches',
  );
});

Deno.test('store build: openStore accepts the built library', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 4,
      idleseconds: 60,
    });
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
