# BUILD.md — doltlite.mjs / doltlite.wasm (amalgamation lineage, v0.11.54)

Reproduces `vendor/doltlite.mjs` + `vendor/doltlite.wasm`: the DoltLite
amalgamation compiled wa-sqlite-shaped via the wa-sqlite build harness
(recipe route R2; in-tree R1 hunt found only `make -C ext/wasm` = the
broken npm lineage (b) and `test/amalgamation_wasm_compile_test.sh` = a
compile-only smoke test whose link step exports just
`_sqlite3_initialize` — insufficient for the wa-sqlite JS wrapper).

## Inputs (recorded)

- emsdk at `~/tools/emsdk` — `sdk-releases-9d70dbe8860ccdd3595f6e6065d94bfb543ae955-64bit`,
  `emcc 6.0.8 (aeb67926e7de656da38bc807d83050af93578758)`,
  node-24.19.0-64bit (emsdk-bundled).
  Install: `git clone https://github.com/emscripten-core/emsdk ~/tools/emsdk
  && cd ~/tools/emsdk && ./emsdk install latest && ./emsdk activate latest`
- `doltlite-amalgamation-0.11.54.zip` (release asset)
  sha256 = `bd0bf68e6b2ebb389af5cb0cce80b0a71e3051043ac091ab0f0ab2f7c6dc5f2a`
  contents: `doltlite.c` (19 583 783 B; sqlite 3.54.0 amalgamation +
  doltlite), `doltlite.h` (694 955 B), `doltliteext.h` (39 467 B).
- doltlite clone @ v0.11.54 (b8f9f72c9b43d9d1e75e3bc51f0380d3f41f56ba),
  used for recipe hunting only.
- wa-sqlite clone @ master (2026-08-24, depth 1) — build harness only.

## Recipe (exact)

```bash
cd /tmp/w0-build/wa-sqlite          # the wa-sqlite clone
mkdir -p deps/version-3.53.0        # bypass its sqlite-tarball download rule:
cp /tmp/w0-build/amalgamation/doltlite-amalgamation-0.11.54/doltlite.c deps/version-3.53.0/sqlite3.c
cp /tmp/w0-build/amalgamation/doltlite-amalgamation-0.11.54/doltlite.h deps/version-3.53.0/sqlite3.h
cp /tmp/w0-build/amalgamation/doltlite-amalgamation-0.11.54/doltliteext.h deps/version-3.53.0/

# patch 1 (recorded): src/register-ext-stub.c — NEW file:
#   #include "sqlite3.h"
#   void RegisterExtensionFunctions(sqlite3 *db){ (void)db; }
#   (wa-sqlite's open_v2 ccalls RegisterExtensionFunctions unconditionally;
#    extension-functions.c itself is omitted — keeps the build offline;
#    SQLITE_ENABLE_MATH_FUNCTIONS covers the useful parts)
# patch 2: src/exported_functions.json — no net change (symbol restored
#   after the stub landed; only ordering differs).
# NOT patched: the Makefile (command-line overrides only).

source ~/tools/emsdk/emsdk_env.sh
make dist/wa-sqlite.mjs \
  CFILES="sqlite3.c main.c libauthorizer.c libfunction.c libhook.c libprogress.c libvfs.c register-ext-stub.c" \
  WASQLITE_EXTRA_DEFINES='-DSQLITE_WASM -DDOLTLITE_PROLLY=1 -DDOLTLITE_VEC1=0 -DVEC1_THREADS=0 -DDOLTLITE_VERSION=\"v0.11.54\"' \
  EMFLAGS_EXTRA='-s ENVIRONMENT="web,worker,node"'

# final link under the doltlite name (so the wasm file is doltlite.wasm):
emcc -Oz -flto \
  -s ALLOW_MEMORY_GROWTH=1 -s WASM=1 -s INVOKE_RUN -s ENVIRONMENT="web,worker,node" \
  -s STACK_SIZE=512KB -s WASM_BIGINT=0 \
  -s EXPORTED_FUNCTIONS=@src/exported_functions.json \
  -s EXPORTED_RUNTIME_METHODS=@src/extra_exported_runtime_methods.json \
  --js-library src/libadapters.js --post-js src/libauthorizer.js \
  --post-js src/libfunction.js --post-js src/libhook.js --post-js \
  src/libprogress.js --post-js src/libvfs.js \
  tmp/obj/dist/sqlite3.o tmp/obj/dist/main.o tmp/obj/dist/libauthorizer.o \
  tmp/obj/dist/libfunction.o tmp/obj/dist/libhook.o tmp/obj/dist/libprogress.o \
  tmp/obj/dist/libvfs.o tmp/obj/dist/register-ext-stub.o \
  -o dist/doltlite.mjs
cp dist/doltlite.mjs dist/doltlite.wasm <repo>/lite/web/w0/vendor/
```

## Deviation from the plan's PR-#2165 flag list (recorded)

Plan listed `SQLITE_WASM, SQLITE_OS_OTHER=1, SQLITE_THREADSAFE=0`.
`SQLITE_OS_OTHER=1` was DROPPED: with it the amalgamation provides no
`sqlite3_os_init`/`sqlite3_os_end` (both are exported-symbol requirements
of the wa-sqlite link) and the link fails
(`wasm-ld: undefined symbol: sqlite3_os_init`). With OS_OTHER unset,
wa-sqlite's default `SQLITE_OS_UNIX` VFS runs on Emscripten MEMFS (same
as stock wa-sqlite). Remotes are NOT gated on OS_OTHER
(`DOLTLITE_ENABLE_REMOTES` defaults to 1 in `src/doltlite_remote.h`;
explicitly NOT set to 0 here). The alternatives (`-DSQLITE_OS_KV=1` →
kvvfs os_init) were noted and not needed.

## Variant note (recorded during W0b)

A `-s NODERAWSOCKETS=1` relink (emscripten 6's node:net backend, real TCP
under node) was built and used for the W0b/W0c transport investigation.
It is one flag away from this recipe (append to both `EMFLAGS_EXTRA` and
the final link). The vendored artifact is built WITHOUT it (browser
behavior is identical for non-remote work, and its connect error is the
more honest one). NOTE: NODERAWSOCKETS makes a browser build ERROR at
socket creation ("NODERAWSOCKETS is currently only supported on Node.js
environment"), so a single artifact cannot serve both runtimes for
remote work — neither backend completes a remote round trip anyway (see
RESULTS.md's W0 log / WB1).

## Acceptance (both runtimes verified 2026-08-24)

- node: `dolt_version()` → `v0.11.54`; 34 `dolt%` functions including
  `dolt_remote dolt_push dolt_fetch dolt_pull dolt_clone`.
- browser (headless Chrome via astral, bare page): same + a committed
  row visible in `dolt_log`.
- JS API (NOT oo1): `import SQLiteESMFactory from './vendor/doltlite.mjs'`
  → `const m = await SQLiteESMFactory()` → `m._sqlite3_initialize()` →
  `const sqlite3 = (await import('wa-sqlite/src/sqlite-api.js')).Factory(m)`
  → `const db = await sqlite3.open_v2('name.db')` (MEMFS path) →
  `await sqlite3.exec(db, sql, (row, columns) => …)`.
