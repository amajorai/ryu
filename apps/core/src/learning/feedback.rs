//! Thumbs feedback: seed the reward + RAG-memory sinks from a 👍 / 👎.
//!
//! See [`apply_message_feedback`] and the module docs on `crate::learning` for why
//! this sink stays Core-side.

use serde::Serialize;

use ryu_learning::Experience;

use super::learning_ctx;
use crate::server::{memory, ServerState};

/// Reward written into the experience buffer for a 👍 / 👎. 👍 is a maximal
/// positive so it always clears `learning.min-reward`; 👎 is `0.0` so it is
/// dropped from the reward-filtered SFT set.
const FEEDBACK_REWARD_UP: f64 = 1.0;
const FEEDBACK_REWARD_DOWN: f64 = 0.0;
/// Importance (1..=5) for a feedback-derived memory fact. Above the default (3)
/// so a human-labelled example is recalled ahead of ambient facts.
const FEEDBACK_MEMORY_IMPORTANCE: i32 = 4;
/// Cap the assistant snippet stored in a memory fact so a long reply doesn't
/// dominate the recall budget.
const FEEDBACK_SNIPPET_CHARS: usize = 600;

/// What a thumbs vote actually seeded downstream. Returned to the client so the
/// UI can hint (e.g. "saved to memory") and for tests. All-false is normal when
/// the vote was cleared or the relevant opt-ins are off.
#[derive(Debug, Clone, Default, Serialize)]
pub struct FeedbackOutcome {
    /// A reward was written into the experience buffer (training path on).
    pub reward_captured: bool,
    /// A RAG memory fact was recorded (memory sink on).
    pub memory_captured: bool,
}

