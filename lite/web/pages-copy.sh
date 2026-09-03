#!/usr/bin/env bash
# pages-copy.sh <src> <dst> — stage the PUBLIC surface of a lite/web tree
# into a www/ destination dir. www/ is what Pages serves; lite/web stays the
# dev source of truth, so this copies only what the browser needs (app +
# spike pages, sync/, w0/ with its vendored artifact, and a pruned
# node_modules — no dev files, no RESULTS.md, no tests, no manifests).
#
# The pages workflow calls this script from EACH checked-out ref (branch tip
# and every frozen tag), so every frozen version carries its own build
# recipe forward: if the copy list ever changes on the tip, already-frozen
# tags keep building with the list that was current when they froze.
set -euo pipefail

src="$1"
dst="$2"

mkdir -p "$dst/node_modules/@trystero-p2p" "$dst/node_modules/@dolthub" "$dst/node_modules/@noble"

cp "$src/index.html" "$src/app.js" "$src/engine-lite.js" \
   "$src/lb-spikes.html" "$src/lb-spikes.js" \
   "$src/lp-spikes.html" "$src/lp-spikes.js" \
   "$src/ms-spikes.html" "$src/ms-spikes.js" \
   "$src/msync-longevity.html" "$src/msync-longevity.js" \
   "$src/spikes.html" "$src/spikes.js" \
   "$dst/"

cp -r "$src/sync" "$dst/sync"
cp -r "$src/w0" "$dst/w0"

cp -r "$src/node_modules/trystero" "$dst/node_modules/trystero"
cp -r "$src/node_modules/@trystero-p2p/nostr" "$dst/node_modules/@trystero-p2p/nostr"
cp -r "$src/node_modules/@trystero-p2p/core" "$dst/node_modules/@trystero-p2p/core"
cp -r "$src/node_modules/@noble/secp256k1" "$dst/node_modules/@noble/secp256k1"
cp -r "$src/node_modules/@dolthub/doltlite-wasm" "$dst/node_modules/@dolthub/doltlite-wasm"
cp -r "$src/node_modules/wa-sqlite" "$dst/node_modules/wa-sqlite"
