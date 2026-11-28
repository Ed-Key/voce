//! The frozen list a dictation boosts with: names read off the screen near
//! the caret, then the custom words in their existing order, capped.
//!
//! The extractor is deliberately plain rules: keep what looks like a name
//! (capitalized away from a sentence start, CamelCase, inner capitals,
//! acronyms, letters mixed with digits or dashes); drop common words, UI
//! chrome, short tokens, paths, URLs, hashes and long phrases.

use crate::settings::AppSettings;
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};

/// At most this many terms in all...
pub const MAX_TERMS: usize = 25;
/// ...and at most this many from the screen; custom words fill the rest.
pub const MAX_SCREEN: usize = 15;
const MAX_WORDS: usize = 3;
const MAX_CHARS: usize = 24;

/// A piece of window text and how far it sits from the caret (0 is the
/// focused element, 1 its parent's other children, and so on).
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenText {
    pub text: String,
    pub distance: u32,
}

/// A screen term with what ranks it.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub term: String,
    pub distance: u32,
    /// 2: in no dictionary; 1: only as a proper noun; 0: a common word.
    pub rarity: u8,
    pub count: u32,
}

/// The system word list: lowercase entries are common words, capitalized
/// ones proper nouns. Empty where there is none (names are then kept).
static LEXICON: Lazy<(HashSet<String>, HashSet<String>)> = Lazy::new(|| {
    let mut common = HashSet::new();
    let mut proper = HashSet::new();
    if let Ok(text) = std::fs::read_to_string("/usr/share/dict/words") {
        for w in text.lines() {
            if w.chars().next().is_some_and(char::is_lowercase) {
                common.insert(w.to_string());
            } else {
                proper.insert(w.to_lowercase());
            }
        }
    }
    (common, proper)
});

/// Interface words that are capitalized on screen but never names.
const CHROME: &[&str] = &[
    "about",
    "account",
    "add",
    "all",
    "archive",
    "back",
    "bold",
    "cancel",
    "chat",
    "chats",
    "close",
    "copy",
    "delete",
    "done",
    "download",
    "draft",
    "drafts",
    "edit",
    "file",
    "files",
    "filter",
    "forward",
    "help",
    "history",
    "home",
    "inbox",
    "insert",
    "italic",
    "loading",
    "login",
    "logout",
    "menu",
    "more",
    "new",
    "next",
    "none",
    "notifications",
    "open",
    "paste",
    "preview",
    "previous",
    "profile",
    "projects",
    "recent",
    "redo",
    "refresh",
    "reply",
    "save",
    "search",
    "send",
    "sent",
    "settings",
    "share",
    "sign",
    "spam",
    "starred",
    "submit",
    "today",
    "tools",
    "trash",
    "undo",
    "untitled",
    "upload",
    "view",
    "window",
    "yesterday",
];

fn is_common(word: &str) -> bool {
    let lower = word.to_lowercase();
    LEXICON.0.contains(&lower) || CHROME.contains(&lower.as_str())
}

fn rarity(term: &str) -> u8 {
    let words: Vec<String> = term.split(' ').map(str::to_lowercase).collect();
    if words
        .iter()
        .all(|w| LEXICON.0.contains(w) || LEXICON.1.contains(w))
    {
        if words.iter().all(|w| LEXICON.0.contains(w)) {
            0
        } else {
            1
        }
    } else {
        2
    }
}

/// Paths, URLs, emails, hashes and the like: never boosted from the screen.
fn is_junk(token: &str) -> bool {
    let hexlike = token.len() >= 7
        && token.chars().all(|c| c.is_ascii_hexdigit())
        && token.chars().any(|c| c.is_ascii_digit());
    token.contains("://")
        || token.contains('/')
        || token.contains('\\')
        || token.contains('@')
        || token.starts_with("www.")
        || token.contains('.') && token.split('.').count() > 1 && !token.ends_with('.')
        || hexlike
}

