//! Process-global agent runner for free-function callers (workflow executor,
//! scheduler, Composio triggers).
//!
//! The chat path ([`crate::sidecar::adapters::route_chat_stream`]) needs nine
//! `ServerState` stores to invoke an agent. Free functions like the workflow
//! executor's `Prompt` node, the scheduler's `JobTarget::Agent`, and the
//! Composio webhook handler have no `ServerState` handle, so they previously
//! could only POST a bare prompt to the gateway — ignoring the `agent_id` the
//! user configured. This module publishes a cloneable [`AgentRunner`] holding
//! those stores as a process-global (the same `set_global`/`global` pattern used
//! by [`crate::sidecar::mcp`], `crate::monitors`, and `crate::composio_triggers`)
//! so any of those callers can invoke the *real* configured agent.
//!
//! Per the Core-vs-Gateway rule this is **Core**: it decides *what runs* (which
//! agent handles the turn). Every model call the agent makes still routes through
//! the Gateway via the shared chat path; nothing here reaches a provider directly.

use std::sync::Arc;
use std::sync::OnceLock;

use crate::agents::AgentStore;
use crate::server::conversations::ConversationStore;
use crate::server::memory::MemoryStore;
use crate::server::trace::TraceStore;
use crate::sidecar::adapters::run_text_turn;
use crate::sidecar::adapters::AcpAgentRegistry;
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::SidecarManager;
use crate::skills::SkillRegistry;

/// Bundle of the chat stores needed to invoke an agent off the chat path.
///
/// Cloning is cheap: every field is an `Arc` or an internally-`Arc`'d store
/// (the same handles `run_reply_text` already takes by value).
#[derive(Clone)]
pub struct AgentRunner {
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
}

impl AgentRunner {
    /// Construct a runner from the same store handles `ServerState` holds.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: Arc<AcpAgentRegistry>,
        conversations: ConversationStore,
        agent_store: AgentStore,
        manager: Arc<SidecarManager>,
        memory: MemoryStore,
        worktree_diffs: crate::server::WorktreeDiffStore,
        mcp: Arc<McpRegistry>,
        skills: SkillRegistry,
        traces: TraceStore,
    ) -> Self {
        Self {
            registry,
            conversations,
            agent_store,
            manager,
            memory,
            worktree_diffs,
            mcp,
            skills,
            traces,
        }
    }

    /// Run one turn through the configured agent and return the final reply text.
    ///
    /// Mirrors `run_member_text`'s shape: a `persist = false` single-user-message
    /// turn so off-chat invocations never write orphan conversation rows. The
    /// `agent_id`'s stored binding (ACP vs OpenAI-compat, gateway routing, tools,
    /// persona) governs the call exactly as it would from the desktop.
    pub async fn run(
        &self,
        agent_id: Option<String>,
        conversation_id: String,
        text: String,
    ) -> anyhow::Result<String> {
        run_text_turn(
            conversation_id,
            agent_id,
            text,
            false,
            Arc::clone(&self.registry),
            self.conversations.clone(),
            self.agent_store.clone(),
            Arc::clone(&self.manager),
            self.memory.clone(),
            Arc::clone(&self.worktree_diffs),
            Arc::clone(&self.mcp),
            self.skills.clone(),
            self.traces.clone(),
        )
        .await
    }

    /// Run one turn on a *worker* conversation and **persist** it (both the user
    /// instruction and the assistant reply are written to history), optionally in
    /// an isolated git worktree.
    ///
    /// This is the primitive behind the coordinator-threads `send_message_to_thread`
    /// tool. Unlike [`AgentRunner::run`] (persist = false, no cwd), a coordinator
    /// spawns durable workers whose transcripts it later reads back, and each
    /// worker runs in its own worktree so parallel workers never collide in the
    /// same checkout. The worktree is created lazily and reused across turns by
    /// `route_chat_stream`'s persistent-session logic, keyed on `conversation_id`.
    pub async fn run_worker(
        &self,
        agent_id: Option<String>,
        conversation_id: String,
        text: String,
        cwd: Option<String>,
        isolate: bool,
    ) -> anyhow::Result<String> {
        crate::sidecar::adapters::run_text_turn_in(
            conversation_id,
            agent_id,
            text,
            true,
            cwd,
            isolate,
            None,
            Arc::clone(&self.registry),
            self.conversations.clone(),
            self.agent_store.clone(),
            Arc::clone(&self.manager),
            self.memory.clone(),
            Arc::clone(&self.worktree_diffs),
            Arc::clone(&self.mcp),
            self.skills.clone(),
            self.traces.clone(),
        )
        .await
    }
}

/// The published runner, set once at startup from `ServerState`'s stores.
static GLOBAL_AGENT_RUNNER: OnceLock<AgentRunner> = OnceLock::new();

/// Publish the global agent runner. Idempotent: a second call is ignored.
pub fn set_global_agent_runner(runner: AgentRunner) {
    let _ = GLOBAL_AGENT_RUNNER.set(runner);
}

/// The global agent runner, if it has been published. `None` in headless/test
/// contexts that never built a `ServerState`, so callers fall back to the
/// gateway default-LLM path.
pub fn global_agent_runner() -> Option<AgentRunner> {
    GLOBAL_AGENT_RUNNER.get().cloned()
}