/// Seed the continual-learning reward and the RAG-memory sinks from a thumbs vote
/// on an assistant message. The message's own `feedback` column is set by the
/// caller (durable UI state); this only fans the vote out to the two learners.
///
/// Stays Core-side (not in the `ryu-learning` crate) because the memory sink is
/// welded to Core's `memory`/`retrieval` stores; it drives the experience buffer
/// and the consent resolvers through the crate's public API.
///
/// - **Reward sink** (gated on [`ryu_learning::resolve_enabled`], default OFF):
///   upsert the turn into the experience buffer, then `set_reward` to `1.0` (👍) or
///   `0.0` (👎). A human label is authoritative — `set_reward` overwrites any prior
///   PRM score, and a 👎 at `0.0` is dropped from the reward-filtered training set.
/// - **Memory sink** (gated on [`ryu_learning::resolve_feedback_memory_enabled`],
///   default ON): a 👍 records the exchange as a recallable good example; a 👎
///   optionally records an "avoid" note (gated on
///   [`ryu_learning::resolve_feedback_down_negative`]).
///
/// `rating` is `Some("up")` / `Some("down")` to seed, or `None` (a cleared vote)
/// which is a no-op here. Fail-soft: a sink error is logged, not propagated, so a
/// downstream hiccup never fails the user's click.
pub async fn apply_message_feedback(
    state: &ServerState,
    conversation_id: &str,
    message_id: &str,
    rating: Option<&str>,
    caller_user_id: Option<&str>,
) -> FeedbackOutcome {
    let mut outcome = FeedbackOutcome::default();
    let ctx = learning_ctx(state);
    let host = &*ctx.host;
    // Tag stamped on every feedback-derived memory fact for this message, so a
    // changed or cleared vote can find and remove its prior artifacts.
    let msg_tag = format!("msg:{message_id}");

    // Roll back any prior feedback artifacts for this message FIRST (idempotent),
    // so re-voting, changing up↔down, or clearing never leaves a stale reward or a
    // contradictory memory fact. Clearing the reward reverts the row to unscored
    // (PRM-rescorable) rather than keeping a dead human label.
    if ryu_learning::resolve_enabled(host).await {
        if let Err(e) = state.experience.clear_reward(message_id).await {
            tracing::warn!("feedback: clearing reward {message_id} failed: {e:#}");
        }
    }
    match state.memory.ids_with_tag(&msg_tag).await {
        Ok(ids) => {
            for id in ids {
                let _ = state.memory.delete(&id).await;
                let _ = state.retrieval.remove_chunk(&id).await;
            }
        }
        Err(e) => tracing::warn!("feedback: listing prior memory facts failed: {e:#}"),
    }

    let is_up = match rating {
        Some("up") => true,
        Some("down") => false,
        // Cleared (or unknown) rating: the rollback above is the whole job.
        _ => return outcome,
    };

    // Per-conversation learning opt-out is honored here exactly as the sweep /
    // score / cycle paths honor it: an excluded conversation's plaintext must
    // never be staged into the buffer or a memory fact.
    if ryu_learning::resolve_excluded(host, conversation_id).await {
        return outcome;
    }

    // Fetch the (user prompt, assistant reply) pair this vote refers to. Both
    // sinks need it; if we can't resolve the turn there is nothing to seed.
    let turn = match state
        .conversations
        .get_turn_for_assistant_message(conversation_id, message_id)
        .await
    {
        Ok(Some(t)) => t,
        Ok(None) => return outcome,
        Err(e) => {
            tracing::warn!("feedback: resolving turn {message_id} failed: {e:#}");
            return outcome;
        }
    };
    let (user_text, assistant_text, agent_id) = turn;
    if user_text.trim().is_empty() || assistant_text.trim().is_empty() {
        return outcome;
    }

    // --- Reward sink (training path; explicit opt-in) ------------------------
    if ryu_learning::resolve_enabled(host).await {
        let generation = ryu_learning::resolve_skill_generation(host).await;
        let exp = Experience {
            id: message_id.to_string(),
            conversation_id: conversation_id.to_string(),
            agent_id: agent_id.clone(),
            user_text: user_text.clone(),
            assistant_text: assistant_text.clone(),
            outcome: "completed".to_string(),
            reward: None,
            base_model: None,
            skill_generation: generation,
            excluded: false,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        // Insert-if-absent then overwrite the reward: a human label wins over any
        // PRM score already on the row.
        if let Err(e) = state.experience.record_if_absent(&exp).await {
            tracing::warn!("feedback: buffering turn {message_id} failed: {e:#}");
        }
        let reward = if is_up {
            FEEDBACK_REWARD_UP
        } else {
            FEEDBACK_REWARD_DOWN
        };
        match state.experience.set_reward(message_id, reward).await {
            Ok(updated) => outcome.reward_captured = updated,
            Err(e) => tracing::warn!("feedback: set_reward({message_id}) failed: {e:#}"),
        }
    }

    // --- Memory sink (RAG; local + private, default on) ---------------------
    if ryu_learning::resolve_feedback_memory_enabled(host).await {
        let record_negative = !is_up && ryu_learning::resolve_feedback_down_negative(host).await;
        if is_up || record_negative {
            let snippet = truncate_snippet(&assistant_text, FEEDBACK_SNIPPET_CHARS);
            let question = user_text.trim();
            let (content, tag) = if is_up {
                (
                    format!("Approach the user liked. When asked \"{question}\", a good answer is: {snippet}"),
                    "good-answer",
                )
            } else {
                (
                    format!("Approach the user disliked. When asked \"{question}\", avoid answering like: {snippet}"),
                    "avoid",
                )
            };
            let agent = agent_id.as_deref().unwrap_or("default");
            let mut mem = crate::server::memory::NewMemory::user_fact(content);
            mem.importance = FEEDBACK_MEMORY_IMPORTANCE;
            mem.when_to_use = Some(question.to_string());
            // `msg_tag` lets a later change/clear find and remove this exact fact.
            mem.tags = vec!["feedback".to_string(), tag.to_string(), msg_tag.clone()];
            mem.author_agent_id = Some(agent.to_string());
            let owner = if crate::server::node_org_id().is_some() {
                if let Some(caller_user_id) = caller_user_id {
                    caller_user_id.to_owned()
                } else {
                    state
                        .conversations
                        .get_access_meta(conversation_id)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|meta| meta.owner_user_id)
                        .unwrap_or_else(crate::server::background_memory_user_id)
                }
            } else {
                crate::server::memory::LOCAL_USER.to_owned()
            };
            let sensitive =
                !crate::server::memory::detect_sensitive_topics(&mem.content).is_empty();
            let sensitive_allowed = state
                .memory
                .include_sensitive_topics(&owner)
                .await
                .unwrap_or(false);
            if sensitive && !sensitive_allowed {
                tracing::info!(
                    "feedback: memory capture skipped because sensitive-topic consent is off"
                );
                return outcome;
            }
            let metadata = feedback_memory_metadata(conversation_id, message_id);
            match state
                .memory
                .record_full_with_metadata(&owner, agent, mem, metadata)
                .await
            {
                Ok(Some(id)) => {
                    outcome.memory_captured = true;
                    // Index now so semantic recall/search sees it immediately
                    // (auto-recall would otherwise lazy-bridge it later).
                    if let Ok(Some(entry)) = state.memory.get(&id).await {
                        crate::server::index_memory_entry(state, &entry).await;
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("feedback: recording memory failed: {e:#}"),
            }
        }
    }

    outcome
}

/// Provenance for a feedback-derived memory: explicit message feedback, citing
/// the voted conversation and the rated assistant message. The ids live in the
/// encrypted payload; the plaintext `msg:<id>` tag stays only so a changed or
/// cleared vote can find and remove its prior fact.
fn feedback_memory_metadata(conversation_id: &str, message_id: &str) -> memory::MemoryMetadata {
    let mut metadata = memory::MemoryMetadata::conversation(
        Some(conversation_id.to_owned()),
        [message_id.to_owned()],
    );
    metadata.provenance.source = memory::MemorySource::Feedback;
    metadata
}

/// Truncate `text` to at most `max` chars on a char boundary, appending an
/// ellipsis when it was cut. Char-based (not byte) so multibyte replies are safe.
fn truncate_snippet(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
#[path = "feedback_tests.rs"]
mod tests;
