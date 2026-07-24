//! Core-side glue for the extracted continual-learning loop (`ryu-learning`).
//!
//! The learning ENGINE (sweep / PRM-score / synthesize-skill / reward-filtered
//! cycle / autonomous skills pass) and the durable [`ryu_learning::ExperienceStore`]
//! now live in the `ryu-learning` capability crate (`apps-store/learning/backend`),
//! ZERO-dependency on `apps/core`. This module is the Core-owned remainder that
//! could NOT leave the process because it is welded to kernel subsystems:
//!
//! - [`CoreLearningHost`] — the concrete [`LearningHost`] impl over [`ServerState`]
//!   the engine calls back through (conversation store, Gateway side-model, approvals
//!   inbox, skills registry, fine-tune dispatch, preference store).
//! - [`learning_ctx`] — builds a [`ryu_learning::LearningCtx`] (the durable store +
//!   a boxed host) for a call site.
//! - [`apply_message_feedback`] — the thumbs 👍/👎 fan-out, which writes the RAG
//!   memory + retrieval stores (Core-owned) in addition to the experience buffer.
//!   It stays here (not in the crate) because the memory sink is welded to Core's
//!   `memory`/`retrieval` stores; it drives the engine only through the crate's
//!   public resolvers + `ExperienceStore`.
//! - [`global_state`] — the published [`ServerState`] handle for code with no `State`
//!   extractor (the scheduler's learning job + two unrelated ServerState borrowers).
//!
//! # Adjudication (2026-07-18): Outcome B — the ENGINE stays IN-PROCESS
//!
//! Wave 4 extracted the engine + durable store into the zero-`apps/core`-dependency
//! `ryu-learning` capability crate. The remaining question was whether the scheduled
//! [`ryu_learning::run_cycle`] / [`ryu_learning::run_skills_pass`] should also run
//! OUT-OF-PROCESS (Design B, the `healing_client`/`quests_client` sidecar model). The
//! honest verdict is **no — keep it compiled-in**, for a concrete, non-cosmetic reason:
//!
//! The healing/quests split works because the sidecar's compute is *self-contained*
//! given a small pushed payload (a failed run), and Core only applies the welded
//! write side. Learning's compute is **not** self-contained. The sweep iterates the
//! ENTIRE conversation corpus (`list_conversations` + a per-conversation `get_messages`
//! loop, `engine.rs`), every PRM/synth turn hits the Gateway side-model via
//! [`LearningHost::run_side_model`], and every gate check
//! ([`ryu_learning::resolve_enabled`] et al.) reads the Core preference store. The
//! engine calls back through the [`LearningHost`] seam ~40 times across six live Core
//! subsystems — conversation store, Gateway side-model, approvals inbox, skills
//! registry (an in-process Arc cache reload), fine-tune dispatch, and the preference
//! store. "Sidecar computes, Core applies" therefore does **not** reduce coupling here;
//! it would relocate a data-hungry consumer away from its data and force a bulk
//! corpus pull + a per-score broker hop for a job that fires at most ~once/day. That is
//! disproportionate broker-back cost for zero modularity gain over the crate extraction
//! already achieved.
//!
//! So learning is a legitimate **Core-data-plane consumer**, in-process by the same
//! rationale as the `memory`/`rag` primitives: crate-extracted (swappable, zero
//! `apps/core` dep) is the decoupling that matters; the process boundary is not.
//! Consequences of this verdict, all already true in the tree:
//! - The fixture (`plugin_manifest/fixtures/learning.plugin.json`, byte-identical to
//!   `apps-store/learning/plugin.json`) is **companion-only**: no `public_mount`, no
//!   sidecar spec. Core serves `/api/learn/*` in-process (`server/learning.rs`).
//! - Core never spawns/health-checks a learning sidecar (no `RYU_LEARNING_BIN`, no
//!   port 8002 in `apps/core`). The `[[bin]] ryu-learning` in the crate is dormant
//!   forward-scaffolding (proves the crate is process-shell-able; its `LearningHost`
//!   degrades to `Err` on every welded callback) — kept, not wired.
//! - [`apply_message_feedback`] (the per-turn thumbs sink, welded to the Core
//!   `memory`/`retrieval` stores) unconditionally stays Core-side.
//!
//! See `docs/continual-learning-metaclaw-spec.md` and the crate's `lib.rs`.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;

use ryu_learning::{ConvMeta, Experience, LearningCtx, LearningHost, Msg, QueuedApproval};

use crate::server::ServerState;

// ---------------------------------------------------------------------------
// Published ServerState handle (scheduler + two unrelated borrowers)
// ---------------------------------------------------------------------------

/// Published `ServerState` handle for code that has no `State` extractor: the
/// scheduler's `LearningCycle` job plus two unrelated ServerState borrowers (the
/// inline-tool bridge in `sidecar/mcp` and the local-engine sync in
/// `sidecar/adapters`). Set once at startup ([`set_global_state`]), mirroring the
/// monitor/quest/identity-health engines' `global_engine()` singletons.
static LEARNING_STATE: OnceLock<ServerState> = OnceLock::new();

/// Publish the `ServerState` for the scheduled learning cycle. Idempotent (first
/// call wins); safe to call once after `ServerState` is constructed.
pub fn set_global_state(state: ServerState) {
    let _ = LEARNING_STATE.set(state);
}

