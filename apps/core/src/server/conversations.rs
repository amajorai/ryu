//! Server-side conversation/session store (spec unit U10).
//!
//! Persists chat history in a local SQLite database (`~/.ryu/conversations.db`)
//! keyed by `conversation_id`. This replaces the per-client localStorage/in-memory
//! history that previously lived in each frontend (desktop, web, CLI, extension).
//!
//! The [`Session`] type (spec unit U004/#118) extends this store: it wraps an
//! existing conversation (reusing [`ConversationStore`] from spec unit #15) and
//! adds run-ownership — a binding to a [`crate::runnable::RunnableKind`] + id and
//! a status/state field. Sessions and conversations share the same SQLite file and
//! the same `Arc<Mutex<Connection>>`, so there is exactly one store and no data
//! duplication across message CRUD.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): conversation/session
//! state is part of *what runs* (orchestration), not *what is allowed/measured/paid*,
//! so it belongs in Core.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{named_params, params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::runnable::RunnableKind;
use ryu_agent_contracts::{
    validate_start_request, ExecutionProfile, HarnessRun, HarnessSession, MultitaskStrategy,
    RunEvent, RunEventEnvelope, RunStatus as HarnessRunStatus, StartRunRequest, PROTOCOL_VERSION,
};
use ryu_kernel_contracts::ResourceKey;

#[path = "conversations_hierarchy.rs"]
mod hierarchy;
pub use hierarchy::*;
#[path = "conversations_scope_guidance.rs"]
mod scope_guidance;
pub use scope_guidance::*;

const MESSAGE_SEARCH_BATCH_SQL: &str =
    "SELECT p.revision, m.id, m.conversation_id, m.role, m.content, m.created_at, p.dirty
     FROM message_search_pending p JOIN messages m ON m.id = p.message_id
     WHERE p.kind = ?1 AND p.revision > ?2 AND p.revision <= ?3
     ORDER BY p.revision LIMIT 128";

// The store is split by responsibility under `conversations/`. Each part
// widens what it shares to `pub(super)`; the re-exports below keep every
// public path at `crate::server::conversations::*`.
mod append;
mod append_at;
mod boot_recovery;
mod branching;
mod channel_turns;
mod checkpoints;
mod clearing;
mod conversation_rows;
mod conversation_settings;
mod deletion;
mod fork;
mod harness_events;
mod harness_queue;
mod harness_rows;
mod harness_start;
mod index_maintenance;
mod listing;
mod message_pages;
mod message_reads;
mod message_types;
mod model_change_types;
mod participants;
mod reactions;
mod read_receipts;
mod row_writes;
mod run_status;
mod schema;
mod schema_conversation_columns;
mod schema_ddl;
mod schema_message_columns;
mod search;
mod sessions;
mod side_chats;
mod store;
mod summary_types;
mod sync_messages;
mod tenancy;
mod text_helpers;
mod titles_models;
mod version_tree;
mod version_types;

pub use channel_turns::*;
pub use checkpoints::*;
pub use clearing::*;
pub use conversation_rows::ChannelAttachRefused;
pub use harness_rows::*;
pub use message_types::*;
pub use model_change_types::*;
pub use reactions::*;
pub(crate) use row_writes::*;
pub use store::*;
pub use summary_types::*;
pub use tenancy::*;
pub use text_helpers::*;
pub use version_types::*;

#[cfg(test)]
#[path = "conversations/render_history_tests.rs"]
mod render_history_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod continued_on_tests;

#[cfg(test)]
mod at_rest_recall_tests;
