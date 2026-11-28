//! Early cleanup: run the cleanup LLM on the recognized text while the
//! dictation key is held, so key release only finishes the last sentence.
//!
//! While recording, each time the stream's committed text grows by
//! `STEP_WORDS`, the whole text so far is cleaned exactly as at release today
//! (one request in flight at most). At release the latest result is reused:
//! as is when it covers the final transcript, otherwise all but its last
//! sentence is sent back as a partial answer and the model writes only the
//! rest. Anything unexpected falls back to today's whole-text cleanup.

use crate::actions::{post_process_target, post_process_transcription};
use crate::settings::AppSettings;
use log::{debug, info, warn};
use once_cell::sync::Lazy;
use regex::Regex;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;

/// New committed words that trigger the next during-speech cleanup.
const STEP_WORDS: usize = 8;
/// Upper bound for one cleanup request; a stuck server must not pin a slot.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// A sentence end: . ? or ! plus closing quotes/brackets, before whitespace.
static SENTENCE_END: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[.!?]["')\]]*\s+"#).unwrap());
static TRAILING_END: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[.!?]["')\]]*$"#).unwrap());

struct Cached {
    input: String,
    output: String,
    finished_at: Instant,
}

#[derive(Default)]
struct Inner {
    /// Bumped on every begin/resolve/cancel; results tagged with an older
    /// session are ignored.
    session: u64,
    /// Settings snapshot for the current dictation; Some only while eligible.
    settings: Option<Arc<AppSettings>>,
    /// New requests may start (false once the key is released).
    open: bool,
    /// Raw committed word count of the input of the last started request.
    started_words: usize,
    /// Latest due input that could not start because one was in flight.
    pending: Option<(String, usize)>,
    in_flight: Option<JoinHandle<()>>,
    cache: Option<Cached>,
}

/// What release should do with the early work.
pub enum Release {
    /// Cached output covers the final transcript exactly.
    Exact(String),
    /// Continue the final transcript from this locked prefix of the output.
    Continue { locked: String, cache_age: Duration },
    /// Use today's whole-text cleanup; the str says why (for the timing log).
    Whole(&'static str),
}

#[derive(Default)]
pub struct EarlyCleanup {
    inner: Mutex<Inner>,
}

impl EarlyCleanup {
    /// Start of a dictation. Enables early cleanup only for the local custom
    /// provider in plain prompt mode, when the user opted in.
    pub fn begin(&self, settings: AppSettings, post_process: bool) {
        let mut inner = self.inner.lock().unwrap();
        abort_in_flight(&mut inner);
        inner.session += 1;
        inner.cache = None;
        inner.pending = None;
        inner.started_words = 0;
        let eligible = post_process && settings.early_cleanup && is_continuable(&settings);
        inner.open = eligible;
        inner.settings = eligible.then(|| Arc::new(settings));
        if eligible {
            debug!("Early cleanup armed for session {}", inner.session);
        }
    }

    /// Session token for a stream worker, taken when its stream starts. A
    /// worker from a cancelled dictation then cannot feed the next one.
    pub fn session(&self) -> u64 {
        self.inner.lock().unwrap().session
    }

    /// Cheap check for the stream worker: is a new request due at this raw
    /// committed word count? The worker only filters text when this is true.
    pub fn due(&self, token: u64, raw_words: usize) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.session == token && inner.open && raw_words >= inner.started_words + STEP_WORDS
    }

    /// The stream worker hands over the filtered committed text once due.
    pub fn offer(self: &Arc<Self>, token: u64, filtered: String, raw_words: usize) {
        let mut inner = self.inner.lock().unwrap();
        if inner.session != token || !inner.open || raw_words < inner.started_words + STEP_WORDS {
            return;
        }
        if inner.in_flight.is_some() {
            inner.pending = Some((filtered, raw_words));
            return;
        }
        self.start_locked(&mut inner, filtered, raw_words);
    }

    fn start_locked(self: &Arc<Self>, inner: &mut Inner, input: String, raw_words: usize) {
        let Some(settings) = inner.settings.clone() else {
            return;
        };
        if input.trim().is_empty() {
            return;
        }
        inner.started_words = raw_words;
        let session = inner.session;
        let this = Arc::clone(self);
        inner.in_flight = Some(tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let output = tokio::time::timeout(
                REQUEST_TIMEOUT,
                post_process_transcription(&settings, &input),
            )
            .await
            .unwrap_or_else(|_| {
                warn!("Early cleanup request timed out");
                None
            });
            debug!(
                "Early cleanup step ({} words) took {:?}, ok={}",
                raw_words,
                started.elapsed(),
                output.is_some()
            );
            this.finish(session, input, output);
        }));
    }

    /// A request ended. Stores the result and starts the pending input.
    fn finish(self: &Arc<Self>, session: u64, input: String, output: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.session != session {
            return; // released, cancelled, or a newer dictation
        }
        inner.in_flight = None;
        if let Some(output) = output.filter(|o| !o.trim().is_empty()) {
            inner.cache = Some(Cached {
                input,
                output,
                finished_at: Instant::now(),
            });
        }
        if inner.open {
            if let Some((next, words)) = inner.pending.take() {
                self.start_locked(&mut inner, next, words);
            }
        }
    }

    /// Key released: no new requests. A request still running may finish
    /// while the ASR stream finalizes; `resolve` decides after that.
    pub fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.open = false;
        inner.pending = None;
    }

    /// After ASR finalize: take what the early work can offer for `final_text`
    /// and end the session (late results are then ignored).
    pub fn resolve(&self, final_text: &str) -> (Release, Option<Arc<AppSettings>>) {
        let mut inner = self.inner.lock().unwrap();
        let settings = inner.settings.take();
        if inner.in_flight.as_ref().is_some_and(|h| !h_is_finished(h)) {
            abort_in_flight(&mut inner);
        }
        inner.in_flight = None;
        inner.open = false;
        inner.pending = None;
        inner.session += 1;
        let cache = inner.cache.take();
        drop(inner);

        if settings.is_none() {
            return (Release::Whole("off"), None);
        }
        let Some(cache) = cache else {
            return (Release::Whole("no_cache"), settings);
        };
        let release = if cache.input == final_text {
            Release::Exact(cache.output)
        } else if !is_word_prefix(&cache.input, final_text) {
            info!(
                "Early cleanup: cached text is not a prefix of the final transcript, {}",
                divergence(&cache.input, final_text)
            );
            Release::Whole("not_prefix")
        } else {
            let locked = lock_prefix(&cache.output);
            if locked.is_empty() {
                Release::Whole("one_sentence")
            } else {
                Release::Continue {
                    locked,
                    cache_age: cache.finished_at.elapsed(),
                }
            }
        };
        (release, settings)
    }

    /// Cancel (Escape), empty recording, or batch fallback: drop everything.
    pub fn cancel(&self) {
        let mut inner = self.inner.lock().unwrap();
        abort_in_flight(&mut inner);
        inner.session += 1;
        inner.settings = None;
        inner.open = false;
        inner.pending = None;
        inner.cache = None;
    }
}