#[derive(Debug, PartialEq)]
enum Shape {
    /// CamelCase, inner capitals, acronyms, digits or dashes: kept anywhere.
    Distinct,
    /// Capitalized: a name only away from a sentence start and if uncommon.
    Capitalized,
    Other,
}

/// Everyday words the system word list is too old to know.
const MODERN: &[&str] = &[
    "app",
    "apps",
    "blog",
    "checkbox",
    "dropdown",
    "email",
    "emails",
    "inbox",
    "keyword",
    "keywords",
    "login",
    "logout",
    "offline",
    "online",
    "popup",
    "screenshot",
    "setup",
    "signup",
    "sidebar",
    "timestamp",
    "toolbar",
    "username",
    "website",
    "workflow",
];

/// A dictionary word, a plural of one, or a MODERN word.
fn everyday(word: &str) -> bool {
    let known = |w: &str| is_common(w) || MODERN.contains(&w);
    known(word)
        || word.strip_suffix('s').is_some_and(known)
        || word.strip_suffix("es").is_some_and(known)
}

/// "key-up", "follow-ups", "5-minute": lowercase, joined by hyphens, every
/// part an everyday word or a number. Not a name ("cua-driver", "gpt-4" are).
fn ordinary_compound(token: &str) -> bool {
    token.contains('-')
        && !token.contains('_')
        && !token.chars().any(char::is_uppercase)
        && token
            .split('-')
            .all(|p| !p.is_empty() && (p.chars().all(|c| c.is_ascii_digit()) || everyday(p)))
}

/// "I'd", "we're", "isn't", with either apostrophe ("O'Brien" is no contraction).
fn contraction(token: &str) -> bool {
    let t = token.to_lowercase().replace('\u{2019}', "'");
    t.contains('\'')
        && ["'d", "'m", "'ll", "'ve", "'re", "n't", "'all"]
            .iter()
            .any(|s| t.ends_with(s))
}

/// A possessive's name: "SPHEREx's" and "SPHEREx\u{2019}s" are "SPHEREx".
fn strip_possessive(token: &str) -> &str {
    ["'s", "\u{2019}s", "'S", "\u{2019}S"]
        .iter()
        .find_map(|s| token.strip_suffix(s))
        .filter(|base| !base.is_empty())
        .unwrap_or(token)
}

fn shape(token: &str) -> Shape {
    if contraction(token) || ordinary_compound(token) {
        return Shape::Other;
    }
    let chars: Vec<char> = token.chars().collect();
    let letters = chars.iter().filter(|c| c.is_alphabetic()).count();
    if letters == 0 {
        return Shape::Other;
    }
    let upper = chars.iter().filter(|c| c.is_uppercase()).count();
    let inner_cap = chars.iter().skip(1).any(|c| c.is_uppercase());
    let mixed = chars
        .iter()
        .any(|c| c.is_ascii_digit() || *c == '-' || *c == '_');
    if (inner_cap && upper < chars.len()) || (upper == letters && letters >= 2) || mixed {
        Shape::Distinct
    } else if chars[0].is_uppercase() {
        Shape::Capitalized
    } else {
        Shape::Other
    }
}

fn long_enough(token: &str) -> bool {
    let n = token.chars().count();
    let lowercase = token.chars().all(|c| !c.is_uppercase());
    n >= 3 && (!lowercase || n >= 4)
}

