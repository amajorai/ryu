//! The language Marketplace "For you" reasons are written in.
//!
//! The reasons are model-written prose the user reads next to the translated
//! Store UI, so the side-model prompt names the node's UI language
//! ([`crate::i18n::locale::node_locale`]) and the feed cache is keyed by it: a
//! language switch regenerates the reasons instead of serving English rows.
//! The JSON keys and the `kind`/`id` values the parser matches stay English.

use crate::i18n::reply_language::reply_language_instruction;

/// The recommendation adapter's base system prompt (English scaffolding).
const RECOMMENDATION_SYSTEM: &str = "You are Ryu's Marketplace recommendation adapter. Rank only the supplied catalog references. Return safe derived reasons and never request or reveal private user context, memory text, credentials, or connection payloads.";

/// The system prompt for `locale`: the base prompt, plus the reply-language
/// line for any language other than English.
pub(super) fn recommendation_system(locale: &str) -> String {
    match reply_language_instruction(locale) {
        Some(instruction) => format!("{RECOMMENDATION_SYSTEM}\n\n{instruction}"),
        None => RECOMMENDATION_SYSTEM.to_owned(),
    }
}

/// The feed cache key. The resolved UI language is part of it, so cached
/// reasons in one language are never served after a switch to another.
pub(super) fn feed_cache_key(
    gateway: &str,
    scope: &str,
    revision: &str,
    profile_revision: &str,
    settings: &str,
    locale: &str,
) -> String {
    let language = crate::i18n::locale::resolve(locale);
    format!("{gateway}:{scope}:{revision}:{profile_revision}:{settings}:{language}")
}
