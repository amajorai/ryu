//! Long-term memory primitive — the SQLite-backed [`MemoryStore`], the
//! multi-level scope model, and scoped recall/CRUD.
//!
//! Extracted from `apps/core/src/server/memory.rs` as an in-process capability
//! crate (mirrors `ryu-crypto`/`ryu-search`). The two Core couplings — the
//! `~/.ryu` default db path and the bind-time owner backfill's org/account
//! resolution — invert through plain constructor injection
//! ([`MemoryStore::open`] takes `node_bound` + `owner`), so this crate has ZERO
//! dependency on `apps/core`; the Core wiring lives in
//! `apps/core/src/memory_host.rs`.
//!
//! Two-tier memory for chat (spec unit U11), with multi-level scoping.
//!
//! Ryu assembles two kinds of context for each chat request:
//!
//! * **Short-term memory** — the recent turns of the *current* conversation.
//!   This is derived directly from U10's conversation store
//!   (`ConversationStore::get_recent_messages`) and assembled into a prompt
//!   prefix. It needs no separate storage.
//! * **Long-term memory** — durable facts carried *across* conversations. This is
//!   **opt-in** per the privacy-by-default principle: nothing is recorded or
//!   recalled unless the request explicitly enables it.
//!
//! Long-term facts carry a **scope level** — [`MemoryScope`] — describing how
//! broadly they apply:
//!
//! * `Agent`   — facts for one agent (`scope_id` = the agent id).
//! * `User`    — facts about the user, visible across agents (broadest personal level).
//! * `Node`    — facts scoped to this Core node / machine.
//! * `Project` — facts scoped to one working folder (`scope_id` = the folder path).
//! * `Org`     — facts shared across an organization (`scope_id` = the org id).
//!   Unlike the other three, an org fact is gated on the CALLER's org, so it is the
//!   one level whose visibility depends on who is asking. It is deliberately NOT in
//!   the default read set (see `effective_levels`): an agent must opt in.
//!
//! Which levels a given agent may read is governed by its `MemorySlot`
//! (`crate::agents::MemorySlot.read_levels`); the retrieval layer
//! (`crate::server::retrieval`) enforces the level + active-project filter at
//! recall time. Each fact is also classified by [`MemoryCategory`] and carries an
//! `importance`, optional `when_to_use` hint, and free-form `tags` — all editable
//! from the desktop Memory Library.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): memory is part of
//! *what runs* (orchestration / session state), not *what is allowed, shared,
//! measured, or paid for*, so it belongs in Core alongside the conversation
//! store from U10.
//!
//! Long-term entries are stored **encrypted-at-rest** with ChaCha20-Poly1305 via
//! the shared [`ryu_crypto`] master key (resolved from env → OS keychain →
//! file fallback, see `docs/encryption-at-rest.md`). The sensitive payload
//! (`content` + `when_to_use`) is bundled as JSON inside the ciphertext; the
//! filterable metadata (`scope`, `scope_id`, `category`, `importance`, `tags`)
//! lives in plaintext columns so it can be filtered in SQL.

use ryu_kernel_contracts::ResourceKey;

mod access;
mod archive_candidates;
mod crypto;
mod delete;
mod list;
mod proposal_review;
mod proposal_types;
mod proposals;
mod recall;
mod schema;
mod sensitive;
mod settings;
mod store;
mod types;
mod update;
mod visibility;
pub mod working;
mod write;

pub use access::MAX_MARK_RECALLED_IDS;
pub use archive_candidates::UnusedEventQuery;
pub use proposal_types::{
    MemoryProposalDraft, MemoryProposalFilter, MemoryProposalOperation, MemoryProposalSource,
    MemoryProposalStatus, MemoryRevisionProposal, NewMemoryProposal,
};
pub use sensitive::{detect_sensitive_topics, SensitiveTopic};
pub use store::MemoryStore;
pub use types::{
    LongTermEntry, MemoryCategory, MemoryFilter, MemoryLifecycle, MemoryMetadata, MemoryPatch,
    MemoryProvenance, MemoryScope, MemorySource, NewMemory,
};
pub use visibility::MemoryVisibility;
pub use working::{
    merge_patch, render_working_memory_block, WorkingMemory, WorkingMemoryConfig,
    WorkingMemoryError, WorkingMemoryMode, WorkingMemoryScope, WorkingMemoryWrite,
    DEFAULT_WORKING_MEMORY_TEMPLATE, MAX_WORKING_MEMORY_BYTES, WORKING_MEMORY_HISTORY_LIMIT,
};

/// Default number of recent turns assembled as short-term context.
pub const DEFAULT_SHORT_TERM_LIMIT: usize = 10;
/// Default number of long-term entries recalled per request.
pub const DEFAULT_LONG_TERM_LIMIT: usize = 5;
/// Hard cap for source-store list/recall calls so a client cannot turn a memory
/// endpoint into an unbounded allocation request.
pub const MAX_MEMORY_QUERY_LIMIT: usize = 500;
/// Default importance for a fact when none is supplied (1..=5 scale).
pub const DEFAULT_IMPORTANCE: i32 = 3;
/// Sentinel user id used while Core is local-first/single-user.
///
/// `AuthState` only carries a device token, not a stable user id, so long-term
/// memory is scoped by `(LOCAL_USER, agent_id)`. When a real user identity is
/// introduced this constant becomes the request's user id.
pub const LOCAL_USER: &str = "local";

/// Derive memory's owning `user_id` from the shared [`ResourceKey`] composition
/// layer. Memory's `user_id` column is `NOT NULL` and shares by SCOPE (it has no
/// `org_id`), so the collapse here is user-only: an attributed key yields its
/// user; an unattributed one falls back to the [`LOCAL_USER`] sentinel — exactly
/// the value the write path used before `ResourceKey` existed, so no stored row
/// changes. This is the "constructors accept-or-derive a ResourceKey internally"
/// seam for the memory plane; [`MemoryStore::record`] still takes a `user_id: &str`.
///
/// FOLLOWUP (deferred this wave, per the task's DO-NOT list): a later wave folds
/// the key's `project`/`node` fields into [`MemoryScope::Project`]/[`MemoryScope::Node`]
/// (memory shares by scope, not by the `(user, org)` pair), so those compound
/// fields are intentionally NOT consulted here yet.
pub fn memory_user_from_key(key: &ResourceKey) -> &str {
    key.user.as_deref().unwrap_or(LOCAL_USER)
}

pub(crate) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod access_tests;

#[cfg(test)]
mod archive_candidates_tests;

#[cfg(test)]
mod crypto_tests;

#[cfg(test)]
mod delete_tests;

#[cfg(test)]
mod list_tests;

#[cfg(test)]
mod proposal_integrity_tests;

#[cfg(test)]
mod proposal_review_tests;

#[cfg(test)]
mod proposal_tests;

#[cfg(test)]
mod proposal_types_tests;

#[cfg(test)]
mod recall_tests;

#[cfg(test)]
mod schema_tests;

#[cfg(test)]
mod sensitive_tests;

#[cfg(test)]
mod settings_tests;

#[cfg(test)]
mod store_tests;

#[cfg(test)]
mod types_tests;

#[cfg(test)]
mod update_tests;

#[cfg(test)]
mod visibility_tests;

#[cfg(test)]
mod write_tests;
