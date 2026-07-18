//! The `LearningHost` seam — every Core-owned callback the learning loop needs,
//! inverted so this crate has ZERO dependency on `apps/core`.
//!
//! The learning engine reads the conversation store, calls the Gateway PRM/synth
//! side-model, queues skill-synthesis approvals, reloads the skills registry,
//! dispatches fine-tunes, and reads/writes preferences. All of those live in
//! Core's kernel; the crate reaches them only through this trait. Core supplies a
//! concrete impl over `ServerState`; the out-of-process sidecar supplies a
//! degrading impl (documented `Err`) because none of these subsystems is reachable
//! from a separate process without a broker-back HTTP surface Core does not yet
//! expose.

use async_trait::async_trait;
use serde_json::Value;

/// A lightweight conversation summary — the subset of Core's `ConversationSummary`
/// the sweep / skills pass reads. `updated_at` is carried verbatim (Unix millis in
/// Core today); the engine only compares it against its own persisted watermark, so
/// the unit is opaque to this crate.
#[derive(Debug, Clone)]
pub struct ConvMeta {
    pub id: String,
    pub agent_id: Option<String>,
    pub updated_at: i64,
    pub message_count: i64,
    pub archived: bool,
}

/// One stored message — the subset of Core's `StoredMessage` the sweep + synthesis
/// transcript read.
#[derive(Debug, Clone)]
pub struct Msg {
    pub id: String,
    pub role: String,
    pub content: String,
    pub agent_id: Option<String>,
}

/// Outcome of queueing a synthesized skill for inbox approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueuedApproval {
    /// Newly queued into the approval inbox.
    Queued,
    /// A pending approval for this skill was already awaiting review (dedupe).
    AlreadyPending,
    /// No approval engine is wired (headless/tests): the caller should fall
    /// through to direct write + activation.
    NoEngine,
}

/// The Core seam. Every method is a callback into a kernel subsystem the learning
/// loop cannot own. Implemented concretely by Core (over `ServerState`) and
/// degradingly by the sidecar binary.
#[async_trait]
pub trait LearningHost: Send + Sync {
    /// Read a preference value (trimmed, non-empty), or `None`.
    async fn pref_get(&self, key: &str) -> Option<String>;

    /// Persist a preference value.
    async fn pref_set(&self, key: &str, value: &str) -> anyhow::Result<()>;

    /// The full conversation list (the sweep + skills pass iterate it).
    async fn list_conversations(&self) -> anyhow::Result<Vec<ConvMeta>>;

    /// The messages of one conversation, in order.
    async fn get_messages(&self, conversation_id: &str) -> anyhow::Result<Vec<Msg>>;

    /// Run a non-streaming completion through the Gateway side-model primitive
    /// (PRM scoring + skill synthesis). Returns the assistant text or an error
    /// string (the shape the engine's `run_model` expects).
    async fn run_side_model(
        &self,
        model: &str,
        effort: &str,
        system: &str,
        user: &str,
    ) -> Result<String, String>;

    /// Default PRM (judge) model id — Core resolves this from its model registry
    /// (a remote-capable default, since the judge must beat the trained model).
    fn default_prm_model(&self) -> String;

    /// Default skill-synthesis model id — Core resolves this local-first (synthesis
    /// is summarization, not a correctness judgement).
    fn default_synth_model(&self) -> String;

    /// Queue a synthesized skill for inbox approval (deferred write: nothing lands
    /// on disk until approve). Returns whether it was newly queued, already
    /// pending, or that no approval engine is wired (fall through to direct
    /// activation).
    async fn queue_skill_approval(
        &self,
        slug: &str,
        name: &str,
        description: &str,
        conversation_id: &str,
        skill_md: String,
    ) -> anyhow::Result<QueuedApproval>;

    /// Hot-reload the skills registry after a skill was written + activated.
    fn reload_skills(&self);

    /// Dispatch a fine-tune job (the reward-filtered retrain) through Core's
    /// fine-tune path. Returns the sidecar's JSON response or an error string.
    async fn dispatch_finetune(&self, body: Value) -> Result<Value, String>;
}
