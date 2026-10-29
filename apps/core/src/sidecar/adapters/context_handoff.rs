//! Context handoff across a model change.
//!
//! Switching a conversation from a large-context model to a smaller one (1M →
//! 256k, a cloud model → a local 8k model) leaves the new model with a history
//! it cannot hold. Without a handoff the provider rejects the turn or the
//! engine's own context shift silently evicts the system prompt. A handoff
//! summarizes everything said *before* the switch once, with a briefing prompt,
//! and from then on the new model receives that briefing plus the turns that
//! came after the switch.
//!
//! The decision is a per-node preference, `context.handoff-on-model-change`:
//!
//! * `smaller-context` (default) — hand off when the new model's context window
//!   is smaller than the previous model's AND the earlier history no longer
//!   fits the new window. Switching between same-size models, or to a smaller
//!   model while the chat is still short, changes nothing.
//! * `different-provider` — hand off whenever the provider changes, regardless
//!   of size (a fresh briefing instead of replaying another vendor's turns).
//! * `always` — hand off on every model change.
//! * `off` — never; the full history is sent as before.
//!
//! The decision, the summary and its boundary are persisted per model change by
//! `server::context_handoff` (see `ConversationStore::record_context_handoff`),
//! so the summary is produced once, replayed byte-identically on every later
//! turn (provider prompt caches keep hitting), and shown in the transcript as a
//! marker. This module holds the pure policy and the two plane appliers.

use super::context_window::{estimate_tokens, PER_MESSAGE_OVERHEAD};
use super::UiMessage;
use crate::server::conversations::{ConversationStore, StoredMessage};

/// Preference key holding the handoff policy.
pub const HANDOFF_PREF: &str = "context.handoff-on-model-change";

/// Upper bound on post-handoff rows replayed on the ACP plane. Matches the
/// context-window module's fetch cap so the rendered replay stays bounded.
const MAX_POST_HANDOFF_FETCH: usize = 400;

/// When a model change hands the earlier history off as a summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffPolicy {
    Off,
    SmallerContext,
    DifferentProvider,
    Always,
}

impl HandoffPolicy {
    /// Parse the stored preference. Unset or unknown values use the default,
    /// `smaller-context`, so a typo never silently disables the safety net.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("off" | "never" | "false" | "0") => Self::Off,
            Some("different-provider" | "provider") => Self::DifferentProvider,
            Some("always" | "all") => Self::Always,
            _ => Self::SmallerContext,
        }
    }
}

/// The model on one side of a change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandoffSide {
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    /// Context window in tokens, when known.
    pub context_window: Option<usize>,
}

/// Why a handoff fires. The wire strings are stored on the marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffReason {
    SmallerContext,
    DifferentProvider,
    Always,
}

impl HandoffReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SmallerContext => "smaller-context",
            Self::DifferentProvider => "different-provider",
            Self::Always => "always",
        }
    }

    /// Whether this reason hands off only when the earlier history overflows the
    /// new window. The size rule exists to keep the chat working, so it never
    /// pays for a summary the new model does not need; the other two are
    /// explicit opt-ins that want the briefing regardless.
    pub fn requires_overflow(self) -> bool {
        matches!(self, Self::SmallerContext)
    }
}

/// Decide whether a change from `previous` to `next` triggers a handoff. PURE.
///
/// `smaller-context` needs both windows: an unknown window cannot be compared,
/// and guessing would summarize chats that did not need it.
pub fn decide(
    policy: HandoffPolicy,
    previous: &HandoffSide,
    next: &HandoffSide,
) -> Option<HandoffReason> {
    if previous.provider_id == next.provider_id && previous.model_id == next.model_id {
        return None;
    }
    match policy {
        HandoffPolicy::Off => None,
        HandoffPolicy::Always => Some(HandoffReason::Always),
        HandoffPolicy::DifferentProvider => {
            (previous.provider_id != next.provider_id).then_some(HandoffReason::DifferentProvider)
        }
        HandoffPolicy::SmallerContext => match (previous.context_window, next.context_window) {
            (Some(before), Some(after)) if after < before => Some(HandoffReason::SmallerContext),
            _ => None,
        },
    }
}

/// Estimated tokens of stored turns, with the same heuristic the context window
/// uses for its ACP replay.
pub fn estimate_stored_tokens(messages: &[StoredMessage]) -> usize {
    messages
        .iter()
        .map(|message| estimate_tokens(&message.content) + PER_MESSAGE_OVERHEAD)
        .sum()
}

