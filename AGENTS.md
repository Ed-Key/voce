# AGENTS.md

Guidance for AI coding assistants working in this repository.

Voce is a macOS dictation and meeting-notes app built with Tauri 2 (Rust backend in `src-tauri/`, React and TypeScript frontend in `src/`, Python helpers for calls). It is a fork of Handy v0.9.8; much of the dictation core still follows Handy's structure.

## Commands

```bash
scripts/vendor-transcribe-cpp.sh   # once after a clone: the patched transcribe-cpp-sys (name boosting in the stream)
bun install
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev                    # run
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app    # release .app
bun run lint            # ESLint
bunx tsc --noEmit       # type check
bun run format          # Prettier + cargo fmt
cd src-tauri && cargo test --lib                                      # Rust tests
cd src-tauri/resources/assistie && python3 -m pytest -q               # companion tests
cd src-tauri/src/calls && python3 -m pytest -q test_observatory.py test_worker.py   # call worker tests
```

The onboarding table (steps and resume, the cleanup test, Voce cleanup's llama-server sidecar, Keychain keys, Names, Storage, the main-key cleanup rule) and its tests are in `docs/onboarding-lifecycle.md`. Release builds stage the sidecar with `scripts/fetch-llama-server.sh`; local runs point `VOCE_LLAMA_SERVER` at a llama-server.

Sign release builds with `APPLE_SIGNING_IDENTITY` (see README); ad-hoc builds lose macOS permissions on every rebuild.

Regenerate `src/bindings.ts` after changing Tauri commands or settings: run a debug build with `HANDY_EXPORT_BINDINGS=1` (for example `HANDY_EXPORT_BINDINGS=1 ./src-tauri/target/debug/voce --list-models`).

## Layout

- `src-tauri/src/actions.rs`: dictation start and stop, cleanup, paste, and the `dictation_timing` log line.
- `src-tauri/src/early_cleanup.rs`: cleaning the transcript while the key is held.
- `src-tauri/src/boost/`: name boosting (the list builder, the screen-name cache and its Accessibility walk, the restore pass); the decoder side is `src-tauri/patches/`. Its table and tests are in `docs/boost-lifecycle.md`.
- `src-tauri/src/managers/`: audio, models, transcription (streaming), history.
- `src-tauri/src/calls/`: meeting notes (capture, detection, the meeting prompt, analysis worker, archive and retention, notch, companion bridge). `worker.py` and `observatory.py` run under a sandbox without network.
- `src-tauri/resources/assistie/`: the companion's Python side (bridge, responder on the Codex CLI, memory, plugin).
- `src/`: settings UI, overlay (`src/overlay/`), notch (`src/notch/`), call pages (`src/components/calls/`).
- `stream-asr/`: the Swift sidecar for live streaming transcription on the Neural Engine.

## Rules

- `crate::APP_ID` must match the identifier in `tauri.conf.json` (a test checks it); call features are gated on it.
- All user-facing strings go through i18next (`src/i18n/locales/en/translation.json`); ESLint enforces it.
- Behavior with timing or lifecycle (overlay, meeting prompt, early cleanup, recording) gets one test per row of an event and state table.
- Never commit personal data, recordings, transcripts or machine-specific paths.
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`) and explain why.
- A branch built in its own worktree with its own `CARGO_TARGET_DIR` (5-13 GB each) must delete that target directory in the same step that merges the branch or removes the worktree. Nothing removes it automatically, and skipped deletions have filled the disk.
