//! The profile conversation title and memory heading, rendered per locale.

use super::*;
use crate::i18n::{messages, Message};

#[test]
fn the_conversation_title_follows_the_setup_kind() {
    assert_eq!(
        profile_conversation_title(false, "en"),
        "Your private Ryu profile"
    );
    assert_eq!(
        profile_conversation_title(true, "en"),
        "Your initial company knowledge"
    );
}

#[test]
fn the_title_is_rendered_from_its_catalogued_template() {
    for (team, template) in [
        (false, messages::ONBOARDING_PROFILE_TITLE_MESSAGE),
        (true, messages::ONBOARDING_COMPANY_KNOWLEDGE_TITLE_MESSAGE),
    ] {
        for locale in ["en", "ja", "ar", "de"] {
            assert_eq!(
                profile_conversation_title(team, locale),
                Message::new(template).render(locale)
            );
        }
    }
}

#[test]
fn the_memory_starts_with_its_heading_then_the_profile() {
    assert_eq!(
        profile_memory_content(false, "- Prefers short replies", "en"),
        "Private profile draft. Verify it before relying on it.\n- Prefers short replies"
    );
    assert_eq!(
        profile_memory_content(true, "- Ships weekly", "en"),
        "Shared company knowledge draft. Verify it before relying on it.\n- Ships weekly"
    );
}

#[test]
fn the_memory_heading_is_localized_but_the_profile_is_kept_verbatim() {
    // The profile is model output; braces in it are not ICU placeholders.
    let profile = "名前: {name} は {count} 件";
    for (team, template) in [
        (false, messages::ONBOARDING_PROFILE_MEMORY_HEADING_MESSAGE),
        (
            true,
            messages::ONBOARDING_COMPANY_KNOWLEDGE_MEMORY_HEADING_MESSAGE,
        ),
    ] {
        for locale in ["ja", "ar", "de"] {
            let heading = Message::new(template).render(locale);
            assert_ne!(heading, Message::new(template).render("en"), "{locale}");
            assert_eq!(
                profile_memory_content(team, profile, locale),
                format!("{heading}\n{profile}")
            );
        }
    }
}