/// A recorded handoff, ready to apply to one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextHandoff {
    /// The labelled briefing that replaces the earlier history.
    pub summary: String,
    /// How many non-system turns the briefing replaces (OpenAI plane).
    pub summarized_count: usize,
    /// Unix milliseconds: stored turns before this are covered (ACP plane).
    pub boundary_at: i64,
}

/// Replace the summarized prefix of a client-sent message array. Returns the
/// briefing for the caller to merge into the system prompt, or `None` when the
/// array does not extend past the summarized prefix, in which case the messages
/// are left untouched. The handoff is resolved for the active thread (an edit
/// before the switch gets its own), so its count lines up with the array the
/// client sends for that thread.
///
/// Every `system` message is kept in place; only the first `summarized_count`
/// non-system turns are removed.
pub fn apply_openai(messages: &mut Vec<UiMessage>, handoff: &ContextHandoff) -> Option<String> {
    let turns = messages.iter().filter(|m| m.role != "system").count();
    if handoff.summarized_count == 0 || turns <= handoff.summarized_count {
        return None;
    }
    let mut dropped = 0usize;
    messages.retain(|message| {
        if message.role == "system" || dropped >= handoff.summarized_count {
            return true;
        }
        dropped += 1;
        false
    });
    Some(handoff.summary.clone())
}

/// The ACP short-term replay after a handoff: the briefing, then the turns on
/// the active thread since the switch, excluding the just-persisted current
/// user turn. Read from the active thread (not the flat log) so a branch the
/// user left never leaks into the replay.
///
/// The post-switch turns are windowed newest-first to `budget` tokens so a long
/// chat after the switch still fits the new model.
pub async fn short_term(
    store: &ConversationStore,
    conversation_id: &str,
    handoff: &ContextHandoff,
    budget: Option<usize>,
) -> Option<String> {
    let thread = match store.get_active_messages(conversation_id).await {
        Ok(thread) => thread,
        Err(error) => {
            tracing::warn!("failed to load post-handoff context: {error:#}");
            return None;
        }
    };
    let start = thread.len().saturating_sub(MAX_POST_HANDOFF_FETCH);
    Some(render_short_term(&thread[start..], handoff, budget))
}

