//! Fine-tuning (Unsloth) durable state — extracted Core capability crate.
//!
//! Core owns *what runs* (a fine-tune job on this node's GPU, or a remote Ryu
//! Cloud GPU node) and the durable job record; the actual training happens in the
//! out-of-process Python worker (`apps-store/finetune/sidecar`). This crate owns
//! the durable records it persists — the [`FinetuneStore`] job DB and the
//! [`adapters`] output catalog — AND the [`api`] `/api/finetune/*` HTTP surface
//! (relocated out of `apps/core/src/server/finetune.rs`), a thin proxy that drives
//! the Python worker over HTTP at [`api::DEFAULT_UNSLOTH_URL`] (`RYU_UNSLOTH_URL`).
//! The surface runs BOTH in-process (Core merges [`routes`]) and out-of-process
//! (the `ryu-finetune` control-plane sidecar in `main.rs`).
//!
//! The lone kernel coupling — the `~/.ryu` data directory — is inverted through
//! [`init_data_dir`], so this crate has ZERO dependency on `apps/core` (the
//! `ryu-monitors` precedent).

use std::path::PathBuf;

pub mod adapters;
pub mod api;
pub mod store;

pub use api::{openapi, routes, FinetuneCtx};
pub use store::{FinetuneJob, FinetuneStore};

/// The crate's data directory (`finetune.db` and `installed-adapters.json` live
/// under it). Set once at startup from Core (`ryu_dir()`); [`data_dir`] falls back
/// to the system temp dir so unit tests and any pre-init handler never panic.
static DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Publish the fine-tune data directory. Idempotent: a second call is ignored.
pub fn init_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// The fine-tune data directory, or the system temp dir when uninitialized.
pub(crate) fn data_dir() -> PathBuf {
    DATA_DIR.get().cloned().unwrap_or_else(std::env::temp_dir)
}
