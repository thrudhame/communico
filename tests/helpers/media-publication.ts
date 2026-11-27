import { assertEquals } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };

// Overlay just the module that owns publication. No fault hooks in the
// product, no change to the checked-out tree, and no simulated filesystem.
export async function mediaPublicationOverlay(dir: string) {
  const root = new URL('../../', import.meta.url);
  const original = new URL('api/engine/media.ts', root);
  let source = await Deno.readTextFile(original);
  for (
    const [name, anchor] of [
      ['file-sync', 'await file.sync();'],
      ['before-install', 'file = null;'],
      ['install', 'installed = true;\n      await Deno.remove(partPath);'],
      [
        'metadata-insert',
        "await tx.media.insert(localpart, mediaId, 'uploaded', uploaded);",
      ],
      ['metadata-update', 'await tx.media.markUploaded(mediaId, uploaded);'],
      ['intent', 'await tx.media.recordExport(mediaId, issuer, digest);'],
    ]
  ) {
    assertEquals(source.split(anchor).length, 2, name);
    const code = `await cut('${name}');`;
    source = source.replace(
      anchor,
      name === 'install'
        ? anchor.replace('\n', `\n${code}\n`)
        : `${anchor}\n${code}`,
    );
  }
  const beforeResponse = 'return { mediaId, sizeBytes };';
  assertEquals(source.split(beforeResponse).length, 2);
  source = source.replace(
    beforeResponse,
    `await cut('before-response');\n${beforeResponse}`,
  );
  const overlay = `${dir}/media-overlay.ts`;
  await Deno.writeTextFile(
    overlay,
    `import { beforeFacadePublication as cut } from '#tests/helpers/facade-process.ts';\n${source}`,
  );
  const imports = Object.fromEntries(
    Object.entries(metadata.imports).map(([key, value]) => [
      key,
      value.startsWith('.') ? new URL(value, root).href : value,
    ]),
  );
  // Standalone import maps do not implicitly resolve JSR package subpaths.
  for (
    const [pkg, subpaths] of [
      ['@pathfinder/pathfinder', ['body', 'middleware', 'response']],
      ['@stdext/crypto', ['hash/argon2']],
    ] as const
  ) {
    for (const subpath of subpaths) {
      imports[`${pkg}/${subpath}`] = `${imports[pkg]}/${subpath}`;
    }
  }
  imports['#engine/media.ts'] = overlay;
  const importMap = `${dir}/media-imports.json`;
  await Deno.writeTextFile(importMap, JSON.stringify({ imports }));
  return importMap;
}
