# Building Voce

Voce builds on macOS only (14.4 or later; developed on Apple Silicon).

## Prerequisites

- Xcode Command Line Tools: `xcode-select --install`
- [Rust](https://rustup.rs/) (stable)
- [Bun](https://bun.sh/)
- CMake (for example `brew install cmake`)

## Steps

```bash
scripts/vendor-transcribe-cpp.sh   # the patched transcribe-cpp-sys (src-tauri/patches/)
bun install
mkdir -p src-tauri/resources/models
curl -o src-tauri/resources/models/silero_vad_v4.onnx https://blob.handy.computer/silero_vad_v4.onnx

# development
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev

# release .app (in src-tauri/target/release/bundle/macos/)
APPLE_SIGNING_IDENTITY="<your certificate>" CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app
```

`CMAKE_POLICY_VERSION_MINIMUM=3.5` works around an older CMake minimum in a native dependency.

## Signing and permissions

Microphone, Accessibility and System Audio Recording permissions are tied to the app's code signature. Without `APPLE_SIGNING_IDENTITY` the build is ad-hoc signed, its signature changes on every rebuild, and macOS asks for permissions again. Any Apple Development or Developer ID certificate in your keychain works (`security find-identity -v -p codesigning` lists them).

If permissions look enabled but Voce still reports them missing after a rebuild, remove Voce from the list in System Settings, add it again, and reopen the app.

## Live call transcription (optional)

`stream-asr/setup.sh` builds the streaming sidecar with Swift, downloads the Nemotron model, and records both paths in `call-ai-runtime.json`. See the README for that file.