fn h_is_finished(handle: &JoinHandle<()>) -> bool {
    handle.inner().is_finished()
}

fn abort_in_flight(inner: &mut Inner) {
    if let Some(handle) = inner.in_flight.take() {
        handle.abort();
        info!("Early cleanup: aborted the in-flight request");
    }
}

/// Continuation needs a server that resumes a trailing assistant message and
/// the plain `${output}` prompt path (not structured output).
fn is_continuable(settings: &AppSettings) -> bool {
    let Some(provider) = settings.active_post_process_provider() else {
        return false;
    };
    provider.id == "custom"
        && !provider.supports_structured_output
        && post_process_target(settings).is_some_and(|t| t.prompt.contains("${output}"))
}

/// The committed words a later chunk cannot extend. The stream commits word
/// pieces, so its last word may be half a word ("wor" before "king"); only a
/// word followed by whitespace is known to be finished.
pub fn finished_words(committed: &str) -> &str {
    let text = committed.trim_end();
    text[..text.rfind(char::is_whitespace).unwrap_or(0)].trim_end()
}

/// `prefix` is `text` cut at a word boundary. The final transcript often adds
/// punctuation right after the last word the stream had committed, so a
/// following punctuation mark counts as a boundary too (the locked text drops
/// the last sentence anyway).
fn is_word_prefix(prefix: &str, text: &str) -> bool {
    text.starts_with(prefix)
        && text[prefix.len()..]
            .chars()
            .next()
            .is_none_or(|c| c.is_whitespace() || ".,!?;:\"')]".contains(c))
}

/// Where `cached` stops matching `final_text`, for the log: character offset,
/// both lengths, and the kind of character on each side. Never the words.
fn divergence(cached: &str, final_text: &str) -> String {
    let kind = |c: Option<char>| match c {
        None => "end",
        Some(c) if c.is_whitespace() => "space",
        Some(c) if c.is_alphanumeric() && c.is_uppercase() => "upper",
        Some(c) if c.is_alphanumeric() => "letter",
        Some(_) => "punct",
    };
    let mut a = cached.chars();
    let mut b = final_text.chars();
    let mut at = 0;
    loop {
        match (a.next(), b.next()) {
            (Some(x), Some(y)) if x == y => at += 1,
            (x, y) => {
                return format!(
                    "diverges at char {at} (cached {} chars, final {} chars; cached has {}, final has {})",
                    cached.chars().count(),
                    final_text.chars().count(),
                    kind(x),
                    kind(y)
                )
            }
        }
    }
}

