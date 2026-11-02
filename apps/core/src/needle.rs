//! Core's Cactus Needle selector for unified tool and Agent Skill discovery,
//! shared by the pinned [`crate::needle2`] and [`crate::needle3`] releases.
//!
//! Needle is deliberately used as a selector, not as an authorization or
//! execution engine. Core builds a temporary function-schema view of the
//! already-scoped catalog, asks Needle for the relevant function aliases,
//! and maps those aliases back to canonical Ryu descriptor ids. The existing
//! Gateway allowlist, approval, budget, audit, and Core dispatch paths remain
//! authoritative after this point.
//!
//! The upstream runtime is a small C ABI shipped in a platform-specific Python
//! wheel. We load that ABI dynamically so the normal Core binary stays usable
//! when the optional runtime is unavailable. The default path lazily downloads
//! and checksum-verifies the pinned public wheel through Ryu's DownloadCenter;
//! an unavailable runtime falls back to the deterministic BM25 ranker. Each
//! release module pins its own [`NeedleRuntime`]: repository, revision, wheel
//! digests, override env vars and, for Needle 3, separately shipped weights.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tokio::sync::Mutex;
use tracing::warn;

use ryu_sidecar_runtime::layout;

use ryu_tool_registry::{ToolDescriptor, ToolSelector};

mod install;
mod library;

pub(crate) use install::platform_tag;
use install::{extract_library, library_name};
use library::NeedleLibrary;

/// One pinned Needle release: where its runtime comes from, which env vars
/// override it, and the process-wide state its C ABI needs.
pub(crate) struct NeedleRuntime {
    /// Human-readable release name used in logs and errors (`Needle 2`).
    pub(crate) label: &'static str,
    /// Engine, model and cache directory name (`needle2`); also the stem of
    /// its DownloadCenter version-record keys (`needle2-engine-<platform>`).
    pub(crate) name: &'static str,
    /// Hugging Face repository that hosts the wheels and weights.
    pub(crate) repo: &'static str,
    pub(crate) revision: &'static str,
    pub(crate) engine_version: &'static str,
    /// Library override env vars, checked in order. The first is the one
    /// suggested when this target has no bundled runtime wheel.
    pub(crate) library_env_keys: &'static [&'static str],
    /// File stem of the native library inside the wheel's `needle/` package.
    pub(crate) wheel_library_stem: &'static str,
    /// The pinned wheel digest for a platform tag.
    pub(crate) wheel_sha256: fn(&str) -> Option<&'static str>,
    /// Weights shipped outside the wheel and handed to `needle_load`.
    pub(crate) weights: Option<NeedleWeights>,
    pub(crate) state: NeedleState,
}

/// Separately downloaded weights for a release whose library loads them at
/// runtime instead of embedding them.
pub(crate) struct NeedleWeights {
    /// Env var that points at a local weights file instead.
    pub(crate) env_key: &'static str,
    /// File name in the repository and under the model dir.
    pub(crate) file_name: &'static str,
    pub(crate) sha256: &'static str,
}

/// Process-wide state owned by one [`NeedleRuntime`].
pub(crate) struct NeedleState {
    /// The DownloadCenter shared by Core's other managed artifacts.
    downloads: OnceLock<crate::downloads::DownloadCenter>,
    /// The one process-local selector instance. Needle's C ABI owns one active
    /// toolset, so a mutex inside the instance serializes its init/complete pair.
    selector: OnceLock<Arc<NeedleSelector>>,
    /// Needle's C ABI state is process-global even when callers construct more
    /// than one Rust selector (for example, concurrent catalog and skill searches
    /// or isolated tests). Serialize the full init/complete/reset transaction
    /// across those instances as well.
    call_lock: std::sync::Mutex<()>,
}

impl NeedleState {
    pub(crate) const fn new() -> Self {
        Self {
            downloads: OnceLock::new(),
            selector: OnceLock::new(),
            call_lock: std::sync::Mutex::new(()),
        }
    }
}

impl NeedleRuntime {
    /// Install Core's process-wide DownloadCenter before any catalog search can
    /// lazily fetch this runtime. Idempotent to keep test/bootstrap wiring
    /// harmless when called more than once.
    pub(crate) fn install_downloads(&self, downloads: crate::downloads::DownloadCenter) {
        let _ = self.state.downloads.set(downloads);
    }

    /// Return this release's shared Core selector.
    pub(crate) fn selector(&'static self) -> Arc<NeedleSelector> {
        self.state
            .selector
            .get_or_init(|| Arc::new(NeedleSelector::new(self)))
            .clone()
    }

