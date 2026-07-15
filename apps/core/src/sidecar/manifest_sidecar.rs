//! The **app ⇄ sidecar bridge** (M3): a generic [`Sidecar`] driven entirely by a
//! plugin manifest's declarative [`SidecarSpec`], instead of hardcoded Rust.
//!
//! A built-in sidecar (llama.cpp, ghost, shadow, …) is a bespoke `impl Sidecar`
//! compiled into Core and hand-registered in `main.rs`. That is the right shape
//! for **infra** sidecars (Core's own substrate) but a wall for **capability**
//! sidecars: a third-party app cannot ship one, and a first-party one still needs
//! a code change. [`ManifestSidecar`] closes that gap — it is one `impl Sidecar`
//! that reads a [`SidecarSpec`] (binary URL/args/env or a Python venv), and is
//! registered into the live [`crate::sidecar::SidecarManager`] on plugin-enable so
//! it rides the *same* managed lifecycle (health monitor, resource sampler,
//! `/api/sidecar/status`, graceful stop) as any built-in.
//!
//! ## Security gate (Core-vs-Gateway)
//!
//! Downloading and spawning an arbitrary process from a manifest is a network +
//! arbitrary-code surface — broader than the external-runtime venv path. It is
//! gated by [`may_run_sidecar`]: a **Core-tier** (first-party) plugin is
//! auto-allowed; a **Community-tier** plugin needs the Gateway-approved
//! [`GRANT_SIDECAR_PROCESS`] (`sidecar:process`) grant, read from the plugin's
//! *approved* grants (post-Gateway-validation), never its declared, unvalidated
//! `permission_grants`. Deciding *what is allowed* is the Gateway's call; this
//! module describes the gate and does the work once permitted. `sidecar:process`
//! is the single grant for running a managed process from a manifest — for the
//! Python flavor it stands in for `runtime:external`, since binary execution is
//! the broader surface and one grant is clearer than two overlapping ones.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::plugin_manifest::schema::{BinarySpec, SidecarProcess, SidecarSpec};
use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// The Gateway grant a Community-tier plugin must hold (approved) before Core will
/// download + spawn a manifest-declared managed sidecar. Follows the existing
/// `category:action` grant convention (`mcp:`, `hook:`, `runtime:`).
pub const GRANT_SIDECAR_PROCESS: &str = "sidecar:process";

/// How long to wait on a health-check HTTP request before treating it as down.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether a plugin of `tier` holding `approved_grants` may run a manifest-declared
/// managed sidecar. Core-tier (first-party) is always allowed; Community-tier is
/// allowed IFF the Gateway approved the [`GRANT_SIDECAR_PROCESS`] grant.
///
/// `approved_grants` MUST be the Gateway-approved set
/// ([`crate::plugins::PluginRecord::approved_grants`]), never the manifest's
/// declared, unvalidated `permission_grants`. Fail-closed. Pure so the gate is
/// unit-tested without a live enable.
pub fn may_run_sidecar(
    tier: crate::plugin_manifest::PluginTier,
    approved_grants: &[String],
) -> bool {
    match tier {
        crate::plugin_manifest::PluginTier::Core => true,
        crate::plugin_manifest::PluginTier::Community => {
            approved_grants.iter().any(|g| g == GRANT_SIDECAR_PROCESS)
        }
    }
}

/// The [`SidecarManager`](crate::sidecar::SidecarManager) key for a plugin's
/// declared sidecar: `<plugin_id>/<local_name>`. The `/` keeps the plugin's
/// namespace distinct from every built-in (which use bare names) and from other
/// plugins. Both parts are already validated (`validate_plugin_id` /
/// `validate_sidecar_spec`) so the result is a safe, collision-free key.
pub fn namespaced_name(plugin_id: &str, local_name: &str) -> String {
    format!("{plugin_id}/{local_name}")
}

/// A [`Sidecar`] whose lifecycle is driven by a manifest [`SidecarSpec`].
pub struct ManifestSidecar {
    /// Namespaced manager key (`<plugin_id>/<spec.name>`).
    name: String,
    /// The owning plugin id (for the on-disk directory + logs).
    plugin_id: String,
    spec: SidecarSpec,
    downloads: crate::downloads::DownloadCenter,
    handle: ProcessHandle,
}

impl ManifestSidecar {
    /// Build a manifest sidecar for `plugin_id` from `spec`. The caller is
    /// responsible for the tier + grant gate ([`may_run_sidecar`]) BEFORE
    /// registering/starting it.
    pub fn new(
        plugin_id: String,
        spec: SidecarSpec,
        downloads: crate::downloads::DownloadCenter,
    ) -> Self {
        let name = namespaced_name(&plugin_id, &spec.name);
        Self {
            name,
            plugin_id,
            spec,
            downloads,
            handle: ProcessHandle::new(),
        }
    }