/// PURE body of [`short_term`].
fn render_short_term(
    recent: &[StoredMessage],
    handoff: &ContextHandoff,
    budget: Option<usize>,
) -> String {
    // The final entry is the current user turn, which ACP sends separately.
    let prior = recent.split_last().map_or(&[][..], |(_, prior)| prior);
    let after: Vec<&StoredMessage> = prior
        .iter()
        .filter(|message| message.created_at >= handoff.boundary_at && message.role != "system")
        .collect();
    let keep = match budget {
        Some(budget) => {
            let budget = budget.saturating_sub(estimate_tokens(&handoff.summary));
            let estimates: Vec<usize> = after
                .iter()
                .map(|message| estimate_tokens(&message.content) + PER_MESSAGE_OVERHEAD)
                .collect();
            let mut total = 0usize;
            let mut kept = 0usize;
            for tokens in estimates.iter().rev() {
                if total + tokens > budget {
                    break;
                }
                total += tokens;
                kept += 1;
            }
            kept
        }
        None => after.len(),
    };
    let mut block = String::from("Conversation so far:\n");
    block.push_str(handoff.summary.trim());
    block.push('\n');
    for message in &after[after.len() - keep..] {
        block.push_str(&message.role);
        block.push_str(": ");
        block.push_str(message.content.trim());
        block.push('\n');
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::adapters::UiContent;

    fn side(provider: &str, model: &str, window: Option<usize>) -> HandoffSide {
        HandoffSide {
            provider_id: Some(provider.to_owned()),
            model_id: Some(model.to_owned()),
            context_window: window,
        }
    }

    fn ui(role: &str, text: &str) -> UiMessage {
        UiMessage {
            metadata: None,
            role: role.to_owned(),
            content: UiContent::Text(text.to_owned()),
            parts: vec![],
        }
    }

    fn stored(role: &str, text: &str, created_at: i64) -> StoredMessage {
        StoredMessage {
            id: format!("m{created_at}"),
            role: role.to_owned(),
            content: text.to_owned(),
            agent_id: None,
            author_user_id: None,
            author_name: None,
            source: None,
            widget_instance_id: None,
            origin_server: None,
            parts: None,
            metadata: None,
            parent_message_id: None,
            interrupted: false,
            sibling_index: 0,
            sibling_count: 1,
            sibling_ids: Vec::new(),
            created_at,
        }
    }

    fn handoff(count: usize, boundary_at: i64) -> ContextHandoff {
        ContextHandoff {
            summary: "[Handoff]\n- earlier".to_owned(),
            summarized_count: count,
            boundary_at,
        }
    }

    #[test]
    fn policy_defaults_to_smaller_context() {
        assert_eq!(HandoffPolicy::parse(None), HandoffPolicy::SmallerContext);
        assert_eq!(
            HandoffPolicy::parse(Some("")),
            HandoffPolicy::SmallerContext
        );
        assert_eq!(
            HandoffPolicy::parse(Some("bogus")),
            HandoffPolicy::SmallerContext
        );
        assert_eq!(HandoffPolicy::parse(Some(" OFF ")), HandoffPolicy::Off);
        assert_eq!(HandoffPolicy::parse(Some("always")), HandoffPolicy::Always);
        assert_eq!(
            HandoffPolicy::parse(Some("different-provider")),
            HandoffPolicy::DifferentProvider
        );
    }

    #[test]
    fn smaller_context_needs_a_known_smaller_window() {
        let big = side("anthropic", "a", Some(1_000_000));
        let small = side("openai", "b", Some(256_000));
        let unknown = side("openai", "c", None);
        let policy = HandoffPolicy::SmallerContext;
        assert_eq!(
            decide(policy, &big, &small),
            Some(HandoffReason::SmallerContext)
        );
        assert_eq!(decide(policy, &small, &big), None);
        assert_eq!(decide(policy, &big, &unknown), None);
        assert_eq!(decide(policy, &unknown, &small), None);
    }

    #[test]
    fn provider_and_always_policies() {
        let a = side("anthropic", "a", Some(200_000));
        let a2 = side("anthropic", "a2", Some(200_000));
        let b = side("openai", "b", Some(200_000));
        assert_eq!(decide(HandoffPolicy::DifferentProvider, &a, &a2), None);
        assert_eq!(
            decide(HandoffPolicy::DifferentProvider, &a, &b),
            Some(HandoffReason::DifferentProvider)
        );
        assert_eq!(
            decide(HandoffPolicy::Always, &a, &a2),
            Some(HandoffReason::Always)
        );
        assert_eq!(decide(HandoffPolicy::Always, &a, &a), None);
        assert_eq!(decide(HandoffPolicy::Off, &a, &b), None);
    }

    #[test]
    fn openai_plane_replaces_the_summarized_prefix_and_keeps_system() {
        let mut messages = vec![
            ui("system", "base"),
            ui("user", "one"),
            ui("assistant", "two"),
            ui("user", "three"),
        ];
        let summary = apply_openai(&mut messages, &handoff(2, 0));
        assert_eq!(summary.as_deref(), Some("[Handoff]\n- earlier"));
        let roles: Vec<&str> = messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["system", "user"]);
        assert_eq!(messages[1].content.as_text(), "three");
    }

    #[test]
    fn openai_plane_skips_a_branch_from_before_the_switch() {
        let mut messages = vec![ui("user", "one"), ui("user", "edited")];
        assert_eq!(apply_openai(&mut messages, &handoff(2, 0)), None);
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn acp_replay_is_briefing_plus_post_switch_turns() {
        let recent = vec![
            stored("user", "old question", 10),
            stored("assistant", "old answer", 20),
            stored("user", "new question", 110),
            stored("assistant", "new answer", 120),
            stored("user", "current", 130),
        ];
        let block = render_short_term(&recent, &handoff(2, 100), None);
        assert!(block.contains("[Handoff]"));
        assert!(block.contains("user: new question"));
        assert!(block.contains("assistant: new answer"));
        assert!(!block.contains("old question"));
        assert!(!block.contains("current"));
    }

    #[test]
    fn acp_replay_windows_post_switch_turns_to_the_budget() {
        let long = "x".repeat(3500);
        let recent = vec![
            stored("user", &long, 110),
            stored("assistant", "short", 120),
            stored("user", "current", 130),
        ];
        let block = render_short_term(&recent, &handoff(0, 100), Some(100));
        assert!(block.contains("assistant: short"));
        assert!(!block.contains(&long));
    }
}
