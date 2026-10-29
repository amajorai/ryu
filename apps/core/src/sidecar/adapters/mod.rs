#[cfg(test)]
#[path = "output_styles_package_prompt_test.rs"]
mod output_styles_package_prompt;

mod handled_turn;
pub(crate) use handled_turn::persist_handled_ui_turn;
#[cfg(test)]
mod cloud_native_tests;
mod messages;
mod model_select_context;
pub(crate) use messages::{append_last_user_text, set_last_user_text, ui_message_text};
use messages::{document_context_block, last_user_images, last_user_message, message_image_parts};
pub use messages::{ImagePart, UiContent, UiMessage};

pub mod acp;
pub(crate) mod acp_direct_spawn;
pub(crate) mod acp_instance_tasks;
pub(crate) mod acp_mcp_over_acp;
pub mod acp_probe_cache;
pub(crate) mod acp_session_models;
pub mod acp_spawn;
pub mod context_breakdown;
pub mod context_handoff;
pub mod context_window;
mod generative_ui;
pub mod live_turn;
pub mod mcp_bridge;
pub mod prompt_cache_warmth;
pub mod sdk;
pub mod turn_control;

pub use acp::{AcpAgentRegistry, FallbackProvider};

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use crate::agents::{AgentStore, PersonaSlot};
use crate::registry::ProviderRegistry;
use crate::ryu_platform::RyuResponseMode;
use crate::server::conversations::{ConversationStore, MessageSearchHit, Tenancy};
use crate::server::memory::{
    MemoryCategory, MemoryScope, MemoryStore, MemoryVisibility, NewMemory,
    DEFAULT_SHORT_TERM_LIMIT, LOCAL_USER,
};
use crate::server::retrieval::{
    ChunkSource, MemoryGraph, MemoryGraphDocument, MemoryGraphQuery, RetrievalOptions,
    RetrievalStore, ScoredChunk,
};
use crate::sidecar::active_engine::{is_local_engine, local_engine_base_url};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::untrusted;
use crate::sidecar::BoxFuture;
use crate::sidecar::SidecarManager;
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use ryu_skills::SkillRegistry;
use ryu_tracing::{hash_args, SpanEnd, SpanKind, SpanStart, TraceStore};
use ryu_workspace::worktree::{create_managed_worktree, find_git_root, is_git_repo, WorktreeGuard};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Live stream registry ────────────────────────────────────────────────────────
//
// Resumable turns live in `live_turn`: a reconnecting client (the user reloaded
// or navigated away and came back) replays the turn so far and then follows it
// via `GET /api/chat/stream/resume/:conversation_id`.

pub use live_turn::{durable_turn, subscribe as subscribe_live_stream};

mod adapter_core;
pub use adapter_core::*;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod run_trace_tests;
