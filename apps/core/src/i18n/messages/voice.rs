//! English sources for voice-mode status and errors.
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! `POST /api/voice/speak` (`server/voice/speak_route.rs`) answers with these
//! rendered in English, and the Companion's localizer matches them. A sentence
//! the Ryu Audio sidecar wrote is relayed alone, never wrapped in one of these,
//! so its own catalog entry still matches. `{engine}` is an engine id and
//! `{error}` a raw local error chain; neither is translated.
#![allow(clippy::useless_format)]

use super::Template;

// ---- request checks -----------------------------------------------------------

pub const VOICE_SPEAK_OWNER_ONLY_MESSAGE: Template =
    |_| format!("Custom and cloned voices are available to the node owner only.");
pub const VOICE_SPEAK_TEXT_LIMIT_MESSAGE: Template = |arg| {
    format!(
        "Text must be at most {limit} characters.",
        limit = arg("limit")
    )
};
pub const VOICE_SPEAK_ONE_REFERENCE_MESSAGE: Template =
    |_| format!("Provide one voice reference sample.");
pub const VOICE_SPEAK_MISSING_TEXT_MESSAGE: Template = |_| format!("Enter the text to speak.");

// ---- engine failures ----------------------------------------------------------

pub const VOICE_SPEAK_OUTETTS_FAILED_MESSAGE: Template = |arg| {
    format!(
        "OuteTTS could not generate audio: {error}",
        error = arg("error")
    )
};
pub const VOICE_SPEAK_GATEWAY_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Gateway Audio could not generate audio: {error}",
        error = arg("error")
    )
};
pub const VOICE_SPEAK_AUDIOCPP_FAILED_MESSAGE: Template = |arg| {
    format!(
        "The native audio engine could not generate audio: {error}",
        error = arg("error")
    )
};
pub const VOICE_SPEAK_FALLBACK_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Audio engine {engine} failed, and the OuteTTS fallback also failed.",
        engine = arg("engine")
    )
};

// ---- the Ryu Audio sidecar ----------------------------------------------------

pub const VOICE_SIDECAR_UNREACHABLE_MESSAGE: Template =
    |_| format!("The Ryu Audio sidecar could not be reached.");
pub const VOICE_ENGINE_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Audio engine {engine} failed with status {status}.",
        engine = arg("engine"),
        status = arg("status")
    )
};
pub const VOICE_ENGINE_CONTENT_TYPE_MESSAGE: Template = |arg| {
    format!(
        "Audio engine {engine} returned an unsupported content type.",
        engine = arg("engine")
    )
};
pub const VOICE_ENGINE_READ_FAILED_MESSAGE: Template = |arg| {
    format!(
        "The audio from engine {engine} could not be read.",
        engine = arg("engine")
    )
};
pub const VOICE_ENGINE_EMPTY_AUDIO_MESSAGE: Template = |arg| {
    format!(
        "Audio engine {engine} returned no audio.",
        engine = arg("engine")
    )
};

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    VOICE_SPEAK_OWNER_ONLY_MESSAGE,
    VOICE_SPEAK_TEXT_LIMIT_MESSAGE,
    VOICE_SPEAK_ONE_REFERENCE_MESSAGE,
    VOICE_SPEAK_MISSING_TEXT_MESSAGE,
    VOICE_SPEAK_OUTETTS_FAILED_MESSAGE,
    VOICE_SPEAK_GATEWAY_FAILED_MESSAGE,
    VOICE_SPEAK_AUDIOCPP_FAILED_MESSAGE,
    VOICE_SPEAK_FALLBACK_FAILED_MESSAGE,
    VOICE_SIDECAR_UNREACHABLE_MESSAGE,
    VOICE_ENGINE_FAILED_MESSAGE,
    VOICE_ENGINE_CONTENT_TYPE_MESSAGE,
    VOICE_ENGINE_READ_FAILED_MESSAGE,
    VOICE_ENGINE_EMPTY_AUDIO_MESSAGE,
];
