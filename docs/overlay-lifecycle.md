# Dictation overlay lifecycle (Slip)

States, in order: **Hidden**, **Arming** (dots circle), **Morph** (dots draw up
into the hand), **Listening** (fingers follow speech-gated loudness, a ripple nod
per committed word), **Release** (fingers draw back to dots), **Finishing** (dots
circle), **Polishing** (dots circle, last dot amber, text dims), **Exiting** (160
ms fade; Rust unmaps the window at 300 ms), **Ended** (hand closes or dots land
as a closed hand, card narrows to a message, holds, fades; Rust unmaps at the
linger time).

Rust owns the window (show, size, unmap). The webview owns the motion. Every row
has one test: `overlay.rs` `lifecycle_tests` (Rust) and
`src/overlay/slip.test.ts` (webview model).

| Event                                                                             | From                                            | To                                                                  | Rust                                           | Test                                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| Press (`show-overlay` recording / streaming)                                      | any, including Ended or Exiting                 | Arming, fresh session                                               | show generation +1, window visible             | Rust `press_shows_a_new_generation...`; TS `press`                     |
| First audio (`recording-ready`)                                                   | Arming                                          | Morph, then Listening after 655 ms + 250 ms hold                    | none                                           | TS `first audio`                                                       |
| Words commit (`stream-text-event`, committed word count grows)                    | Listening                                       | Listening + one ripple nod; first text widens pill to slip          | none                                           | TS `words commit`                                                      |
| Release (stream phase working/transcribing, or `show-overlay` transcribing)       | Arming, Morph, Listening                        | Release, then Finishing                                             | none                                           | TS `release`                                                           |
| Polish (phase working/polishing, or `show-overlay` processing)                    | Release, Finishing                              | Polishing                                                           | none                                           | TS `polish`                                                            |
| Polish done                                                                       | Polishing                                       | Polishing (holds until paste)                                       | none                                           | TS `polish done`                                                       |
| Paste (`hide-overlay`)                                                            | any shown state                                 | Exiting, Hidden after 160 ms                                        | hide after 300 ms, as before                   | Rust `paste_hides_after...`; TS `paste`                                |
| Cancel (`overlay-ended` cancelled)                                                | Listening: hand closes. Other states: dots land | Ended, "Cancelled", ~1.7-2.0 s                                      | linger 2050 ms; later plain hides skipped      | Rust `cancel_lingers...`, `plain_hides_after_a_cancel...`; TS `cancel` |
| Nothing heard (`overlay-ended` nothing_heard: no samples, empty text)             | Finishing / Polishing                           | Ended, "Nothing heard"                                              | linger 2050 ms                                 | Rust `nothing_heard...`; TS `nothing heard`                            |
| Error (`overlay-ended` error: transcription failed, mic failed to start)          | any shown state                                 | Ended, "Couldn't transcribe", amber dot, held 2.5x                  | linger 3400 ms                                 | Rust `error_lingers_longer`; TS `error`                                |
| Second end in one session                                                         | Ended                                           | Ended (first wins)                                                  | ignored                                        | Rust `a_second_end...`; TS `second end`                                |
| New press during a lingering hide                                                 | Ended                                           | Arming, fresh session                                               | generation +1, so the linger's hide is skipped | Rust `new_press_during_a_lingering_hide...`; TS `new press during end` |
| Model unavailable                                                                 | Hidden                                          | Hidden (start returns before showing)                               | an end is a plain hide                         | Rust `model_unavailable...`; TS `model unavailable`                    |
| Worker sees the cancel first (any cancelled branch, or no samples after a cancel) | any shown state                                 | Ended, "Cancelled" (never a plain hide that would beat the message) | ends with Cancelled; the second end is ignored | Rust `a_second_end...`                                                 |
| Live text while the compact (Minimal) card is shown                               | any                                             | unchanged: text ignored, card stays compact                         | none                                           | manual (React wiring)                                                  |
| Press between the last frame's unmount and React's commit                         | Hidden                                          | Arming; the frame loop restarts on the press counter                | none                                           | manual (React wiring)                                                  |

Notes

- Paste is never delayed: the lingering hide is used only for cancel, nothing
  heard and error. `hide_recording_overlay` keeps its 300 ms delay.
- `end_recording_overlay` runs on the main thread, after any queued show, so a
  microphone that fails right after the press still shows the error.
- Ended ignores a late `hide-overlay` only in Rust (skipped while lingering);
  if one still reaches the webview it starts the fade at once.
