# communico

A Matrix homeserver rebuilding its core on Turso.

This branch currently contains reused, database-independent pieces: the
rulebook, canonical JSON, event IDs and redaction, signing primitives,
transport helpers, configuration loading, pure endpoint sources and test
harnesses. It does not yet contain a runnable homeserver.

The former Doltgres implementation and its integration tests remain on
`doltgres` at `2d3944abaed7571fd8fe24a532860bd134a46d15`.

## Checks

Run inside the authorized project test VM:

- `deno task check`
- `deno task test`
- `sh hooks/pre-commit`

Configuration uses `defaults/communico.toml`, an optional
`config/communico.toml` overlay and `COMMUNICO_*` environment overrides.
`deno task config` prints the merged settings; it does not initialize storage.

The Complement runner, blacklist and historical baseline are retained for
restoration. Its runtime image and continuity query helpers must be rebuilt
before the harness can run on this branch.
