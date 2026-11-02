//! The sentences a failover verdict carries, as Core messages.
//!
//! A verdict's `note` is rendered in the node's language: the failover wrapper
//! sends it as a visible text part, which is all a native, Island or TUI client
//! shows. The same sentences travel as `messages` (`{ message, args }`, the
//! English ICU source plus its values, see
//! [`crate::i18n::messages::FAILOVER_WAIT_MESSAGE`] and its siblings), so the
//! desktop renders them in the reader's own language and time zone.

use std::sync::RwLock;

use chrono::{DateTime, FixedOffset};
use serde_json::Value;

use crate::i18n::{locale, messages, Message};

/// The node's language, as of the last failover read.
///
/// [`super::decide`] is pure and synchronous, while the node's `ui-language`
/// preference is an async read. [`super::read_all_windows`], which every live
/// decision awaits first, refreshes this, so the note matches the language the
/// node is set to. It starts in English.
static NODE_LOCALE: RwLock<&'static str> = RwLock::new("en");

/// The locale a live verdict's note is rendered in.
pub(super) fn node_locale() -> &'static str {
    NODE_LOCALE.read().map_or("en", |locale| *locale)
}

/// Record the node's language for the next note.
pub(super) fn set_node_locale(tag: &'static str) {
    if let Ok(mut locale) = NODE_LOCALE.write() {
        *locale = tag;
    }
}

/// A human name for an agent id (`acp:claude` → `Claude`).
pub(super) fn display_agent(agent_id: &str) -> String {
    let bare = agent_id.strip_prefix("acp:").unwrap_or(agent_id);
    match bare.to_ascii_lowercase().as_str() {
        "claude" => "Claude".to_string(),
        "codex" => "Codex".to_string(),
        "copilot" => "Copilot".to_string(),
        "grok" => "Grok".to_string(),
        "glm" => "GLM".to_string(),
        other => title(other),
    }
}

/// Title-case an unknown agent id for display.
fn title(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

/// The vendor's plan name, when it gave a non-blank one. Absent is the ordinary
/// case for a gateway 429 against a provider with no subscription window.
fn plan_name(reading: Option<&super::AgentWindows>) -> Option<&str> {
    reading
        .and_then(|r| r.plan.as_deref())
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
}

/// "Claude has reached its session limit on your Max plan." `window` is the
/// spent window's label, or `None` when the cap was reported outright and no
/// window confirmed it.
pub(super) fn out_of(
    failed_agent: &str,
    window: Option<&str>,
    reading: Option<&super::AgentWindows>,
) -> Message {
    let agent = display_agent(failed_agent);
    let message = match (window, plan_name(reading)) {
        (Some(window), Some(plan)) => Message::new(messages::FAILOVER_OUT_OF_WINDOW_PLAN_MESSAGE)
            .text("window", window.to_lowercase())
            .text("plan", plan),
        (Some(window), None) => Message::new(messages::FAILOVER_OUT_OF_WINDOW_MESSAGE)
            .text("window", window.to_lowercase()),
        (None, Some(plan)) => {
            Message::new(messages::FAILOVER_OUT_OF_USAGE_PLAN_MESSAGE).text("plan", plan)
        }
        (None, None) => Message::new(messages::FAILOVER_OUT_OF_USAGE_MESSAGE),
    };
    message.text("agent", agent)
}

/// "Retrying on Codex, which has 80% left."
pub(super) fn retrying(agent_id: &str, headroom: f64) -> Message {
    Message::new(messages::FAILOVER_RETRYING_MESSAGE)
        .text("agent", display_agent(agent_id))
        .number("headroom", headroom, 0, 0)
}

/// "Codex still has 80% left. Reactive failover is set to notify only, …"
pub(super) fn held(agent_id: &str, headroom: f64) -> Message {
    Message::new(messages::FAILOVER_HELD_MESSAGE)
        .text("agent", display_agent(agent_id))
        .number("headroom", headroom, 0, 0)
}

/// "Every plan is out of room. The first to reopen is …, at 18:40 on Sunday,
/// November 1." The time and day are in the node's local zone; the desktop
/// replaces both from the verdict's `resets_at` in the reader's zone.
pub(super) fn wait(agent_id: &str, window: &str, at: DateTime<FixedOffset>) -> Message {
    let local = at.with_timezone(&chrono::Local);
    Message::new(messages::FAILOVER_WAIT_MESSAGE)
        .text("window", window.to_lowercase())
        .text("agent", display_agent(agent_id))
        .text("time", local.format("%H:%M").to_string())
        .date("date", local.date_naive())
}

/// "No other plan with room was found."
pub(super) fn no_candidate() -> Message {
    Message::new(messages::FAILOVER_NO_CANDIDATE_MESSAGE)
}

/// The note rendered for `tag`, plus the wire form of each sentence.
pub(super) fn finish(sentences: &[Message], tag: &str) -> (String, Vec<Value>) {
    let mut note = String::new();
    for sentence in sentences {
        let text = sentence.render(tag);
        if !note.is_empty() {
            // A sentence still in English (no translation yet) keeps its space
            // even in Japanese or Chinese.
            note.push_str(if note.ends_with(|c: char| c.is_ascii()) {
                " "
            } else {
                locale::sentence_separator(tag)
            });
        }
        note.push_str(&text);
    }
    (note, sentences.iter().map(Message::to_wire).collect())
}