    /// `<plugins_dir>/<plugin_id>` — where this plugin's `bin/` and `runtime/`
    /// directories live, namespaced so two plugins never collide.
    fn plugin_dir(&self) -> PathBuf {
        crate::plugin_manifest::PluginManifestLoader::plugins_dir().join(&self.plugin_id)
    }

    /// The health-check URL: `http://127.0.0.1:<port><health_path>`.
    fn health_url(&self) -> String {
        health_url(self.spec.port, &self.spec.health_path)
    }
}

/// Build the loopback health-check URL for a port + path. Pure, so it is unit
/// tested without a running process.
fn health_url(port: u16, health_path: &str) -> String {
    format!("http://127.0.0.1:{port}{health_path}")
}

/// The safe last-path-segment filename of a download URL (fail-closed).
fn url_filename(url: &str) -> anyhow::Result<String> {
    let parsed =
        url::Url::parse(url).map_err(|e| anyhow::anyhow!("invalid binary url '{url}': {e}"))?;
    parsed
        .path_segments()
        .and_then(|segs| segs.last())
        .filter(|f| {
            !f.is_empty() && *f != "." && *f != ".." && !f.contains('\\') && !f.contains('\0')
        })
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("cannot derive a safe filename from '{url}'"))
}

/// The per-version install directory for a binary sidecar:
/// `<plugin_dir>/bin/<version>`. Namespacing by version means bumping `version`
/// re-downloads/re-extracts into a fresh path.
fn version_dir(plugin_dir: &Path, bin: &BinarySpec) -> PathBuf {
    plugin_dir.join("bin").join(&bin.version)
}

/// SSRF-screen a plugin-controlled URL and require https. Shared by the raw-binary
/// and archive download paths.
async fn screen_https(url: &str) -> anyhow::Result<()> {
    let parsed = crate::server::screen_agent_egress_url(url)
        .await
        .map_err(|e| anyhow::anyhow!("binary url rejected: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(anyhow::anyhow!(
            "binary url must use https, got '{}'",
            parsed.scheme()
        ));
    }
    Ok(())
}

/// Download (checksum-verified, idempotent) the binary — raw executable or archive
/// — into its versioned install dir, extract if archived, make the executable
/// runnable, and return the path to run.
async fn ensure_binary(
    bin: &BinarySpec,
    plugin_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> anyhow::Result<PathBuf> {
    let dir = version_dir(plugin_dir, bin);
    let sha = bin.sha256.clone().filter(|s| !s.is_empty());

    let exe = match &bin.archive {
        // ── Raw executable ────────────────────────────────────────────────────
        None => {
            let dest = dir.join(url_filename(&bin.url)?);
            // Idempotency: without a checksum an already-present binary is trusted;
            // with one, DownloadCenter verifies the on-disk file (skip / re-fetch).
            if !(sha.is_none() && dest.exists()) {
                screen_https(&bin.url).await?;
                downloads
                    .download_blocking(crate::downloads::DownloadSpec {
                        kind: crate::downloads::DownloadKind::Other,
                        label: format!("plugin sidecar binary: {}", bin.url),
                        url: bin.url.clone(),
                        dest: dest.clone(),
                        sha256: sha,
                        version_record: None,
                    })
                    .await?;
            }
            dest
        }
        // ── Archive (extract the whole tree so sibling libs stay co-located) ───
        Some(fmt) => {
            let root = dir.join("root");
            // `binary_name` is required + validated for archives; unwrap is safe
            // post-validation but guard anyway (fail-closed, no panic).
            let binary_name = bin.binary_name.as_deref().ok_or_else(|| {
                anyhow::anyhow!("archive sidecar is missing 'binary_name'")
            })?;
            let exe = root.join(binary_name);
            // Idempotency: once extracted, reuse it — re-reading a multi-hundred-MB
            // archive on every start is not worth it. The checksum guarantee is
            // enforced at install time (below), not on every boot.
            if !exe.exists() {
                let archive_path = dir.join(url_filename(&bin.url)?);
                if !(sha.is_none() && archive_path.exists()) {
                    screen_https(&bin.url).await?;
                    downloads
                        .download_blocking(crate::downloads::DownloadSpec {
                            kind: crate::downloads::DownloadKind::Other,
                            label: format!("plugin sidecar archive: {}", bin.url),
                            url: bin.url.clone(),
                            dest: archive_path.clone(),
                            sha256: sha,
                            version_record: None,
                        })
                        .await?;
                }
                extract_archive(fmt, &archive_path, &root).await?;
                if !exe.exists() {
                    return Err(anyhow::anyhow!(
                        "archive did not contain the declared binary '{binary_name}'"
                    ));
                }
            }
            exe
        }
    };

    make_executable(&exe).await;
    Ok(exe)
}

/// Extract `archive_path` (format `fmt`) into `dest_dir` on a blocking thread
/// (the extractors are synchronous + CPU-bound). Preserves the archive's internal
/// directory structure so an executable's sibling libraries land next to it.
async fn extract_archive(fmt: &str, archive_path: &Path, dest_dir: &Path) -> anyhow::Result<()> {
    let fmt = fmt.to_owned();
    let archive_path = archive_path.to_owned();
    let dest_dir = dest_dir.to_owned();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let data = std::fs::read(&archive_path)
            .map_err(|e| anyhow::anyhow!("reading archive {}: {e}", archive_path.display()))?;
        use crate::sidecar::download_manager::{
            extract_tar_bz2_to_dir, extract_tar_gz_to_dir, extract_zip_to_dir,
        };
        match fmt.as_str() {
            "tar.gz" => extract_tar_gz_to_dir(&data, &dest_dir, None)?,
            "tar.bz2" => extract_tar_bz2_to_dir(&data, &dest_dir, None)?,
            "zip" => extract_zip_to_dir(&data, &dest_dir, None)?,
            other => return Err(anyhow::anyhow!("unsupported archive format '{other}'")),
        };
        Ok(())
    })
    .await
    .map_err(|e| anyhow::anyhow!("archive extraction task panicked: {e}"))?
}

