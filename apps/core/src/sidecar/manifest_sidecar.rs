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

/// The Core preference key that gates the experimental extension-host runtime
/// (`kind: "node"` sidecars). Mirrors the desktop `ryu:experimental-plugin-runtime`
/// flag so a single toggle governs both surfaces; **default OFF**. Also satisfiable
/// via the `RYU_EXPERIMENTAL_PLUGIN_RUNTIME` env (the headless/test seam).
pub const EXPERIMENTAL_PLUGIN_RUNTIME_PREF: &str = "ryu:experimental-plugin-runtime";

/// Env override for [`EXPERIMENTAL_PLUGIN_RUNTIME_PREF`] — truthy (`1`/`true`/`on`)
/// enables the node runtime without a prefs DB write. Read first so a headless Core
/// (and the integration harness) can opt in with no desktop.
const EXPERIMENTAL_PLUGIN_RUNTIME_ENV: &str = "RYU_EXPERIMENTAL_PLUGIN_RUNTIME";

/// The embedded extension-host bootstrap (RFC Option B) — the first-party JS Core
/// passes as the actual entrypoint for a `kind: "node"` sidecar. It loads the
/// plugin's declared entry module, calls `activate(context)`, and serves the managed
/// HTTP surface. Dependency-free (`node:http` only) so it runs on stock node AND bun.
const HOST_BOOTSTRAP_JS: &str = include_str!("assets/plugin_host_bootstrap.mjs");

/// Filename the embedded bootstrap is written to inside the plugin dir (dot-prefixed
/// so it never collides with a plugin's own entry path).
const HOST_BOOTSTRAP_FILENAME: &str = ".ryu-host-bootstrap.mjs";

/// Whether a truthy flag string enables a boolean toggle (`1`/`true`/`on`, case-insensitive).
fn is_truthy(v: &str) -> bool {
    let t = v.trim();
    t == "1" || t.eq_ignore_ascii_case("true") || t.eq_ignore_ascii_case("on")
}

/// Whether the experimental plugin runtime is enabled: the `RYU_EXPERIMENTAL_PLUGIN_RUNTIME`
/// env override first (the headless/test seam), else the Core preference
/// [`EXPERIMENTAL_PLUGIN_RUNTIME_PREF`] (the desktop toggle). **Default OFF** — a
/// `kind: "node"` sidecar refuses to spawn until this is on.
async fn experimental_plugin_runtime_enabled() -> bool {
    if let Ok(v) = std::env::var(EXPERIMENTAL_PLUGIN_RUNTIME_ENV) {
        if is_truthy(&v) {
            return true;
        }
    }
    if let Ok(store) = crate::server::preferences::PreferencesStore::open_default() {
        if let Ok(Some(v)) = store.get(EXPERIMENTAL_PLUGIN_RUNTIME_PREF).await {
            return is_truthy(&v);
        }
    }
    false
}

/// Resolve a JS runtime for a node sidecar: an explicit `"bun"`/`"node"` (already
/// spec-validated) must exist on `PATH`; otherwise prefer `bun` then `node`.
/// Returns the bare program name (PATH-resolved at spawn) or a descriptive error.
fn resolve_node_runtime(explicit: Option<&str>) -> anyhow::Result<String> {
    if let Some(rt) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        if which_on_path(rt).is_some() {
            return Ok(rt.to_owned());
        }
        return Err(anyhow::anyhow!(
            "declared node runtime '{rt}' was not found on PATH"
        ));
    }
    for candidate in ["bun", "node"] {
        if which_on_path(candidate).is_some() {
            return Ok(candidate.to_owned());
        }
    }
    Err(anyhow::anyhow!(
        "no JavaScript runtime found on PATH (need 'bun' or 'node' for a node sidecar)"
    ))
}

/// Minimal `which`: the first `PATH` entry containing an executable `program`
/// (adding the common Windows extensions). Avoids pulling in a crate for one lookup.
fn which_on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(program);
        if direct.is_file() {
            return Some(direct);
        }
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let c = dir.join(format!("{program}.{ext}"));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

