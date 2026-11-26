#!/bin/bash
# Setup for live call transcription: build the sidecar, fetch the 560 ms Nemotron Core ML bundle and
# NVIDIA's license files (outside the worker's no-network sandbox), and point the call runtime at them.
# Usage: stream-asr/setup.sh [app data dir]   (default: Voce's app data folder)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
data="${1:-$HOME/Library/Application Support/com.edkiboma.voce}"
runtime="$data/call-ai-runtime.json"
[ -f "$runtime" ] || { echo "No runtime config at $runtime" >&2; exit 1; }

(cd "$here" && swift build -c release)
binary="$here/.build/release/handy-stream-asr"
root="$data/stream-asr"
mkdir -p "$root"
models="$("$binary" --download "$root" | /usr/bin/python3 -c 'import json,sys; print(json.loads(sys.stdin.readline())["folder"])')"
# Neither the NVIDIA nor the FluidInference repo ships a license file; handy-computer's copy is NVIDIA's text.
[ -f "$models/LICENSE" ] || curl -fsSL "https://huggingface.co/handy-computer/nemotron-speech-streaming-en-0.6b-gguf/resolve/main/LICENSE" -o "$models/LICENSE"
printf '%s\n' "Licensed by NVIDIA Corporation under the NVIDIA Open Model License" \
  "Model: nvidia/nemotron-speech-streaming-en-0.6b. Core ML conversion: FluidInference/nemotron-speech-streaming-en-0.6b-coreml (560 ms)." > "$models/NOTICE"
/usr/bin/python3 - "$runtime" "$binary" "$models" <<'PY'
import json, os, sys
path, binary, models = sys.argv[1:]
config = json.load(open(path))
config.update(stream_asr=binary, stream_models=models)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(config, f)
os.replace(tmp, path)
print("stream_asr:", binary, "\nstream_models:", models)
PY
