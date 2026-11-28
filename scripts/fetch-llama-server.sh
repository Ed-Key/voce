#!/bin/sh
# Stage the cleanup sidecar for a release build: the pinned official
# llama.cpp macOS arm64 release, checked against its sha256, reduced to
# llama-server and the dylibs it loads, in src-tauri/binaries/.
# src-tauri/tauri.sidecar.conf.json (passed to `tauri build --config`) puts
# them in Voce.app/Contents/MacOS, where llama-server's @loader_path rpath
# finds the dylibs and local_llm.rs finds llama-server.
#
# They are bundled as macOS "files", not externalBin: Tauri re-signs an
# externalBin with Voce's own entitlements, and a self-signed build (no Team
# ID) then refuses to load the dylibs under the hardened runtime. So this
# script signs them itself when APPLE_SIGNING_IDENTITY is set, llama-server
# with src-tauri/llama-server.entitlements; Tauri's signature of the .app
# then seals them. VOCE_SIGN_TIMESTAMP=1 adds a secure timestamp (needed for
# notarization).
#
# The archive is cached in $VOCE_LLAMA_CACHE/<tag>/ (default
# ~/.cache/voce-llama) and reused when its checksum matches.
set -eu

TAG=b12818
ARCHIVE="llama-$TAG-bin-macos-arm64.tar.gz"
URL="https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ARCHIVE"
SHA256=b05fc72e0ed39d343f7e955d3fc67087ea56e161dc0cfb462f5f0163af372234

here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/src-tauri/binaries"
conf="$here/src-tauri/tauri.sidecar.conf.json"
entitlements="$here/src-tauri/llama-server.entitlements"
cache="${VOCE_LLAMA_CACHE:-$HOME/.cache/voce-llama}/$TAG"

sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

mkdir -p "$cache"
if [ ! -f "$cache/$ARCHIVE" ] || [ "$(sha_of "$cache/$ARCHIVE")" != "$SHA256" ]; then
    curl -fL --retry 3 -o "$cache/$ARCHIVE.part" "$URL"
    mv "$cache/$ARCHIVE.part" "$cache/$ARCHIVE"
fi
got=$(sha_of "$cache/$ARCHIVE")
if [ "$got" != "$SHA256" ]; then
    echo "llama.cpp $TAG checksum mismatch: $got" >&2
    exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$cache/$ARCHIVE" -C "$tmp"
src="$tmp/llama-$TAG"
[ -x "$src/llama-server" ] || { echo "llama-server not in $ARCHIVE" >&2; exit 1; }

# The files the bundle config ships (the dylibs under their install names).
files=$(python3 -c 'import json,sys; print("\n".join(v.split("/",1)[1] for v in json.load(open(sys.argv[1]))["bundle"]["macOS"]["files"].values() if v.startswith("binaries/")))' "$conf")

rm -rf "$dest"
mkdir -p "$dest"
for f in $files; do
    case "$f" in
        llama.cpp-LICENSE) cp "$src/LICENSE" "$dest/$f" ;;
        *) cp -L "$src/$f" "$dest/$f" ;;
    esac
done

# Every @rpath library the server loads, directly or through another dylib,
# must be one the bundle ships; nothing else from the archive is bundled.
for f in $files; do
    case "$f" in llama-server | *.dylib) ;; *) continue ;; esac
    for need in $(otool -L "$dest/$f" | awk '/@rpath\//{sub("@rpath/","",$1); print $1}'); do
        if [ ! -f "$dest/$need" ]; then
            echo "$f needs $need, which tauri.sidecar.conf.json does not ship" >&2
            exit 1
        fi
    done
done

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    stamp="--timestamp=none"
    [ "${VOCE_SIGN_TIMESTAMP:-}" = 1 ] && stamp="--timestamp"
    for f in $files; do
        case "$f" in *.dylib)
            codesign --force --options runtime "$stamp" --sign "$APPLE_SIGNING_IDENTITY" "$dest/$f" ;;
        esac
    done
    codesign --force --options runtime "$stamp" --entitlements "$entitlements" \
        --sign "$APPLE_SIGNING_IDENTITY" "$dest/llama-server"
fi

# The staged server runs with its dylibs (and, when signed, its signature).
"$dest/llama-server" --version >/dev/null 2>&1 || {
    echo "the staged llama-server does not start" >&2
    "$dest/llama-server" --version >&2 || true
    exit 1
}
echo "staged llama-server $TAG in $dest"