/// The full loaded manifest for `plugin_id` (built-in or user-installed), or `None`
/// when absent. Reads at spawn (rare) so it is never stale — the same pattern
/// [`declared_permissions_for`] / [`declared_capabilities_for`] use.
fn owning_manifest(plugin_id: &str) -> Option<crate::plugin_manifest::PluginManifest> {
    crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == plugin_id)
}

/// Materialize a node sidecar's backend bundle to `<plugin_dir>/<entry>` (from the
/// owning manifest's inline `backend_code` payload, mirroring `ui_code`), then
/// integrity-check the on-disk file against `backend_sha256` — **fail-closed** on a
/// mismatch so an entry file swapped between install and spawn can never run.
/// Returns the absolute entry path the bootstrap will import.
async fn prepare_node_backend(
    plugin_dir: &Path,
    entry_rel: &str,
    manifest: Option<&crate::plugin_manifest::PluginManifest>,
) -> anyhow::Result<PathBuf> {
    let entry_path = plugin_dir.join(entry_rel);

    // Write the payload bundle if the manifest carries one (the common install path).
    if let Some(code) = manifest
        .and_then(|m| m.backend_code.as_deref())
        .filter(|c| !c.is_empty())
    {
        if let Some(parent) = entry_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                anyhow::anyhow!("creating node backend dir {}: {e}", parent.display())
            })?;
        }
        tokio::fs::write(&entry_path, code)
            .await
            .map_err(|e| anyhow::anyhow!("writing node backend {}: {e}", entry_path.display()))?;
    }

    if !entry_path.exists() {
        return Err(anyhow::anyhow!(
            "node backend entry '{}' not found and the manifest carries no backend_code",
            entry_path.display()
        ));
    }

    // Integrity gate: hash the on-disk file, refuse on mismatch (fail-closed).
    if let Some(expected) = manifest
        .and_then(|m| m.backend_sha256.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let bytes = tokio::fs::read(&entry_path)
            .await
            .map_err(|e| anyhow::anyhow!("reading node backend for hashing: {e}"))?;
        use sha2::{Digest, Sha256};
        let actual = hex::encode(Sha256::digest(&bytes));
        if actual != expected.to_ascii_lowercase() {
            return Err(anyhow::anyhow!(
                "node backend hash mismatch for '{}' (manifest declares {expected}, file hashes to {actual}); refusing to start",
                entry_path.display()
            ));
        }
    }

    Ok(entry_path)
}

/// Write the embedded host bootstrap into `plugin_dir` and return its path. Rewritten
/// on every spawn so a Core upgrade always ships the current bootstrap.
async fn write_host_bootstrap(plugin_dir: &Path) -> anyhow::Result<PathBuf> {
    tokio::fs::create_dir_all(plugin_dir)
        .await
        .map_err(|e| anyhow::anyhow!("creating plugin dir {}: {e}", plugin_dir.display()))?;
    let path = plugin_dir.join(HOST_BOOTSTRAP_FILENAME);
    tokio::fs::write(&path, HOST_BOOTSTRAP_JS)
        .await
        .map_err(|e| anyhow::anyhow!("writing host bootstrap {}: {e}", path.display()))?;
    Ok(path)
}

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

// ── Native-sidecar permission record (unified permission grammar, honest v1) ──────
//
// A native (host-binary / Python) manifest sidecar is a full OS process — Core does
// NOT sandbox it this wave (ryu-mail, for one, needs real filesystem access). But a
// plugin can still DECLARE a `PermissionSet`, and it is load-bearing to (a) record
// what was declared and (b) warn loudly that the declaration is recorded-but-
// UNENFORCED for a native process, so the honesty of the deny-by-default story is
// visible rather than silently false. The sandbox-backed lanes (Deno PTC, wasmtime/
// Docker) DO enforce the same set — see `run_sandboxed_with_permissions` and
// `SandboxCapabilities::from_permissions`.
//
// The record is a process-global map ManifestSidecar writes at `start()` and the
// `SidecarManager` reads for the status surface. A module-global (rather than a
// struct field threaded through `ManifestSidecar::new`) is deliberate: `new`'s
// caller lives outside this change's file set, and the manager stores `Arc<dyn
// Sidecar>` with no downcast — this is the one in-set seam that surfaces the data
// without touching either.

