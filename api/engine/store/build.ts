// api/engine/store/build.ts — the library the store was qualified against:
// the Turso pin, the carried patch set, and how the crate was featured.
// openStore refuses anything else; the .so states these itself (ffi_build_info).
export type BuildInfo = {
  turso_version: string;
  turso_rev: string;
  patches: string[];
  default_features: boolean;
  features: string[];
};

export const EXPECTED_BUILD = {
  tursoRev: '607bff9fd0e547a25a97b3bf06e83bcc5d99d53c',
  patches: [
    'b43a81770cea76ced953309175aef06027d65cde27b2e09aeff48d352fb2012d',
  ],
} as const;

export function checkBuildInfo(info: BuildInfo): void {
  const problems: string[] = [];
  if (info.turso_rev !== EXPECTED_BUILD.tursoRev) {
    problems.push(
      `turso rev ${info.turso_rev}, expected ${EXPECTED_BUILD.tursoRev}`,
    );
  }
  const patches = [...info.patches].sort();
  const expected = [...EXPECTED_BUILD.patches].sort();
  if (
    patches.length !== expected.length ||
    patches.some((patch, index) => patch !== expected[index])
  ) {
    problems.push(
      `patches [${patches.join(', ')}], expected [${expected.join(', ')}]`,
    );
  }
  if (problems.length) {
    throw new Error(`native library build mismatch: ${problems.join('; ')}`);
  }
}
