//! Shadow binary downloader.
//!
//! It downloads a pre-built archive and extracts `shadow[.exe]` from it. The
//! default archive is owned by the public Shadow satellite release
//! (amajorai/shadow); RYU_SHADOW_RELEASE_URL overrides it with a private,
//! pre-release or self-built archive. The shared download, verification and
//! install logic lives in [`super::super::satellite_downloader`].

use std::path::PathBuf;

use anyhow::Result;

use super::super::satellite_downloader::{SatelliteBinary, SatelliteDownloader};
use crate::sidecar::download_manager::ProgressCallback;

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "shadow.exe"
    } else {
        "shadow"
    };
    crate::paths::bin_dir().join(name)
}

/// The release asset this host needs — `shadow-<os>-<arch>.<ext>`.
fn artifact_name() -> String {
    let ext = if cfg!(target_os = "windows") {
        "zip"
    } else {
        "tar.gz"
    };
    format!("shadow-{}.{ext}", crate::update::platform_tag())
}

pub(in crate::sidecar::tools) static SPEC: SatelliteBinary = SatelliteBinary {
    name: "shadow",
    label: "Shadow",
    repo: "amajorai/shadow",
    url_env: "RYU_SHADOW_RELEASE_URL",
    tmp_stem: "shadow",
    version_args: &["--version"],
    bin_path,
    artifact_name,
};

pub struct ShadowDownloader(SatelliteDownloader);

impl ShadowDownloader {
    pub fn new() -> Self {
        Self(SatelliteDownloader::new(&SPEC))
    }

    pub fn with_progress(self, cb: ProgressCallback) -> Self {
        Self(self.0.with_progress(cb))
    }

    /// Ensure the Shadow binary is installed at `<data dir>/bin/shadow`.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        self.0.ensure_installed(downloads).await
    }
}

impl Default for ShadowDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_path_is_under_the_ryu_bin_dir() {
        let p = bin_path();
        assert_eq!(p.parent().and_then(|d| d.file_name()), Some("bin".as_ref()));
        assert!(
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("shadow")),
            "got: {}",
            p.display()
        );
    }
}