/// One native manifest sidecar's declared runtime permission posture, surfaced on
/// the status plane. Serializable so wiring it onto `SidecarStatus` + the
/// `/api/sidecar/status` handler (both in `apps/core/src/sidecar/mod.rs` +
/// `server/mod.rs`, outside this change's file set) is a trivial documented
/// followup.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NativeSidecarPermissions {
    /// Namespaced sidecar key (`<plugin_id>/<local_name>`).
    pub name: String,
    /// The owning plugin id.
    pub plugin_id: String,
    /// The manifest-declared permission set, or `None` when the manifest declared
    /// no `permissions` block (deny-all intent for the sandboxed lanes; for a native
    /// process the OS access is whatever the binary does — see [`Self::enforced`]).
    pub declared: Option<crate::plugin_manifest::PermissionSet>,
    /// Always `false` for a native sidecar in v1 — the declared set is **recorded
    /// but not OS-enforced**. Present so a reader never has to infer it.
    pub enforced: bool,
}

/// Process-global record of every native manifest sidecar's declared permissions,
/// keyed by namespaced name. Written at `start()`, read by the manager.
fn native_permission_record(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, NativeSidecarPermissions>> {
    static RECORD: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, NativeSidecarPermissions>>,
    > = std::sync::OnceLock::new();
    RECORD.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// A snapshot of every native manifest sidecar's declared permission posture, for
/// the status surface. The manager re-exposes this
/// ([`crate::sidecar::SidecarManager::native_sidecar_permissions`]).
pub fn native_sidecar_permission_reports() -> Vec<NativeSidecarPermissions> {
    native_permission_record()
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

/// Load the owning plugin manifest's declared [`PermissionSet`] for `plugin_id`,
/// or `None` when the plugin is absent / declared no `permissions` block. Reads the
/// installed manifest set (rare — only at sidecar start), so it never caches stale.
fn declared_permissions_for(plugin_id: &str) -> Option<crate::plugin_manifest::PermissionSet> {
    crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == plugin_id)
        .and_then(|m| m.permissions)
}

/// Record `plugin_id`'s declared permission posture for its `name`d native sidecar
/// and, when a set is declared, emit the structured "recorded but unenforced"
/// warning. Called from `start()`. Idempotent (overwrites the prior entry).
fn record_native_permissions(name: &str, plugin_id: &str) {
    let declared = declared_permissions_for(plugin_id);
    if declared.is_some() {
        // A native process is unsandboxed this wave: any declared set is narrower
        // than the process's real OS access, so the declaration cannot be honoured
        // here. Warn loudly (structured) rather than let the deny-by-default story
        // be silently false. The Deno PTC + wasmtime/Docker lanes DO enforce it.
        tracing::warn!(
            target: "ryu::permissions",
            sidecar = %name,
            plugin_id = %plugin_id,
            enforced = false,
            "native manifest sidecar declares a runtime permission set that is \
             RECORDED BUT NOT OS-ENFORCED this wave — the process runs unsandboxed \
             with full host access (followup: OS-level sandboxing for native sidecars)"
        );
    }
    if let Ok(mut record) = native_permission_record().lock() {
        record.insert(
            name.to_owned(),
            NativeSidecarPermissions {
                name: name.to_owned(),
                plugin_id: plugin_id.to_owned(),
                declared,
                enforced: false,
            },
        );
    }
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

    /// The profile-aware bind/proxy port for this sidecar: `profile::port(spec.port)`
    /// (identity in release; shifted in dev/custom profiles so two Core profiles
    /// don't collide on a static manifest port). The single definition every port
    /// consumer here uses — health, the port registry, and (via `port()`) the ext
    /// proxy — so they never drift from the port the child is told to bind.
    pub fn effective_port(&self) -> u16 {
        crate::profile::port(self.spec.port)
    }

    /// The health-check URL: `http://127.0.0.1:<port><health_path>`.
    fn health_url(&self) -> String {
        health_url(self.effective_port(), &self.spec.health_path)
    }

    /// This plugin's minted per-process secret, injected into the sidecar at spawn
    /// (`RYU_EXT_TOKEN`), presented on the health probe, and re-stamped by the ext
    /// proxy on every hop. See [`crate::sidecar::ext_proxy::ext_token`].
    fn ext_token(&self) -> String {
        crate::sidecar::ext_proxy::ext_token(
            crate::sidecar::ext_proxy::node_token().as_deref(),
            &self.plugin_id,
        )
    }
}

/// The env vars Core injects into every manifest sidecar at spawn so it can (a)
/// authenticate the loopback caller as "came through Core" (`RYU_EXT_TOKEN`) and (b)
/// name itself on the host-API callback (`RYU_EXT_PLUGIN_ID`). Layered over the
/// manifest-declared env (the manifest cannot override these reserved keys — they are
/// applied last).
fn inject_ext_env(env: &mut BTreeMap<String, String>, plugin_id: &str, token: &str) {
    env.insert(
        crate::sidecar::ext_proxy::ENV_EXT_TOKEN.to_owned(),
        token.to_owned(),
    );
    env.insert(
        crate::sidecar::ext_proxy::ENV_EXT_PLUGIN_ID.to_owned(),
        plugin_id.to_owned(),
    );
    // Co-location guarantee: pass Core's data dir so a sidecar that persists state
    // (e.g. ryu-mail's mail.db) lands under the SAME `RYU_DIR` Core uses, honoring
    // its `RYU_DIR`-env-first paths rule. Reserved (applied last).
    env.insert(
        "RYU_DIR".to_owned(),
        crate::paths::ryu_dir().to_string_lossy().into_owned(),
    );
    // Core's own (profile-shifted) loopback port, so a sidecar that reaches BACK into
    // Core over a host callback (e.g. ryu-monitors' Spider fetch + alert fan-out) knows
    // where Core listens. Reserved + always applied here — `inject_shim_env` also sets
    // it, but only on the best-effort cap-shim path, so setting it unconditionally
    // guarantees it is present even when no shims materialize. `entry().or_insert`
    // keeps the shim path from overriding it.
    env.entry(crate::sidecar::cli_shims::ENV_CORE_PORT.to_owned())
        .or_insert_with(crate::sidecar::cli_shims::core_port_string);
}

/// This plugin's DECLARED capability edges (`requires.capabilities` names), read
/// from the installed manifest — the set the capability CLI shims generate
/// convenience aliases for. Empty when the plugin declares none (the `ryu-cap`
/// multiplexer is still materialized). Reads at spawn (rare), so never stale.
fn declared_capabilities_for(plugin_id: &str) -> Vec<String> {
    crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == plugin_id)
        .map(|m| {
            m.required_capabilities()
                .iter()
                .map(|c| c.capability.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Materialize this plugin's capability CLI shims and layer the shim dir onto the
/// child's `PATH` + inject `RYU_CORE_PORT` (via
/// [`crate::sidecar::cli_shims::inject_shim_env`]) so a sandboxed sidecar can
/// invoke brokered capabilities as plain commands (`ryu-cap`, `ryu-rag-retrieve`,
/// …). Best-effort: a materialize failure logs and leaves `env` untouched — the
/// sidecar still spawns (it just has no shims that run), never blocking Core.
async fn inject_cap_shims(env: &mut BTreeMap<String, String>, plugin_id: &str, plugin_dir: &Path) {
    let declared = declared_capabilities_for(plugin_id);
    match crate::sidecar::cli_shims::materialize(plugin_dir, &declared).await {
        Ok(shim_dir) => crate::sidecar::cli_shims::inject_shim_env(env, &shim_dir),
        Err(e) => tracing::warn!(
            plugin_id,
            error = %e,
            "could not materialize capability CLI shims; sidecar spawns without them"
        ),
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

/// Spawn a program with a MINIMAL env — the child does NOT inherit Core's
/// environment; it sees only the benign allow-list plus the explicit `env`. Used
/// for the experimental node extension host so a third-party JS backend can never
/// read Core's `RYU_TOKEN`/`RYU_MASTER_KEY`/provider keys (which would let it forge
/// any other plugin's ext-token). See [`ProcessHandle::start_path_with_clean_env`].
async fn spawn_clean(
    handle: &ProcessHandle,
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    handle.start_path_with_clean_env(program, args, &env).await
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
        let plugin_id = self.plugin_id.clone();
        let ext_token = self.ext_token();
        Box::pin(async move {
            // Record the declared runtime permission posture (and warn when it is a
            // recorded-but-unenforced set on this unsandboxed native process) before
            // the process comes up, so the status surface reflects intent even if the
            // spawn later fails.
            record_native_permissions(&name, &plugin_id);
            match &spec.process {
                SidecarProcess::Binary(bin) => {
                    let exe = ensure_binary(bin, &plugin_dir, &downloads).await?;
                    // Layer the reserved ext-loader env over the manifest's own env
                    // (applied last so a manifest can't override the injected secret).
                    let mut env = bin.env.clone();
                    inject_ext_env(&mut env, &plugin_id, &ext_token);
                    inject_cap_shims(&mut env, &plugin_id, &plugin_dir).await;
                    spawn(&handle, &exe.to_string_lossy(), &bin.args, &env).await?;
                }
                SidecarProcess::Local(local) => {
                    // A binary already on the host (a sibling Ryu ships, e.g.
                    // `ryu-mail`) — spawn directly, no download. An optional
                    // `command_env` (e.g. RYU_MAIL_BIN) overrides the program path.
                    let program = local
                        .command_env
                        .as_ref()
                        .and_then(|k| std::env::var(k).ok())
                        .map(|s| s.trim().to_owned())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| local.command.clone());
                    let mut env = local.env.clone();
                    // Tell the child which port to bind, profile-shifted, so it binds
                    // the SAME port Core health-checks + proxies to (effective_port).
                    if let Some(port_env) = &local.port_env {
                        env.insert(
                            port_env.clone(),
                            crate::profile::port(spec.port).to_string(),
                        );
                    }
                    inject_ext_env(&mut env, &plugin_id, &ext_token);
                    inject_cap_shims(&mut env, &plugin_id, &plugin_dir).await;
                    spawn(&handle, &program, &local.args, &env).await?;
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
                    let mut env: BTreeMap<String, String> = rt
                        .env
                        .iter()
                        .map(|(k, v)| (k.clone(), v.replace("${RYU_DIR}", &ryu_dir_str)))
                        .collect();
                    // Same profile-aware bind port as the Local path: inject the
                    // shifted port so the child binds what Core health-checks/proxies.
                    if let Some(port_env) = &rt.port_env {
                        env.insert(
                            port_env.clone(),
                            crate::profile::port(spec.port).to_string(),
                        );
                    }
                    inject_ext_env(&mut env, &plugin_id, &ext_token);
                    inject_cap_shims(&mut env, &plugin_id, &plugin_dir).await;
                    spawn(&handle, &python.to_string_lossy(), &args, &env).await?;
                }
                SidecarProcess::Node(node) => {
                    // Extension host (RFC Option B): run the plugin's JS backend under
                    // a managed Node/Bun runtime via Core's embedded bootstrap. Gated
                    // behind the experimental flag — a policy refusal, not a crash (the
                    // sidecar is optional, so Core boot is unaffected).
                    if !experimental_plugin_runtime_enabled().await {
                        return Err(anyhow::anyhow!(
                            "node sidecar '{name}' refused: the experimental plugin runtime is off \
                             (enable the '{EXPERIMENTAL_PLUGIN_RUNTIME_PREF}' preference or set \
                             {EXPERIMENTAL_PLUGIN_RUNTIME_ENV}=1)"
                        ));
                    }
                    let manifest = owning_manifest(&plugin_id);
                    // Materialize + integrity-check the backend bundle (fail-closed).
                    let entry_path =
                        prepare_node_backend(&plugin_dir, node.entry.trim(), manifest.as_ref())
                            .await?;
                    // Write the embedded host bootstrap next to it.
                    let bootstrap = write_host_bootstrap(&plugin_dir).await?;
                    // Resolve the runtime (explicit > bun > node on PATH).
                    let runtime = resolve_node_runtime(node.runtime.as_deref())?;

                    // Env: reserved ext-loader vars + cap shims (which set RYU_CORE_PORT
                    // for the host-RPC callback) + the host bootstrap contract.
                    let mut env: BTreeMap<String, String> = BTreeMap::new();
                    inject_ext_env(&mut env, &plugin_id, &ext_token);
                    inject_cap_shims(&mut env, &plugin_id, &plugin_dir).await;
                    env.insert(
                        "RYU_HOST_ENTRY".to_owned(),
                        entry_path.to_string_lossy().into_owned(),
                    );
                    env.insert(
                        "RYU_HOST_PORT".to_owned(),
                        crate::profile::port(spec.port).to_string(),
                    );
                    env.insert("RYU_HOST_HEALTH_PATH".to_owned(), spec.health_path.clone());
                    env.insert(
                        "RYU_HOST_PLUGIN_VERSION".to_owned(),
                        manifest
                            .as_ref()
                            .map(|m| m.version.clone())
                            .unwrap_or_default(),
                    );
                    env.insert(
                        "RYU_HOST_API_VERSION".to_owned(),
                        ryu_kernel_contracts::host_api::HOST_API_VERSION.to_owned(),
                    );

                    // Loud audit trail on every node-host spawn: it runs third-party
                    // code unsandboxed with full host access, so record who/what/which
                    // grants approved it (the single load-bearing containment is the
                    // Gateway grant gate on `sidecar:process`).
                    tracing::warn!(
                        target: "ryu::permissions",
                        sidecar = %name,
                        plugin_id = %plugin_id,
                        version = %manifest
                            .as_ref()
                            .map(|m| m.version.clone())
                            .unwrap_or_default(),
                        backend_sha256 = %manifest
                            .as_ref()
                            .and_then(|m| m.backend_sha256.clone())
                            .unwrap_or_default(),
                        declared_grants = ?manifest
                            .as_ref()
                            .map(|m| m.permission_grants.clone())
                            .unwrap_or_default(),
                        "spawning experimental node extension host — third-party code runs \
                         UNSANDBOXED with full host access (env-scrubbed of secrets; \
                         gated only by the Gateway `sidecar:process` grant)"
                    );
                    let args = vec![bootstrap.to_string_lossy().into_owned()];
                    // Node backends get a scrubbed/minimal env (never Core's secrets).
                    spawn_clean(&handle, &runtime, &args, &env).await?;
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
        // Present the minted secret on the probe so a sidecar that gates its health
        // route (defense in depth) still admits Core's own check — closing the
        // previously-unauthenticated probe. A sidecar that ignores it is unaffected.
        let token = self.ext_token();
        Box::pin(async move {
            if !running {
                return HealthStatus::Unhealthy("process not running".to_owned());
            }
            let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
                Ok(c) => c,
                Err(e) => return HealthStatus::Degraded(format!("client build failed: {e}")),
            };
            match client.get(&url).bearer_auth(&token).send().await {
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
        Some(self.effective_port())
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
            http: None,
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
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
            http: None,
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let sc = ManifestSidecar::new("com.acme.voice".to_owned(), spec, downloads);
        assert_eq!(sc.name(), "com.acme.voice/tts");
        assert_eq!(sc.health_url(), "http://127.0.0.1:8085/health");
    }

    #[test]
    fn is_truthy_accepts_common_flag_forms() {
        for on in ["1", "true", "TRUE", "on", " On "] {
            assert!(is_truthy(on), "{on:?} should be truthy");
        }
        for off in ["0", "false", "off", "", "no"] {
            assert!(!is_truthy(off), "{off:?} should be falsy");
        }
    }

    #[test]
    fn resolve_node_runtime_rejects_missing_explicit() {
        // An explicit runtime that is not on PATH is a clean error, not a fallback.
        let err = resolve_node_runtime(Some("definitely-not-a-real-runtime-xyz"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not found on PATH"), "{err}");
    }

    #[test]
    fn which_on_path_finds_a_known_program() {
        // `sh` on unix / `cmd` on windows is always present — proves the lookup works.
        #[cfg(unix)]
        assert!(which_on_path("sh").is_some());
        #[cfg(windows)]
        assert!(which_on_path("cmd").is_some());
        assert!(which_on_path("definitely-not-a-real-program-xyz").is_none());
    }

    fn tmp_plugin_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ryu-node-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest_with_backend(code: &str, sha: Option<&str>) -> crate::plugin_manifest::PluginManifest {
        crate::plugin_manifest::PluginManifest {
            id: "com.test.node".to_owned(),
            name: "Node".to_owned(),
            version: "1.0.0".to_owned(),
            backend_code: Some(code.to_owned()),
            backend_sha256: sha.map(str::to_owned),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn prepare_node_backend_writes_and_verifies_hash() {
        let dir = tmp_plugin_dir();
        let code = "export function activate(){}";
        use sha2::{Digest, Sha256};
        let sha = hex::encode(Sha256::digest(code.as_bytes()));
        let manifest = manifest_with_backend(code, Some(&sha));

        let entry = prepare_node_backend(&dir, "backend.mjs", Some(&manifest))
            .await
            .expect("valid backend materializes");
        assert_eq!(entry, dir.join("backend.mjs"));
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), code);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn prepare_node_backend_refuses_on_hash_mismatch() {
        let dir = tmp_plugin_dir();
        let manifest = manifest_with_backend("export function activate(){}", Some("deadbeef"));
        let err = prepare_node_backend(&dir, "backend.mjs", Some(&manifest))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("hash mismatch"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn prepare_node_backend_refuses_when_absent() {
        let dir = tmp_plugin_dir();
        // No backend_code and no on-disk file → refuse (nothing to run).
        let manifest = crate::plugin_manifest::PluginManifest {
            id: "com.test.node".to_owned(),
            name: "Node".to_owned(),
            version: "1.0.0".to_owned(),
            ..Default::default()
        };
        let err = prepare_node_backend(&dir, "backend.mjs", Some(&manifest))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("not found"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_host_bootstrap_is_dependency_free() {
        let dir = tmp_plugin_dir();
        let path = write_host_bootstrap(&dir).await.unwrap();
        let src = std::fs::read_to_string(&path).unwrap();
        // The bootstrap must stay importable on stock node AND bun — node builtins only.
        assert!(src.contains("node:http"));
        assert!(src.contains("activate"));
        assert!(!src.contains("require("), "bootstrap must be ESM, no CJS require");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn native_permission_record_surfaces_report() {
        // Recording a native sidecar's posture makes it appear in the status-plane
        // reader with `enforced:false` (honest v1 — declared but not OS-enforced).
        // No manifest on disk in the test env → `declared: None`, which is fine: the
        // seam (record → reader) is what this asserts.
        let name = format!("com.test.perm-{}/worker", uuid::Uuid::new_v4());
        record_native_permissions(&name, "com.test.perm");
        let reports = native_sidecar_permission_reports();
        let found = reports
            .iter()
            .find(|r| r.name == name)
            .expect("recorded sidecar appears in the report");
        assert_eq!(found.plugin_id, "com.test.perm");
        assert!(!found.enforced, "native sidecars are never OS-enforced in v1");
        // Serializes for the future status wire.
        let value = serde_json::to_value(found).unwrap();
        assert_eq!(value["enforced"], serde_json::json!(false));
        assert_eq!(value["name"], serde_json::json!(name));
    }
}