/// Best-effort `chmod 755` on Unix so a freshly downloaded binary can be spawned.
/// A no-op on Windows (executability is not a permission bit there).
async fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) =
            tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).await
        {
            tracing::warn!("could not chmod {}: {e}", path.display());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Spawn a program (absolute path) with owned args + env layered on the inherited
/// environment, storing the child in `handle`.
async fn spawn(
    handle: &ProcessHandle,
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    handle.start_path_with_env(program, args, &env).await
}

impl Sidecar for ManifestSidecar {
    fn name(&self) -> &str {
        &self.name
    }

    /// Manifest sidecars are always optional: a plugin's process failing to start
    /// must never abort Core boot (unlike a required infra sidecar).
    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let name = self.name.clone();
        let spec = self.spec.clone();
        let plugin_dir = self.plugin_dir();
        let downloads = self.downloads.clone();
        let handle = self.handle.clone();
        Box::pin(async move {
            match &spec.process {
                SidecarProcess::Binary(bin) => {
                    let exe = ensure_binary(bin, &plugin_dir, &downloads).await?;
                    spawn(&handle, &exe.to_string_lossy(), &bin.args, &bin.env).await?;
                }
                SidecarProcess::Python(rt) => {
                    // Reuse the external-runtime provisioner (venv + pip + assets),
                    // then spawn `<venv python> -m <entry>`. The runtime lives in a
                    // per-sidecar dir so two python sidecars in one plugin don't share
                    // a venv.
                    let dir = plugin_dir.join("runtime").join(&spec.name);
                    let python =
                        crate::sidecar::external_runtime::provision(rt, &dir, &downloads)
                            .await
                            .map_err(|e| anyhow::anyhow!("python provisioning failed: {e}"))?;
                    let args = vec!["-m".to_owned(), rt.entry.clone()];
                    // Layer the manifest-declared env, expanding `${RYU_DIR}` so a
                    // runtime can target Core-owned cache/output paths portably.
                    let ryu_dir = crate::paths::ryu_dir();
                    let ryu_dir_str = ryu_dir.to_string_lossy();
                    let env: BTreeMap<String, String> = rt
                        .env
                        .iter()
                        .map(|(k, v)| (k.clone(), v.replace("${RYU_DIR}", &ryu_dir_str)))
                        .collect();
                    spawn(&handle, &python.to_string_lossy(), &args, &env).await?;
                }
            }
            tracing::info!("manifest sidecar '{name}' started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let handle = self.handle.clone();
        Box::pin(async move { handle.stop().await })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = self.handle.is_running();
        let url = self.health_url();
        Box::pin(async move {
            if !running {
                return HealthStatus::Unhealthy("process not running".to_owned());
            }
            let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
                Ok(c) => c,
                Err(e) => return HealthStatus::Degraded(format!("client build failed: {e}")),
            };
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => HealthStatus::Degraded(format!("health returned {}", resp.status())),
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.handle.is_running()
    }

    fn pid(&self) -> Option<u32> {
        self.handle.pid()
    }

    /// The declared port, so the manager's port registry can reject a collision
    /// with a built-in or another plugin before spawning.
    fn port(&self) -> Option<u16> {
        Some(self.spec.port)
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        let handle = self.handle.clone();
        let plugin_dir = self.plugin_dir();
        let local = self.spec.name.clone();
        let name = self.name.clone();
        Box::pin(async move {
            let _ = handle.stop().await;
            // Remove the installed binary tree for this sidecar's plugin bin/. The
            // per-version namespacing lives under `bin/`, so drop the whole dir.
            crate::sidecar::remove_dir(&plugin_dir.join("bin")).await;
            if delete_data {
                crate::sidecar::remove_dir(&plugin_dir.join("runtime").join(&local)).await;
            }
            tracing::info!("manifest sidecar '{name}' uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::schema::ExternalRuntimeConfig;
    use crate::plugin_manifest::PluginTier;

    fn binary_spec() -> SidecarSpec {
        SidecarSpec {
            name: "engine".to_owned(),
            process: SidecarProcess::Binary(BinarySpec {
                url: "https://example.com/dl/my-engine".to_owned(),
                sha256: None,
                version: "1.2.3".to_owned(),
                archive: None,
                binary_name: None,
                args: vec!["--port".to_owned(), "9099".to_owned()],
                env: BTreeMap::new(),
            }),
            port: 9099,
            health_path: "/health".to_owned(),
        }
    }

    #[test]
    fn namespaced_name_joins_plugin_and_local() {
        assert_eq!(namespaced_name("com.acme.tool", "engine"), "com.acme.tool/engine");
    }

    #[test]
    fn health_url_is_loopback() {
        assert_eq!(health_url(9099, "/health"), "http://127.0.0.1:9099/health");
        assert_eq!(health_url(8080, "/v1/ping"), "http://127.0.0.1:8080/v1/ping");
    }

    #[test]
    fn sidecar_name_is_namespaced() {
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let sc = ManifestSidecar::new("com.acme.tool".to_owned(), binary_spec(), downloads);
        assert_eq!(sc.name(), "com.acme.tool/engine");
        assert!(!sc.is_required());
        assert!(!sc.is_running());
        assert_eq!(sc.pid(), None);
        assert_eq!(sc.port(), Some(9099));
    }

    #[test]
    fn version_dir_is_namespaced() {
        let bin = BinarySpec {
            url: "https://example.com/dl/my-engine".to_owned(),
            sha256: None,
            version: "1.2.3".to_owned(),
            archive: None,
            binary_name: None,
            args: vec![],
            env: BTreeMap::new(),
        };
        let dir = version_dir(Path::new("/plugins/acme"), &bin);
        assert_eq!(dir, Path::new("/plugins/acme").join("bin").join("1.2.3"));
        assert_eq!(
            dir.join(url_filename(&bin.url).unwrap()),
            Path::new("/plugins/acme").join("bin").join("1.2.3").join("my-engine")
        );
    }

    #[test]
    fn url_filename_rejects_url_without_filename() {
        assert!(url_filename("https://example.com/dl/").is_err());
        assert_eq!(url_filename("https://example.com/a/b/tool").unwrap(), "tool");
    }

    #[test]
    fn core_tier_always_runs() {
        assert!(may_run_sidecar(PluginTier::Core, &[]));
        assert!(may_run_sidecar(PluginTier::Core, &["unrelated:grant".to_owned()]));
    }

    #[test]
    fn community_tier_needs_approved_grant() {
        assert!(!may_run_sidecar(PluginTier::Community, &[]));
        assert!(!may_run_sidecar(
            PluginTier::Community,
            &["mcp:web_search".to_owned()]
        ));
        assert!(may_run_sidecar(
            PluginTier::Community,
            &[GRANT_SIDECAR_PROCESS.to_owned()]
        ));
    }

    #[test]
    fn python_flavor_builds() {
        let spec = SidecarSpec {
            name: "tts".to_owned(),
            process: SidecarProcess::Python(ExternalRuntimeConfig {
                kind: "python".to_owned(),
                entry: "ryu_tts".to_owned(),
                ..Default::default()
            }),
            port: 8085,
            health_path: "/health".to_owned(),
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let sc = ManifestSidecar::new("com.acme.voice".to_owned(), spec, downloads);
        assert_eq!(sc.name(), "com.acme.voice/tts");
        assert_eq!(sc.health_url(), "http://127.0.0.1:8085/health");
    }
}
