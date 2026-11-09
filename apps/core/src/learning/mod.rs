//! Core-side glue for the extracted continual-learning loop (`ryu-learning`).
//!
//! The learning ENGINE (sweep / PRM-score / synthesize-skill / reward-filtered
//! cycle / autonomous skills pass) and the durable [`ryu_learning::ExperienceStore`]
//! now live in the `ryu-learning` capability crate (`crates/core/learning`),
//! ZERO-dependency on `apps/core`. This module is the Core-owned remainder that
//! could NOT leave the process because it is welded to kernel subsystems:
//!
//! - [`CoreLearningHost`] — the concrete [`LearningHost`] impl over [`ServerState`]
//!   the engine calls back through (conversation store, Gateway side-model, approvals
//!   inbox, skills registry, fine-tune dispatch, preference store). Fine-tune
//!   dispatch names no app: it calls the `finetune.start` / `finetune.merge`
//!   capabilities through the generic Core-as-consumer broker helper.
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
//! OUT-OF-PROCESS (Design B, the Self-Healing / app-capability sidecar model). The
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
//! - The manifest (`apps-store/learning/manifest.json` — the single copy Core
//!   `include_str!`s) is **companion-only**: no `public_mount`, no sidecar spec. Core
//!   serves `/api/learn/*` in-process (`server/learning.rs`).
//! - The app FACE therefore stays under `apps-store/learning/` (`manifest.json` +
//!   `ui/`) while the ENGINE crate sits at `crates/core/learning`, with the other
//!   extracted always-in-process Core capability crates (`ryu-activity`,
//!   `ryu-predict`). `apps-store/*/backend` is for app backends that ship as their
//!   own out-of-process sidecar — which Outcome B says this one never will.
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
use serde_json::Value;

use ryu_learning::{ConvMeta, LearningCtx, LearningHost, Msg, QueuedApproval};

use crate::server::ServerState;
use crate::sidecar::capability_consumer::{
    CapabilityCallError, CapabilityConsumer, CapabilityReply,
};

/// Start a fine-tune job (the reward-filtered retrain). Request is the job spec the
/// provider's `/start` route takes verbatim; reply `2xx { "job_id": ... }`.
pub(crate) const CAP_FINETUNE_START: &str = "finetune.start";
/// Merge a trained adapter into a registered model artifact. Request is the merge
/// spec verbatim; reply `2xx { "stem": ..., "gguf_path": ... }`.
pub(crate) const CAP_FINETUNE_MERGE: &str = "finetune.merge";

/// Invoke a fine-tune capability on whichever enabled app provides it and return the
/// provider's JSON reply, or the error string [`LearningHost`] expects.
async fn call_finetune_capability(
    capabilities: &CapabilityConsumer,
    capability: &str,
    body: &Value,
) -> Result<Value, String> {
    let reply = capabilities
        .call_capability(capability, body)
        .await
        .map_err(finetune_refusal)?;
    finetune_reply(capability, reply)
}

/// A missing provider is the common refusal (the fine-tuning app is disabled or not
/// installed), so say so instead of surfacing a binding code.
fn finetune_refusal(error: CapabilityCallError) -> String {
    match error {
        CapabilityCallError::Unbound { capability, .. } => format!(
            "no enabled app provides the '{capability}' capability; install or enable an \
             app that runs fine-tunes"
        ),
        other => other.to_string(),
    }
}

/// `Ok(body)` on 2xx; otherwise the provider's own `{"error": ...}` text when it sent
/// one, else the status.
fn finetune_reply(capability: &str, reply: CapabilityReply) -> Result<Value, String> {
    if reply.is_success() {
        return Ok(reply.body);
    }
    Err(reply.body.get("error").and_then(Value::as_str).map_or_else(
        || format!("'{capability}' returned HTTP {}", reply.status),
        str::to_owned,
    ))
}

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
    learning_ctx_with_visibility(state, None)
}

/// Build a caller-scoped learning context for a request on a registered node.
/// The handler performs the exact node-scope authorization before calling this
/// helper; the host still fails closed if it is ever constructed with no caller.
pub fn learning_ctx_for_caller(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> LearningCtx {
    let visibility =
        crate::sidecar::control_plane::registered_node().map(|node| LearningVisibility {
            owner_user_id: caller.as_ref().map(|current| current.user_id.clone()),
            org_id: Some(node.org.id),
            node_bound: true,
        });
    learning_ctx_with_visibility(state, visibility)
}

fn learning_ctx_with_visibility(
    state: &ServerState,
    visibility: Option<LearningVisibility>,
) -> LearningCtx {
    LearningCtx::new(
        state.experience.clone(),
        Arc::new(CoreLearningHost {
            state: state.clone(),
            visibility,
        }),
        state.client.clone(),
    )
}

#[derive(Clone)]
struct LearningVisibility {
    owner_user_id: Option<String>,
    org_id: Option<String>,
    node_bound: bool,
}

/// The concrete [`LearningHost`] over [`ServerState`]. Holds a cheap `ServerState`
/// clone (all `Arc`-backed) so it outlives the borrow that built it; it is created
/// per call and dropped after, so it never forms a reference cycle with the state.
struct CoreLearningHost {
    state: ServerState,
    visibility: Option<LearningVisibility>,
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
        let rows = match self.visibility.as_ref() {
            Some(visibility) => {
                self.state
                    .conversations
                    .list_conversations_visible(
                        visibility.owner_user_id.as_deref(),
                        visibility.org_id.as_deref(),
                        visibility.node_bound,
                    )
                    .await?
            }
            None => self.state.conversations.list_conversations().await?,
        };
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
        if let Some(visibility) = self.visibility.as_ref() {
            let visible = self
                .state
                .conversations
                .visible_conversation_ids(
                    visibility.owner_user_id.as_deref(),
                    visibility.org_id.as_deref(),
                    visibility.node_bound,
                )
                .await?;
            if !visible.iter().any(|id| id == conversation_id) {
                anyhow::bail!("conversation is not visible to this learning caller");
            }
        }
        let rows = self
            .state
            .conversations
            .get_learning_messages(conversation_id)
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
        crate::server::call_side_model(
            &self.state,
            &crate::sidecar::gateway::SidePurpose::LearningJudge,
            model,
            effort,
            system,
            user,
        )
        .await
    }

    fn default_prm_model(&self) -> String {
        crate::registry::DEFAULT_LLM_MODEL.to_string()
    }

    fn default_synth_model(&self) -> String {
        crate::registry::local_chat_model_id()
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
        let capabilities = CapabilityConsumer::from_state(&self.state);
        call_finetune_capability(&capabilities, CAP_FINETUNE_START, &body).await
    }

    async fn merge_finetune(&self, body: Value) -> Result<Value, String> {
        let capabilities = CapabilityConsumer::from_state(&self.state);
        call_finetune_capability(&capabilities, CAP_FINETUNE_MERGE, &body).await
    }
}

mod feedback;

pub use feedback::{apply_message_feedback, FeedbackOutcome};

#[cfg(test)]
mod tests;
