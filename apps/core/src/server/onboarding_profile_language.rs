//! The language of the onboarding profile draft and agent suggestions.
//!
//! The profile runs as an agent turn whose reply the user reads (the Markdown
//! profile and the suggested agents' names, descriptions and reasons), so the
//! turn's own prompt names the node's UI language
//! ([`crate::i18n::locale::node_locale`]). The `RYU_AGENT_SUGGESTIONS_JSON`
//! marker, JSON keys and tool ids stay English: the reply parser matches them.

use crate::i18n::reply_language::reply_language_instruction;

/// The profile turn's prompt for `locale`: `prompt` unchanged for English, or
/// with the reply-language line appended otherwise.
pub(super) fn with_profile_language(prompt: String, locale: &str) -> String {
    match reply_language_instruction(locale) {
        Some(instruction) => format!(
            "{}\n\n{instruction} This includes the profile and each suggestion's name, title, \
             description and reason; keep the RYU_AGENT_SUGGESTIONS_JSON marker and the tool ids \
             exactly as given.",
            prompt.trim_end()
        ),
        None => prompt,
    }
}
