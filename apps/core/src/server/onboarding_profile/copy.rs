//! The profile build's user-visible text, rendered in the node's language: the
//! profile conversation's title and the heading of the profile memory.

use crate::i18n::{messages, Message};

/// The title of the owner-scoped profile conversation.
pub(super) fn profile_conversation_title(team_knowledge: bool, locale: &str) -> String {
    let template = if team_knowledge {
        messages::ONBOARDING_COMPANY_KNOWLEDGE_TITLE_MESSAGE
    } else {
        messages::ONBOARDING_PROFILE_TITLE_MESSAGE
    };
    Message::new(template).render(locale)
}

/// The profile memory: a localized "verify before relying on it" heading, then
/// the drafted profile as the agent wrote it.
pub(super) fn profile_memory_content(team_knowledge: bool, profile: &str, locale: &str) -> String {
    let template = if team_knowledge {
        messages::ONBOARDING_COMPANY_KNOWLEDGE_MEMORY_HEADING_MESSAGE
    } else {
        messages::ONBOARDING_PROFILE_MEMORY_HEADING_MESSAGE
    };
    format!("{}\n{profile}", Message::new(template).render(locale))
}
