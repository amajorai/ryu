//! Core-side shim + host for the extracted [`ryu_downloads`] crate.
//!
//! The DownloadCenter primitive — the process-wide artifact registry, the
//! stream-to-`.part` transfer engine (HTTP Range + `If-Range` resume, bounded
//! retry, checksum-verify + atomic rename), pause/resume/cancel, live SSE
//! progress, and the durable history log — now lives in `crates/ryu-downloads`.
//! That crate has ZERO dependency on `apps/core`; the three cross-cutting calls
//! the transfer engine needs are inverted through the [`ryu_downloads::DownloadsHost`]
//! trait, implemented here:
//!
//! - the active `~/.ryu` **data dir** → [`crate::paths::ryu_dir`] (dynamic; the
//!   user can relocate the data folder at runtime),
//! - the **version-store checksum-skip** → [`crate::sidecar::download_manager::VersionStore`]
//!   (`installed_checksum` on the fast path, `record_persisted` after verify), and
//! - **Hugging Face bearer auth** → [`crate::hf_auth`] (`is_hf_url` + `authorize`;
//!   the token is attached only to Hub hosts and never leaves Core).
//!
//! Core installs the host once at boot via [`install`] (from `main`), BEFORE any
//! download can run — downloads is a non-optional dep (the sidecar loader, model
//! catalog, engines, and marketplace install all fetch through it). The rest of
//! the tree keeps using `crate::downloads::{DownloadCenter, DownloadSpec, …}`
//! unchanged via the glob re-export below.

pub use ryu_downloads::*;

use std::path::PathBuf;

use crate::sidecar::download_manager::VersionStore;

/// Install [`CoreDownloadsHost`] as the process-global downloads host. Idempotent
/// (a second call is a no-op). Called once from `main` at boot, before the first
/// download can run.
pub fn install() {
    ryu_downloads::set_global_host(std::sync::Arc::new(CoreDownloadsHost));
}

/// Core's [`ryu_downloads::DownloadsHost`] — the kernel side of the downloads seam
/// (data dir + version-store checksum-skip + Hugging Face auth).
pub struct CoreDownloadsHost;

impl ryu_downloads::DownloadsHost for CoreDownloadsHost {
    fn ryu_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }

    fn installed_checksum(&self, store_key: &str) -> Option<String> {
        VersionStore::load()
            .installed_checksum(store_key)
            .map(str::to_string)
    }

    fn record_version(&self, store_key: &str, version: &str, checksum: &str) {
        let _ = VersionStore::record_persisted(store_key, version, checksum);
    }

    fn authorize(&self, url: &str, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if crate::hf_auth::is_hf_url(url) {
            crate::hf_auth::authorize(req)
        } else {
            req
        }
    }
}