/// The part of a cleaned output that stays fixed: everything except the last
/// sentence, minus the final sentence punctuation. The tokenizer writes ".\n\n"
/// as one token, so a kept "." would rule out a paragraph break at the seam.
pub fn lock_prefix(output: &str) -> String {
    let body = output.trim_end();
    let Some(last_end) = SENTENCE_END.find_iter(body).last() else {
        return String::new();
    };
    let kept = body[..last_end.end()].trim_end();
    TRAILING_END.replace(kept, "").into_owned()
}

/// Locked prefix + the model's continuation. None when the reply starts over
/// (repeats the start of the locked text): it may have rewritten or dropped
/// locked words, so the caller falls back to whole-text cleanup.
pub fn join(locked: &str, reply: &str) -> Option<String> {
    let head: String = locked.trim_start().chars().take(30).collect();
    if reply.trim_start().starts_with(&head) {
        return None;
    }
    // A reply that restarts with the locked text's last words would write
    // them twice ("...to Alice" + "to Alice. Then..."): fall back too.
    let norm = |w: &str| -> String {
        w.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    };
    let lw: Vec<String> = locked.split_whitespace().map(norm).collect();
    let rw: Vec<String> = reply.split_whitespace().map(norm).collect();
    if (2..=4).any(|n| n <= lw.len() && n <= rw.len() && lw[lw.len() - n..] == rw[..n]) {
        return None;
    }
    let needs_space = reply
        .chars()
        .next()
        .is_some_and(|c| !c.is_whitespace() && !".!?,;:\"')]".contains(c));
    let sep = if needs_space { " " } else { "" };
    Some(format!("{locked}{sep}{reply}").trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_prefix_keeps_all_but_last_sentence_without_final_period() {
        assert_eq!(lock_prefix("One. Two? Three"), "One. Two");
        assert_eq!(lock_prefix("One. Two? Three."), "One. Two");
        assert_eq!(lock_prefix("Only one."), "");
        assert_eq!(lock_prefix("A.\n\nB. C"), "A.\n\nB");
    }

    #[test]
    fn join_handles_paragraph_word_and_restart_replies() {
        assert_eq!(join("A b", ".\n\nC d.").as_deref(), Some("A b.\n\nC d."));
        assert_eq!(join("A b", ". C d.").as_deref(), Some("A b. C d."));
        assert_eq!(join("A b", "and c.").as_deref(), Some("A b and c."));
        // Row 10: a restart falls back instead of replacing locked text.
        let locked = "Please send the quarterly report to Alice. Keep it";
        assert_eq!(
            join(locked, "Please send the quarterly report. Then call Bob."),
            None
        );
    }

    #[test]
    fn boost_row12_a_reply_restarting_with_the_locked_words_falls_back() {
        assert_eq!(
            join("Send the report to Alice", "to Alice. Then call Bob."),
            None
        );
        // One repeated word can be real speech ("that that"); it is kept.
        assert!(join("I know that", "that is fine.").is_some());
    }

    #[test]
    fn boost_row11_a_name_respelled_across_an_offer_is_not_a_prefix() {
        // The offer ended in "open"; with "pencil" the final text respelled
        // both words as OpenPencil, so the cache is not a prefix: whole
        // cleanup, never stale locked text.
        let ec = Arc::new(EarlyCleanup::default());
        {
            let mut i = ec.inner.lock().unwrap();
            i.settings = Some(Arc::new(settings_with_early()));
            i.cache = Some(Cached {
                input: "we ship today. switch to open".into(),
                output: "We ship today. Switch to open.".into(),
                finished_at: Instant::now(),
            });
        }
        let (r, _) = ec.resolve("we ship today. switch to OpenPencil now");
        assert!(matches!(r, Release::Whole("not_prefix")));
    }

    #[test]
    fn divergence_reports_position_and_kinds_without_words() {
        let d = divergence("it works", "it worked fine");
        assert_eq!(
            d,
            "diverges at char 7 (cached 8 chars, final 14 chars; cached has letter, final has letter)"
        );
        assert!(divergence("hi", "hi").contains("cached has end, final has end"));
        assert!(!divergence("secret words", "secret wordz").contains("words"));
    }

    #[test]
    fn offers_stop_before_the_last_committed_word() {
        // A cached offer that ended inside a word the next chunk extended
        // ("wor" then "working") was never a prefix of the final text.
        assert_eq!(finished_words("so it is wor"), "so it is");
        assert_eq!(finished_words("so it is "), "so it");
        assert_eq!(finished_words("one"), "");
        assert_eq!(finished_words(""), "");
        assert!(is_word_prefix(
            finished_words("we are wor"),
            "we are working on it"
        ));
    }

    #[test]
    fn word_prefix_requires_a_word_boundary() {
        assert!(is_word_prefix("move the", "move the meeting"));
        assert!(is_word_prefix("move the", "move the"));
        assert!(!is_word_prefix("move th", "move the meeting"));
        assert!(!is_word_prefix("moved", "move the meeting"));
        // The final transcript often adds punctuation right after the last
        // word the stream had committed (live test 2026-11-25, not_prefix).
        assert!(is_word_prefix("it works", "it works. The next part"));
        assert!(is_word_prefix("so, it works", "so, it works, and then"));
        assert!(is_word_prefix("did it work", "did it work? Yes"));
        assert!(!is_word_prefix("it work", "it works. The next part"));
    }

    fn settings_with_early() -> AppSettings {
        let mut s = crate::settings::get_default_settings();
        s.early_cleanup = true;
        s
    }

    #[test]
    fn release_paths_follow_the_table() {
        // Row 11: armed but nothing cached -> whole.
        let ec = Arc::new(EarlyCleanup::default());
        ec.inner.lock().unwrap().settings = Some(Arc::new(settings_with_early()));
        let (r, _) = ec.resolve("hello world");
        assert!(matches!(r, Release::Whole("no_cache")));

        let put = |input: &str, output: &str| {
            let ec = Arc::new(EarlyCleanup::default());
            {
                let mut i = ec.inner.lock().unwrap();
                i.settings = Some(Arc::new(settings_with_early()));
                i.cache = Some(Cached {
                    input: input.into(),
                    output: output.into(),
                    finished_at: Instant::now(),
                });
            }
            ec
        };
        // Row 7: exact.
        let (r, _) = put("so um hi there", "So, hi there.").resolve("so um hi there");
        assert!(matches!(r, Release::Exact(ref o) if o == "So, hi there."));
        // Row 8: prefix -> continue from locked text.
        let (r, _) = put("one two. three four", "One two. Three four.")
            .resolve("one two. three four five six");
        assert!(matches!(r, Release::Continue { ref locked, .. } if locked == "One two"));
        // Row 9: not a prefix -> whole.
        let (r, _) = put("one two", "One two.").resolve("one tree four");
        assert!(matches!(r, Release::Whole("not_prefix")));
        // One-sentence cache: nothing to lock -> whole.
        let (r, _) = put("one two", "One two.").resolve("one two three");
        assert!(matches!(r, Release::Whole("one_sentence")));
        // Row 14: not armed -> whole, no settings.
        let (r, s) = EarlyCleanup::default().resolve("x");
        assert!(matches!(r, Release::Whole("off")) && s.is_none());
    }

    #[test]
    fn stale_results_are_ignored_after_resolve_or_cancel() {
        let ec = Arc::new(EarlyCleanup::default());
        let session = {
            let mut i = ec.inner.lock().unwrap();
            i.settings = Some(Arc::new(settings_with_early()));
            i.open = true;
            i.session
        };
        ec.cancel(); // row 12
        ec.finish(session, "late".into(), Some("Late.".into()));
        assert!(ec.inner.lock().unwrap().cache.is_none());
    }

    #[test]
    fn due_needs_step_words_and_an_open_session() {
        let ec = Arc::new(EarlyCleanup::default());
        assert!(!ec.due(ec.session(), 100)); // row 14: not armed
        {
            let mut i = ec.inner.lock().unwrap();
            i.settings = Some(Arc::new(settings_with_early()));
            i.open = true;
        }
        let token = ec.session();
        assert!(!ec.due(token, STEP_WORDS - 1)); // row 1
        assert!(ec.due(token, STEP_WORDS)); // row 2
        assert!(!ec.due(token + 1, STEP_WORDS)); // stale worker token
        ec.close(); // row 6
        assert!(!ec.due(token, 100));
    }

    #[test]
    fn offer_while_in_flight_is_kept_as_pending() {
        // Row 3: one in flight; the newest due input waits.
        let ec = Arc::new(EarlyCleanup::default());
        {
            let mut i = ec.inner.lock().unwrap();
            i.settings = Some(Arc::new(settings_with_early()));
            i.open = true;
            i.in_flight = Some(tauri::async_runtime::spawn(async {}));
        }
        let t = ec.session();
        ec.offer(t, "a b c d e f g h".into(), 8);
        ec.offer(t, "a b c d e f g h i j".into(), 10);
        ec.offer(t + 1, "from a cancelled worker".into(), 99);
        let i = ec.inner.lock().unwrap();
        assert_eq!(i.pending.as_ref().map(|p| p.1), Some(10));
    }
}
