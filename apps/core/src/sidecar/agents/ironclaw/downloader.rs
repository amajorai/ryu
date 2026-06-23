//! IronClaw downloader — now a thin wrapper over the shared
//! [`crate::sidecar::agents::archive_agent`] machinery, which it was the model
//! for. IronClaw's per-platform GitHub-release archive (`ironclaw-<platform>.{ext}`
//! under `nearai/ironclaw`) is expressed as an [`ArchiveAgentSpec`] and installed
//! via the generic `ensure_installed`, proving the abstraction by its first
//! consumer.

use std::path::PathBuf;

use anyhow::Result;

use crate::sidecar::agents::archive_agent::{self, ArchiveAgentSpec};

/// The IronClaw archive spec (the values the bespoke downloader used to hardcode).
const IRONCLAW_SPEC: ArchiveAgentSpec = ArchiveAgentSpec {
    id: "ironclaw",
    repo: "nearai/ironclaw",
    asset_template: "ironclaw-{platform}.{ext}",
    binary_name: "ironclaw",
    pinned_tag: None,
    label: "IronClaw",
};

pub fn binary_path() -> PathBuf {
    IRONCLAW_SPEC.binary_path()
}

pub struct IronClawDownloader;

impl IronClawDownloader {
    pub fn new() -> Self {
        Self
    }

    /// Ensure the IronClaw binary is installed at `~/.ryu/bin/ironclaw`.
    ///
    /// The release archive downloads through the global [`DownloadCenter`] (#456)
    /// so it streams to disk and shows in the overlay; the binary is then
    /// extracted and placed atomically by the shared archive machinery.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        archive_agent::ensure_installed(&IRONCLAW_SPEC, downloads).await?;
        Ok(())
    }
}

impl Default for IronClawDownloader {
    fn default() -> Self {
        Self::new()
    }
}