    pub(crate) fn explicit_library_path(&self) -> Result<Option<PathBuf>, String> {
        for key in self.library_env_keys {
            let Some(value) = std::env::var_os(key) else {
                continue;
            };
            let path = PathBuf::from(value);
            if path.is_file() {
                return Ok(Some(path));
            }
            return Err(format!("{key} points to a missing {} library", self.label));
        }
        Ok(None)
    }

    /// `None` when the weights are not overridden, or this release has none.
    pub(crate) fn explicit_weights_path(&self) -> Result<Option<PathBuf>, String> {
        let Some(weights) = &self.weights else {
            return Ok(None);
        };
        let key = weights.env_key;
        let Some(value) = std::env::var_os(key) else {
            return Ok(None);
        };
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(Some(path));
        }
        Err(format!("{key} points to missing {} weights", self.label))
    }

    /// Resolve this release's separate weights, downloading them on first use.
    /// `None` when the release ships none.
    pub(crate) async fn ensure_default_weights(&self) -> Result<Option<PathBuf>, String> {
        let Some(weights) = &self.weights else {
            return Ok(None);
        };
        if let Some(path) = self.explicit_weights_path()? {
            return Ok(Some(path));
        }
        // Weights are a model, not part of the engine: `models/tool-routing/<name>/<ver>/`.
        let base = layout::model_family_dir(
            &crate::paths::ryu_dir(),
            layout::Modality::ToolRouting,
            self.name,
        )
        .join(self.engine_version);
        let weight_path = base.join(weights.file_name);
        if weight_path.is_file() {
            return Ok(Some(weight_path));
        }
        if let Some(refusal) = crate::sidecar::onboarding::automatic_download_refusal(&format!(
            "The {} tool and skill router weights",
            self.label
        )) {
            return Err(refusal);
        }
        std::fs::create_dir_all(&base)
            .map_err(|error| format!("create {} cache {}: {error}", self.label, base.display()))?;
        self.download(
            "weights",
            crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Engine,
                role: crate::downloads::DownloadRole::Engine,
                label: format!("{} tool and skill router weights", self.label),
                url: format!(
                    "https://huggingface.co/{}/resolve/{}/{}",
                    self.repo, self.revision, weights.file_name
                ),
                dest: weight_path.clone(),
                sha256: Some(weights.sha256.to_owned()),
                version_record: self.version_record("weights"),
            },
        )
        .await?;
        Ok(Some(weight_path))
    }

    pub(crate) async fn ensure_default_library(&self) -> Result<PathBuf, String> {
        let label = self.label;
        let Some(platform) = platform_tag() else {
            return Err(format!(
                "{label} has no bundled runtime wheel for target {}-{}; set {}",
                std::env::consts::OS,
                std::env::consts::ARCH,
                self.library_env_keys[0]
            ));
        };
        let library_name = library_name();
        let base = layout::engine_dir(
            &crate::paths::ryu_dir(),
            layout::EngineGroup::ToolRouting,
            self.name,
        )
        .join(self.engine_version);
        let library_path = base.join(library_name);
        if library_path.is_file() {
            return Ok(library_path);
        }
        // With automatic local downloads off, refuse before any download (and
        // before creating the cache dir) so tool ranking falls back to BM25.
        if let Some(refusal) =
            crate::sidecar::onboarding::automatic_download_refusal(&format!("The {label} runtime"))
        {
            return Err(refusal);
        }
        std::fs::create_dir_all(&base)
            .map_err(|error| format!("create {label} cache {}: {error}", base.display()))?;

        let wheel_name = format!(
            "cactus_needle-{}-py3-none-{platform}.whl",
            self.engine_version
        );
        // The wheel is only an archive to pull the library out of: stage it in
        // `tmp/downloads`, keep just the library in the engine dir.
        let wheel_path = crate::sidecar::download_manager::tmp_dir().join(&wheel_name);
        let url = format!(
            "https://huggingface.co/{}/resolve/{}/python/{wheel_name}",
            self.repo, self.revision
        );
        let wheel_path = self
            .download(
                "runtime",
                crate::downloads::DownloadSpec {
                    kind: crate::downloads::DownloadKind::Engine,
                    role: crate::downloads::DownloadRole::Engine,
                    label: format!("{label} tool and skill router"),
                    url,
                    dest: wheel_path,
                    sha256: (self.wheel_sha256)(platform).map(str::to_owned),
                    version_record: self.version_record(platform),
                },
            )
            .await?;

        let library_path_for_extract = library_path.clone();
        // Installed as `libneedle.<ext>`; the wheel may name it after its release.
        let library_member = format!(
            "needle/{}{}",
            self.wheel_library_stem,
            &library_name["libneedle".len()..]
        );
        let wheel_for_extract = wheel_path.clone();
        let name = self.name;
        tokio::task::spawn_blocking(move || {
            extract_library(
                label,
                name,
                &wheel_for_extract,
                &library_path_for_extract,
                &library_member,
            )
        })
        .await
        .map_err(|error| format!("{label} extraction worker failed: {error}"))??;
        let _ = tokio::fs::remove_file(&wheel_path).await;
        Ok(library_path)
    }

    /// Fetch one pinned artifact through Core's DownloadCenter.
    async fn download(
        &self,
        artifact: &str,
        spec: crate::downloads::DownloadSpec,
    ) -> Result<PathBuf, String> {
        let downloads = self
            .state
            .downloads
            .get()
            .cloned()
            .ok_or_else(|| format!("{} DownloadCenter is not initialized", self.label))?;
        downloads
            .download_blocking(spec)
            .await
            .map_err(|error| format!("download {} {artifact}: {error:#}", self.label))
    }

    fn version_record(&self, suffix: &str) -> Option<crate::downloads::VersionRecord> {
        Some(crate::downloads::VersionRecord {
            store_key: format!("{}-engine-{suffix}", self.name),
            version: self.engine_version.to_owned(),
        })
    }

    fn tool_index_path(&self) -> PathBuf {
        layout::cache_path(
            &crate::paths::ryu_dir(),
            &format!("{}/tools.idx", self.name),
        )
    }
}

