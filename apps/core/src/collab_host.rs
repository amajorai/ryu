//! Core's implementation of the extracted [`ryu_collab::CollabHost`] seam.
//!
//! The `ryu-collab` crate owns the authoritative CRDT document engine — the
//! `DocRegistry`, the `CollabStore` rusqlite persistence, the `DocSyncMessage`
//! wire protocol, and the `Y.Doc -> source` projection. What it cannot own —
//! because it is a kernel utility — is the active `~/.ryu` data dir the store
//! resolves `collab.db` against ([`crate::paths::ryu_dir`]). This shim implements
//! that one coupling, and Core installs it once at boot via
//! [`ryu_collab::set_global_host`], BEFORE `CollabStore::open_default` first opens
//! the store (`main.rs`), so `open_default` never races the install.

use std::path::PathBuf;

use ryu_collab::CollabHost;

/// Install [`CoreCollabHost`] as the process-global collab host. Idempotent (a
/// second call is a no-op). Called once from `main` at boot, before the collab
/// store opens.
pub fn install() {
    ryu_collab::set_global_host(std::sync::Arc::new(CoreCollabHost));
}

/// Core's `CollabHost` — the kernel side of the collab seam.
pub struct CoreCollabHost;

impl CollabHost for CoreCollabHost {
    fn ryu_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }
}
