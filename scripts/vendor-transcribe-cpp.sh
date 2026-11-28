#!/bin/sh
# Materialize src-tauri/vendor/transcribe-cpp-sys-0.5.0: the published crate
# (checked against its crates.io checksum) plus
# src-tauri/patches/transcribe-cpp-sys-0.5.0-stream-boost.patch, which boosts
# the dictation's list inside the streaming Parakeet decoder (an upstream
# candidate for transcribe.cpp issue #126).
# Cargo.toml patches the crate to that folder, so run this once after a
# clone and after changing the patch. The folder is not committed.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/src-tauri/vendor/transcribe-cpp-sys-0.5.0"
patch_file="$here/src-tauri/patches/transcribe-cpp-sys-0.5.0-stream-boost.patch"
sha="a6d535f101276d4c81b2169cdaff45b89dfaf86124fa9b1d4730a29277668dc4"

crate=""
for c in "${CARGO_HOME:-$HOME/.cargo}"/registry/cache/*/transcribe-cpp-sys-0.5.0.crate; do
    [ -f "$c" ] && crate="$c"
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -z "$crate" ]; then
    crate="$tmp/transcribe-cpp-sys-0.5.0.crate"
    curl -fsSL -o "$crate" https://crates.io/api/v1/crates/transcribe-cpp-sys/0.5.0/download
fi
got=$(shasum -a 256 "$crate" | cut -d' ' -f1)
if [ "$got" != "$sha" ]; then
    echo "transcribe-cpp-sys 0.5.0 checksum mismatch: $got" >&2
    exit 1
fi
tar -xzf "$crate" -C "$tmp"
(cd "$tmp/transcribe-cpp-sys-0.5.0" && patch -p1 --quiet < "$patch_file")
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$tmp/transcribe-cpp-sys-0.5.0" "$dest"
echo "vendored $dest"
