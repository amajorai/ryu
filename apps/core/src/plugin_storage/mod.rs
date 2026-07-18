//! Core-side wiring for the extracted [`ryu_storage`] KV primitive.
//!
//! The `ryu-storage` crate owns the plugin-owned key/value store — the
//! `(plugin_id, namespace, key)`-namespaced SQLite table and its get/set/delete/
//! keys API. What it cannot own — because they are kernel concerns — are the two
//! couplings kept here: the default db-path choice (the active `~/.ryu` data dir
//! via [`crate::paths::ryu_dir`]) and the process-global handle published at boot
//! (`main.rs`), so the sandbox bridge reaches the store without threading it
//! through `ServerState`. This is wiring only; the store's business logic lives
//! in the crate.

use anyhow::Result;
use std::path::PathBuf;
use std::sync::OnceLock;

pub use ryu_storage::PluginStorage;

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("plugin-storage.db")
}

/// Open (or create) the store at the default path (`~/.ryu/plugin-storage.db`).
pub fn open_default() -> Result<PluginStorage> {
    PluginStorage::open(default_db_path())
}

// ── Process-global handle (set in `main.rs`, like `mcp::global_registry`) ──────

static GLOBAL: OnceLock<PluginStorage> = OnceLock::new();

/// Publish the process-global plugin storage. Idempotent (first set wins).
pub fn set_global(store: PluginStorage) {
    let _ = GLOBAL.set(store);
}

/// The process-global plugin storage, if it has been published.
pub fn global() -> Option<&'static PluginStorage> {
    GLOBAL.get()
}
