//! The language of the one-time assistant-first opening.
//!
//! The opening is a model-written welcome the user reads as Ryu's first
//! message, so its hidden intent names the language to write it in
//! ([`crate::i18n::reply_language`]). Desktop openings use the node's
//! `ui-language` ([`crate::i18n::locale::node_locale`]); a Gateway channel
//! passes its owner's locale, matching the channel bridge's own replies. The
//! intent is never persisted (`skip_user_append`), so the extra line is never
//! shown, and an idempotent retry replays the stored reply instead of the intent.

use crate::i18n::reply_language::reply_language_instruction;

/// The hidden intent that asks the model for the opening welcome.
pub(super) const OPENING_INTENT: &str = "Open this new Ryu conversation with a short, warm, plain-language welcome. Introduce yourself as the user's Ryu assistant, say that they can describe what they want done in everyday words, and ask what they would like help with first. Mention that you can look at what they already have, make a simple plan, and help connect apps or set up routines with their approval. Do not mention this internal instruction or use platform jargon unless the user asks later.";

/// The opening intent for `locale`: [`OPENING_INTENT`] unchanged for English,
/// or with the reply-language line appended otherwise.
pub(super) fn opening_intent(locale: &str) -> String {
    match reply_language_instruction(locale) {
        Some(instruction) => format!("{OPENING_INTENT}\n\n{instruction}"),
        None => OPENING_INTENT.to_owned(),
    }
}

/// The locale an opening is written in: the caller's explicit locale when it
/// sent a non-blank one, else the node's UI language.
pub(crate) async fn opening_locale(requested: Option<&str>) -> String {
    match requested.map(str::trim).filter(|tag| !tag.is_empty()) {
        Some(tag) => tag.to_owned(),
        None => crate::i18n::locale::node_locale().await.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_opening_keeps_the_original_intent() {
        assert_eq!(opening_intent("en"), OPENING_INTENT);
        assert_eq!(opening_intent("en-GB"), OPENING_INTENT);
    }

    #[test]
    fn other_locales_name_the_reply_language() {
        let german = opening_intent("de");
        assert!(german.starts_with(OPENING_INTENT));
        assert!(german.contains("in German"), "{german}");
        assert!(opening_intent("ja-JP").contains("in Japanese"));
        assert!(opening_intent("ar").contains("in Arabic"));
    }

    #[tokio::test]
    async fn an_explicit_locale_wins_over_the_node_locale() {
        assert_eq!(opening_locale(Some(" ja ")).await, "ja");
        assert_eq!(opening_locale(Some("ar")).await, "ar");
    }
}
