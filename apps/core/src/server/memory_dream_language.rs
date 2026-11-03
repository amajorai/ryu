//! The language of Dream's review text.
//!
//! Dream's `summary` and each proposal's `reason` are model-written prose the
//! user reads in the review panel, so they follow the node's UI language
//! ([`crate::i18n::locale::node_locale`]). The proposed memories themselves
//! (`content`, `when_to_use`, `tags`) keep the language of the chat they came
//! from: a memory is recalled into later chats in that language, and
//! translating it would change the fact the user said. JSON keys and the
//! `category` values stay English because the parser matches them.

use crate::i18n::reply_language::english_language_name;

/// The Dream system prompt for `locale`: `system` unchanged for English, or
/// with a line naming the language for `summary` and `reason` otherwise.
pub(super) fn with_dream_language(system: String, locale: &str) -> String {
    let name = english_language_name(locale);
    if name == "English" {
        return system;
    }
    format!(
        "{}\n\nWrite \"summary\" and every \"reason\" in {name}. Keep each memory's \"content\", \
         \"when_to_use\" and \"tags\" in the original language of its source messages; do not \
         translate them. Keep JSON keys and \"category\" values exactly as given, in English.",
        system.trim_end()
    )
}
