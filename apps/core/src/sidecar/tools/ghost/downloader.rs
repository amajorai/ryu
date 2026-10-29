//! Ghost binary downloader.
//!
//! It downloads a pre-built archive and extracts `ghost[.exe]` from it. The
//! default archive is owned by the public Ghost satellite release
//! (amajorai/ghost); RYU_GHOST_RELEASE_URL overrides it with a private,
//! pre-release or self-built archive. The shared download, verification and
//! install logic lives in [`super::super::satellite_downloader`].

use std::path::PathBuf;

use anyhow::Result;

use super::super::satellite_downloader::{SatelliteBinary, SatelliteDownloader};
use crate::sidecar::download_manager::ProgressCallback;

fn bin_path() -> PathBuf {
    super::ghost_bin_path()
}

/// The release asset this host needs — `ghost-<os>-<arch>.<ext>`.
fn artifact_name() -> String {
    let ext = if cfg!(target_os = "windows") {
        "zip"
    } else {
        "tar.gz"
    };
    format!("ghost-{}.{ext}", crate::update::platform_tag())
}

pub(in crate::sidecar::tools) static SPEC: SatelliteBinary = SatelliteBinary {
    name: "ghost",
    label: "Ghost",
    repo: "amajorai/ghost",
    url_env: "RYU_GHOST_RELEASE_URL",
    tmp_stem: "ghost-latest",
    version_args: &["version"],
    bin_path,
    artifact_name,
};

pub struct GhostDownloader(SatelliteDownloader);

impl GhostDownloader {
    pub fn new() -> Self {
        Self(SatelliteDownloader::new(&SPEC))
    }

    pub fn with_progress(self, cb: ProgressCallback) -> Self {
        Self(self.0.with_progress(cb))
    }

    /// Ensure the Ghost binary is installed at `~/.ryu/bin/ghost`.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        self.0.ensure_installed(downloads).await
    }
}

impl Default for GhostDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_path_is_the_shared_ghost_bin() {
        assert_eq!(bin_path(), super::super::ghost_bin_path());
    }
}
