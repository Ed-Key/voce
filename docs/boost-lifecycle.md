# Name boosting lifecycle

At key-down a list is frozen: names read off the screen near the caret (the
per-window name cache), then the custom words, at most 25 terms. The live
stream decodes with that list: transcribe.cpp's phrase boost runs inside the
streaming greedy Parakeet decoder, with its match state carried across
chunks like the predictor's. After decoding, a restore pass respells listed
names that came out with other casing or spacing. Release, early cleanup and
the overlay work exactly as without boosting; there is no second model
instance and nothing waits at release.

Code: `src-tauri/patches/transcribe-cpp-sys-0.5.0-stream-boost.patch`
(vendored by `scripts/vendor-transcribe-cpp.sh`), `start_stream(vocabulary)`
and the restore calls in `managers/transcription.rs`, `boost_for` and the
restore before paste in `actions.rs`, `src-tauri/src/boost/` (`list.rs`
extractor, caps and restore pass; `screen.rs` name cache and debounced
window walk; `ax.rs` the Accessibility walk and the Chromium and Electron
warm-up).

Data each dictation keeps: the frozen list and the `boost` reason (`Boost`
in `actions.rs`). The stream session keeps its own copy of the boost
automaton and the automaton state (`ParakeetStreamingDecoderState`).

Rules:

- The stream boosts only a model with `Feature::Vocabulary` that streams and
  is not Whisper (Whisper keeps its prompt path). A model still loading at
  key-down gets the list; the library ignores it if the model cannot use it.
- The automaton is built at stream begin, while the caller's term strings
  are alive, and copied into the session, so a later run cannot change it.
- The restore pass runs on early cleanup's offers, on the finalized stream
  text, on the batch fallback's text, and on the cleaned text before paste.
  It respells a run of 1 to 3 words whose letters and digits equal a listed
  term's, for terms with an inner capital, a digit or an uncommon word; never
  across punctuation or a line break; a compound of ordinary words from the
  screen only from the same single word written like a name.
- Term text is never logged, including the library's own warning for a
  term the model cannot write (patched to say only that one was skipped).
- `dictation_timing` gains `keyup_ms` (from the key-up itself, 50 ms before
  `stop()`), `boost=on|off:<reason>` and `terms`. Term text is never logged.
- Gate: per word bucket (0-40, 40-100, 100-200, 200+), key-up-to-text p50 and
  p90 with cleanup on, read from `dictation_timing`, are no slower than
  without boosting.

