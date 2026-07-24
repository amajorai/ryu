//! Shared test doubles for the learning crate.
//!
//! A configurable in-memory [`LearningHost`] so the engine's resolvers, flow
//! functions, and HTTP handlers can be exercised without Core, the Gateway, the
//! skills registry, or any network. Every callback is a pure in-process fake:
//! prefs live in a map, conversations/messages are canned, and the side-model /
//! approval-queue / finetune outcomes are set per test. Nothing here touches disk
//! (beyond the caller's own tempfile-backed [`crate::store::ExperienceStore`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use crate::host::{ConvMeta, LearningHost, Msg, QueuedApproval};

/// A fully in-memory [`LearningHost`]. Build with [`MockHost::new`] then chain the
/// `with_*` setters. All fields are behavior knobs the engine reads through the
/// trait seam.
pub struct MockHost {
    prefs: Mutex<HashMap<String, String>>,
    conversations: Vec<ConvMeta>,
    messages: HashMap<String, Vec<Msg>>,
    /// Reply returned by `run_side_model` when the system prompt is the PRM judge.
    pub prm_reply: Option<String>,
    /// Reply returned by `run_side_model` for the synthesis prompt.
    pub synth_reply: Option<String>,
    /// When set, `run_side_model` fails (both PRM and synth).
    pub side_err: bool,
    /// When set, `get_messages` returns `Err`.
    pub messages_err: bool,
    /// When set, `list_conversations` returns `Err`.
    pub list_convos_err: bool,
    /// Outcome returned by `queue_skill_approval` (default `Queued`).
    pub queue: QueuedApproval,
    /// When set, `queue_skill_approval` returns `Err`.
    pub queue_bail: bool,
    /// `Some` -> `dispatch_finetune` returns Ok with this; `None` -> Err.
    pub finetune: Option<Value>,
    /// Count of `reload_skills` calls — the tell that a skill was activated.
    pub reloaded: AtomicUsize,
    pub default_prm: String,
    pub default_synth: String,
}

impl MockHost {
    pub fn new() -> Self {
        Self {
            prefs: Mutex::new(HashMap::new()),
            conversations: Vec::new(),
            messages: HashMap::new(),
            prm_reply: None,
            synth_reply: None,
            side_err: false,
            messages_err: false,
            list_convos_err: false,
            queue: QueuedApproval::Queued,
            queue_bail: false,
            finetune: None,
            reloaded: AtomicUsize::new(0),
            default_prm: "default-prm-model".to_string(),
            default_synth: "default-synth-model".to_string(),
        }
    }

    /// Set a preference (raw value, exactly as the pref store would hold it).
    pub fn with_pref(self, key: &str, value: &str) -> Self {
        self.prefs
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        self
    }

    /// Flip the global training opt-in on.
    pub fn enabled(self) -> Self {
        self.with_pref(crate::engine::LEARNING_ENABLED_PREF, "true")
    }

    /// Append a (non-archived) conversation.
    pub fn with_conversation(mut self, id: &str, updated_at: i64, message_count: i64) -> Self {
        self.conversations.push(ConvMeta {
            id: id.to_string(),
            agent_id: None,
            updated_at,
            message_count,
            archived: false,
        });
        self
    }

    /// Append an archived conversation (sweep/skills pass must skip it).
    pub fn with_archived_conversation(mut self, id: &str, message_count: i64) -> Self {
        self.conversations.push(ConvMeta {
            id: id.to_string(),
            agent_id: None,
            updated_at: 0,
            message_count,
            archived: true,
        });
        self
    }

    /// Set the ordered `(role, content)` messages for a conversation.
    pub fn with_messages(mut self, conversation_id: &str, turns: &[(&str, &str)]) -> Self {
        let msgs = turns
            .iter()
            .enumerate()
            .map(|(i, (role, content))| Msg {
                id: format!("{conversation_id}-{i}"),
                role: (*role).to_string(),
                content: (*content).to_string(),
                agent_id: None,
            })
            .collect();
        self.messages.insert(conversation_id.to_string(), msgs);
        self
    }

    pub fn reload_count(&self) -> usize {
        self.reloaded.load(Ordering::SeqCst)
    }
}

impl Default for MockHost {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LearningHost for MockHost {
    async fn pref_get(&self, key: &str) -> Option<String> {
        self.prefs.lock().unwrap().get(key).cloned()
    }

    async fn pref_set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.prefs
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ConvMeta>> {
        if self.list_convos_err {
            anyhow::bail!("list_conversations failed");
        }
        Ok(self.conversations.clone())
    }

    async fn get_messages(&self, conversation_id: &str) -> anyhow::Result<Vec<Msg>> {
        if self.messages_err {
            anyhow::bail!("get_messages failed");
        }
        Ok(self
            .messages
            .get(conversation_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn run_side_model(
        &self,
        _model: &str,
        _effort: &str,
        system: &str,
        _user: &str,
    ) -> Result<String, String> {
        if self.side_err {
            return Err("side model unavailable".to_string());
        }
        // PRM_SYSTEM opens with "You are a strict reward model ...".
        if system.contains("reward model") {
            return self
                .prm_reply
                .clone()
                .ok_or_else(|| "no prm reply configured".to_string());
        }
        self.synth_reply
            .clone()
            .ok_or_else(|| "no synth reply configured".to_string())
    }

    fn default_prm_model(&self) -> String {
        self.default_prm.clone()
    }

    fn default_synth_model(&self) -> String {
        self.default_synth.clone()
    }

    async fn queue_skill_approval(
        &self,
        _slug: &str,
        _name: &str,
        _description: &str,
        _conversation_id: &str,
        _skill_md: String,
    ) -> anyhow::Result<QueuedApproval> {
        if self.queue_bail {
            anyhow::bail!("queue failed");
        }
        Ok(self.queue)
    }

    fn reload_skills(&self) {
        self.reloaded.fetch_add(1, Ordering::SeqCst);
    }

    async fn dispatch_finetune(&self, _body: Value) -> Result<Value, String> {
        match &self.finetune {
            Some(v) => Ok(v.clone()),
            None => Err("finetune dispatch failed".to_string()),
        }
    }
}