/// The names in one piece of text, in order (repeats included).
pub fn extract(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    // Tokens with whether a sentence starts at them.
    let mut tokens: Vec<(String, bool)> = Vec::new();
    let mut sentence_start = true;
    for raw in text.split_whitespace() {
        let token = strip_possessive(
            raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_'),
        );
        let ends = raw
            .trim_end_matches(['"', '\'', ')', ']'])
            .ends_with(['.', '!', '?', ':']);
        if !token.is_empty() {
            tokens.push((token.to_string(), sentence_start));
        }
        sentence_start = ends || raw.ends_with('\n');
        if raw.contains(['(', ')', ',', ';']) && !ends {
            // A break inside the run of names.
            tokens.push((String::new(), false));
        }
    }
    let keep_single = |t: &str, at_start: bool| -> bool {
        if t.chars().count() > MAX_CHARS || is_junk(t) || !long_enough(t) {
            return false;
        }
        match shape(t) {
            Shape::Distinct => !(at_start && is_common(t)),
            Shape::Capitalized => !at_start && !is_common(t),
            Shape::Other => false,
        }
    };
    let mut i = 0;
    while i < tokens.len() {
        // A run of capitalized or distinct tokens is one phrase.
        let mut j = i;
        while j < tokens.len()
            && !tokens[j].0.is_empty()
            && shape(&tokens[j].0) != Shape::Other
            && !is_junk(&tokens[j].0)
            && (j == i || !tokens[j].1)
        {
            j += 1;
        }
        if j == i {
            i += 1;
            continue;
        }
        let run = &tokens[i..j];
        let singles: Vec<&str> = run
            .iter()
            .filter(|(t, s)| keep_single(t, *s))
            .map(|(t, _)| t.as_str())
            .collect();
        if run.len() >= 2 && run.len() <= MAX_WORDS {
            // "Claude Code": a phrase with at least one name in it.
            let words: Vec<&str> = run
                .iter()
                .enumerate()
                .filter(|(k, (t, s))| !(*k == 0 && *s && is_common(t)))
                .map(|(_, (t, _))| t.as_str())
                .collect();
            let phrase = words.join(" ");
            if words.len() >= 2 && !singles.is_empty() && phrase.chars().count() <= MAX_CHARS {
                out.push(phrase);
            }
        }
        out.extend(singles.iter().map(|s| s.to_string()));
        i = j;
    }
    out
}

/// Rank the names in `texts`: nearest the caret first, then the rarest,
/// then the most frequent.
pub fn rank(texts: &[ScreenText]) -> Vec<Candidate> {
    let mut by_term: HashMap<String, Candidate> = HashMap::new();
    let mut order = Vec::new();
    for t in texts {
        for term in extract(&t.text) {
            let e = by_term.entry(term.clone()).or_insert_with(|| {
                order.push(term.clone());
                Candidate {
                    rarity: rarity(&term),
                    term,
                    distance: t.distance,
                    count: 0,
                }
            });
            e.distance = e.distance.min(t.distance);
            e.count += 1;
        }
    }
    let mut out: Vec<Candidate> = order
        .into_iter()
        .map(|t| by_term.remove(&t).unwrap())
        .collect();
    out.sort_by(|a, b| {
        a.distance
            .cmp(&b.distance)
            .then(b.rarity.cmp(&a.rarity))
            .then(b.count.cmp(&a.count))
    });
    out
}

/// Screen terms first (at most MAX_SCREEN), then custom words in their
/// order filling the rest, at most MAX_TERMS, no repeats.
pub fn combine(screen: &[Candidate], custom: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let seen = |out: &Vec<String>, t: &str| out.iter().any(|o| o.eq_ignore_ascii_case(t));
    let custom: Vec<&str> = custom
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .collect();
    for c in screen {
        if out.len() == MAX_SCREEN {
            break;
        }
        if !seen(&out, &c.term) && !custom.iter().any(|w| w.eq_ignore_ascii_case(&c.term)) {
            out.push(c.term.clone());
        }
    }
    for w in custom {
        if out.len() == MAX_TERMS {
            break;
        }
        if !seen(&out, w) {
            out.push(w.to_string());
        }
    }
    out
}

