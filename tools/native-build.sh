#!/bin/sh
# The qualified engine: one pinned source tree, one carried upstream patch.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cache=${COMMUNICO_NATIVE_CACHE:-"$root/.native-cache"}
mkdir -p "$cache" "$root/.native"
cache=$(CDPATH='' cd -- "$cache" && pwd)
source="$cache/turso"
pin=607bff9fd0e547a25a97b3bf06e83bcc5d99d53c
patch="$root/native/turso-ffi/patches/turso-pr-9770.patch"
if [ ! -d "$source/.git" ]; then
  git init "$source"
  git -C "$source" remote add origin https://github.com/tursodatabase/turso.git
  git -C "$source" fetch --depth 1 origin "$pin"
  git -C "$source" checkout --detach "$pin"
fi
test "$(git -C "$source" rev-parse HEAD)" = "$pin"
if git -C "$source" apply --reverse --check "$patch" 2>/dev/null; then
  : # The patch is already applied.
else
  git -C "$source" apply --check "$patch"
  git -C "$source" apply "$patch"
fi
# The library states what it is: rev and version of the checkout, sha256 of
# every carried patch, and the manifest's feature set — all read at compile
# time (env!), so a build without these variables fails.
manifest="$root/native/turso-ffi/Cargo.toml"
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$source/Cargo.toml" | head -1)
dep=$(grep -E '^turso = ' "$manifest")
default_features=$(printf '%s\n' "$dep" | sed -n 's/.*default-features = \([a-z]*\).*/\1/p')
features=$(printf '%s\n' "$dep" | sed -n 's/.*features = \[\([^]]*\)\].*/\1/p' | tr -d ' "')
patches=$(find "$root/native/turso-ffi/patches" -name '*.patch' -type f |
  sort | xargs -r sha256sum | awk '{print $1}' | paste -sd, -)
for value in "$version" "$default_features"; do
  if [ -z "$value" ]; then
    echo "native-build: cannot read turso version/default-features" >&2
    exit 1
  fi
done
export COMMUNICO_TURSO_VERSION="$version"
export COMMUNICO_TURSO_REV="$pin"
export COMMUNICO_TURSO_PATCHES="$patches"
export COMMUNICO_TURSO_DEFAULT_FEATURES="$default_features"
export COMMUNICO_TURSO_FEATURES="$features"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$cache/target"}
cargo build --release -j 2 --manifest-path "$root/native/turso-ffi/Cargo.toml" \
  --config "patch.crates-io.turso.path=\"$source/bindings/rust\""
cp "$CARGO_TARGET_DIR/release/libturso_ffi.so" "$root/.native/libturso_ffi.so"
sha256sum "$root/.native/libturso_ffi.so"
