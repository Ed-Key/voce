//! Name boosting (docs/boost-lifecycle.md): a frozen list of names, read off
//! the screen near the caret plus the custom words, is boosted inside the
//! live stream's own decoder, and the listed spellings are restored in the
//! text.

#[cfg(target_os = "macos")]
mod ax;
pub mod list;
pub mod screen;
