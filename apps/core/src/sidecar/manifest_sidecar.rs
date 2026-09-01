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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::plugin_manifest::schema::{
    BinarySpec, ProviderRegistrationSpec, SidecarProcess, SidecarSpec,
};
use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// The Gateway grant a Community-tier plugin must hold (approved) before Core will
/// download + spawn a manifest-declared managed sidecar. Follows the existing
/// `category:action` grant convention (`mcp:`, `hook:`, `runtime:`).
pub const GRANT_SIDECAR_PROCESS: &str = "sidecar:process";

/// How long to wait on a health-check HTTP request before treating it as down.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// The Core preference key that gates the experimental extension-host runtime
/// (`kind: "node"` sidecars) — i.e. spawning a plugin's own BACKEND process.
/// **Default OFF**, and Core-only: the desktop once had a same-named localStorage
/// flag in front of the sandboxed plugin/widget UI, but that was a separate store
/// governing a separate surface and it has since been removed (the UI path is
/// unconditional). Nothing in the desktop writes this pref; set it through the
/// preferences store or the `RYU_EXPERIMENTAL_PLUGIN_RUNTIME` env (the
/// headless/test seam). The key string is persisted state — renaming it would
/// silently reset any operator who opted in.
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
/// [`EXPERIMENTAL_PLUGIN_RUNTIME_PREF`]. **Default OFF** — a
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
///
/// `pub(crate)` for `sidecar::mcp::mcp_command_is_present`, which asks the same
/// question about a manifest-declared MCP server's command. Shared rather than
/// re-implemented so the two "is this program installed?" answers cannot disagree —
/// a sidecar reported present and its plugin's MCP server reported missing (or the
/// reverse) would be unexplainable from either surface.
///
/// # Windows: the returned path is spawnable, the bare name may not be
///
/// The `cmd`/`bat` extensions matter because that is how Windows ships the runners
/// this host cares about (`npx`, `bunx`, `pnpm`, an npm-installed `bun` — all
/// `*.cmd` shims). But **`Command::new("npx")` cannot spawn them.** `std`'s
/// `resolve_exe` (`library/std/src/sys/process/windows.rs`, verified against the
/// 1.96 toolchain) does `path.set_extension("exe")` for a bare name with no dot and
/// never consults `PATHEXT` — appending `.exe` is a `CreateProcessW` rule, PATHEXT is
/// a `cmd.exe` one. A batch file spawns only when the program string *itself* ends in
/// `.bat`/`.cmd`, which makes `std` re-target the spawn at `cmd.exe /c`.
///
/// So a caller that answers "installed?" with this function and then hands
/// `Command::new` the *bare name* is wrong on Windows for every `.cmd` shim: probe
/// passes, spawn `ENOENT`s. Hand it the returned [`PathBuf`] instead. The MCP path
/// does exactly that in `sidecar::mcp::spawn_program_for`, which every registry spawn
/// goes through via `McpServerConfig::to_command`.
///
/// Not yet true of [`resolve_node_runtime`] above, which returns the bare `"bun"` /
/// `"node"` string it later spawns (`spawn_clean`) — a latent break for a host whose
/// only `bun` is an npm `bun.cmd`. Left alone deliberately: it is a separate,
/// not pre-installed code path (the experimental node extension host) and needs its own
/// test, not a drive-by.
pub(crate) fn which_on_path(program: &str) -> Option<PathBuf> {
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

/// Where a bare, Ryu-managed `command` lands on this host: `<data dir>/bin/<command>`
/// (`.exe` appended on Windows).
///
/// Profile-aware by construction — `download_manager::bin_dir()` is
/// `paths::ryu_dir().join("bin")`, so a `RYU_PROFILE=dev` stack resolves
/// `~/.ryu-dev/bin` and never collides with a release stack.
///
/// This is only the **path computation**, deliberately: [`ensure_local_sidecar_present`]
/// additionally requires a `<command>.version` marker matching the running Core before
/// it reuses a bin, because a self-update must re-fetch a stale artifact. That staleness
/// rule is download-lifecycle policy and must NOT travel with this helper — a caller that
/// only asks "is there a binary here I could spawn?" (the MCP registration probe) would
/// otherwise report a locally-built or hand-placed binary as missing.
pub(crate) fn managed_bin_path(command: &str) -> PathBuf {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    crate::sidecar::download_manager::bin_dir().join(format!("{command}{ext}"))
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

// ── Missing-binary record (WHY a `Local` sidecar has no process) ─────────────────
//
// A `Local`-kind sidecar (`ryu-mail`, `ryu-browser`, `ryu-simulator`, …) is a bare
// `command` whose bytes are fetched on first enable by `ensure_local_sidecar_present`.
// That fetch is best-effort by design (an optional app must never abort boot), and
// until this record existed EVERY failure — a release that publishes no
// `<command>-<os>-<arch>` asset at all, a 404, a checksum mismatch — was swallowed
// into one `tracing::warn!` and the spawn then ran the bare command that does not
// exist. Downstream, the ONLY thing a user or a panel could see was the ext-proxy's
// generic `502 sidecar unreachable`, which is indistinguishable from "the app crashed"
// and from "the app is lazily scaled to zero". An unpublished asset is a permanent,
// self-inflicted 502 that reads as a bug in the app.
//
// So the reason is now recorded and surfaced through the SAME seam the native-
// permission record above uses (process-global map + `pub` reader), for the same
// reason its own comment gives: the writers live here and the manager stores
// `Arc<dyn Sidecar>` with no downcast, so the status handler cannot ask a sidecar
// why it is missing. Two consumers:
//
//  1. [`ManifestSidecar::health_check`] — turns the flat `Unhealthy("process not
//     running")` into `Unhealthy("binary not installed: …")`, i.e. it rides
//     [`HealthStatus`], the reason channel that already exists, rather than a new one.
//  2. [`missing_sidecar_binary_reports`] — the JSON-ready snapshot served under
//     `/api/sidecar/status`'s `missing_binaries` key (`server/mod.rs::sidecar_status`,
//     beside `native_permissions`), so a panel can render "binary not installed"
//     instead of "502". No `SidecarManager` change was needed — the reader is
//     free-standing, which is why it can be called straight from the handler.

/// One `Local`-kind manifest sidecar whose binary could not be resolved or installed,
/// and why. Serialized as-is onto the status plane (see the module note above), so the
/// field names are wire contract.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MissingSidecarBinary {
    /// Namespaced sidecar key (`<plugin_id>/<local_name>`) — the same key
    /// `/api/sidecar/status` reports liveness under, so a reader can join the two.
    pub name: String,
    /// The owning plugin id (what a panel offers to disable/reinstall).
    pub plugin_id: String,
    /// The bare `command` the manifest declared (e.g. `ryu-browser`).
    pub command: String,
    /// The release asset this host would have installed: `<command>-<os>-<arch>[.exe]`
    /// per [`crate::update::platform_tag`]. Named explicitly because the common cause
    /// is a release that publishes a DIFFERENT name (or nothing at all) for this
    /// platform — the operator needs the exact string to fix CI against.
    pub expected_asset: String,
    /// Human-readable cause: not published / download failed / dev build with no
    /// override. Rendered verbatim by a status panel.
    pub reason: String,
}

/// Process-global record of every `Local` sidecar whose binary is missing, keyed by
/// namespaced name. Written by `ensure_local_sidecar_present` (and cleared by it the
/// moment the binary resolves), read by `health_check` + the status reader.
fn missing_binary_record(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, MissingSidecarBinary>> {
    static RECORD: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, MissingSidecarBinary>>,
    > = std::sync::OnceLock::new();
    RECORD.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Snapshot of every `Local` sidecar whose binary could not be installed, for the
/// status surface. Empty on a healthy host — an entry exists only while a sidecar's
/// command genuinely cannot be resolved (each success path clears its own entry), so a
/// reader can treat any entry as actionable.
///
/// The READ half of the seam. Its consumer is the `/api/sidecar/status` handler
/// (`server/mod.rs::sidecar_status`), which serves this vec under `missing_binaries`.
/// Do not delete it to silence a dead-code warning: if the handler key ever goes
/// away, restore the key rather than the reader — losing it puts the 502 back with no
/// way for any surface to explain it.
pub fn missing_sidecar_binary_reports() -> Vec<MissingSidecarBinary> {
    missing_binary_record()
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

/// The recorded missing-binary reason for one namespaced sidecar, if any. `None` for a
/// sidecar whose binary is present (or that is not `Local`-kind at all) — so a caller
/// must never infer "binary missing" from a merely stopped process: a `lazy` sidecar
/// scaled to zero is `running: false` by design and has no entry here.
fn missing_sidecar_binary_reason(name: &str) -> Option<String> {
    missing_binary_record()
        .lock()
        .ok()
        .and_then(|m| m.get(name).map(|r| r.reason.clone()))
}

// ── Registration failures (the OTHER invisible failure) ───────────────────────
//
// Sibling of the missing-binary record above, and it exists for the same reason: a
// failure that is otherwise invisible to every surface. When `claim_port` refuses —
// some unrelated process on this host already holds the sidecar's declared port — the
// name never enters the manager's `dynamic` registry, so it does not merely read as
// "failed" on `/api/sidecar/status`, it is ABSENT. The app simply looks broken, with
// the only signal a `tracing::warn!` nobody reads. The ext-proxy's 503 body names the
// condition per-request; this record is the durable half, readable with no request in
// flight, and is what `SidecarManager::statuses` synthesizes an entry from.

/// Process-global record of every manifest sidecar whose REGISTRATION failed, keyed by
/// namespaced name, holding `claim_port`'s own error string verbatim (re-wording it
/// would lose the port number and the OS error, which are the two things the operator
/// needs). Written by the manager's register path, cleared the moment registration
/// succeeds or the sidecar is deregistered.
fn registration_failure_record(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static RECORD: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    RECORD.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Record that `name` could not be registered, and why. Idempotent (overwrites).
/// Logged at `error`, like the missing-binary sibling: an app the user just enabled
/// cannot run at all, and — unlike a crash — nothing will retry it.
pub(crate) fn record_registration_failure(name: &str, reason: &str) {
    tracing::error!(sidecar = %name, "app sidecar failed to register: {reason}");
    if let Ok(mut record) = registration_failure_record().lock() {
        record.insert(name.to_owned(), reason.to_owned());
    }
}

/// Clear `name`'s registration-failure record — called on a later successful
/// registration and on deregister, so a freed port or a disabled app never leaves a
/// stale reason on the status plane.
pub(crate) fn clear_registration_failure(name: &str) {
    if let Ok(mut record) = registration_failure_record().lock() {
        record.remove(name);
    }
}

/// The recorded registration-failure reason for one namespaced sidecar, if any.
pub(crate) fn registration_failure_reason(name: &str) -> Option<String> {
    registration_failure_record()
        .lock()
        .ok()
        .and_then(|m| m.get(name).cloned())
}

/// Every `(name, reason)` currently recorded as failed-to-register. Read by
/// [`crate::sidecar::SidecarManager::statuses`], which synthesizes a status row per
/// entry — the ONLY way these sidecars appear on the status plane at all, since a
/// failed registration means there is no `Arc<dyn Sidecar>` to report on.
pub(crate) fn registration_failures() -> Vec<(String, String)> {
    registration_failure_record()
        .lock()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Whether `spec` must be STARTED at enable rather than merely registered.
///
/// `!spec.lazy` is the declared answer; the `provides_provider` clause is a deliberate
/// coercion, and it exists because `lazy: true` + `provides_provider` is not a
/// configuration Core can honor — the two declarations are mutually exclusive by
/// construction:
///
/// - A lazy sidecar's ONLY wake trigger is a proxy or capability-broker hit
///   (`SidecarManager::wake_sidecar` is reachable from nowhere else).
/// - A `provides_provider` sidecar's only client is Pi, which dials the registered
///   `baseUrl` **directly** and never traverses the ext proxy.
///
/// So nothing can ever wake it. That was survivable while the provider entry persisted
/// in `models.json` across restarts; it stopped being survivable once `purge_sidecar_providers`
/// began dropping sidecar-owned entries at boot to clear the stale ones an unclean exit
/// leaves behind. For an auth bridge whose entire purpose is serving `/v1`, one unclean
/// exit would otherwise kill the provider permanently: the entry is purged, and the only
/// thing that could rewrite it is the Healthy edge of a health monitor that is never
/// spawned because the process is never started.
///
/// Starting it eagerly makes the purge safe exactly as its own doc comment claims: the
/// monitor runs, and the first Healthy edge re-registers the provider through
/// `register_provider_once`. In the window between the two, the provider id is simply
/// ABSENT from Pi's model list — a missing row, never a row pointing at a dead (or
/// squatted) port with the ext token as its `apiKey`. That is the correct degradation,
/// and it is the reason the alternative fix — registering at registration time instead —
/// was rejected.
///
/// Extracted as a named predicate so the coercion is unit-testable without a process.
pub fn starts_eagerly(spec: &SidecarSpec) -> bool {
    !spec.lazy || spec.provides_provider.is_some()
}

/// Whether `spec` may be scaled to zero on an idle timer.
///
/// The same argument as [`starts_eagerly`], one step further: idle-stop is only safe
/// for something that can be woken again. `ManifestSidecar::stop` does call
/// `deregister_provider` first, so an idle-stop leaves no entry pointing at a dead port
/// — but it makes the provider *vanish from Pi's model list* every idle window and
/// reappear on the next wake that may never come. A model that blinks in and out of the
/// picker for reasons no user can see is a worse bug than the memory the scale-to-zero
/// saves.
pub fn may_idle_stop(spec: &SidecarSpec) -> bool {
    spec.provides_provider.is_none()
}

// ── Crash reasons (the THIRD invisible failure) ───────────────────────────────
//
// Third sibling of the two records above, and the one that covered the gap the
// liveness fix opened up. Before `ProcessHandle::is_running` polled the child, a
// sidecar whose process OOMed or was `kill -9`ed reported `running: true,
// failure_reason: None` on `/api/sidecar/status` — the status plane's single most
// misleading state, since the app was dead and the surface said it was fine. Now
// that liveness is truthful the row flips to `running: false`, and this record is
// what supplies the WHY so it does not read as an ordinary scaled-to-zero sidecar.

/// Process-global record of every manifest sidecar whose process exited without a
/// stop being requested, keyed by namespaced name. Written by the manager's health
/// monitor on the tick that observes `has_exited()`; cleared on the next successful
/// `start()` and on deregister.
fn crash_record() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static RECORD: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    RECORD.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Record that `name`'s process died on its own, and why. Idempotent (overwrites).
pub(crate) fn record_crash_reason(name: &str, reason: &str) {
    tracing::error!(sidecar = %name, "app sidecar process exited unexpectedly: {reason}");
    if let Ok(mut record) = crash_record().lock() {
        record.insert(name.to_owned(), reason.to_owned());
    }
}

/// Clear `name`'s crash record — called on every successful `start()` (the process
/// is demonstrably back) and on deregister, so a recovered or disabled app never
/// carries a stale "crashed" reason on the status plane.
pub(crate) fn clear_crash_reason(name: &str) {
    if let Ok(mut record) = crash_record().lock() {
        record.remove(name);
    }
}

/// The recorded crash reason for one namespaced sidecar, if any. Read by
/// [`crate::sidecar::SidecarManager::statuses`] as the second link in the
/// `failure_reason` chain, behind the registration failure (which is the more
/// fundamental condition: a sidecar that never registered cannot have crashed).
pub(crate) fn crash_reason(name: &str) -> Option<String> {
    crash_record()
        .lock()
        .ok()
        .and_then(|m| m.get(name).cloned())
}

/// Record that `name`'s binary is missing, with the reason, and log it at `error`
/// (not `warn`): an app the user just enabled cannot run at all, which is the loudest
/// class of failure this path has. Idempotent (overwrites the prior entry).
fn record_missing_sidecar_binary(
    name: &str,
    plugin_id: &str,
    command: &str,
    expected_asset: &str,
    reason: String,
) {
    tracing::error!(
        sidecar = %name,
        plugin_id = %plugin_id,
        command = %command,
        expected_asset = %expected_asset,
        "app sidecar binary is not installed: {reason}"
    );
    if let Ok(mut record) = missing_binary_record().lock() {
        record.insert(
            name.to_owned(),
            MissingSidecarBinary {
                name: name.to_owned(),
                plugin_id: plugin_id.to_owned(),
                command: command.to_owned(),
                expected_asset: expected_asset.to_owned(),
                reason,
            },
        );
    }
}

/// Drop `name`'s missing-binary entry. Called from every path that DID resolve a
/// program, so a sidecar fixed by a later install/override stops reporting a stale
/// "binary not installed" forever. Also called on uninstall, so a removed sidecar
/// leaves no entry behind for a name that no longer exists.
fn clear_missing_sidecar_binary(name: &str) {
    if let Ok(mut record) = missing_binary_record().lock() {
        record.remove(name);
    }
}

/// Everything the managed-bin **ready notifier** needs to re-run the owning plugin's
/// MCP-server registration once its binary has actually landed. Handed to
/// [`ManifestSidecar::with_mcp_registration`] by the one production construction site
/// (`apply_sidecars`), which already holds all four values.
///
/// Injected rather than read from a process global (`mcp::global_registry`) so the
/// notifier is exercisable end-to-end by a test: `notify_managed_binary_ready` is
/// reached through a real [`ManifestSidecar`] code path with a real
/// [`McpRegistry`](crate::sidecar::mcp::McpRegistry), no OnceLock to win a race for.
///
/// `manifest` is an `Arc` because a manifest can carry inline `ui_code`/`backend_code`
/// and every sidecar of a plugin holds one.
#[derive(Clone)]
pub struct McpRegistration {
    /// The live registry the plugin's declared servers are registered into.
    pub registry: Arc<crate::sidecar::mcp::McpRegistry>,
    /// The owning plugin's manifest — the sole source of the `mcp_servers` declarations.
    pub manifest: Arc<crate::plugin_manifest::PluginManifest>,
    /// The owning plugin's tier, for the registration gate.
    pub tier: crate::plugin_manifest::PluginTier,
    /// The Gateway-**approved** grants from the plugin RECORD (never the manifest's own
    /// unvalidated `permission_grants`), for the registration gate.
    pub approved_grants: Vec<String>,
    /// The activation generation that is allowed to publish the registration.
    /// `None` keeps standalone tests and legacy construction sites ungated.
    pub runtime: Option<crate::plugins::runtime::RuntimeGenerationBinding>,
}

/// Everything the **ext-API fetch hook** needs to lower this sidecar's own OpenAPI
/// document into derived agent tools, once it is actually serving.
///
/// Handed to [`ManifestSidecar::with_openapi_import`] by the one production
/// construction site (`apply_sidecars`), which is the only place already holding the
/// manifest, the tier, the grants and `state.mcp` at once. Injected rather than read
/// from a process global for the same reason [`McpRegistration`] is: the hook is then
/// reachable end-to-end from a test with a real registry and no `OnceLock` race.
///
/// ## Why this is armed PER SIDECAR, not per manifest
///
/// [`crate::ext_api::lower`] pairs ONE sidecar's `http.mount` with THAT sidecar's
/// declared `http.routes`. A manifest may carry several sidecars, each nesting at its
/// own mount; pairing sidecar A's mount with sidecar B's routes yields sub-paths that
/// fail the intersection and are dropped — safe, but it would report the drop against
/// the wrong manifest block and leave the app author hunting a route that was never
/// the problem. So `mount`/`declared_routes` are read for the spec this sidecar owns.
///
/// Per-sidecar arming is why [`sidecar_key`](Self::sidecar_key), not `plugin_id`, is
/// the registry key and the re-wake latch — see
/// [`McpRegistry::set_ext_api_routes_for_sidecar`] for what keying by plugin broke.
///
/// [`McpRegistry::set_ext_api_routes_for_sidecar`]: crate::sidecar::mcp::McpRegistry::set_ext_api_routes_for_sidecar
#[derive(Clone)]
pub struct OpenApiImport {
    /// The live registry the derived routes are stored in.
    pub registry: Arc<crate::sidecar::mcp::McpRegistry>,
    /// The owning plugin's real id (`@ryu/crm`) — the id namespace, the `/api/ext/<id>`
    /// proxy segment, and the audit/env-read principal at dispatch.
    pub plugin_id: String,
    /// This sidecar's LOCAL name (`spec.name`), used to find its block again in the
    /// live manifest. Local rather than namespaced because that is what a manifest's
    /// `sidecars[].name` actually holds.
    pub sidecar_name: String,
    /// The manager/registry key for this sidecar — [`namespaced_name`] of the two
    /// fields above. Carried rather than recomputed so the key stored in the registry
    /// is byte-identical to the one the manager, the proxy and the idle reaper use.
    pub sidecar_key: String,
    /// The live manifest store (`ServerState::app_manifests`), read at IMPORT time to
    /// resolve `upstream_mount` + `declared_routes` for this sidecar.
    ///
    /// A live read rather than the arm-time snapshot below because an in-place app
    /// update rewrites the manifest **without** re-running `apply_sidecars`: it calls
    /// `reload_manifests_inner` (which replaces the contents of exactly this store)
    /// and then `clear_ext_api_routes`, leaving the next Healthy edge to re-lower. With
    /// a snapshot that re-lowering would intersect the NEW spec against the OLD
    /// manifest's declared routes and strip the OLD mount — deriving tools for paths
    /// the update withdrew (which then 404 at the proxy) while dropping ones it added.
    /// The store write happens *before* the clear, so by the time anything re-lowers
    /// the new manifest is already visible here.
    ///
    /// `None` in contexts with no manifest store wired (tests, CLI), which falls back
    /// to the snapshot.
    pub manifests: Option<Arc<tokio::sync::RwLock<Vec<crate::plugin_manifest::PluginManifest>>>>,
    /// Arm-time snapshot of this sidecar's `http.mount`, normalised the same way the
    /// proxy normalises it. Stripped from every spec path, because the ext-proxy
    /// re-adds it. Used only when the live lookup above is unavailable.
    pub upstream_mount: String,
    /// Arm-time snapshot of this sidecar's declared HTTP routes. The proxy 404s
    /// anything outside them (including a method that has no declaration), so an
    /// operation that matches none is unreachable and must not become a tool. Used
    /// only when the live lookup is unavailable.
    pub declared_routes: Vec<crate::plugin_manifest::schema::RouteSpec>,
    /// Shared client for the one-shot spec fetch. Reused rather than built per call so
    /// the hook does not stand up a fresh connection pool on every sidecar.
    pub client: reqwest::Client,
    /// The activation generation that is allowed to publish derived routes.
    /// `None` keeps standalone tests and legacy construction sites ungated.
    pub runtime: Option<crate::plugins::runtime::RuntimeGenerationBinding>,
}

impl OpenApiImport {
    /// The mount + declared paths to lower against, read from the LIVE manifest when
    /// one is reachable and falling back to the arm-time snapshot otherwise.
    ///
    /// The read guard is dropped before returning, deliberately: the caller goes on to
    /// do a network fetch bounded at [`OPENAPI_FETCH_TIMEOUT`] (10s), and holding a
    /// `tokio::sync::RwLock` read across that would block `reload_manifests_inner`'s
    /// writer — i.e. stall the very update path this live read exists to serve — for
    /// the whole fetch. `tokio`'s lock will not warn about that.
    ///
    /// The mount is normalised here exactly as the arming site normalises it
    /// (`trim_end_matches('/')`). If the two normalisations disagreed, the prefix
    /// stripped at lowering would stop matching the one the proxy re-adds, and the
    /// mismatch would appear only *after* an update — the same window this fixes.
    async fn lowering_inputs(&self) -> (String, Vec<crate::plugin_manifest::schema::RouteSpec>) {
        let fallback = || (self.upstream_mount.clone(), self.declared_routes.clone());
        let Some(store) = self.manifests.as_ref() else {
            return fallback();
        };
        let guard = store.read().await;
        let resolved = guard
            .iter()
            .find(|m| m.id == self.plugin_id)
            .and_then(|m| m.sidecars.iter().find(|s| s.name == self.sidecar_name))
            .and_then(|spec| spec.http.as_ref())
            .map(|http| {
                (
                    http.mount
                        .as_deref()
                        .map(|m| m.trim_end_matches('/').to_owned())
                        .unwrap_or_default(),
                    http.routes.clone(),
                )
            });
        drop(guard);
        // A miss means the manifest or the sidecar block is gone (uninstalled
        // mid-fetch, renamed by an update). The snapshot is then the best available
        // description of the process that is actually answering on this port.
        resolved.unwrap_or_else(fallback)
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
    /// Whether this sidecar's `provides_provider` declaration is currently registered
    /// as a model provider. Health is *polled*, so this latches the Unhealthy→Healthy
    /// transition: registration fires once on the way up, deregistration once on stop.
    provider_registered: Arc<AtomicBool>,
    /// Set by [`ManifestSidecar::with_mcp_registration`] when the owning plugin declares
    /// `mcp_servers`; drives [`notify_managed_binary_ready`] after each `Local` binary
    /// resolution. `None` leaves the notifier off entirely (every existing caller and
    /// every non-MCP plugin).
    mcp: Option<McpRegistration>,
    /// Set by [`ManifestSidecar::with_openapi_import`] for a compiled-in app whose
    /// sidecar serves an HTTP surface; drives [`import_openapi_once`] on the Healthy
    /// edge. `None` leaves the ext-API derivation off entirely (every third-party app
    /// and every sidecar with no `http` block).
    openapi: Option<OpenApiImport>,
    /// Whether an ext-API lowering for this sidecar is currently IN FLIGHT — a
    /// concurrency claim, deliberately **not** an "already done" latch.
    ///
    /// The done-latch is the registry ([`McpRegistry::has_ext_api_routes`]), and that
    /// distinction is load-bearing: `clear_ext_api_routes` (deactivate, app update) has
    /// to be able to re-arm the lowering without rebuilding this object, which a local
    /// done-flag would silently prevent. See [`import_openapi_once`] for the full
    /// argument and for how a zero-tool result is still recorded so the poll terminates.
    ///
    /// Health is polled every 30s and a `lazy` sidecar re-enters the Healthy edge on
    /// every wake, so overlapping attempts are a real possibility rather than a
    /// theoretical one; the claim is what makes the second one free.
    ///
    /// [`McpRegistry::has_ext_api_routes`]: crate::sidecar::mcp::McpRegistry::has_ext_api_routes
    openapi_imported: Arc<AtomicBool>,
    /// The plugin generation that owns this sidecar. Health callbacks and
    /// asynchronous imports use it to reject stale completions after reload.
    runtime: Option<crate::plugins::runtime::RuntimeGenerationBinding>,
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
            provider_registered: Arc::new(AtomicBool::new(false)),
            mcp: None,
            openapi: None,
            openapi_imported: Arc::new(AtomicBool::new(false)),
            runtime: None,
        }
    }

    /// Arm the managed-bin ready notifier for this sidecar (see [`McpRegistration`] and
    /// [`notify_managed_binary_ready`]). Opt-in: a caller that does not set it keeps the
    /// pre-existing behavior exactly.
    #[must_use]
    pub fn with_mcp_registration(mut self, registration: McpRegistration) -> Self {
        self.mcp = Some(registration);
        self
    }

    /// Bind this sidecar to the plugin generation that created it.
    #[must_use]
    pub fn with_runtime_binding(
        mut self,
        binding: crate::plugins::runtime::RuntimeGenerationBinding,
    ) -> Self {
        self.runtime = Some(binding);
        self
    }

    /// Arm the ext-API fetch hook for this sidecar (see [`OpenApiImport`] and
    /// [`import_openapi_once`]). Opt-in: a caller that does not set it keeps the
    /// pre-existing behavior exactly, and the derived-tool plane stays empty.
    ///
    /// **The trust gate is the caller's.** `apply_sidecars` arms this only for
    /// `crate::plugins::builtins::is_compiled_in_manifest`. A third-party spec is
    /// attacker-controlled text that would land in front of the model with no human
    /// in the loop — and `may_read_env_secret` would refuse its `env:RYU_TOKEN` read
    /// anyway, so its derived tools would look real and 401 forever.
    #[must_use]
    pub fn with_openapi_import(mut self, spec: OpenApiImport) -> Self {
        self.openapi = Some(spec);
        self
    }

    /// Register this sidecar's declared model provider, if it declares one. Idempotent
    /// via [`provider_registered`]: the health monitor polls, so only the transition
    /// into Healthy performs the write.
    ///
    /// A registration failure is logged, not propagated: a refused id (collision with a
    /// built-in or another owner) must not take the sidecar itself down.
    ///
    /// [`provider_registered`]: ManifestSidecar::provider_registered

    /// Deregister this sidecar's declared model provider, so a stopped sidecar never
    /// leaves a provider selectable at a dead loopback port. No-op when it was never
    /// registered, or when the entry is not owned by this plugin.
    fn deregister_provider(&self) {
        let Some(spec) = self.spec.provides_provider.as_ref() else {
            return;
        };
        // A crash/reconcile race can lose the in-memory latch while the owned
        // models.json row still exists. Always attempt the ownership-checked
        // removal; `deregister_sidecar_provider` is a no-op for absent or
        // foreign rows, so this remains safe for sidecars that never registered.
        self.provider_registered.swap(false, Ordering::SeqCst);
        match crate::pi_config::deregister_sidecar_provider(&self.plugin_id, &spec.id) {
            Ok(true) => tracing::info!(
                plugin = %self.plugin_id,
                provider = %spec.id,
                "deregistered sidecar model provider"
            ),
            Ok(false) => {}
            Err(e) => tracing::warn!(
                plugin = %self.plugin_id,
                provider = %spec.id,
                "sidecar provider deregistration failed: {e}"
            ),
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

/// Inject the Shadow API bearer (`SHADOW_API_TOKEN`) so a sidecar that dials the
/// device-local Shadow directly (`ryu-clips`, `ryu-meetings` — they read
/// `RYU_SHADOW_URL` themselves) can pass Shadow's bearer gate
/// (`apps/shadow/src/server.rs`: everything except `/health` requires it). The
/// value is the SAME read-or-create token `ShadowProcess::start` injects into
/// Shadow itself ([`crate::sidecar::tools::shadow::ensure_api_token`] /
/// `api_token`), so spawn and clients always agree. The token is injected
/// deliberately for sidecars that need direct Shadow access; it is never
/// obtained through ambient environment inheritance.
fn inject_shadow_env(env: &mut BTreeMap<String, String>) {
    if env.contains_key("SHADOW_API_TOKEN") {
        return;
    }
    match crate::sidecar::tools::shadow::api_token()
        .ok_or_else(|| anyhow::anyhow!("no token resolved"))
        .or_else(|_| crate::sidecar::tools::shadow::ensure_api_token())
    {
        Ok(token) => {
            env.insert("SHADOW_API_TOKEN".to_owned(), token);
        }
        Err(e) => tracing::warn!(
            "manifest sidecar: could not prepare the Shadow API token (direct Shadow calls will fail closed): {e}"
        ),
    }
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

/// Register a sidecar-declared model provider exactly once, latching on `flag`.
///
/// Free function (not a method) so the polled health future — which owns only clones,
/// never `&self` — can drive it on the Unhealthy→Healthy edge.
///
/// A refused registration (id collides with a built-in, or is owned by another plugin)
/// is logged and the latch is released so a later health transition retries. It never
/// propagates: a provider that cannot be registered must not take its sidecar down.
fn register_provider_once(
    plugin_id: &str,
    spec: &ProviderRegistrationSpec,
    port: u16,
    ext_token: &str,
    flag: &AtomicBool,
) {
    if flag.swap(true, Ordering::SeqCst) {
        return;
    }
    match crate::pi_config::register_sidecar_provider(plugin_id, spec, port, Some(ext_token)) {
        Ok(()) => tracing::info!(
            plugin = %plugin_id,
            provider = %spec.id,
            "registered sidecar model provider at 127.0.0.1:{port}"
        ),
        Err(e) => {
            tracing::warn!(
                plugin = %plugin_id,
                provider = %spec.id,
                "sidecar provider registration refused: {e}"
            );
            flag.store(false, Ordering::SeqCst);
        }
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
///
/// **Integrity gate (fail-closed):** a Community-tier plugin's binary sidecar MUST
/// declare a non-empty `sha256` — an arbitrary https URL with no checksum is
/// unverifiable native code, so the spawn is refused, mirroring how
/// [`prepare_node_backend`] refuses a `backend_sha256` mismatch. Core-tier
/// (first-party built-in) manifests keep the historical optional-checksum
/// behavior — they are compiled into this binary and reviewed in-repo.
async fn ensure_binary(
    plugin_id: &str,
    bin: &BinarySpec,
    plugin_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> anyhow::Result<PathBuf> {
    let dir = version_dir(plugin_dir, bin);
    let sha = bin.sha256.clone().filter(|s| !s.is_empty());
    let community = owning_manifest(plugin_id)
        .map(|manifest| crate::plugins::builtins::tier_for_manifest(&manifest))
        .unwrap_or_else(|| crate::plugins::builtins::tier_for(plugin_id))
        == crate::plugin_manifest::PluginTier::Community;
    if community && sha.is_none() {
        return Err(anyhow::anyhow!(
            "binary sidecar for community plugin '{plugin_id}' declares no sha256 for '{}'; \
             refusing to download/run an unverifiable binary (add a sha256 to the manifest)",
            bin.url
        ));
    }

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
                        role: crate::downloads::DownloadRole::Plugin,
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
            let binary_name = bin
                .binary_name
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("archive sidecar is missing 'binary_name'"))?;
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
                            role: crate::downloads::DownloadRole::Plugin,
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

/// Best-effort fetch of a release asset's sibling `<url>.sha256` (the release
/// workflow emits one next to every published binary, format `<hex>  <filename>`).
/// Returns the 64-char hex digest for `DownloadCenter` to verify against, or `None`
/// when the checksum is absent/unreachable/malformed — the caller then downloads
/// unverified with a warning. Only invoked in release builds (behind the same gate as
/// the download it guards), so `reqwest` here never runs in dev.
#[cfg(not(debug_assertions))]
async fn fetch_release_sha256(url: &str) -> Option<String> {
    let sha_url = format!("{url}.sha256");
    if screen_https(&sha_url).await.is_err() {
        return None;
    }
    let body = reqwest::get(&sha_url)
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    // The checksum file is `<hex>  <filename>`; take the first whitespace token and
    // accept it only when it is a well-formed SHA-256 (64 hex chars).
    let hex = body.split_whitespace().next()?;
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// Download-on-enable for a `Local`-kind managed sidecar (the apps-store app bins:
/// `ryu-mail`, `ryu-meetings`, …). A `Local` sidecar declares only a bare
/// `command` and assumes the binary is already on the host — historically the
/// **desktop** prefetched all app bins into `~/.ryu/bin` at boot, unconditionally,
/// for every app whether enabled or not. This ties the binary to the app lifecycle
/// instead: the bin is fetched the first time its app is enabled (or, for a `lazy`
/// sidecar, first woken), so a disabled app costs nothing and an uninstall can
/// remove it (see `remove_local_sidecar_binaries` on the uninstall path).
///
/// Resolution order (mirrors how the child is later spawned + how Core resolves a
/// bin elsewhere — env override, then `~/.ryu/bin`):
///   1. `command_env` (e.g. `RYU_MAIL_BIN`) pointing at an existing file → use it
///      verbatim (a user- or dev-managed binary; `bun dev` sets these, which is
///      also why the download below is release-only — dev never pulls release bins).
///   2. `~/.ryu/bin/<command>[.exe]` already present → use it (installed earlier).
///   3. Otherwise, in a release build, download
///      `<base>/<command>-<os>-<arch>[.exe]` from the release hub into
///      `~/.ryu/bin/<command>[.exe]` and use that. `<base>` defaults to this repo's
///      `releases/latest/download` and is overridable via `RYU_SIDECAR_RELEASE_BASE`
///      (mirrors the ghost/shadow `RYU_*_RELEASE_URL` seam). The `<os>-<arch>` slug
///      is `update::platform_tag()`, byte-identical to the release workflow's asset
///      suffix (`macos-aarch64` / `linux-x86_64` / `windows-x86_64`).
///
/// Best-effort: any failure returns the originally-resolved program unchanged so the
/// spawn proceeds and fails loudly exactly as it did before this hook existed (a
/// manifest sidecar is optional and never aborts boot). Idempotent via the
/// `dest.exists()` skip, so enable + boot-reconcile + lazy-wake all converge without
/// re-downloading.
///
/// Best-effort is NOT silent, though: when every resolution step fails AND the bare
/// `command` is not on `PATH` either, the reason is recorded against `name` (see
/// [`record_missing_sidecar_binary`]) so `health_check` and `/api/sidecar/status` can
/// say "binary not installed: expected `<asset>`" instead of leaving the ext-proxy's
/// generic `502 sidecar unreachable` as the only symptom. Every path that DOES resolve
/// a program clears that record first, so a later install/override heals it.
///
/// Integrity: verified best-effort against the sibling `<asset>.sha256` the release
/// publishes (see `fetch_release_sha256`) — present ⇒ `DownloadCenter` fails the
/// transfer on a mismatch; absent ⇒ download proceeds unverified with a warning
/// (first-party bins over https, same posture as the old desktop prefetch).
async fn ensure_local_sidecar_present(
    name: &str,
    plugin_id: &str,
    resolved_program: String,
    command: &str,
    downloads: &crate::downloads::DownloadCenter,
    mcp: Option<&McpRegistration>,
) -> String {
    let program =
        resolve_local_sidecar_program(name, plugin_id, resolved_program, command, downloads).await;
    // The binary may have JUST become resolvable (installed above, or found already
    // installed). Tell the MCP registry, which re-probes and picks up any declaration it
    // had to skip. Unconditional — the re-probe is the authority, so a resolution that
    // changed nothing registers nothing.
    if let Some(registration) = mcp {
        notify_managed_binary_ready(registration).await;
    }
    program
}

/// The resolution half of [`ensure_local_sidecar_present`] — every rung and every
/// early return documented there. Split out so the notifier above runs on ALL of them
/// (including the fall-through) without threading the call through four exits.
async fn resolve_local_sidecar_program(
    name: &str,
    plugin_id: &str,
    resolved_program: String,
    command: &str,
    downloads: &crate::downloads::DownloadCenter,
) -> String {
    // 1. An env override (or any resolved program) that points at a real file wins.
    if std::path::Path::new(&resolved_program).exists() {
        clear_missing_sidecar_binary(name);
        return resolved_program;
    }

    let ext = if cfg!(windows) { ".exe" } else { "" };
    // The one place this path is defined; `sidecar::mcp` resolves the SAME path when it
    // decides whether a manifest-declared MCP server's bare command is installed.
    let dest = managed_bin_path(command);
    // Version marker written next to the bin (`ryu-mail.version`) recording the Core
    // version that installed it — the single release train keeps Core + every app bin
    // in lockstep, so a marker that doesn't match the running Core means a self-update
    // left an older bin behind and it must be re-fetched.
    let marker = dest.with_extension("version");
    let current = crate::update::current_version();

    // 2. Already installed under ~/.ryu/bin AND stamped with the running Core's
    //    version — reuse it. A missing or mismatched marker is treated as absent so a
    //    post-update stale bin is replaced (mirrors the desktop installer's
    //    `installed_version_matches` staleness check the old prefetch relied on).
    if dest.exists()
        && tokio::fs::read_to_string(&marker)
            .await
            .ok()
            .is_some_and(|s| s.trim() == current)
    {
        clear_missing_sidecar_binary(name);
        return dest.to_string_lossy().into_owned();
    }

    // The release asset this host needs — `<command>-<os>-<arch>[.exe]`. Computed
    // OUTSIDE the download block below (which is release-only) because the recorded
    // missing-binary reason names it in BOTH build profiles: an operator staring at a
    // dev box still needs the exact string CI must publish, and it is what makes the
    // naming contract testable at all (a debug `cargo test` never enters that block).
    let expected_asset = format!("{command}-{}{ext}", crate::update::platform_tag());

    // 3. Fetch it — release builds only. In a debug build the bins are owned by
    //    turbo (`bun dev`) and resolved via `RYU_*_BIN`/PATH, so never auto-download
    //    a release artifact over a locally-built one; fall through to the bare
    //    command and let the spawn surface a missing-binary error as it always has.
    //
    // A failure here no longer just warns: it is carried down to the fall-through as
    // the recorded reason, so "the release publishes no such asset" is reported as
    // itself instead of as a generic 502 from whatever calls the sidecar later.
    #[cfg_attr(debug_assertions, allow(unused_mut))]
    let mut download_error: Option<String> = None;
    #[cfg(not(debug_assertions))]
    {
        let base = std::env::var("RYU_SIDECAR_RELEASE_BASE").unwrap_or_else(|_| {
            format!(
                "https://github.com/{}/releases/latest/download",
                crate::update::RYU_REPO
            )
        });
        let asset = expected_asset.clone();
        let url = format!("{base}/{asset}");
        if let Err(e) = screen_https(&url).await {
            tracing::warn!("app sidecar '{command}': refusing download url {url}: {e}");
            download_error = Some(format!("refused download url {url}: {e}"));
        } else {
            // Integrity: verify against the sibling `<asset>.sha256` the release
            // publishes. Best-effort — a missing/unreadable checksum downloads
            // unverified (warned), matching the old desktop prefetch's
            // warn-and-continue posture; when present, DownloadCenter fails the
            // transfer on a mismatch.
            let sha256 = fetch_release_sha256(&url).await;
            if sha256.is_none() {
                tracing::warn!(
                    "app sidecar '{command}': no .sha256 published for {asset}; \
                     downloading unverified"
                );
            }
            match downloads
                .download_blocking(crate::downloads::DownloadSpec {
                    kind: crate::downloads::DownloadKind::Other,
                    role: crate::downloads::DownloadRole::Plugin,
                    label: format!("app sidecar: {command}"),
                    url: url.clone(),
                    dest: dest.clone(),
                    sha256,
                    version_record: None,
                })
                .await
            {
                Ok(path) => {
                    make_executable(&path).await;
                    // Stamp the version so a later Core self-update re-fetches a stale bin.
                    let _ = tokio::fs::write(&marker, &current).await;
                    clear_missing_sidecar_binary(name);
                    return path.to_string_lossy().into_owned();
                }
                Err(e) => {
                    tracing::warn!("app sidecar '{command}': download from {url} failed: {e}");
                    download_error = Some(format!("download from {url} failed: {e}"));
                }
            }
        }
    }

    // 4. Nothing resolved. The bare `command` still gets returned (the spawn is the
    //    authoritative resolver and a dev box legitimately keeps these bins on PATH),
    //    but if it is not on PATH either, this sidecar CANNOT start and the only
    //    downstream symptom would be a permanent `502 sidecar unreachable`. Record why.
    if which_on_path(command).is_some() {
        clear_missing_sidecar_binary(name);
        return resolved_program;
    }
    let reason = match download_error {
        Some(err) => format!(
            "'{expected_asset}' could not be installed into {} — {err}. If the release \
             publishes no asset by that exact name for this platform, no host can ever \
             install this sidecar.",
            dest.display()
        ),
        // Debug build (or a release build whose download block was skipped): nothing was
        // fetched, so say what the host looked for rather than implying a failed transfer.
        None => format!(
            "'{command}' is not on PATH, absent from {}, and no `command_env` override \
             points at it. A dev build never fetches release assets — build the sidecar \
             locally or set its `command_env`; a release build would install \
             '{expected_asset}'.",
            dest.display()
        ),
    };
    record_missing_sidecar_binary(name, plugin_id, command, &expected_asset, reason);
    resolved_program
}

/// The managed-bin **ready notifier**: re-run the owning plugin's MCP-server
/// registration now that a `Local` sidecar's binary has been resolved.
///
/// # Why this exists
///
/// `mcp_server_config_from_decl` can lower a manifest's bare `command` to
/// `<data dir>/bin/<command>` (the resolver rung), but that file only ever gets there
/// via [`ensure_local_sidecar_present`], which runs from `ManifestSidecar::start` —
/// **not** from enable. `activate_plugin` registers MCP servers immediately after
/// *spawning* `apply_sidecars`, so on a fresh enable the download has not finished (and
/// for a `lazy` sidecar has not even started): the probe correctly reports the command
/// missing, the declaration is skipped, and — because a skip is remembered nowhere —
/// the server stays dark until the next Core restart re-runs the `onStartup` pass. This
/// closes that window from the other side: the moment the binary is there, ask again.
///
/// # Why it re-runs the whole gated function
///
/// It calls [`crate::sidecar::mcp::register_manifest_mcp_servers`] verbatim rather than
/// re-implementing "register the declarations that now resolve". That function owns the
/// tier + approved-`mcp:server` gate, the per-declaration probe, and the name-ownership
/// check; a second path that re-derived any of them would be a second door that drifts
/// out of step with the first. So this is not an ungated entry point — it is the same
/// entry point, asked a second time, with the grants that came off the plugin RECORD.
///
/// # Cost control
///
/// `register_server` rebuilds the whole server map and clears the tool/resource caches,
/// which would force every stdio server to re-spawn on the next listing. A lazy sidecar
/// wakes repeatedly (scale-to-zero), so this returns early unless at least one declared
/// name is still unowned — making the steady-state wake a couple of map lookups. Same
/// reasoning as the `onStartup`-only guard on the boot re-register.
///
/// The guard asks `plugin_server_owner`, NOT `contains_server`: the latter answers `true`
/// for every reserved built-in name (`research`, `threads`, the capability facade, …)
/// whether or not anything is registered, so it would switch this notifier off
/// permanently for precisely the apps that are taking over a name Core still reserves —
/// silently, since registration would in fact have overlaid the built-in. That is the
/// failure mode the extra accessor exists to avoid. Note the guard only suppresses the
/// SUCCESS steady state: on a host where the binary never installs, the name stays
/// unowned and every wake re-probes and re-warns, which is the honest behavior.
///
/// Scope: driven from the `Local` arm only, which is correct — a `Binary`-kind sidecar's
/// bytes land under `<plugin_dir>/bin`, never in the managed bin dir the resolver rung
/// looks at, so nothing about its download can change how a bare command resolves.
///
/// Returns the names registered by this pass (empty on the common no-op), for logging
/// and for the tests that assert the seam actually fires.
async fn notify_managed_binary_ready(registration: &McpRegistration) -> Vec<String> {
    let _runtime_lease = match &registration.runtime {
        Some(binding) => match binding.acquire().await {
            Some(lease) => Some(lease),
            None => return Vec::new(),
        },
        None => None,
    };
    let manifest = &registration.manifest;
    if manifest.mcp_servers.is_empty() {
        return Vec::new();
    }
    if manifest
        .mcp_servers
        .keys()
        .all(|name| registration.registry.plugin_server_owner(name).is_some())
    {
        return Vec::new();
    }
    let registered = crate::sidecar::mcp::register_manifest_mcp_servers(
        &registration.registry,
        manifest,
        registration.tier,
        &registration.approved_grants,
    );
    if !registered.is_empty() {
        tracing::info!(
            plugin = %manifest.id,
            servers = ?registered,
            "managed binary is present: registered plugin-declared MCP server(s) that were \
             skipped when the plugin was enabled"
        );
    }
    registered
}

/// How long the one-shot OpenAPI fetch may take. Explicit, because nothing in the
/// health lane bounds an arbitrary `reqwest` call for you: the probe's own client
/// carries [`HEALTH_TIMEOUT`] (2s) and this is a different, larger document served by
/// a process that has only just reported healthy. 10s is generous enough for a cold
/// FastAPI/utoipa spec render and short enough that a wedged sidecar cannot leave a
/// task parked for the life of the node.
const OPENAPI_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Filename both generators we ship against (FastAPI, utoipa) publish the document
/// under. Where it is *rooted* is the interesting part — see [`openapi_doc_urls`].
const OPENAPI_DOC_FILE: &str = "/openapi.json";

/// Ceiling on how many operations the fetch hook RETAINS out of a spec.
///
/// Deliberately not the exposure cap (`mcp::EXT_API_PER_PLUGIN_CAP`, 60), and much
/// larger than it. The two numbers do different jobs and applying either in the
/// other's place is a silent bug:
///
/// - This one bounds the *retained* operation set handed to `ext_api::lower`, so a
///   sidecar serving a 50k-operation spec cannot put 50k `ImportedTool`s in front of
///   the intersection and the caps behind it.
/// - The exposure cap bounds what the model is offered, and must be applied AFTER
///   `ext_api::lower` has dropped the operations the manifest does not declare. Cap
///   at 60 here instead and the budget gets spent on operations that are then thrown
///   away — a declared operation truncated off the end while an undeclared one held
///   its slot, with nothing in the logs to show for it, because from the importer's
///   point of view it capped correctly.
///
/// **It does not bound construction, and must not be described as if it did.**
/// `openapi_import::spec_to_api_with_base` builds an `ImportedTool` for *every*
/// operation in the parsed document and truncates to this ceiling afterwards, so peak
/// memory during an import is a function of the document, not of this number. Bounding
/// construction would mean pushing a limit down into `spec_to_api_with_base`, which is
/// shared with the hand-driven `/api/tools/import/openapi` route and would change that
/// caller's behavior too. What actually bounds the pathological case at this seam is
/// [`EXT_API_SPEC_MAX_BYTES`]: a document has to be transferred before it can be
/// parsed, and nothing over a few MB gets that far.
const EXT_API_SPEC_OP_CEILING: usize = 500;

/// Hard cap on the bytes read from a sidecar's OpenAPI document.
///
/// Without it the only bound on this fetch is [`OPENAPI_FETCH_TIMEOUT`] (10s), and 10
/// seconds of *loopback* is measured in gigabytes — a sidecar that streams forever
/// (buggy generator, wrong handler, hostile third-party app once the trust gate widens)
/// would have Core buffer the lot into a `Vec` and then hand it to a JSON parser. Both
/// halves are unbounded consumption; this is the one number that stops them.
///
/// 4 MB against real documents: the largest first-party spec we ship is well under
/// 1 MB, and a 500-operation document (the parse ceiling above) with verbose schemas
/// lands around 2 MB. So a document over this is either not a spec or is far past the
/// point where the exposure caps would keep 60 of its operations anyway.
const EXT_API_SPEC_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The three outcomes of reading a spec body, kept apart because they classify
/// DIFFERENTLY at the call site — which is the whole point of the type.
enum SpecBody {
    /// The document, complete and under the cap.
    Body(Vec<u8>),
    /// The document is over [`EXT_API_SPEC_MAX_BYTES`]. **Definitive**: the bytes will
    /// be just as oversized on the next health poll.
    TooLarge,
    /// The stream broke mid-body. **Transient**: this says nothing about the document.
    Transport(String),
}

/// Read a response body with a hard byte cap, modelled on `server::read_capped_body`
/// (content-length pre-check, then a `chunk()` loop with a running total).
///
/// Deliberately a local twin rather than a call into that one: the catalog helper is
/// reached only through the SSRF-guarded, https-only `guarded_get*` family — which
/// would reject `http://127.0.0.1:<port>`, the only address this hook ever talks to —
/// and it collapses every failure into one `anyhow::Error`, losing exactly the
/// over-cap/transport distinction the caller has to make.
///
/// The content-length check is an early-out, not the bound: a lying or absent header
/// changes nothing, because the streaming total below is what actually stops the read.
async fn read_capped_spec_body(mut resp: reqwest::Response, url: &str) -> SpecBody {
    if resp
        .content_length()
        .is_some_and(|len| len > EXT_API_SPEC_MAX_BYTES)
    {
        return SpecBody::TooLarge;
    }
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() as u64 + chunk.len() as u64 > EXT_API_SPEC_MAX_BYTES {
                    return SpecBody::TooLarge;
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => return SpecBody::Body(buf),
            Err(e) => return SpecBody::Transport(format!("reading {url}: {e}")),
        }
    }
}

/// Statuses that mean "ask again", as opposed to "this is the app's answer".
///
/// 5xx is the sidecar failing, not refusing. 408 and 429 are explicit retry-later
/// signals. Everything else in the non-2xx range (401, 403, 404, …) describes a stable
/// property of what the app serves at this URL and is treated as definitive, so the
/// ~40 apps that publish no document stop being re-probed twice a minute forever.
fn is_transient_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// The URLs to try, in order, for a sidecar's OpenAPI document.
///
/// **The root is tried first, and that ordering is the whole function.** `http.mount`
/// says where the sidecar nests its *routes*, not where its server is rooted — the
/// spec's own `paths` already carry the mount (which is precisely why
/// `ext_api::lower` has to strip it), so an app nesting at `/api/crm` still serves
/// its schema from `/openapi.json`. Building the doc URL under the mount would 404 on
/// every app that has one, and — because a 404 is classified DEFINITIVE — would latch
/// that app at zero derived tools for the life of the process, logging nothing above
/// debug. That failure reads exactly like "shipped and green".
///
/// The mount-prefixed form is still tried second, because a framework *can* nest its
/// docs along with its router (FastAPI's `root_path`, a utoipa route registered
/// inside the nest). Two requests, once, only when the first 404s, in a spawned task.
fn openapi_doc_urls(base: &str, mount: &str) -> Vec<String> {
    let mount = mount.trim_end_matches('/');
    let mut urls = vec![format!("{base}{OPENAPI_DOC_FILE}")];
    if !mount.is_empty() {
        urls.push(format!("{base}{mount}{OPENAPI_DOC_FILE}"));
    }
    urls
}

/// The **ext-API fetch hook**: lower this sidecar's own OpenAPI document into derived
/// agent tools, once, the first time it reports healthy.
///
/// # Why the HEALTHY edge and not plugin-enable
///
/// This is the decisive constraint, not a preference. [`crate::plugins::seed`]'s
/// `seed_preinstalled` runs from `main.rs` *before* `ServerState` exists and writes
/// `store.insert` / `set_enabled` directly — so for every pre-installed built-in (which
/// is every app that matters here) `activate_plugin` NEVER runs. An enable-time hook
/// would therefore give the highest-value apps zero derived tools permanently, and
/// would do it silently: nothing errors, the tools simply are not there.
///
/// Even where `activate_plugin` does run, it is too early. `apply_sidecars` has at
/// that point only `tokio::spawn`ed the start, so the process is not listening; and a
/// `lazy` sidecar has no process at all until its first proxy hit. Healthy is the
/// first moment a spec can actually be fetched.
///
/// # Why it is spawned, never awaited inline
///
/// `health_check` is polled every 30s by `spawn_health_monitor` and its own client
/// carries a 2s timeout. Doing a 10s fetch + parse inline would stall the health lane
/// for every sidecar behind it and could make the monitor's own cadence slip.
///
/// # The latch is the REGISTRY, not the local flag
///
/// [`has_ext_api_routes_for_sidecar`] is the only thing that decides "already lowered",
/// and the local [`ManifestSidecar::openapi_imported`] flag is a *concurrency claim* —
/// it stops two overlapping health polls both fetching, and is released after each
/// attempt.
///
/// That split is load-bearing rather than stylistic. If the local flag were the latch,
/// [`McpRegistry::clear_ext_api_routes`] would stop re-arming anything: the update path
/// clears the registry without rebuilding the sidecar object, so a flag that stayed
/// `true` would leave the app with zero derived tools until the next process restart.
/// Making the registry authoritative means every clear — deactivate, update — is a real
/// re-arm.
///
/// The consequence is that a lowering which produces NO tools must still be *recorded*
/// in the registry, or the Healthy edge would refetch forever. It is: a definitive
/// answer (any HTTP response, including a 404 from an app that serves no spec, and any
/// parse/lower failure) stores an EMPTY route set, which
/// `has_ext_api_routes_for_sidecar` reads as done. Only a transport-level failure —
/// connection refused, timeout, a truncated body, or a 5xx/408/429 from a sidecar that
/// is still coming up — stores nothing and is retried on the next poll, because that is
/// the one class of failure that plausibly resolves itself.
///
/// [`has_ext_api_routes_for_sidecar`]: crate::sidecar::mcp::McpRegistry::has_ext_api_routes_for_sidecar
/// [`McpRegistry::clear_ext_api_routes`]: crate::sidecar::mcp::McpRegistry::clear_ext_api_routes
async fn import_openapi_once(spec: OpenApiImport, port: u16, latch: Arc<AtomicBool>) {
    let _runtime_lease = match &spec.runtime {
        Some(binding) => match binding.acquire().await {
            Some(lease) => Some(lease),
            None => return,
        },
        None => None,
    };
    // Asked per SIDECAR, not per plugin. The plugin-scoped `has_ext_api_routes` would
    // answer `true` as soon as the app's first HTTP sidecar had lowered, so a second
    // one would skip its own fetch for the life of the process — see
    // `McpRegistry::set_ext_api_routes_for_sidecar`. The clear that re-arms this is
    // plugin-scoped, which is correct: deactivate/update retire every sidecar at once.
    if spec
        .registry
        .has_ext_api_routes_for_sidecar(&spec.sidecar_key)
    {
        return;
    }
    // Claim the work. A `lazy` sidecar can cross Healthy again while the first fetch is
    // still in flight (the poll is 30s, the fetch is bounded at 10s but a wake can also
    // come from a proxy hit), and two concurrent lowerings of the same document would
    // be pure waste — the second would overwrite the first with the same rows.
    if latch
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    // Hold the claim in a guard rather than releasing it with a bare store at the end
    // of the function. The work below parses and lowers an app-authored document, and
    // an unwind anywhere in there would skip a trailing store and strand the claim at
    // `true` forever. That failure is invisible and permanent: a panic also means
    // nothing was stored, so `has_ext_api_routes` stays false, every later Healthy edge
    // spawns a task that loses the CAS and returns immediately, and the app derives zero
    // tools for the life of the process with nothing in the log to explain it. The only
    // other writer of the flag is `stop()`, which an eager (non-lazy) sidecar may never
    // reach.
    let _claim = ClaimGuard(Arc::clone(&latch));
    let outcome = import_openapi(&spec, port).await;
    match outcome {
        // Definitive: record it (possibly as zero routes) so the Healthy edge stops
        // asking. `set_ext_api_routes` stores an empty vec rather than skipping, which
        // is exactly what makes the "app serves no spec" case terminate.
        // The claim must STILL be held. A fetch takes up to 10s, and a deactivate in
        // that window stops the sidecar (which releases the claim) after clearing the
        // registry — so storing unconditionally would resurrect a disabled app's
        // derived tools and leave them until the next restart, defeating the clear
        // that just ran. Re-reading the claim is the cheapest way to notice, and it
        // reads false in exactly that case and no other.
        Some(_) if !latch.load(Ordering::SeqCst) => {
            tracing::info!(
                plugin = %spec.plugin_id,
                "ext_api: discarding a lowering whose sidecar was torn down mid-fetch"
            );
        }
        Some(routes) => {
            let derived = routes.len();
            spec.registry.set_ext_api_routes_for_sidecar(
                &spec.plugin_id,
                &spec.sidecar_key,
                routes,
            );
            if derived > 0 {
                tracing::info!(
                    plugin = %spec.plugin_id,
                    derived,
                    "ext_api: derived searchable tools from the app's own OpenAPI document"
                );
            }
        }
        // Transient: leave the registry untouched so the next Healthy edge retries.
        None => {}
    }
    // `_claim` releases here. On the definitive path the registry check at the top is
    // what suppresses the next poll; on the transient path releasing is what allows the
    // retry at all.
}

/// Releases [`import_openapi_once`]'s in-flight claim on the way out, including on an
/// unwind. See the comment at the claim site for why a bare store is not enough.
struct ClaimGuard(Arc<AtomicBool>);

impl Drop for ClaimGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Fetch + parse + lower this sidecar's OpenAPI document.
///
/// `Some(routes)` is a **definitive** answer, including `Some(vec![])` for an app that
/// serves no spec or serves one nothing can be derived from — the caller records it and
/// stops asking. `None` is a **transient** transport failure the caller should retry.
/// Split out of [`import_openapi_once`] so that classification is the whole content of
/// this function and cannot be lost in the latch bookkeeping around it.
async fn import_openapi(
    spec: &OpenApiImport,
    port: u16,
) -> Option<Vec<crate::ext_api::ExtApiRoute>> {
    // The bearer is computed HERE, at fetch time, not captured when the hook was
    // armed. `RYU_TOKEN` can rotate while Core runs, and `ext_token` is derived from
    // it — the health probe recomputes per call for exactly this reason, and a hook
    // armed at enable would present a stale secret to a sidecar that had already been
    // handed the new one.
    let token = crate::sidecar::ext_proxy::ext_token(
        crate::sidecar::ext_proxy::node_token().as_deref(),
        &spec.plugin_id,
    );
    // The sidecar's OWN address, not the ext-proxy: this is Core reading the app's
    // document, not an agent calling the app. (The routes the document lowers to do
    // go back through the proxy — see `ext_api::lower`.)
    let base = format!("http://127.0.0.1:{port}");

    // The lowering inputs, read LIVE (see `OpenApiImport::lowering_inputs`) so a
    // re-lowering after an in-place update intersects the new spec against the new
    // manifest, not the one this hook was armed with. Resolved before the fetch so the
    // read guard is long gone by the time anything blocks on the network.
    let (upstream_mount, declared_routes) = spec.lowering_inputs().await;

    // Try the candidates in order, keeping the FIRST 2xx. A 4xx moves on to the next
    // candidate; a 5xx/408/429 and any transport failure abort immediately and are
    // reported as transient, because "the sidecar is not answering properly" is not
    // evidence about where it publishes its schema.
    let candidates = openapi_doc_urls(&base, &upstream_mount);
    let mut found: Option<(String, Vec<u8>)> = None;
    let mut last_status: Option<reqwest::StatusCode> = None;
    for url in &candidates {
        match spec
            .client
            .get(url)
            .bearer_auth(&token)
            .timeout(OPENAPI_FETCH_TIMEOUT)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match read_capped_spec_body(resp, url).await {
                    SpecBody::Body(b) => {
                        found = Some((url.clone(), b));
                        break;
                    }
                    // DEFINITIVE. An over-cap body is a property of the document the app
                    // publishes, not a hiccup: retrying re-downloads the same oversized
                    // bytes on every 30s health poll forever, which is the amplification
                    // the cap exists to prevent. Recording zero routes stops the loop.
                    SpecBody::TooLarge => {
                        tracing::warn!(
                            plugin = %spec.plugin_id,
                            "ext_api: {url} exceeds the {EXT_API_SPEC_MAX_BYTES}-byte spec cap; \
                             deriving no tools for this sidecar. Narrow the document, or the \
                             manifest's `http.routes`, rather than expecting a retry."
                        );
                        return Some(Vec::new());
                    }
                    // A truncated body is a transport failure, not an answer about the app.
                    SpecBody::Transport(e) => {
                        tracing::debug!(plugin = %spec.plugin_id, "ext_api: reading {url} failed: {e}");
                        return None;
                    }
                }
            }
            // TRANSIENT by status. The Healthy edge fires the instant the health route
            // first answers, which is exactly when a sidecar still warming up (workers
            // forking, a router mounted after the health probe, a rate limiter shedding
            // load) answers 503/429 on everything else. Treating that as an answer
            // recorded "this app serves no OpenAPI document" for the life of the
            // process — permanently, silently, and only on slow boots.
            //
            // Returning instead of trying the next candidate: a 503 at the root says
            // nothing about the mount, and a second request only adds load to a sidecar
            // that is already telling us it cannot serve.
            Ok(resp) if is_transient_status(resp.status()) => {
                tracing::debug!(
                    plugin = %spec.plugin_id,
                    "ext_api: {url} returned {} — retrying on the next Healthy edge",
                    resp.status()
                );
                return None;
            }
            // 4xx (in practice 404) is the app's real answer about this URL: try the
            // next candidate, and if none answers the caller records "no spec".
            Ok(resp) => {
                last_status = Some(resp.status());
                tracing::debug!(
                    plugin = %spec.plugin_id,
                    "ext_api: {url} returned {}",
                    resp.status()
                );
            }
            Err(e) => {
                tracing::debug!(plugin = %spec.plugin_id, "ext_api: fetching {url} failed: {e}");
                return None;
            }
        }
    }

    // Every candidate answered, none with a document. A sidecar that serves no
    // OpenAPI schema is a perfectly valid app — it simply contributes no derived
    // tools. DEFINITIVE: a 404 now is a 404 in 30 seconds, and re-asking on every
    // health poll would make every app that does not use this feature pay for it.
    //
    // Logged at INFO, not debug, because "this app derived nothing" is the single
    // outcome an app author needs to be able to see, and it is otherwise the only
    // outcome that leaves no trace at all. The last status is carried into the line for
    // the same reason: this is the one branch that latches an app at zero tools, and
    // "404" (no such document) versus "401" (the bearer was rejected) are completely
    // different bugs that would otherwise look identical from the log.
    let Some((url, body)) = found else {
        tracing::info!(
            plugin = %spec.plugin_id,
            tried = ?candidates,
            status = last_status.map(|s| s.as_u16()),
            "ext_api: no OpenAPI document served — this app contributes no derived tools"
        );
        return Some(Vec::new());
    };

    // Definitive from here down: the app answered, and a document that does not parse
    // (or does not lower) will not start parsing without a restart — which clears the
    // claim and re-reads the spec anyway.
    let doc = match crate::openapi_import::parse_spec(&body) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(plugin = %spec.plugin_id, "ext_api: {url} is not a parseable spec: {e}");
            return Some(Vec::new());
        }
    };
    // The base override MUST be absolute: `spec_to_api_with_base` derives the egress
    // domain through `host_of`, which returns `None` for a relative path and makes the
    // whole import a hard error. Capped at the PARSE ceiling, not the exposure cap —
    // see `EXT_API_SPEC_OP_CEILING` for why capping here would truncate declared
    // operations in favour of undeclared ones.
    let api = match crate::openapi_import::spec_to_api_with_base(
        &doc,
        EXT_API_SPEC_OP_CEILING,
        Some(&base),
    ) {
        Ok(api) => api,
        Err(e) => {
            tracing::warn!(plugin = %spec.plugin_id, "ext_api: {url} could not be lowered: {e}");
            return Some(Vec::new());
        }
    };

    let (routes, dropped_undeclared) =
        crate::ext_api::lower(&spec.plugin_id, &api, &upstream_mount, &declared_routes);
    // The two drop counters are reported SEPARATELY on purpose. `api.dropped` is the
    // importer's cap truncation ("your spec is bigger than we will expose"); the other
    // is a manifest-declaration gap ("the proxy would 404 this path"). Different
    // causes, different fixes — summing them into one "N dropped" tells the app author
    // neither, and sends them to the wrong file.
    if api.dropped > 0 || dropped_undeclared > 0 {
        tracing::info!(
            plugin = %spec.plugin_id,
            source = %url,
            derived = routes.len(),
            dropped_over_ceiling = api.dropped,
            dropped_undeclared,
            "ext_api: some operations were not derived — `dropped_over_ceiling` means the \
             spec exceeded the parse ceiling, `dropped_undeclared` means the manifest's \
             `http.routes` does not declare the path (the proxy would 404 it)"
        );
    }
    Some(routes)
}

/// Remove the `~/.ryu/bin` binaries of a manifest's `Local`-kind sidecars — the
/// uninstall counterpart to [`ensure_local_sidecar_present`]. Called only from the
/// **uninstall** path (never plain disable, which keeps the bin so a re-enable is
/// instant), after the process is already stopped. Best-effort: a failed removal
/// warns and is otherwise ignored (leftover bytes are harmless and re-verified on
/// the next enable). A `command_env`-overridden bin is left alone — that path points
/// at a user/dev-managed file Core did not install and must not delete. `Binary`-kind
/// sidecars are skipped here: their bytes live under `<plugin_dir>/bin` and are
/// removed when the plugin directory is torn down.
pub(crate) async fn remove_local_sidecar_binaries(
    manifest: &crate::plugin_manifest::PluginManifest,
) {
    for spec in &manifest.sidecars {
        let SidecarProcess::Local(local) = &spec.process else {
            continue;
        };
        // The sidecar is going away, so any recorded "binary not installed" reason for
        // it must go too — otherwise the status surface keeps reporting a missing
        // binary for a name that no longer exists. Unconditional (before the
        // env-override skip): the record is about resolution, not about ownership of
        // the bytes.
        clear_missing_sidecar_binary(&namespaced_name(&manifest.id, &spec.name));
        // Respect an env override — that binary is not ours to remove.
        let env_override = local
            .command_env
            .as_ref()
            .and_then(|k| std::env::var(k).ok())
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        if env_override.is_some() {
            continue;
        }
        let dest = managed_bin_path(&local.command);
        // Drop the version marker alongside the bin (best-effort; harmless if absent).
        let _ = tokio::fs::remove_file(dest.with_extension("version")).await;
        if !dest.exists() {
            continue;
        }
        match tokio::fs::remove_file(&dest).await {
            Ok(()) => tracing::info!(
                plugin = %manifest.id,
                "uninstall: removed app sidecar binary {}",
                dest.display()
            ),
            Err(e) => tracing::warn!(
                plugin = %manifest.id,
                "uninstall: failed to remove app sidecar binary {}: {e}",
                dest.display()
            ),
        }
    }
}

/// Spawn a manifest-owned process with a minimal allowlisted environment plus
/// its explicit manifest/Core contract. Native sidecars are powerful host
/// processes, but they must never receive Core's owner token or master/provider
/// secrets merely through ambient environment inheritance.
async fn spawn(
    handle: &ProcessHandle,
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    handle.start_path_with_clean_env(program, args, &env).await
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
        let mcp = self.mcp.clone();
        Box::pin(async move {
            // Record the declared runtime permission posture (and warn when it is a
            // recorded-but-unenforced set on this unsandboxed native process) before
            // the process comes up, so the status surface reflects intent even if the
            // spawn later fails.
            record_native_permissions(&name, &plugin_id);
            // A start is the one event that makes a prior crash record untrue. Cleared
            // BEFORE the spawn rather than after: if this attempt itself fails, the
            // caller surfaces the start error, and leaving the *previous* death's
            // reason on the status plane would attribute the wrong cause to it.
            clear_crash_reason(&name);
            match &spec.process {
                SidecarProcess::Binary(bin) => {
                    let exe = ensure_binary(&plugin_id, bin, &plugin_dir, &downloads).await?;
                    // Layer the reserved ext-loader env over the manifest's own env
                    // (applied last so a manifest can't override the injected secret).
                    let mut env = bin.env.clone();
                    inject_ext_env(&mut env, &plugin_id, &ext_token);
                    inject_shadow_env(&mut env);
                    inject_cap_shims(&mut env, &plugin_id, &plugin_dir).await;
                    spawn(&handle, &exe.to_string_lossy(), &bin.args, &env).await?;
                }
                SidecarProcess::Local(local) => {
                    // A sibling-Ryu binary (e.g. `ryu-mail`). An optional
                    // `command_env` (e.g. RYU_MAIL_BIN) overrides the program path.
                    let program = local
                        .command_env
                        .as_ref()
                        .and_then(|k| std::env::var(k).ok())
                        .map(|s| s.trim().to_owned())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| local.command.clone());
                    // Download-on-enable: fetch the bin into `~/.ryu/bin` on first
                    // enable/wake if it isn't already present (release builds only;
                    // dev resolves it via RYU_*_BIN/PATH). Ties the binary to the app
                    // lifecycle instead of the desktop's old blanket boot-prefetch.
                    // Passing `name`/`plugin_id` in is what lets a resolution failure be
                    // RECORDED against this sidecar (surfaced by `health_check` +
                    // `missing_sidecar_binary_reports`) instead of swallowed into a warn.
                    //
                    // `mcp` is the ready notifier: once the binary is actually there, the
                    // owning plugin's `mcp_servers` declarations are re-offered to the
                    // registry, which had to skip them at enable time (the download had
                    // not happened yet — for a lazy sidecar, this is the first time it
                    // ever runs).
                    let program = ensure_local_sidecar_present(
                        &name,
                        &plugin_id,
                        program,
                        &local.command,
                        &downloads,
                        mcp.as_ref(),
                    )
                    .await;
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
                    inject_shadow_env(&mut env);
                    inject_cap_shims(&mut env, &plugin_id, &plugin_dir).await;
                    spawn(&handle, &program, &local.args, &env).await?;
                }
                SidecarProcess::Python(rt) => {
                    // Reuse the external-runtime provisioner (venv + pip + assets),
                    // then spawn `<venv python> -m <entry>`. The runtime lives in a
                    // per-sidecar dir so two python sidecars in one plugin don't share
                    // a venv.
                    let dir = plugin_dir.join("runtime").join(&spec.name);
                    let python = crate::sidecar::external_runtime::provision(rt, &dir, &downloads)
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
                    inject_shadow_env(&mut env);
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
        // Drop the provider entry BEFORE the process goes away, so there is no window
        // where a selectable provider points at a port nothing is listening on.
        self.deregister_provider();
        // Release any in-flight ext-API import claim, in the same spirit as
        // `deregister_provider` above: a spawned fetch whose sidecar is going away has
        // nothing left to talk to, and leaving the claim set would make the next start
        // skip its first Healthy edge.
        //
        // The registry rows are deliberately NOT cleared here. A stop is routine —
        // scale-to-zero idles a healthy app every few minutes — and dropping its tools
        // on each idle would make them flicker in and out of search for reasons no user
        // can see, while the next wake would refetch a document that has not changed.
        // Deactivate and update are the events that clear (see `deactivate_plugin` /
        // `update_app_handler`), because those are the ones after which the old rows
        // might actually be wrong.
        self.openapi_imported.store(false, Ordering::SeqCst);
        let handle = self.handle.clone();
        Box::pin(async move { handle.stop().await })
    }

    /// The crash path's half of `stop`'s provider teardown.
    ///
    /// `stop()` above is the ONLY other caller of [`Self::deregister_provider`], and a
    /// crash never runs it: the child dies on its own and nothing tears anything down.
    /// So without this the entry in `models.json` — a selectable provider whose
    /// `baseUrl` is `http://127.0.0.1:<port>/v1` and whose `apiKey` is this plugin's
    /// minted ext token — outlives the process that justified it, and stays until the
    /// next Core boot's [`crate::pi_config::purge_sidecar_providers`] sweep. Pi dials
    /// that `baseUrl` **directly**, so neither the ext proxy's registration gate nor
    /// the manager's `forward_target` refusal is in the path: the first local process
    /// to bind the now-free port is handed the token and the request bodies.
    ///
    /// Symmetric to the `stop` ordering note: there, deregistration happens *before*
    /// the process goes away; here the process is already gone, so the whole point is
    /// to shrink that window to the health monitor's detection latency instead of "the
    /// rest of this Core's lifetime".
    ///
    /// Cheap and non-panicking, as the trait requires: it is one `swap` on an
    /// [`std::sync::atomic::AtomicBool`] for the sidecars that never registered
    /// anything, and for the ones that did it is a small synchronous `models.json`
    /// rewrite whose every failure mode `deregister_provider` already logs rather than
    /// propagates — the same call `stop()` makes from the same async context.
    fn on_crash_detected(&self) {
        self.deregister_provider();
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = self.handle.is_running();
        // A recorded missing-binary reason, if this sidecar's `command` could not be
        // resolved at all (see the missing-binary record note above). Read here rather
        // than inferred from `!running`: a `lazy` sidecar scaled to zero is also not
        // running, and calling THAT "binary not installed" would be a lie.
        let missing_binary = missing_sidecar_binary_reason(&self.name);
        let url = self.health_url();
        // Present the minted secret on the probe so a sidecar that gates its health
        // route (defense in depth) still admits Core's own check — closing the
        // previously-unauthenticated probe. A sidecar that ignores it is unaffected.
        let token = self.ext_token();
        // Captured for the provider registration the Healthy edge triggers: the future
        // outlives this borrow, so it takes owned clones rather than `&self`.
        let provider = self.spec.provides_provider.clone();
        let plugin_id = self.plugin_id.clone();
        let port = self.effective_port();
        let registered = Arc::clone(&self.provider_registered);
        // Same owned-clone treatment as `provider` above, for the ext-API fetch hook.
        let openapi = self.openapi.clone();
        let openapi_latch = Arc::clone(&self.openapi_imported);
        let runtime_binding = self.runtime.clone();
        Box::pin(async move {
            if !running {
                // Say WHICH kind of "not running" this is. `binary not installed:` is
                // the diagnosable case — no process can ever exist on this host until
                // the bytes arrive — and is what a status panel renders instead of the
                // ext-proxy's generic 502.
                return match missing_binary {
                    Some(reason) => {
                        HealthStatus::Unhealthy(format!("binary not installed: {reason}"))
                    }
                    None => HealthStatus::Unhealthy("process not running".to_owned()),
                };
            }
            let _runtime_lease = match runtime_binding {
                Some(binding) => match binding.acquire().await {
                    Some(lease) => Some(lease),
                    None => return HealthStatus::Unhealthy("plugin runtime inactive".to_owned()),
                },
                None => None,
            };
            let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
                Ok(c) => c,
                Err(e) => return HealthStatus::Degraded(format!("client build failed: {e}")),
            };
            match client.get(&url).bearer_auth(&token).send().await {
                Ok(resp) if resp.status().is_success() => {
                    // Healthy means the endpoint is actually serving, so this is the
                    // first moment it is safe to publish as a selectable provider.
                    if let Some(spec) = provider.as_ref() {
                        // Same token the probe just presented: Pi will send it as the
                        // provider's apiKey when it calls the sidecar directly.
                        register_provider_once(&plugin_id, spec, port, &token, &registered);
                    }
                    // …and the first moment its OpenAPI document can be fetched.
                    // SPAWNED, never awaited here: this lane is polled every 30s and
                    // its client carries a 2s timeout, whereas the fetch is bounded at
                    // `OPENAPI_FETCH_TIMEOUT` (10s) — awaiting it would stall the
                    // monitor. Latched inside `import_openapi_once`, so the repeated
                    // Healthy edges a lazy sidecar produces cost one atomic load each.
                    if let Some(import) = openapi {
                        tokio::spawn(import_openapi_once(
                            import,
                            port,
                            Arc::clone(&openapi_latch),
                        ));
                    }
                    HealthStatus::Healthy
                }
                Ok(resp) => HealthStatus::Degraded(format!("health returned {}", resp.status())),
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.handle.is_running()
    }

    /// Delegates to the handle: a manifest sidecar always owns the child it spawned,
    /// so it is one of the few `Sidecar` impls that can answer this at all. See
    /// [`ProcessHandle::has_exited`] for why it is not `!is_running()`.
    fn has_exited(&self) -> bool {
        self.handle.has_exited()
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
            provides_provider: None,
        }
    }

    #[tokio::test]
    async fn ensure_binary_refuses_community_sidecar_without_sha256() {
        // A Community-tier plugin (anything not in CORE_PLUGINS) with a Binary
        // sidecar and no sha256 must fail closed BEFORE any network/disk work.
        let SidecarProcess::Binary(bin) = &binary_spec().process else {
            panic!("binary_spec is a Binary process");
        };
        assert!(bin.sha256.is_none());
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let err = ensure_binary(
            "com.example.community-tool",
            bin,
            Path::new("/nonexistent/plugins/com.example.community-tool"),
            &downloads,
        )
        .await
        .expect_err("must refuse an unverifiable community binary");
        assert!(err.to_string().contains("no sha256"), "got: {err}");
    }

    #[test]
    fn namespaced_name_joins_plugin_and_local() {
        assert_eq!(
            namespaced_name("com.acme.tool", "engine"),
            "com.acme.tool/engine"
        );
    }

    /// The `provides_provider` block a bridge manifest ships (see
    /// `examples/auth-bridge/build.mjs`) deserializes and yields the loopback baseUrl
    /// Core registers. Pins the on-the-wire field names so the example cannot silently
    /// drift from the Rust contract.
    #[test]
    fn provides_provider_deserializes_from_manifest_json() {
        let spec: SidecarSpec = serde_json::from_str(
            r#"{
                "name": "bridge",
                "process": { "kind": "node", "entry": "./backend.js" },
                "port": 7997,
                "health_path": "/health",
                "provides_provider": {
                    "id": "chatgpt-bridge",
                    "label": "ChatGPT (subscription bridge)",
                    "api": "openai-completions",
                    "base_path": "/v1",
                    "models": ["gpt-5", "gpt-5-codex"]
                }
            }"#,
        )
        .expect("bridge manifest should deserialize");

        let provider = spec.provides_provider.expect("provides_provider present");
        assert_eq!(provider.id, "chatgpt-bridge");
        assert_eq!(provider.effective_api(), "openai-completions");
        assert_eq!(provider.base_url(7997), "http://127.0.0.1:7997/v1");
        assert_eq!(provider.models.len(), 2);
    }

    /// Omitting the block leaves the sidecar a non-provider, and the optional
    /// sub-fields fall back to their documented defaults.
    #[test]
    fn provides_provider_is_optional_with_defaults() {
        let spec: SidecarSpec = serde_json::from_str(
            r#"{
                "name": "plain",
                "process": { "kind": "node", "entry": "./x.js" },
                "port": 7001
            }"#,
        )
        .expect("manifest without provides_provider should deserialize");
        assert!(spec.provides_provider.is_none());

        let minimal: ProviderRegistrationSpec =
            serde_json::from_str(r#"{ "id": "some-bridge" }"#).expect("minimal spec");
        assert_eq!(minimal.effective_api(), "openai-completions");
        assert_eq!(minimal.base_url(9000), "http://127.0.0.1:9000/v1");
        assert!(minimal.models.is_empty());
    }

    #[test]
    fn health_url_is_loopback() {
        assert_eq!(health_url(9099, "/health"), "http://127.0.0.1:9099/health");
        assert_eq!(
            health_url(8080, "/v1/ping"),
            "http://127.0.0.1:8080/v1/ping"
        );
    }

    #[test]
    fn sidecar_name_is_namespaced() {
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let sc = ManifestSidecar::new("com.acme.tool".to_owned(), binary_spec(), downloads);
        assert_eq!(sc.name(), "com.acme.tool/engine");
        assert!(!sc.is_required());
        assert!(!sc.is_running());
        assert_eq!(sc.pid(), None);
        assert_eq!(sc.port(), Some(crate::profile::port(9099)));
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
            Path::new("/plugins/acme")
                .join("bin")
                .join("1.2.3")
                .join("my-engine")
        );
    }

    #[test]
    fn url_filename_rejects_url_without_filename() {
        assert!(url_filename("https://example.com/dl/").is_err());
        assert_eq!(
            url_filename("https://example.com/a/b/tool").unwrap(),
            "tool"
        );
    }

    #[test]
    fn core_tier_always_runs() {
        assert!(may_run_sidecar(PluginTier::Core, &[]));
        assert!(may_run_sidecar(
            PluginTier::Core,
            &["unrelated:grant".to_owned()]
        ));
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
            provides_provider: None,
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let sc = ManifestSidecar::new("com.acme.voice".to_owned(), spec, downloads);
        assert_eq!(sc.name(), "com.acme.voice/tts");
        assert_eq!(
            sc.health_url(),
            format!("http://127.0.0.1:{}/health", crate::profile::port(8085))
        );
    }

    /// **Defect 3.** `lazy: true` + `provides_provider` is an unsatisfiable pair, so
    /// the provider declaration wins and the sidecar starts eagerly.
    ///
    /// Without the coercion, the boot purge of stale sidecar-owned `models.json`
    /// entries is permanently fatal to such a sidecar: the entry is dropped, nothing
    /// starts the process (Pi dials `baseUrl` directly and never traverses the proxy
    /// that is a lazy sidecar's only wake trigger), so the Healthy edge that would
    /// re-register the provider never happens.
    #[test]
    fn provider_declaring_sidecar_starts_eagerly_even_when_lazy() {
        let provider = ProviderRegistrationSpec {
            id: "acme-bridge".to_owned(),
            label: Some("Acme Bridge".to_owned()),
            api: None,
            base_path: None,
            models: vec!["acme-1".to_owned()],
        };

        // Plain lazy sidecar: still lazy. The coercion must be narrow.
        let mut spec = binary_spec();
        spec.lazy = true;
        assert!(
            !starts_eagerly(&spec),
            "a lazy sidecar with no provider keeps wake-on-demand"
        );
        assert!(may_idle_stop(&spec));

        // The documented third-party auth-bridge shape — coerced to eager.
        spec.provides_provider = Some(provider.clone());
        assert!(
            starts_eagerly(&spec),
            "provides_provider must force an eager start; nothing can ever wake it"
        );
        assert!(
            !may_idle_stop(&spec),
            "and it must not be scaled to zero either — the model would vanish from \
             Pi's picker until a wake that never comes"
        );

        // An eager provider sidecar is unaffected (it was already eager).
        spec.lazy = false;
        assert!(starts_eagerly(&spec));

        // No provider, not lazy: eager, and idle-stop stays available.
        let plain = binary_spec();
        assert!(starts_eagerly(&plain));
        assert!(may_idle_stop(&plain));
    }

    /// **Defect 3's wiring**, as opposed to its predicate. The test above proves
    /// `starts_eagerly` computes the right answer; it says nothing about whether the
    /// enable path ever asks. The whole regression is one token wide — flipping
    /// `apply_sidecars`' gate from `!starts_eagerly(spec)` back to `spec.lazy` restores
    /// defect 3 in full and leaves every other test in this crate green, because they
    /// all call the predicate directly.
    ///
    /// The call site is asserted against the source text rather than by calling
    /// `apply_sidecars`, which takes a whole `ServerState` (a SQLite plugin store, an
    /// MCP registry, an ACP agent registry, …) that no unit test can stand up. The
    /// comparison is whitespace-insensitive so rustfmt rewrapping cannot fail it, and
    /// it pins the branch STRUCTURE — gate first, then the register-only arm, then the
    /// eager `register_and_start` — so a gate that merely mentions `starts_eagerly`
    /// somewhere decorative while still branching on `spec.lazy` does not pass.
    #[test]
    fn apply_sidecars_gates_the_register_only_branch_on_starts_eagerly() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/server/mod.rs");
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let squished: String = src.chars().filter(|c| !c.is_whitespace()).collect();

        let gate = squished
            .find("if!crate::sidecar::manifest_sidecar::starts_eagerly(spec){")
            .expect(
                "apply_sidecars must gate the register-only (lazy) arm on \
                 `starts_eagerly(spec)`, not on `spec.lazy`: a sidecar that declares \
                 `provides_provider` can never be woken (Pi dials its baseUrl directly, \
                 never the ext proxy), so leaving it lazy means the boot purge drops its \
                 provider row and nothing ever re-registers it",
            );
        // Deliberately matched on the call NAME only, not its argument list: the arms
        // themselves are ordinary code other work rewrites, and this test must fail for
        // the gate flipping and nothing else.
        let rest = &squished[gate..];
        let register_only = rest
            .find("manager.register(")
            .expect("the register-only arm still registers without starting");
        let eager = rest
            .find("manager.register_and_start(")
            .expect("the eager arm still starts");
        assert!(
            register_only < eager,
            "the register-only arm must be the one the `starts_eagerly` gate guards; a \
             gate that falls through to `register_and_start` first is not the branch \
             defect 3 is about"
        );
    }

    /// The `models.json` row for `id`, read straight off disk — the persisted form Pi
    /// actually loads, not an in-memory projection of it.
    fn provider_row(id: &str) -> Option<serde_json::Value> {
        let raw =
            std::fs::read_to_string(crate::pi_config::config_dir().join("models.json")).ok()?;
        let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
        json.get("providers")?.get(id).cloned()
    }

    /// **The crash lane.** `deregister_provider` had exactly one caller —
    /// [`ManifestSidecar::stop`] — and a crashed child runs no teardown at all, so the
    /// provider row outlived the process that justified it: a selectable model whose
    /// `baseUrl` is the loopback port the crash just freed and whose `apiKey` is this
    /// plugin's minted ext token. Pi dials that `baseUrl` DIRECTLY, so the ext proxy's
    /// registration gate and the manager's `forward_target` refusal are both out of the
    /// path — the first local process to bind the vacated port is handed the credential
    /// and every inference request body, and nothing takes the row away until the next
    /// boot's `purge_sidecar_providers`.
    ///
    /// Reverting `on_crash_detected` (here or its call in
    /// `SidecarManager::note_crash_if_exited`) fails this.
    #[tokio::test]
    async fn crash_teardown_drops_the_provider_row_and_its_credential() {
        let _guard = crate::pi_config::lock_pi_config_test_env();
        let dir = std::env::temp_dir().join(format!("ryu-crash-provider-{}", uuid::Uuid::new_v4()));
        std::env::set_var("RYU_PI_AGENT_DIR", &dir);

        let provider = ProviderRegistrationSpec {
            id: "acme-crash-bridge".to_owned(),
            label: Some("Acme Crash Bridge".to_owned()),
            api: None,
            base_path: None,
            models: vec!["acme-1".to_owned()],
        };
        let mut spec = binary_spec();
        spec.provides_provider = Some(provider.clone());
        let sc = ManifestSidecar::new(
            "com.acme.crashbridge".to_owned(),
            spec,
            crate::downloads::DownloadCenter::with_default_client(),
        );

        // The Healthy edge that publishes it — exactly what the health monitor does.
        register_provider_once(
            &sc.plugin_id,
            &provider,
            sc.effective_port(),
            "ext-tok-crash",
            &sc.provider_registered,
        );
        let row = provider_row(&provider.id).expect("a healthy sidecar publishes its provider");
        assert_eq!(
            row["apiKey"], "ext-tok-crash",
            "the row carries the plugin's minted ext token — that is the credential at \
             stake, not just a dangling URL"
        );

        // The child dies on its own. `stop()` is never called on this path; this hook
        // is the only teardown a crash gets.
        sc.on_crash_detected();

        assert!(
            provider_row(&provider.id).is_none(),
            "a crashed sidecar's provider row must be gone: it points Pi at a port this \
             process no longer holds, with the plugin's ext token as the apiKey"
        );
        // Idempotent and panic-free: the monitor may see the same corpse again, and a
        // later stop() runs the same teardown.
        sc.on_crash_detected();
        sc.stop().await.unwrap();
        assert!(provider_row(&provider.id).is_none());

        std::env::remove_var("RYU_PI_AGENT_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sidecar that declares no provider has nothing to release, and the crash hook
    /// must stay a cheap no-op for it — the monitor calls this on every detected exit.
    #[test]
    fn crash_teardown_is_a_noop_without_a_declared_provider() {
        let sc = ManifestSidecar::new(
            "com.acme.plain".to_owned(),
            binary_spec(),
            crate::downloads::DownloadCenter::with_default_client(),
        );
        // No pi-config lock, no temp dir, no models.json: if this touched disk at all it
        // would be reaching into the developer's real config from a unit test.
        sc.on_crash_detected();
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

    fn manifest_with_backend(
        code: &str,
        sha: Option<&str>,
    ) -> crate::plugin_manifest::PluginManifest {
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
        assert!(
            !src.contains("require("),
            "bootstrap must be ESM, no CJS require"
        );
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
        assert!(
            !found.enforced,
            "native sidecars are never OS-enforced in v1"
        );
        // Serializes for the future status wire.
        let value = serde_json::to_value(found).unwrap();
        assert_eq!(value["enforced"], serde_json::json!(false));
        assert_eq!(value["name"], serde_json::json!(name));
    }

    // ── Missing app-sidecar binary: recorded + surfaced, never swallowed ──────────

    /// A `Local` sidecar spec for a command that cannot exist on any host.
    fn local_spec(command: &str) -> SidecarSpec {
        SidecarSpec {
            name: "worker".to_owned(),
            process: SidecarProcess::Local(crate::plugin_manifest::schema::LocalProcessSpec {
                command: command.to_owned(),
                command_env: None,
                port_env: None,
                args: vec![],
                env: BTreeMap::new(),
            }),
            port: 9098,
            health_path: "/health".to_owned(),
            http: None,
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
            provides_provider: None,
        }
    }

    /// The 404-swallowing case, which is what left `@ryu/browser` showing a
    /// permanent "502 sidecar unreachable": when nothing resolves the command, the
    /// reason is RECORDED (not just warned) and it names the exact release asset this
    /// platform needs, so an operator can diff it against what CI publishes.
    #[tokio::test]
    async fn missing_local_sidecar_binary_is_recorded_with_the_expected_release_asset() {
        let command = format!("ryu-test-absent-{}", uuid::Uuid::new_v4());
        let name = format!("com.test.absent/{command}");
        let downloads = crate::downloads::DownloadCenter::with_default_client();

        // Falls through to the bare command (the spawn stays the authoritative
        // resolver — this hook never turns an optional sidecar into a boot failure).
        let program = ensure_local_sidecar_present(
            &name,
            "com.test.absent",
            command.clone(),
            &command,
            &downloads,
            None,
        )
        .await;
        assert_eq!(program, command);

        let reports = missing_sidecar_binary_reports();
        let found = reports
            .iter()
            .find(|r| r.name == name)
            .expect("an unresolvable command must be recorded, not swallowed");
        assert_eq!(found.plugin_id, "com.test.absent");
        assert_eq!(found.command, command);
        // The asset-name contract: `<command>-<os>-<arch>[.exe]`, byte-identical to
        // what the release workflow must publish. A mismatch here IS the bug class
        // this record exists to expose (ryu-browser ships `-mac-arm64.dmg`).
        let ext = if cfg!(windows) { ".exe" } else { "" };
        assert_eq!(
            found.expected_asset,
            format!("{command}-{}{ext}", crate::update::platform_tag())
        );
        assert!(!found.reason.is_empty(), "a record must carry its reason");
        // Serializes for the status wire (the `/api/sidecar/status` seam).
        let value = serde_json::to_value(found).unwrap();
        assert_eq!(value["name"], serde_json::json!(name));
        assert_eq!(
            value["expected_asset"],
            serde_json::json!(found.expected_asset)
        );

        clear_missing_sidecar_binary(&name);
    }

    /// A record must never outlive the problem: once the binary resolves (a later
    /// install, or a `command_env` override pointing at a dev build) the entry is
    /// dropped, so a healed sidecar stops reporting "binary not installed" forever.
    #[tokio::test]
    async fn resolved_local_sidecar_binary_clears_a_stale_missing_record() {
        let name = format!("com.test.healed-{}/worker", uuid::Uuid::new_v4());
        record_missing_sidecar_binary(
            &name,
            "com.test.healed",
            "ryu-healed",
            "ryu-healed-macos-aarch64",
            "stale".to_owned(),
        );
        assert!(missing_sidecar_binary_reason(&name).is_some());

        // An existing file at the resolved program path is step 1 of the resolution
        // order (an env override or an already-installed bin).
        let existing = std::env::temp_dir().join(format!("ryu-healed-{}", uuid::Uuid::new_v4()));
        std::fs::write(&existing, b"#!/bin/sh\n").unwrap();
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let program = ensure_local_sidecar_present(
            &name,
            "com.test.healed",
            existing.to_string_lossy().into_owned(),
            "ryu-healed",
            &downloads,
            None,
        )
        .await;

        assert_eq!(program, existing.to_string_lossy());
        assert!(
            missing_sidecar_binary_reason(&name).is_none(),
            "a resolved binary must clear its stale missing-binary record"
        );
        std::fs::remove_file(&existing).ok();
    }

    // ── the managed-bin ready notifier ────────────────────────────────────────────

    /// A uniquely-named slot in the Ryu-managed bin dir: reserved (absent) first, so a
    /// test can assert the enable-time skip, then `install()`ed to make the binary land.
    /// Removed on `Drop`.
    ///
    /// Writes into the process's ACTUAL data dir (`~/.ryu/bin`, or the profile variant)
    /// rather than redirecting it: `paths::ryu_dir()` is a `OnceLock` resolved on first
    /// use, so setting `RYU_DIR` from a test would take effect or not depending on which
    /// sibling test ran first. A uuid-suffixed name cannot collide with a real installed
    /// binary, and it is never spawned.
    struct ManagedBinSlot {
        command: String,
        path: PathBuf,
    }

    impl ManagedBinSlot {
        fn reserve() -> Self {
            let command = format!("ryu-test-notify-{}", uuid::Uuid::new_v4());
            let path = managed_bin_path(&command);
            assert!(
                which_on_path(&command).is_none(),
                "precondition: a uuid-named command is not on PATH"
            );
            assert!(!path.is_file(), "precondition: the slot starts empty");
            Self { command, path }
        }

        /// The binary lands — deliberately WITHOUT the `<command>.version` marker
        /// `ensure_local_sidecar_present` demands before it reuses a bin. The marker is
        /// download-lifecycle policy; the MCP resolver rung only asks "is there a file
        /// here", so this is also the dev-box shape (a locally built binary).
        fn install(&self) {
            std::fs::create_dir_all(self.path.parent().expect("bin dir has a parent"))
                .expect("create the managed bin dir");
            std::fs::write(&self.path, b"").expect("write the managed bin");
        }
    }

    impl Drop for ManagedBinSlot {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// A manifest declaring exactly one `mcp_servers` entry whose `command` is the bare
    /// name of a Ryu-managed binary — the shape the managed-bin resolver rung exists for
    /// (no `command_env` for anything to seed).
    fn manifest_declaring_mcp_server(
        plugin_id: &str,
        server: &str,
        command: &str,
    ) -> crate::plugin_manifest::PluginManifest {
        let mut mcp_servers = BTreeMap::new();
        mcp_servers.insert(
            server.to_owned(),
            crate::plugin_manifest::McpServerDecl {
                command: Some(command.to_owned()),
                command_env: None,
                args: vec![],
                env: BTreeMap::new(),
                description: None,
                enabled: true,
                ..Default::default()
            },
        );
        crate::plugin_manifest::PluginManifest {
            id: plugin_id.to_owned(),
            name: "Notifier Test".to_owned(),
            version: "1.0.0".to_owned(),
            mcp_servers,
            ..Default::default()
        }
    }

    /// The whole point of the notifier: at enable the binary is not there yet, so the
    /// declaration is skipped and nothing remembers it — and then the sidecar's binary
    /// lands and the server registers itself, with no restart.
    ///
    /// Both halves are asserted in one test on purpose: the skip is the precondition
    /// that makes the registration meaningful. Without it, a host where the command
    /// happened to resolve would pass while proving nothing.
    ///
    /// The discriminator is the stored ABSOLUTE path, not mere presence: Ryu's installer
    /// puts `<data dir>/bin` on the user's `PATH`, so on some hosts a bare name also
    /// resolves through the plain-`PATH` rung, which stores the name verbatim. Only the
    /// managed-bin rung can produce the absolute path.
    #[tokio::test]
    async fn a_landed_managed_binary_registers_the_plugins_mcp_server() {
        let slot = ManagedBinSlot::reserve();
        let plugin_id = format!("com.test.notify-{}", uuid::Uuid::new_v4());
        let server = format!("notify-srv-{}", uuid::Uuid::new_v4());
        let sidecar_name = namespaced_name(&plugin_id, "worker");

        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let manifest = Arc::new(manifest_declaring_mcp_server(
            &plugin_id,
            &server,
            &slot.command,
        ));

        // 1. Enable time, reproduced exactly: `activate_plugin` registers the manifest's
        //    servers while `apply_sidecars` is still fetching the binary. Nothing to
        //    spawn, so the declaration is skipped — and a skip is remembered nowhere.
        let at_enable = crate::sidecar::mcp::register_manifest_mcp_servers(
            &registry,
            &manifest,
            PluginTier::Core,
            &[],
        );
        assert!(
            at_enable.is_empty() && !registry.contains_server(&server),
            "precondition: with no binary on disk the declaration must be skipped"
        );

        // 2. The binary lands — the event this notifier exists to observe.
        slot.install();

        let registration = McpRegistration {
            registry: Arc::clone(&registry),
            manifest: Arc::clone(&manifest),
            tier: PluginTier::Core,
            approved_grants: Vec::new(),
            runtime: None,
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let program = ensure_local_sidecar_present(
            &sidecar_name,
            &plugin_id,
            slot.command.clone(),
            &slot.command,
            &downloads,
            Some(&registration),
        )
        .await;

        // 3. Registered, from the real `ManifestSidecar` code path. Note the resolver
        //    that matters is the MCP one, not this function's: with no `.version` marker
        //    the sidecar resolution still falls through to the bare command, and the
        //    server registers anyway.
        assert_eq!(program, slot.command);
        assert!(
            registry.contains_server(&server),
            "a binary landing must register the declaration the enable pass skipped"
        );
        let summary = registry
            .server_summaries()
            .into_iter()
            .find(|s| s.name == server)
            .expect("the registered server must be listed");
        assert_eq!(
            summary.command,
            slot.path.to_string_lossy(),
            "the stored command must be the absolute managed-bin path, not the bare name"
        );

        // 4. Cost control: a lazy sidecar wakes over and over, and `register_server`
        //    rebuilds the server map + clears the tool cache. Once every declared name is
        //    registered the notifier must do nothing at all.
        assert!(
            notify_managed_binary_ready(&registration).await.is_empty(),
            "a wake with nothing left to register must not touch the registry"
        );

        clear_missing_sidecar_binary(&sidecar_name);
    }

    /// The skip-if-nothing-to-do guard must key on OWNERSHIP, not on "is this name known
    /// to the registry". Core reserves a set of built-in server names
    /// (`threads`, `research`, the capability facade, …) that `contains_server` answers
    /// `true` for whether or not anything is registered — while a plugin registration by
    /// that name is real work, because it overlays the built-in in `rebuild_servers`.
    ///
    /// Guarding on `contains_server` would therefore switch this notifier off
    /// *permanently*, and silently, for exactly the apps that are taking a name Core
    /// still reserves — which is the shape of every in-flight severance of a built-in
    /// Core MCP module out to its own app. Hence `plugin_server_owner`.
    #[tokio::test]
    async fn a_name_core_merely_reserves_does_not_suppress_the_notifier() {
        let slot = ManagedBinSlot::reserve();
        slot.install();
        let plugin_id = format!("com.test.reserved-{}", uuid::Uuid::new_v4());
        // Any reserved built-in name works; `threads` stands in for whichever Core
        // module an app is in the middle of taking over.
        let server = crate::sidecar::mcp::threads::SERVER_NAME;
        let sidecar_name = namespaced_name(&plugin_id, "worker");

        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        assert!(
            registry.contains_server(server),
            "precondition: the name is reserved even though nothing is registered"
        );
        assert!(
            registry.plugin_server_owner(server).is_none(),
            "precondition: but no PLUGIN owns it, so a registration would change something"
        );

        let registration = McpRegistration {
            registry: Arc::clone(&registry),
            manifest: Arc::new(manifest_declaring_mcp_server(
                &plugin_id,
                server,
                &slot.command,
            )),
            tier: PluginTier::Core,
            approved_grants: Vec::new(),
            runtime: None,
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let _ = ensure_local_sidecar_present(
            &sidecar_name,
            &plugin_id,
            slot.command.clone(),
            &slot.command,
            &downloads,
            Some(&registration),
        )
        .await;

        assert_eq!(
            registry.plugin_server_owner(server).as_deref(),
            Some(plugin_id.as_str()),
            "a reserved-but-unowned name must not short-circuit the notifier"
        );
        // And now that it IS owned, the guard does its job on the next wake.
        assert!(
            notify_managed_binary_ready(&registration).await.is_empty(),
            "once owned, a wake must not touch the registry"
        );

        clear_missing_sidecar_binary(&sidecar_name);
    }

    /// The notifier is the SAME gated door, asked twice — not a second, ungated one. A
    /// Community-tier plugin without the approved `mcp:server` grant registers nothing
    /// when its binary lands, exactly as it registered nothing at enable.
    ///
    /// This is the property that matters most here: the notifier fires from a code path
    /// (a sidecar start / lazy wake) that has no gate of its own, so if it re-derived
    /// "which declarations now resolve" instead of re-running
    /// `register_manifest_mcp_servers`, a `~/.ryu/plugins` manifest could reach
    /// `Command::new` just by shipping a binary.
    #[tokio::test]
    async fn the_notifier_does_not_bypass_the_tier_and_grant_gate() {
        let slot = ManagedBinSlot::reserve();
        slot.install();
        let plugin_id = format!("com.test.ungated-{}", uuid::Uuid::new_v4());
        let server = format!("ungated-srv-{}", uuid::Uuid::new_v4());
        let sidecar_name = namespaced_name(&plugin_id, "worker");

        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let registration = McpRegistration {
            registry: Arc::clone(&registry),
            manifest: Arc::new(manifest_declaring_mcp_server(
                &plugin_id,
                &server,
                &slot.command,
            )),
            tier: PluginTier::Community,
            approved_grants: Vec::new(),
            runtime: None,
        };

        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let _ = ensure_local_sidecar_present(
            &sidecar_name,
            &plugin_id,
            slot.command.clone(),
            &slot.command,
            &downloads,
            Some(&registration),
        )
        .await;

        assert!(
            !registry.contains_server(&server),
            "a Community-tier plugin without the approved grant must register nothing, \
             even though its binary is now installed and resolvable"
        );
        // And the grant is what unlocks it — so the skip above is the gate, not a
        // resolution failure that would make this test vacuous.
        let granted = McpRegistration {
            approved_grants: vec![crate::sidecar::mcp::GRANT_MCP_SERVER.to_owned()],
            ..registration
        };
        assert_eq!(
            notify_managed_binary_ready(&granted).await,
            vec![server.clone()],
            "with the grant approved, the same landing registers the server"
        );

        clear_missing_sidecar_binary(&sidecar_name);
    }

    /// The surfaced half: `health_check` reports the recorded reason through
    /// [`HealthStatus::Unhealthy`] — the reason channel that already exists — so a
    /// stopped sidecar reads as "binary not installed", not the indistinguishable
    /// "process not running" a crash and a lazy scale-to-zero also produce.
    #[tokio::test]
    async fn health_check_says_binary_not_installed_rather_than_process_not_running() {
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let plugin_id = format!("com.test.nobin-{}", uuid::Uuid::new_v4());
        let sc = ManifestSidecar::new(plugin_id.clone(), local_spec("ryu-test-nobin"), downloads);
        let name = sc.name().to_owned();

        // No record yet: a not-running sidecar (crashed, or lazily scaled to zero) must
        // NOT be reported as a missing binary — that would be a lie about the cause.
        assert!(!sc.is_running());
        let before = sc.health_check().await;
        let HealthStatus::Unhealthy(msg) = before else {
            panic!("a stopped sidecar is Unhealthy");
        };
        assert_eq!(msg, "process not running");

        record_missing_sidecar_binary(
            &name,
            &plugin_id,
            "ryu-test-nobin",
            "ryu-test-nobin-macos-aarch64",
            "not published for this platform".to_owned(),
        );
        let after = sc.health_check().await;
        let HealthStatus::Unhealthy(msg) = after else {
            panic!("a sidecar with no binary is Unhealthy");
        };
        assert!(
            msg.starts_with("binary not installed: "),
            "health must carry the missing-binary reason, got: {msg}"
        );
        assert!(msg.contains("not published for this platform"), "{msg}");

        clear_missing_sidecar_binary(&name);
    }

    // ── The ext-API fetch hook ────────────────────────────────────────────────

    /// A one-shot loopback server that counts connections and answers every request
    /// with a bare 404 — the shape of a real sidecar that serves no OpenAPI document,
    /// which is the case the latch has to terminate on. Returns its port plus the
    /// live hit counter.
    ///
    /// A real socket rather than a mock because the thing under test is precisely
    /// whether a SECOND fetch happens: a fake that records calls to a trait would be
    /// asserting about the fake's own bookkeeping, not about the hook's behaviour.
    fn spawn_counting_probe() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        spawn_probe(ProbeReply::Status(404))
    }

    /// What a [`spawn_probe`] listener answers with. Each variant is a classification
    /// the fetch hook has to get right, and each one is a different code path out of
    /// `import_openapi` — which is why they share one listener instead of three.
    #[derive(Clone, Copy)]
    enum ProbeReply {
        /// A bare status with an empty body (404 ⇒ definitive, 503 ⇒ transient).
        Status(u16),
        /// A 200 whose body is `bytes` long — used to cross
        /// [`EXT_API_SPEC_MAX_BYTES`]. The declared `content-length` is deliberately a
        /// LIE (it claims a small body), so passing this test proves the *streaming*
        /// total is what bounds the read, not the header pre-check a hostile or buggy
        /// server controls.
        OversizedBody { bytes: usize },
    }

    /// A loopback server that counts connections and answers every request the same
    /// way. Returns its port plus the live hit counter.
    fn spawn_probe(reply: ProbeReply) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::AtomicUsize;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        if let ProbeReply::OversizedBody { bytes } = reply {
            tokio::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("into tokio");
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        return;
                    };
                    counter.fetch_add(1, Ordering::SeqCst);
                    let mut buf = [0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    // Chunked, so the client cannot pre-empt on `content-length` — the
                    // read has to be stopped by the running total or not at all.
                    let _ = sock
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                              transfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                        )
                        .await;
                    // 64 KB of filler per chunk; the JSON is never valid, which is fine
                    // — the cap must trip long before anything tries to parse it.
                    let chunk = vec![b'x'; 64 * 1024];
                    let header = format!("{:x}\r\n", chunk.len());
                    let mut sent = 0usize;
                    while sent < bytes {
                        if sock.write_all(header.as_bytes()).await.is_err()
                            || sock.write_all(&chunk).await.is_err()
                            || sock.write_all(b"\r\n").await.is_err()
                        {
                            break;
                        }
                        sent += chunk.len();
                    }
                    let _ = sock.write_all(b"0\r\n\r\n").await;
                    let _ = sock.shutdown().await;
                }
            });
            return (port, hits);
        }
        let ProbeReply::Status(status) = reply else {
            unreachable!("the oversized arm returned above");
        };
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("into tokio");
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                // Drain the request line/headers first: answering into an unread
                // socket makes some clients report a connection reset instead of the
                // status, which would misclassify a definitive 404 as transient.
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 {status} Status\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (port, hits)
    }

    /// The default hook fixture: plugin `@ryu/probe`, its `worker` sidecar, no live
    /// manifest store (so [`OpenApiImport::lowering_inputs`] falls back to the
    /// snapshot, which is the shape every pre-existing test asserts against).
    fn probe_import(registry: &Arc<crate::sidecar::mcp::McpRegistry>) -> OpenApiImport {
        probe_import_named(registry, "@ryu/probe", "worker")
    }

    fn probe_import_named(
        registry: &Arc<crate::sidecar::mcp::McpRegistry>,
        plugin_id: &str,
        sidecar: &str,
    ) -> OpenApiImport {
        OpenApiImport {
            registry: Arc::clone(registry),
            plugin_id: plugin_id.to_owned(),
            sidecar_name: sidecar.to_owned(),
            sidecar_key: namespaced_name(plugin_id, sidecar),
            manifests: None,
            upstream_mount: "/api".to_owned(),
            declared_routes: Vec::new(),
            client: reqwest::Client::new(),
            runtime: None,
        }
    }

    /// A stranded claim is permanent and silent: the flag stays `true`, nothing was
    /// stored so `has_ext_api_routes` stays `false`, and every later Healthy edge
    /// spawns a task that loses the CAS and returns. The app then derives zero tools
    /// for the life of the process with nothing in the log to say why. Releasing from
    /// `Drop` rather than a trailing store is what makes an unwind survivable.
    #[test]
    fn claim_guard_releases_on_unwind() {
        let latch = Arc::new(AtomicBool::new(true));
        let escaped = std::panic::catch_unwind({
            let latch = Arc::clone(&latch);
            move || {
                let _claim = ClaimGuard(latch);
                panic!("lowering blew up");
            }
        });
        assert!(escaped.is_err(), "the panic must actually have unwound");
        assert!(
            !latch.load(Ordering::SeqCst),
            "an unwind must still release the claim, or the app never derives again"
        );
    }

    /// The re-wake guard. A `lazy` sidecar with `idle_stop_secs` crosses the Healthy
    /// edge on every wake, so an unlatched hook would refetch and reparse the same
    /// document for the life of the node.
    ///
    /// This also pins the half that makes termination possible at all: a definitive
    /// "no spec here" answer is RECORDED (as zero routes), not merely skipped. If it
    /// were skipped, `has_ext_api_routes` would stay false and every one of the ~40
    /// apps that serve no OpenAPI document would be re-probed twice a minute forever.
    #[tokio::test]
    async fn import_is_latched_and_does_not_refetch_on_rewake() {
        let (port, hits) = spawn_counting_probe();
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let latch = Arc::new(AtomicBool::new(false));

        import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "the first Healthy edge tries the root, then the mount-prefixed form"
        );
        assert!(
            registry.has_ext_api_routes("@ryu/probe"),
            "a definitive answer must be recorded even when it derives nothing"
        );

        import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 2, "a re-wake must not refetch");
    }

    /// The ROOT is tried first. `http.mount` says where the sidecar nests its routes,
    /// not where its server is rooted — the spec's own paths already carry the mount
    /// (which is why `ext_api::lower` strips it), so an app nesting at `/api/crm`
    /// still publishes its schema at `/openapi.json`. Getting this backwards 404s
    /// every app that has a mount, and — because a 404 is definitive — latches it at
    /// zero derived tools for the life of the process.
    #[test]
    fn openapi_is_probed_at_the_root_before_the_mount() {
        assert_eq!(
            openapi_doc_urls("http://127.0.0.1:8009", "/api/crm"),
            vec![
                "http://127.0.0.1:8009/openapi.json".to_owned(),
                "http://127.0.0.1:8009/api/crm/openapi.json".to_owned(),
            ]
        );
        // No mount ⇒ one candidate, not a duplicate of the same URL.
        assert_eq!(
            openapi_doc_urls("http://127.0.0.1:8009", ""),
            vec!["http://127.0.0.1:8009/openapi.json".to_owned()]
        );
    }

    /// …and the latch is re-armable, which is the whole reason it lives in the
    /// REGISTRY rather than in this struct. `deactivate_plugin` and
    /// `update_app_handler` both clear the rows without rebuilding the sidecar object;
    /// a local done-flag would make those clears permanent (zero derived tools until
    /// the next process restart) instead of a re-lower request.
    #[tokio::test]
    async fn clearing_the_registry_re_arms_the_import() {
        let (port, hits) = spawn_counting_probe();
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let latch = Arc::new(AtomicBool::new(false));

        import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
        let after_first = hits.load(Ordering::SeqCst);
        assert!(after_first > 0);

        registry.clear_ext_api_routes("@ryu/probe");
        import_openapi_once(probe_import(&registry), port, latch).await;
        assert!(
            hits.load(Ordering::SeqCst) > after_first,
            "clearing the registry must let the next Healthy edge re-lower"
        );
    }

    /// A 404 is the app's real answer about this URL, so it stays DEFINITIVE: the ~40
    /// shipped apps that publish no OpenAPI document must be recorded as "nothing to
    /// derive" and never probed again, or every one of them pays two requests per
    /// health poll for the life of the node.
    ///
    /// The counterpart to `server_error_status_is_transient_and_retries` below — the
    /// two together are the whole content of the status split, and asserting only one
    /// of them would pass under a classifier that treats everything the same way.
    #[tokio::test]
    async fn not_found_is_definitive() {
        let (port, hits) = spawn_probe(ProbeReply::Status(404));
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let latch = Arc::new(AtomicBool::new(false));
        let import = probe_import(&registry);
        let key = import.sidecar_key.clone();

        import_openapi_once(import, port, Arc::clone(&latch)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "a 4xx at the root must still try the mount-prefixed candidate"
        );
        assert!(
            registry.has_ext_api_routes_for_sidecar(&key),
            "a 404 from every candidate is an answer, and must be recorded"
        );

        import_openapi_once(probe_import(&registry), port, latch).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "and it must never be re-asked"
        );
    }

    /// 401/403 stay DEFINITIVE, and that is a deliberate call rather than a gap in the
    /// list. "The bearer was rejected" is a stable property of how the sidecar is
    /// configured, not a hiccup — treating it as transient would put every
    /// auth-misconfigured app into a permanent two-requests-per-30s loop that nothing
    /// ever breaks, since the token Core presents does not change by being re-sent.
    ///
    /// Pinned separately because it is the plausible wrong edit: "the token must have
    /// rotated, so retry" reads reasonable and would leave the suite green. The INFO
    /// line on the definitive branch carries the status precisely so an operator can
    /// tell this case apart from a 404 without a retry loop to make it obvious.
    #[tokio::test]
    async fn unauthorized_is_definitive_not_a_retry_loop() {
        let (port, hits) = spawn_probe(ProbeReply::Status(401));
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let latch = Arc::new(AtomicBool::new(false));
        let import = probe_import(&registry);
        let key = import.sidecar_key.clone();

        import_openapi_once(import, port, Arc::clone(&latch)).await;
        assert!(
            registry.has_ext_api_routes_for_sidecar(&key),
            "a rejected bearer is an answer about the app, not a transport hiccup"
        );
        let after_first = hits.load(Ordering::SeqCst);

        import_openapi_once(probe_import(&registry), port, latch).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            after_first,
            "…so it must never be re-asked"
        );
    }

    /// A 5xx is the sidecar failing, not answering — and the Healthy edge fires at
    /// exactly the moment a sidecar is most likely to be mid-boot (health route up,
    /// the rest of the router not yet mounted, workers still forking). Recording that
    /// as "this app serves no OpenAPI document" would latch the app at zero derived
    /// tools for the life of the process, on nothing but a slow start.
    ///
    /// Also pins the no-second-candidate rule: a 503 at the root says nothing about
    /// the mount, so retrying the mount would only add load to a sidecar that is
    /// already shedding it. One hit per attempt, not two.
    #[tokio::test]
    async fn server_error_status_is_transient_and_retries() {
        let (port, hits) = spawn_probe(ProbeReply::Status(503));
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let latch = Arc::new(AtomicBool::new(false));
        let import = probe_import(&registry);
        let key = import.sidecar_key.clone();

        import_openapi_once(import, port, Arc::clone(&latch)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "a transient status must abort the candidate walk, not double the load"
        );
        assert!(
            !registry.has_ext_api_routes_for_sidecar(&key),
            "a 503 must store NOTHING, or the retry can never happen"
        );

        // The next Healthy edge (30s later in production; immediately here) re-asks.
        import_openapi_once(probe_import(&registry), port, latch).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "the sidecar that was briefly 503 must get another chance"
        );
    }

    /// Unbounded consumption: the only bound on this fetch used to be the 10s timeout,
    /// and 10 seconds of loopback is gigabytes — buffered into a `Vec` and then handed
    /// to a JSON parser.
    ///
    /// Two properties in one test, because either alone is a false pass:
    ///
    /// 1. The read is *stopped* — the probe streams far more than
    ///    [`EXT_API_SPEC_MAX_BYTES`] under a chunked encoding with no honest
    ///    `content-length`, so only the running total can stop it.
    /// 2. The refusal is *definitive*. A transient classification here would be worse
    ///    than no cap at all: every 30s health poll would re-download the same
    ///    oversized document forever, turning a one-shot memory spike into a permanent
    ///    bandwidth loop.
    #[tokio::test]
    async fn oversized_spec_body_is_refused_and_not_retried() {
        let over = (EXT_API_SPEC_MAX_BYTES as usize) + 512 * 1024;
        let (port, hits) = spawn_probe(ProbeReply::OversizedBody { bytes: over });
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let latch = Arc::new(AtomicBool::new(false));
        let import = probe_import(&registry);
        let key = import.sidecar_key.clone();

        import_openapi_once(import, port, Arc::clone(&latch)).await;
        let after_first = hits.load(Ordering::SeqCst);
        assert_eq!(
            after_first, 1,
            "the first candidate answered 200, so the walk stops there"
        );
        assert!(
            registry.has_ext_api_routes_for_sidecar(&key),
            "an over-cap body must be recorded as a definitive zero-tool result"
        );

        import_openapi_once(probe_import(&registry), port, latch).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            after_first,
            "…and must NOT be re-downloaded on the next Healthy edge"
        );
    }

    /// The direct unit on the cap, so a regression is attributed to the reader rather
    /// than to the hook around it — and so the `content-length` pre-check is pinned
    /// independently of the streaming total the test above exercises.
    #[tokio::test]
    async fn a_lying_content_length_cannot_bypass_the_spec_cap() {
        // A server may under-declare (or omit) `content-length`; the pre-check is an
        // early-out, never the bound.
        let over = (EXT_API_SPEC_MAX_BYTES as usize) + 512 * 1024;
        let (port, _hits) = spawn_probe(ProbeReply::OversizedBody { bytes: over });
        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/openapi.json"))
            .send()
            .await
            .expect("the probe answers");
        assert!(
            resp.content_length()
                .is_none_or(|l| l <= EXT_API_SPEC_MAX_BYTES),
            "precondition: the header must not be what trips the cap"
        );
        assert!(
            matches!(
                read_capped_spec_body(resp, "probe").await,
                SpecBody::TooLarge
            ),
            "the streaming total is the bound"
        );
    }

    /// One derived row, shaped enough to be stored and counted. The registry never
    /// inspects anything but `id`/`plugin_id` on the paths under test here.
    fn derived_row(id: &str, plugin: &str) -> crate::ext_api::ExtApiRoute {
        crate::ext_api::ExtApiRoute {
            id: id.to_owned(),
            plugin_id: plugin.to_owned(),
            method: "GET".to_owned(),
            url: format!("core:/api/ext/{plugin}/thing"),
            name: "Do the thing".to_owned(),
            description: None,
            header_params: vec![],
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    /// **FIX 3.** The hook is armed per SIDECAR while the store used to be keyed per
    /// PLUGIN, so a manifest with two `http` sidecars had its second lowering silently
    /// overwrite the first — and, worse, the plugin-scoped latch then answered "already
    /// lowered" for the second sidecar before it ever ran, making the winner a function
    /// of health-poll ordering.
    ///
    /// Both halves are asserted, because they fail independently:
    ///
    /// - the LATCH half, end-to-end through `import_openapi_once`: sidecar B must
    ///   actually go and fetch after sidecar A has finished;
    /// - the STORE half: A's rows must still be there once B has stored its own.
    ///
    /// Latent today only because exactly one shipped manifest (`finetune`) declares two
    /// sidecars and its second happens to carry no `http` block. That is a coincidence,
    /// not a guarantee, and the failure it would produce is invisible.
    #[tokio::test]
    async fn two_http_sidecars_on_one_plugin_do_not_overwrite_each_other() {
        let (port, hits) = spawn_counting_probe();
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());

        let alpha = probe_import_named(&registry, "@ryu/twin", "alpha");
        let beta = probe_import_named(&registry, "@ryu/twin", "beta");
        let (alpha_key, beta_key) = (alpha.sidecar_key.clone(), beta.sidecar_key.clone());
        assert_ne!(alpha_key, beta_key, "the two sidecars must key differently");

        import_openapi_once(alpha, port, Arc::new(AtomicBool::new(false))).await;
        let after_alpha = hits.load(Ordering::SeqCst);
        assert!(after_alpha > 0, "the first sidecar fetched");

        import_openapi_once(beta, port, Arc::new(AtomicBool::new(false))).await;
        assert!(
            hits.load(Ordering::SeqCst) > after_alpha,
            "the SECOND sidecar of the same plugin must still fetch its own document — \
             a plugin-scoped latch would have skipped it forever"
        );
        assert!(registry.has_ext_api_routes_for_sidecar(&alpha_key));
        assert!(registry.has_ext_api_routes_for_sidecar(&beta_key));

        // The store half: two sidecars' rows coexist instead of the later replacing
        // the earlier.
        registry.set_ext_api_routes_for_sidecar(
            "@ryu/twin",
            &alpha_key,
            vec![derived_row("ryu_ext.ryu_twin.get_alpha", "@ryu/twin")],
        );
        registry.set_ext_api_routes_for_sidecar(
            "@ryu/twin",
            &beta_key,
            vec![derived_row("ryu_ext.ryu_twin.get_beta", "@ryu/twin")],
        );
        assert!(
            registry
                .describe("ryu_ext.ryu_twin.get_alpha")
                .await
                .is_some(),
            "the first sidecar's rows must survive the second's lowering"
        );
        assert!(registry
            .describe("ryu_ext.ryu_twin.get_beta")
            .await
            .is_some());
    }

    /// …and the plugin-scoped clear must reach BOTH of them. `deactivate_plugin` and
    /// `update_app_handler` know only the plugin id, so a sidecar-keyed store with a
    /// `map.remove(plugin_id)` clear would leave the second sidecar's rows searchable
    /// and callable for an app the user just disabled — tools that the ext-proxy then
    /// refuses at the hop, i.e. tools that can only fail.
    ///
    /// The look-alike plugin is the other half of the keying invariant: ownership
    /// requires a `/` boundary, so disabling `@ryu/twin` must not strip `@ryu/twin-x`.
    #[tokio::test]
    async fn deactivate_clears_every_sidecar_for_the_plugin() {
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let alpha = namespaced_name("@ryu/twin", "alpha");
        let beta = namespaced_name("@ryu/twin", "beta");
        let neighbour = namespaced_name("@ryu/twin-x", "alpha");

        registry.set_ext_api_routes_for_sidecar(
            "@ryu/twin",
            &alpha,
            vec![derived_row("ryu_ext.ryu_twin.get_alpha", "@ryu/twin")],
        );
        // A zero-route entry is still an entry — it is what makes the latch terminate,
        // so a clear that only removed non-empty ones would re-arm nothing.
        registry.set_ext_api_routes_for_sidecar("@ryu/twin", &beta, vec![]);
        registry.set_ext_api_routes_for_sidecar(
            "@ryu/twin-x",
            &neighbour,
            vec![derived_row("ryu_ext.ryu_twin_x.get_alpha", "@ryu/twin-x")],
        );

        registry.clear_ext_api_routes("@ryu/twin");

        assert!(
            !registry.has_ext_api_routes_for_sidecar(&alpha),
            "the clear must reach the first sidecar"
        );
        assert!(
            !registry.has_ext_api_routes_for_sidecar(&beta),
            "…and the second, including one that lowered to zero rows"
        );
        assert!(
            !registry.has_ext_api_routes("@ryu/twin"),
            "the plugin-scoped read model must agree, so a re-enable re-lowers"
        );
        assert!(
            registry.has_ext_api_routes_for_sidecar(&neighbour),
            "a plugin whose id merely PREFIXES the cleared one must be untouched"
        );
        assert!(
            registry
                .describe("ryu_ext.ryu_twin_x.get_alpha")
                .await
                .is_some(),
            "…and its rows must still dispatch"
        );
    }

    /// **FIX 4.** An in-place app update rewrites the manifest without re-running
    /// `apply_sidecars`: it reloads `state.app_manifests` and clears the derived rows,
    /// leaving the next Healthy edge to re-lower. If the lowering inputs were the
    /// arm-time snapshot, that re-lowering would intersect the NEW spec against the OLD
    /// declared routes and strip the OLD mount — deriving tools for paths the update
    /// withdrew (which then 404 at the proxy) while silently dropping the ones it added.
    ///
    /// So the inputs are a live read, with the snapshot as the fallback. All three
    /// branches are pinned here, because each fails differently: no store at all (test
    /// and CLI contexts), a store that does not know this sidecar (uninstalled or
    /// renamed mid-fetch), and the hit that is the whole point.
    #[tokio::test]
    async fn lowering_inputs_are_read_live_from_the_updated_manifest() {
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());

        // No store wired ⇒ the arm-time snapshot, unchanged.
        let bare = probe_import_named(&registry, "@ryu/updated", "worker");
        assert_eq!(
            bare.lowering_inputs().await,
            ("/api".to_owned(), Vec::new()),
            "with no manifest store the snapshot must still be used"
        );

        // The manifest as it looks AFTER an update: a different mount, different routes.
        let mut spec = binary_spec();
        spec.name = "worker".to_owned();
        spec.http = Some(
            serde_json::from_value(serde_json::json!({
                "mount": "/api/new/",
                "routes": [{ "path": "/added" }],
            }))
            .expect("the http fixture must match HttpProxySpec"),
        );
        let manifest = crate::plugin_manifest::PluginManifest {
            id: "@ryu/updated".to_owned(),
            name: "Updated".to_owned(),
            version: "2.0.0".to_owned(),
            sidecars: vec![spec],
            ..Default::default()
        };
        let store = Arc::new(tokio::sync::RwLock::new(vec![manifest]));

        let live = OpenApiImport {
            manifests: Some(Arc::clone(&store)),
            ..probe_import_named(&registry, "@ryu/updated", "worker")
        };
        let (mount, routes) = live.lowering_inputs().await;
        assert_eq!(mount, "/api/new");
        assert_eq!(
            routes
                .iter()
                .map(|route| route.path.as_str())
                .collect::<Vec<_>>(),
            ["/added"]
        );

        // A sidecar the live manifest does not describe (renamed, or the app was
        // uninstalled mid-fetch) falls back rather than lowering against nothing.
        let renamed = OpenApiImport {
            manifests: Some(store),
            ..probe_import_named(&registry, "@ryu/updated", "gone")
        };
        assert_eq!(
            renamed.lowering_inputs().await,
            ("/api".to_owned(), Vec::new()),
            "a miss must fall back to the snapshot, not to an empty declaration set"
        );
    }
}