| #   | State              | Event                                                                                                                                     | Expected result                                                                                                                                                            | Test                                                                                                                                                      | Kind       |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | idle               | key down, a boosting model, list non-empty                                                                                                | the stream starts with the frozen list; `boost=on`                                                                                                                         | `actions::boost_tests::boost_row1_a_boosting_model_gets_the_frozen_list`                                                                                  | sim        |
| 2   | idle               | key down, list empty                                                                                                                      | the stream starts as before; `boost=off:empty`                                                                                                                             | `actions::boost_tests::boost_row2_no_list_means_no_boost`                                                                                                 | sim        |
| 3   | idle               | key down, the loaded model cannot boost (ONNX, Whisper, no vocabulary)                                                                    | no list passed; `boost=off:model`                                                                                                                                          | `actions::boost_tests::boost_row3_a_model_that_cannot_boost_gets_no_list`                                                                                 | sim        |
| 4   | idle               | key down, the model is still loading                                                                                                      | the list is passed; the stream boosts once the model is up                                                                                                                 | `actions::boost_tests::boost_row4_a_model_still_loading_gets_the_list`                                                                                    | sim        |
| 5   | recording          | a listed name spans two stream chunks, or ends in the final tail                                                                          | the automaton state carries across chunks and into finalize; the name is written once                                                                                      | real app: dictate a listed name across a pause and at the very end                                                                                        | real       |
| 6   | release            | no stream text (the model does not stream, or the stream failed)                                                                          | batch fallback decodes offline with the same list                                                                                                                          | real app with a model that does not stream; the batch path calls `transcribe_with_vocabulary`                                                             | real       |
| 7   | any                | model switch or unload during a dictation                                                                                                 | the session, its automaton and state go with the engine, as the stream does today                                                                                          | existing stream tests; real app                                                                                                                           | real       |
| 8   | release            | a listed name written with other casing or spacing                                                                                        | respelled as listed; other letters never match                                                                                                                             | `boost::list::tests::row8_listed_names_are_respelled_only_when_the_letters_match`                                                                         | sim        |
| 9   | release            | the words span punctuation, a slash, brackets or a line break                                                                             | not respelled                                                                                                                                                              | `boost::list::tests::row9_respelling_never_crosses_punctuation_or_line_breaks`                                                                            | sim        |
| 10  | release            | a compound of ordinary words from the screen ("BackGround")                                                                               | ordinary speech ("back ground", "background") untouched                                                                                                                    | `boost::list::tests::row10_everyday_compounds_from_the_screen_stay_ordinary_words`                                                                        | sim        |
| 11  | release            | a respelling changed text an early-cleanup offer had already sent                                                                         | the cache is not a prefix: whole cleanup, never stale locked text                                                                                                          | `early_cleanup::tests::boost_row11_a_name_respelled_across_an_offer_is_not_a_prefix`                                                                      | sim        |
| 12  | release            | the continuation restarts with the locked text's last words                                                                               | rejected; whole cleanup, so nothing is written twice                                                                                                                       | `early_cleanup::tests::boost_row12_a_reply_restarting_with_the_locked_words_falls_back`                                                                   | sim        |
| 12b | stream             | an offer is due while the last committed word is half a word ("wor" before "king")                                                        | the offer stops before the last word, so the cache stays a word prefix of the final text                                                                                   | `early_cleanup::tests::offers_stop_before_the_last_committed_word`                                                                                        | sim        |
| 13  | release            | cleanup writes a listed name differently                                                                                                  | the restore pass respells it before paste                                                                                                                                  | `boost::list::tests::row8_listed_names_are_respelled_only_when_the_letters_match` (the same pass)                                                         | sim        |
| 14  | key down           | the name cache is stale or still building                                                                                                 | what is cached plus custom words; never waits on a walk                                                                                                                    | `boost::screen::tests::row14_key_down_uses_what_is_cached_and_never_waits`                                                                                | sim        |
| 15  | idle               | app activation, focus or window-title change                                                                                              | one debounced (300 ms) walk refreshes that window's cache off the main thread; every AX call in the walk has a 50 ms timeout; a text field gives the text around its caret | `boost::screen::tests::row15_triggers_within_the_debounce_make_one_walk`; walk caps (50 ms, 300 nodes) in the real app                                    | sim + real |
| 16  | any                | secure input, or a focused secure field                                                                                                   | no walk, no screen names; custom words only; after a focus change the app's cached names are hidden until the next walk says what is focused                               | `boost::list::tests::row16_secure_input_means_custom_words_only`, `boost::screen::tests::row16_a_focus_change_hides_the_cached_names_until_the_next_walk` | sim        |
| 18  | release            | timing                                                                                                                                    | `keyup_ms` counts from the real key-up, `total_ms` from `stop()`                                                                                                           | `transcription_coordinator::tests::boost_row18_release_timing_counts_from_the_real_key_up`                                                                | sim        |
| 19  | release (real app) | any dictation, cleanup on, release build                                                                                                  | key-up-to-text p50 and p90 per word bucket no slower than without boosting                                                                                                 | `dictation_timing` lines (`keyup_ms`, `boost`) from 50 dictations                                                                                         | real       |
| 20  | idle               | window text holds ordinary hyphenated words ("key-up", "5-minute"), contractions ("I'd", either apostrophe) or a possessive ("SPHEREx's") | not names; a possessive gives its name; "cua-driver" and "gpt-4" stay names                                                                                                | `boost::list::tests::row20_ordinary_hyphenated_words_and_contractions_are_not_names`                                                                      | sim        |

Notes

- Only the real app can confirm rows 5, 6, 7, 15's walk on real windows, and 19.
