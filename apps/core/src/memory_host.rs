//! Core's kernel side of the extracted [`ryu_memory`] seam.
//!
//! The `ryu-memory` crate owns the long-term memory store — the encrypted-at-rest
//! `MemoryStore`, the multi-level scope model, scoped recall, and CRUD. What it
//! cannot own — because they are kernel couplings — are the two wirings the
//! default constructor needs: the `~/.ryu` default db path
//! ([`crate::paths::ryu_dir`]) and the bind-time owner backfill's org/account
//! resolution (the control plane + account vault). This shim resolves both and
//! injects them into [`ryu_memory::MemoryStore::open`].
//!
//! Mirrors the `search_host`/`crypto_host` precedent (kernel wiring the extracted
//! crate can't own), by *constructor injection* like `ryu-storage`/`ryu-search`
//! (`open(path, …)`), not a process-global host.

use anyhow::Result;
use ryu_memory::MemoryStore;

/// Open the long-term memory store at the default path
/// (`~/.ryu/conversations.db`, shared with the conversation store), resolving the
/// bind-time owner backfill's two Core inputs: whether this node is org-bound
/// (`control_plane::registered_org()`) and the signed-in local account's user id
/// (`auth::load_accounts().active()`).
pub fn open_default() -> Result<MemoryStore> {
    let db_path = crate::paths::ryu_dir().join("conversations.db");
    let node_bound = crate::sidecar::control_plane::registered_org().is_some();
    let owner = crate::auth::load_accounts()
        .active()
        .map(|a| a.user_id.clone());
    MemoryStore::open(db_path, node_bound, owner.as_deref())
}