pub(crate) struct NeedleSelector {
    runtime: &'static NeedleRuntime,
    /// `None` until the first successful resolution. Failed downloads are not
    /// cached permanently, so a transient network failure can recover later.
    resolved_library: Mutex<Option<PathBuf>>,
    /// Needle's C ABI has process-global state and is not safe to call
    /// concurrently. The dynamic library stays loaded for Core's lifetime.
    engine: Arc<std::sync::Mutex<Option<NeedleLibrary>>>,
}

impl NeedleSelector {
    pub(crate) fn new(runtime: &'static NeedleRuntime) -> Self {
        Self {
            runtime,
            resolved_library: Mutex::default(),
            engine: Arc::default(),
        }
    }

    async fn library_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = self.runtime.explicit_library_path()? {
            return Ok(path);
        }

        let mut resolved = self.resolved_library.lock().await;
        if let Some(path) = resolved.as_ref() {
            return Ok(path.clone());
        }
        let path = self.runtime.ensure_default_library().await?;
        *resolved = Some(path.clone());
        Ok(path)
    }
}

#[async_trait::async_trait]
impl ToolSelector for NeedleSelector {
    async fn select(&self, query: &str, candidates: &[ToolDescriptor]) -> Option<Vec<String>> {
        if query.trim().is_empty() || candidates.is_empty() {
            return Some(Vec::new());
        }

        let runtime = self.runtime;
        let label = runtime.label;
        let path = match self.library_path().await {
            Ok(path) => path,
            Err(error) => {
                warn!(error = %error, "{label} unavailable; falling back to BM25 tool ranking");
                return None;
            }
        };
        let weight_path = match runtime.ensure_default_weights().await {
            Ok(path) => path,
            Err(error) => {
                warn!(error = %error, "{label} weights unavailable; falling back to BM25 tool ranking");
                return None;
            }
        };
        let query = query.to_owned();
        let candidates = candidates.to_vec();
        let engine = Arc::clone(&self.engine);

        match tokio::task::spawn_blocking(move || {
            let _call_guard = runtime
                .state
                .call_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut guard = engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_none() {
                *guard = Some(NeedleLibrary::load(runtime, &path, weight_path.as_deref())?);
            }
            guard
                .as_mut()
                .expect("Needle library was initialized")
                .select(&query, &candidates)
        })
        .await
        {
            Ok(Ok(selected)) => Some(selected),
            Ok(Err(error)) => {
                warn!(error = %error, "{label} selection failed; falling back to BM25 tool ranking");
                None
            }
            Err(error) => {
                warn!(error = %error, "{label} worker failed; falling back to BM25 tool ranking");
                None
            }
        }
    }
}

/// Catalog fixtures shared by the release modules' runtime smoke tests.
#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests;