/// The published `ServerState`, if startup wired it. `None` in tests/headless.
pub fn global_state() -> Option<ServerState> {
    LEARNING_STATE.get().cloned()
}

// ---------------------------------------------------------------------------
// Ctx + host: the Core seam the crate engine calls back through
// ---------------------------------------------------------------------------

/// Build a [`ryu_learning::LearningCtx`] for a call site — the durable experience
/// buffer (`state.experience`) plus a boxed [`CoreLearningHost`] over the given
/// state. Cheap (Arc-backed clones); the HTTP surface, scheduler, and feedback
/// fan-out each build one on demand.
pub fn learning_ctx(state: &ServerState) -> LearningCtx {
    LearningCtx::new(
        state.experience.clone(),
        Arc::new(CoreLearningHost {
            state: state.clone(),
        }),
        state.client.clone(),
    )
}

/// The concrete [`LearningHost`] over [`ServerState`]. Holds a cheap `ServerState`
/// clone (all `Arc`-backed) so it outlives the borrow that built it; it is created
/// per call and dropped after, so it never forms a reference cycle with the state.
struct CoreLearningHost {
    state: ServerState,
}

#[async_trait]
impl LearningHost for CoreLearningHost {
    async fn pref_get(&self, key: &str) -> Option<String> {
        self.state.preferences.get(key).await.ok().flatten()
    }

    async fn pref_set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.state.preferences.set(key, value).await
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ConvMeta>> {
        let rows = self.state.conversations.list_conversations().await?;
        Ok(rows
            .into_iter()
            .map(|c| ConvMeta {
                id: c.id,
                agent_id: c.agent_id,
                updated_at: c.updated_at,
                message_count: c.message_count,
                archived: c.archived,
            })
            .collect())
    }

    async fn get_messages(&self, conversation_id: &str) -> anyhow::Result<Vec<Msg>> {
        let rows = self
            .state
            .conversations
            .get_messages(conversation_id)
            .await?;
        Ok(rows
            .into_iter()
            .map(|m| Msg {
                id: m.id,
                role: m.role,
                content: m.content,
                agent_id: m.agent_id,
            })
            .collect())
    }

    async fn run_side_model(
        &self,
        model: &str,
        effort: &str,
        system: &str,
        user: &str,
    ) -> Result<String, String> {
        crate::server::call_side_model(&self.state, model, effort, system, user).await
    }

    fn default_prm_model(&self) -> String {
        crate::registry::DEFAULT_LLM_MODEL.to_string()
    }

    fn default_synth_model(&self) -> String {
        crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_string()
    }

    async fn queue_skill_approval(
        &self,
        slug: &str,
        name: &str,
        description: &str,
        conversation_id: &str,
        skill_md: String,
    ) -> anyhow::Result<QueuedApproval> {
        let Some(engine) = crate::approvals::global_engine() else {
            // No approval engine wired (headless/tests): the engine falls through
            // to direct write + activation.
            return Ok(QueuedApproval::NoEngine);
        };
        let req = crate::approvals::ApprovalRequest::for_skill_synthesis(
            slug,
            name,
            description,
            conversation_id,
            skill_md,
        );
        // `request_deduped` returns None when a pending approval for this skill was
        // already awaiting review.
        match engine.request_deduped(req).await? {
            Some(_) => Ok(QueuedApproval::Queued),
            None => Ok(QueuedApproval::AlreadyPending),
        }
    }

    fn reload_skills(&self) {
        self.state.skills.reload();
    }

    async fn dispatch_finetune(&self, body: Value) -> Result<Value, String> {
        self.state.finetune.start(body).await
    }
}

// ---------------------------------------------------------------------------
// Thumbs feedback: seed the reward + RAG-memory sinks from a 👍 / 👎
// ---------------------------------------------------------------------------

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
            match state
                .memory
                .record_full(&crate::server::background_memory_user_id(), agent, mem)
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
mod tests {
    use super::*;

    #[test]
    fn truncate_snippet_trims_and_leaves_short_text_unchanged() {
        assert_eq!(truncate_snippet("  hello  ", 10), "hello");
        // Exactly `max` chars is not truncated (no ellipsis).
        assert_eq!(truncate_snippet("abcde", 5), "abcde");
    }

    #[test]
    fn truncate_snippet_cuts_long_text_and_appends_ellipsis() {
        let out = truncate_snippet("abcdefghij", 3);
        assert_eq!(out, "abc…");
        // The ellipsis is a single char, not three dots.
        assert_eq!(out.chars().count(), 4);
    }

    #[test]
    fn truncate_snippet_counts_chars_not_bytes_for_multibyte() {
        // Four multibyte codepoints; max=2 keeps two whole chars + ellipsis.
        let out = truncate_snippet("héllo wörld ☃☃", 2);
        assert_eq!(out, "hé…");
        // Never splits a multibyte codepoint (would panic on a byte boundary).
        assert!(out.chars().count() == 3);
    }

    #[test]
    fn truncate_snippet_zero_max_is_just_ellipsis_for_nonempty() {
        assert_eq!(truncate_snippet("x", 0), "…");
        // Empty (after trim) stays empty even at max 0.
        assert_eq!(truncate_snippet("   ", 0), "");
    }
}
