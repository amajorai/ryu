//! English sources for the onboarding profile build (`server/onboarding_profile`).
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!`, written as a whole
//! sentence. They are re-exported from [`super`], so callers keep using
//! `i18n::messages::NAME_MESSAGE`.
//!
//! Core renders them once, in the node's language, when it names the profile
//! conversation and when it writes the profile memory. The memory headings are
//! followed by a newline and the drafted profile, which is model output in the
//! node's language and is never looked up in the catalog.
#![allow(clippy::useless_format)]

use super::Template;

// ---- the profile conversation's title ---------------------------------------

pub const ONBOARDING_PROFILE_TITLE_MESSAGE: Template = |_| format!("Your private Ryu profile");
pub const ONBOARDING_COMPANY_KNOWLEDGE_TITLE_MESSAGE: Template =
    |_| format!("Your initial company knowledge");

// ---- the heading of the profile memory --------------------------------------

pub const ONBOARDING_PROFILE_MEMORY_HEADING_MESSAGE: Template =
    |_| format!("Private profile draft. Verify it before relying on it.");
pub const ONBOARDING_COMPANY_KNOWLEDGE_MEMORY_HEADING_MESSAGE: Template =
    |_| format!("Shared company knowledge draft. Verify it before relying on it.");

// ---- agent suggestion fallbacks ---------------------------------------------
//
// Shown on an agent suggestion when the model left that field empty.

pub const ONBOARDING_SUGGESTION_TITLE_FALLBACK_MESSAGE: Template = |_| format!("Suggested agent");
pub const ONBOARDING_SUGGESTION_SUMMARY_FALLBACK_MESSAGE: Template =
    |_| format!("A focused helper for a repeated workflow.");
pub const ONBOARDING_SUGGESTION_REASON_FALLBACK_MESSAGE: Template =
    |_| format!("This workflow showed up repeatedly in your recent work.");

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    ONBOARDING_PROFILE_TITLE_MESSAGE,
    ONBOARDING_COMPANY_KNOWLEDGE_TITLE_MESSAGE,
    ONBOARDING_PROFILE_MEMORY_HEADING_MESSAGE,
    ONBOARDING_COMPANY_KNOWLEDGE_MEMORY_HEADING_MESSAGE,
    ONBOARDING_SUGGESTION_TITLE_FALLBACK_MESSAGE,
    ONBOARDING_SUGGESTION_SUMMARY_FALLBACK_MESSAGE,
    ONBOARDING_SUGGESTION_REASON_FALLBACK_MESSAGE,
];