/// Letters and digits only, lowercase: the identity of a spelling.
fn letters(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// How a list term may be respelled.
#[derive(PartialEq)]
enum Respell {
    No,
    /// Only from the same words written differently ("Trailblazer").
    Joined,
    /// Also from separate words ("open pencil" to "OpenPencil").
    Split,
}

/// Whether a term is worth respelling, and how. Terms need an inner capital,
/// a digit or a word that is no ordinary dictionary word ("OpenPencil",
/// "K-0001", "Zelberg"; not "Hypothesis"). A compound made only of
/// ordinary words ("BackGround", "SetUp") is respelled from separate words
/// only when the user listed it as a custom word: from the screen it could
/// be ordinary speech ("in the back ground").
fn respellable(term: &str, trusted: bool) -> Respell {
    let inner_cap = term
        .split_whitespace()
        .any(|w| w.chars().skip(1).any(char::is_uppercase));
    let digit = term.chars().any(|c| c.is_ascii_digit());
    let parts = camel_parts(term);
    let uncommon = parts.iter().any(|w| !LEXICON.0.contains(&w.to_lowercase()));
    let n = letters(term).chars().count();
    let long_enough = if digit { n >= 3 } else { n >= 4 };
    if !long_enough || !(inner_cap || digit || uncommon) {
        Respell::No
    } else if uncommon || digit || trusted {
        Respell::Split
    } else {
        Respell::Joined
    }
}

/// The words of a term, CamelCase split ("OpenPencil" -> Open, Pencil).
fn camel_parts(term: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in term.split(|c: char| !c.is_alphabetic()) {
        let mut cur = String::new();
        for c in word.chars() {
            if c.is_uppercase() && cur.chars().last().is_some_and(char::is_lowercase) {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(c);
        }
        if !cur.is_empty() {
            out.push(cur);
        }
    }
    out
}

/// Characters a respelled span may hold between its first and last letter:
/// letters, digits, single spaces, hyphens and apostrophes. Anything else
/// (a period, comma, slash, bracket, quote, line break) is a boundary.
fn plain_core(core: &str) -> bool {
    !core.contains("  ")
        && core
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '\'' || c == '\u{2019}')
}

/// Respell list terms the decoder wrote with other casing or spacing:
/// a run of 1 to 3 words whose letters and digits equal a term's ("open
/// pencil", "Trailblazer") becomes the term ("OpenPencil", "TrailBlazer").
/// Outer punctuation and a possessive `'s` stay; spans never cross other
/// punctuation or line breaks. Exact letters only, so it changes how a
/// listed name is written, never what was said. `trusted` are the custom
/// words (see `respellable`). Longer terms go first; between terms with
/// the same letters, the earlier in the list wins.
pub fn restore_spelling(text: &str, terms: &[String], trusted: &[String]) -> String {
    // Respelling one name can expose a match for another (a split or joined
    // word): repeat to a fixed point. A chain of overlapping terms that does
    // not settle in a few passes leaves the text as decoded, so a second
    // call never gives another spelling.
    let mut cur = restore_once(text, terms, trusted);
    for _ in 0..4 {
        let next = restore_once(&cur, terms, trusted);
        if next == cur {
            return cur;
        }
        cur = next;
    }
    text.to_string()
}

fn restore_once(text: &str, terms: &[String], trusted: &[String]) -> String {
    // One spelling per set of letters: the earlier in the list wins, so a
    // second pass never flips a name back ("Zelberg" vs "Zel Berg").
    let mut seen = std::collections::HashSet::new();
    let mut terms: Vec<(&String, Respell)> = terms
        .iter()
        .filter(|t| seen.insert(letters(t)))
        .map(|t| (t, respellable(t, trusted.iter().any(|w| w == t))))
        .filter(|(_, r)| *r != Respell::No)
        .collect();
    if terms.is_empty() {
        return text.to_string();
    }
    terms.sort_by_key(|(t, _)| std::cmp::Reverse(letters(t).len()));
    // Words with what follows each (a space, a line break, nothing).
    let mut words: Vec<(String, String)> = Vec::new();
    for piece in regex_split(text) {
        match piece {
            Piece::Word(w) => words.push((w.to_string(), String::new())),
            Piece::Gap(g) => match words.last_mut() {
                Some(last) => last.1.push_str(g),
                None => words.push((String::new(), g.to_string())),
            },
        }
    }
    let mut used = vec![false; words.len()];
    for (term, how) in terms {
        let want = letters(term);
        let max_n = if how == Respell::Split { 3 } else { 1 };
        for n in 1..=max_n {
            for i in 0..words.len().saturating_sub(n - 1) {
                if used[i..i + n].iter().any(|u| *u)
                    || words[i..i + n - 1].iter().any(|(_, gap)| gap != " ")
                {
                    continue;
                }
                let span: String = words[i..i + n]
                    .iter()
                    .map(|(w, _)| w.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                let (Some(a), Some(b)) = (
                    span.find(|c: char| c.is_alphanumeric()),
                    span.rfind(|c: char| c.is_alphanumeric()),
                ) else {
                    continue;
                };
                let b = b + span[b..].chars().next().map_or(1, char::len_utf8);
                let mut core = &span[a..b];
                let mut suffix = "";
                for s in ["'s", "\u{2019}s"] {
                    if let Some(stem) = core.strip_suffix(s) {
                        core = stem;
                        suffix = s;
                    }
                }
                if !plain_core(core) || letters(core) != want {
                    continue;
                }
                if core == term.as_str() {
                    // Already as listed: keep it, and keep other terms off it.
                    used[i..i + n].iter_mut().for_each(|u| *u = true);
                    continue;
                }
                // An ordinary word only counts as the name when the decoder
                // already wrote it like one (capitalized).
                let ordinary = LEXICON.0.contains(&letters(core));
                let capital = core.chars().next().is_some_and(char::is_uppercase);
                if how == Respell::Joined && ordinary && !capital {
                    continue;
                }
                words[i].0 = format!("{}{}{}{}", &span[..a], term, suffix, &span[b..]);
                let gap = words[i + n - 1].1.clone();
                words[i].1 = gap;
                for w in words.iter_mut().take(i + n).skip(i + 1) {
                    *w = (String::new(), String::new());
                }
                used[i..i + n].iter_mut().for_each(|u| *u = true);
            }
        }
    }
    words.into_iter().map(|(w, g)| w + &g).collect()
}

enum Piece<'a> {
    Word(&'a str),
    Gap(&'a str),
}

/// Text split into words and the whitespace between them, losslessly.
fn regex_split(text: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_space = None;
    for (i, c) in text.char_indices() {
        let space = c.is_whitespace();
        if in_space.is_some_and(|s| s != space) {
            let part = &text[start..i];
            out.push(if in_space == Some(true) {
                Piece::Gap(part)
            } else {
                Piece::Word(part)
            });
            start = i;
        }
        in_space = Some(space);
    }
    if start < text.len() {
        let part = &text[start..];
        out.push(if in_space == Some(true) {
            Piece::Gap(part)
        } else {
            Piece::Word(part)
        });
    }
    out
}

/// The list for a dictation starting now: the cached names of the
/// frontmost window (never waiting on a walk, boost row 14) plus custom
/// words. Under secure input there are no screen names (row 16).
pub fn frozen_list(settings: &AppSettings) -> Vec<String> {
    let secure = crate::secure_input::is_enabled_now();
    let screen = if secure {
        Vec::new()
    } else {
        super::screen::cached_for_frontmost()
    };
    list_for(secure, &screen, &settings.custom_words)
}

fn list_for(secure: bool, screen: &[Candidate], custom: &[String]) -> Vec<String> {
    combine(if secure { &[] } else { screen }, custom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_names_and_drops_common_words_chrome_and_junk() {
        let got = extract(
            "Meeting notes. Ask Zelberg about QuillPad and the K-0001 build. \
             Settings Search https://example.com/x a1b2c3d4e5 ~/src/main.rs NASA ok AI",
        );
        assert!(got.contains(&"Zelberg".to_string()), "{got:?}");
        assert!(got.contains(&"QuillPad".to_string()));
        assert!(got.contains(&"K-0001".to_string()));
        assert!(got.contains(&"NASA".to_string()));
        for bad in [
            "Meeting",
            "Ask",
            "Settings",
            "Search",
            "ok",
            "AI",
            "a1b2c3d4e5",
        ] {
            assert!(!got.iter().any(|t| t == bad), "{bad} in {got:?}");
        }
        assert!(!got
            .iter()
            .any(|t| t.contains("example") || t.contains("main.rs")));
    }

    #[test]
    fn a_capitalized_common_word_at_a_sentence_start_is_not_a_name() {
        assert!(extract("Today we ship.").is_empty());
        assert_eq!(
            extract("We ship with Claude Code today."),
            vec!["Claude Code", "Claude"]
        );
    }

    #[test]
    fn phrases_are_at_most_three_words_and_24_characters() {
        let got = extract("see Alpha Bravo Charlie Delta here");
        assert!(!got.iter().any(|t| t.split(' ').count() > 3), "{got:?}");
        assert!(extract("the Supercalifragilisticexpialidocious one").is_empty());
    }

    #[test]
    fn lowercase_tokens_need_four_characters_and_a_digit_or_dash() {
        assert_eq!(extract("use cua-driver now"), vec!["cua-driver"]);
        assert!(extract("use a-b now").is_empty());
    }

    #[test]
    fn row20_ordinary_hyphenated_words_and_contractions_are_not_names() {
        // Junk a real window walk kept, curly apostrophes included.
        let got = extract(
            "so lift the key-up in-app after the five-minute and 5-minute follow-ups, \
             a prior-art one-shot all-sky check. Then I\u{2019}d say I\u{2019}m sure \
             and I'd say we're done, it isn\u{2019}t",
        );
        assert!(got.is_empty(), "{got:?}");
        let got = extract("screenshots-only and checkboxes-only, so Y'all and Y\u{2019}all know");
        assert!(got.is_empty(), "{got:?}");
        // Names keep working: a part that is no ordinary word, digits in a
        // name, and the name inside a possessive.
        let got = extract(
            "use cua-driver and gpt-4 with qa-bot, ask O'Brien about \
             SPHEREx\u{2019}s map and TrailBlazer's run",
        );
        for want in [
            "cua-driver",
            "gpt-4",
            "qa-bot",
            "O'Brien",
            "SPHEREx",
            "TrailBlazer",
        ] {
            assert!(got.iter().any(|t| t == want), "{want} missing from {got:?}");
        }
        assert!(
            !got.iter()
                .any(|t| t.ends_with("'s") || t.ends_with("\u{2019}s")),
            "{got:?}"
        );
    }

    #[test]
    fn ranking_is_distance_then_rarity_then_frequency() {
        let texts = [
            ScreenText {
                text: "talk to Zorblax and Zorblax".into(),
                distance: 2,
            },
            ScreenText {
                text: "with Quixotlan here".into(),
                distance: 0,
            },
            ScreenText {
                text: "and Mlorpvane there".into(),
                distance: 2,
            },
        ];
        let r: Vec<String> = rank(&texts).into_iter().map(|c| c.term).collect();
        assert_eq!(r, vec!["Quixotlan", "Zorblax", "Mlorpvane"]);
    }

    #[test]
    fn row8_listed_names_are_respelled_only_when_the_letters_match() {
        let list: Vec<String> = [
            "OpenPencil",
            "TrailBlazer",
            "K-0001",
            "Hypothesis",
            "Zelberg",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let r = |t: &str| restore_spelling(t, &list, &[]);
        assert_eq!(
            r("switch from openpencil, then Trailblazer."),
            "switch from OpenPencil, then TrailBlazer."
        );
        assert_eq!(r("build k 0001 now"), "build K-0001 now");
        assert_eq!(r("ask zelberg's team"), "ask Zelberg's team");
        // A common word is left alone, and other letters never match.
        assert_eq!(
            r("my hypothesis is open pencils"),
            "my hypothesis is open pencils"
        );
        assert_eq!(restore_spelling("no names here", &[], &[]), "no names here");
        // Idempotent: a second pass changes nothing, whatever the list holds.
        let both = vec!["Zelberg".to_string(), "Zel Berg".to_string()];
        let once = restore_spelling("ask zel berg now", &both, &[]);
        assert_eq!(once, "ask Zelberg now");
        assert_eq!(restore_spelling(&once, &both, &[]), once);
        // Overlapping terms reach their fixed point in one call.
        let overlap = vec!["Zorblax-Labs".to_string(), "Acme Zorblax".to_string()];
        let once = restore_spelling("acmezorblax labs", &overlap, &[]);
        assert_eq!(restore_spelling(&once, &overlap, &[]), once);
        // A long chain that does not settle: left as decoded, so stable too.
        let chain: Vec<String> = [
            "J0 K1 L2", "H8 I9 J0", "F6 G7 H8", "D4 E5 F6", "B2 C3 D4", "A1 B2",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let text = "a1b2 c3d4 e5f6 g7h8 i9j0 k1l2";
        let once = restore_spelling(text, &chain, &[]);
        assert_eq!(restore_spelling(&once, &chain, &[]), once);
    }

    #[test]
    fn row9_respelling_never_crosses_punctuation_or_line_breaks() {
        let list = vec!["OpenPencil".to_string(), "Zelberg".to_string()];
        let trusted = list.clone();
        let r = |t: &str| restore_spelling(t, &list, &trusted);
        assert_eq!(
            r("leave it open. pencil it in"),
            "leave it open. pencil it in"
        );
        assert_eq!(r("open/pencil"), "open/pencil");
        assert_eq!(r("open (pencil)"), "open (pencil)");
        assert_eq!(r("open\npencil"), "open\npencil");
        assert_eq!(r("open\tpencil"), "open\tpencil");
        assert_eq!(r("\"zel berg\" said"), "\"Zelberg\" said");
        // Separate words join only for a trusted (custom) compound.
        assert_eq!(r("open pencil today"), "OpenPencil today");
        assert_eq!(
            restore_spelling("open pencil today", &list, &[]),
            "open pencil today"
        );
    }

    #[test]
    fn row10_everyday_compounds_from_the_screen_stay_ordinary_words() {
        let list = vec![
            "BackGround".to_string(),
            "SetUp".to_string(),
            "GPT-4".to_string(),
        ];
        assert_eq!(
            restore_spelling("in the back ground, set up the gpt 4 run", &list, &[]),
            "in the back ground, set up the GPT-4 run"
        );
        // One ordinary word is the name only when written like one.
        assert_eq!(
            restore_spelling("open the background tab", &list, &[]),
            "open the background tab"
        );
        assert_eq!(
            restore_spelling("open the Background tab", &list, &[]),
            "open the BackGround tab"
        );
        // GPT-4 and GPT-5 are different names.
        assert_eq!(restore_spelling("gpt 5", &list, &[]), "gpt 5");
    }

    #[test]
    fn row16_secure_input_means_custom_words_only() {
        let screen = rank(&[ScreenText {
            text: "with Quixotlan".into(),
            distance: 0,
        }]);
        let custom = vec!["Voce".to_string()];
        assert_eq!(list_for(false, &screen, &custom), vec!["Quixotlan", "Voce"]);
        assert_eq!(list_for(true, &screen, &custom), vec!["Voce"]);
    }

    #[test]
    fn caps_hold_and_custom_words_backfill() {
        let screen: Vec<Candidate> = (0..20)
            .map(|i| Candidate {
                term: format!("Name{i}"),
                distance: 0,
                rarity: 2,
                count: 1,
            })
            .collect();
        let custom: Vec<String> = (0..20).map(|i| format!("Custom{i}")).collect();
        let list = combine(&screen, &custom);
        assert_eq!(list.len(), MAX_TERMS);
        assert_eq!(
            list.iter().filter(|t| t.starts_with("Name")).count(),
            MAX_SCREEN
        );
        // Fewer screen names leave more room for custom words, in order.
        let list = combine(&screen[..3], &custom);
        assert_eq!(list.len(), 23);
        assert_eq!(list[3], "Custom0");
        // A custom word also seen on screen appears once.
        let list = combine(&screen[..1], &["name0".to_string()]);
        assert_eq!(list, vec!["name0"]);
    }
}
