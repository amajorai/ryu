//! Shared fixtures for the MCP registry tests, plus the runtime test suites.

#[path = "agentbrowser_capabilities_runtime_test.rs"]
mod agentbrowser_capabilities_runtime;
#[path = "bytebot_registry_runtime_test.rs"]
mod bytebot_registry_runtime;
#[path = "cloudflare_clef_runtime_test.rs"]
mod cloudflare_clef_runtime;
#[path = "cloudflare_oauth_capabilities_runtime_test.rs"]
mod cloudflare_oauth_capabilities_runtime;
#[path = "ghost_capabilities_runtime_test.rs"]
mod ghost_capabilities_runtime;
#[path = "kev_clef_capabilities_runtime_test.rs"]
mod kev_clef_capabilities_runtime;
#[path = "lazy_sidecar_wake_test.rs"]
mod lazy_sidecar_wake;
#[path = "local_decision_models_runtime_test.rs"]
mod local_decision_models_runtime;
#[path = "reasoning_verify_capabilities_runtime_test.rs"]
mod reasoning_verify_capabilities_runtime;
#[path = "scrapling_capabilities_runtime_test.rs"]
mod scrapling_capabilities_runtime;
#[path = "spidercloud_capabilities_runtime_test.rs"]
mod spidercloud_capabilities_runtime;
#[path = "web_capabilities_runtime_test.rs"]
mod web_capabilities_runtime;
use super::*;

use crate::plugin_manifest::schema::RunnableEntry as PmRunnableEntry;
use crate::runnable::RunnableKind;

// Share the canonical Core environment guard with other suites rather than
// creating an MCP-only mutex around process-global environment mutations.
pub(super) fn lock_mcp_env() -> std::sync::MutexGuard<'static, ()> {
    crate::sidecar::gateway::lock_gateway_env()
}

pub(super) struct RestoreDiscoveryAllowHosts(Option<std::ffi::OsString>);
impl Drop for RestoreDiscoveryAllowHosts {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var("RYU_AGENT_EGRESS_ALLOW_HOSTS", value),
            None => std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS"),
        }
    }
}

pub(super) fn allow_discovery_test_host(
    address: std::net::SocketAddr,
) -> RestoreDiscoveryAllowHosts {
    let restore = RestoreDiscoveryAllowHosts(std::env::var_os("RYU_AGENT_EGRESS_ALLOW_HOSTS"));
    let mut allowed = restore.0.clone().unwrap_or_default();
    if !allowed.is_empty() {
        allowed.push(",");
    }
    allowed.push(address.to_string());
    std::env::set_var("RYU_AGENT_EGRESS_ALLOW_HOSTS", allowed);
    restore
}

/// Make `ghost`'s manifest declaration RESOLVABLE for the life of the guard.
///
/// `register_manifest_mcp_servers` now skips a declaration whose command is not
/// installed, and the `ghost` binary is fetched only by Ghost's own downloader
/// (whose `archive_url()` has no default), so on a dev box and in CI it is
/// genuinely absent — the real registration is correctly skipped there. The tests
/// below are about the REGISTRY (ownership, `contains_server`, `command_env`
/// lowering), not about whether Ghost shipped, so they point `RYU_GHOST_BIN` — the
/// same `command_env` the manifest declares, and the same one `main.rs` seeds — at
/// a file that exists.
///
/// Holds the shared Core environment guard and restores the previous value in `Drop`, so a panicking
/// assertion cannot leak `RYU_GHOST_BIN` into a sibling test. `std::sync::Mutex` is
/// NOT reentrant, so do **not** construct this while already holding
/// [`lock_mcp_env`] — that self-deadlocks. Take one or the other, never both. (The
/// associated [`GhostBinPresent::manifest`] takes no lock and is safe either way,
/// which is why the skip test can call it under its own guard.)
pub(super) struct GhostBinPresent {
    path: std::path::PathBuf,
    previous: Option<String>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl GhostBinPresent {
    pub(super) fn new() -> Self {
        let lock = lock_mcp_env();
        let ext = if cfg!(windows) { ".exe" } else { "" };
        let path =
            std::env::temp_dir().join(format!("ryu-test-ghost-{}{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"#!/bin/sh\n").expect("write the stand-in ghost binary");
        let previous = std::env::var("RYU_GHOST_BIN").ok();
        std::env::set_var("RYU_GHOST_BIN", &path);
        Self {
            path,
            previous,
            _lock: lock,
        }
    }

    /// The absolute path `RYU_GHOST_BIN` points at — what the lowered
    /// `McpServerConfig.command` must equal.
    pub(super) fn program(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    /// The real `ghost` built-in manifest.
    pub(super) fn manifest() -> PluginManifest {
        crate::plugin_manifest::PluginManifestLoader::load_builtins()
            .into_iter()
            .find(|m| m.id == "@ryu/ghost")
            .expect("ghost built-in manifest present")
    }
}

impl Drop for GhostBinPresent {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(prev) => std::env::set_var("RYU_GHOST_BIN", prev),
            None => std::env::remove_var("RYU_GHOST_BIN"),
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

// ── capability adapter bridge: what sandboxed JS may reach ─────────────────
//
// The adapter seam's whole safety argument is that an adapter's authority is a
// SUBSET of the declarative path it replaces: the manifest fixes which tools
// are reachable, before the sandbox starts. These cover that decision directly
// (no sandbox run, no live registry needed).

/// A real file at [`managed_bin_path`] for a uniquely-named bare command, removed on
/// `Drop`.
///
/// It writes into the process's ACTUAL data dir (`~/.ryu/bin`, or the profile/`RYU_DIR`
/// variant) rather than redirecting the dir at a temp path, because `paths::ryu_dir()`
/// is a `OnceLock` resolved on first use: setting `RYU_DIR` from a test would take
/// effect or not depending on which sibling test called it first, in a suite that runs
/// in parallel. A uuid-suffixed name cannot collide with a real installed binary, and
/// the file is never spawned — every assertion here is `is_file()`.
pub(super) struct ManagedBin {
    pub(super) command: String,
    pub(super) path: std::path::PathBuf,
}

impl ManagedBin {
    pub(super) fn install() -> Self {
        let command = format!("ryu-test-managed-{}", uuid::Uuid::new_v4());
        let path = crate::sidecar::manifest_sidecar::managed_bin_path(&command);
        std::fs::create_dir_all(path.parent().expect("bin dir has a parent"))
            .expect("create the managed bin dir");
        std::fs::write(&path, b"").expect("write the managed bin");
        Self { command, path }
    }
}

impl Drop for ManagedBin {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(super) fn derived_route(id: &str, plugin_id: &str) -> crate::ext_api::ExtApiRoute {
    crate::ext_api::ExtApiRoute {
        id: id.to_owned(),
        plugin_id: plugin_id.to_owned(),
        method: "GET".to_owned(),
        url: format!("core:/api/ext/{plugin_id}/records"),
        name: "List records".to_owned(),
        description: None,
        header_params: Vec::new(),
        input_schema: serde_json::json!({ "type": "object", "properties": {} }),
    }
}

pub(super) fn sample_tool() -> RegistryTool {
    RegistryTool::candidate("fs.read_file", "fs", "read_file")
}

/// Register a manifest's `mcp_servers` the way the enable path does: the real
/// tier for the manifest's id, plus the grants the plugin's RECORD would carry.
/// Every existing registration test goes through this, so the gate is exercised
/// rather than bypassed.
pub(super) fn register_as_enabled(
    reg: &McpRegistry,
    manifest: &PluginManifest,
    approved_grants: &[&str],
) -> Vec<String> {
    let approved: Vec<String> = approved_grants.iter().map(|g| (*g).to_owned()).collect();
    register_manifest_mcp_servers(
        reg,
        manifest,
        crate::plugins::builtins::tier_for_manifest(manifest),
        &approved,
    )
}

/// A command that is guaranteed to resolve on every host these tests run on, so
/// the registration tests exercise the tier/ownership gates rather than
/// [`mcp_command_is_present`].
///
/// It has to be *something* real: registration now skips a declaration whose
/// command cannot be found, so a literal `npx` (or `/bin/sh`) would make these
/// tests pass or fail on whether the runner happens to be installed — and a
/// refusal test would then pass for the wrong reason. The test binary itself is
/// the one path that always exists and is never spawned by any of this.
pub(super) fn present_command() -> String {
    std::env::current_exe()
        .expect("a test binary always has a path")
        .to_string_lossy()
        .into_owned()
}

/// A manifest that declares one stdio MCP server under `mcp_servers`.
pub(super) fn manifest_with_mcp_server(id: &str, server: &str) -> PluginManifest {
    let mut mcp_servers = BTreeMap::new();
    mcp_servers.insert(
        server.to_owned(),
        crate::plugin_manifest::McpServerDecl {
            command: Some(present_command()),
            command_env: None,
            args: vec!["-y".to_owned(), "some-mcp".to_owned()],
            env: BTreeMap::new(),
            description: Some("a plugin-declared server".to_owned()),
            enabled: true,
            ..Default::default()
        },
    );
    PluginManifest {
        id: id.to_owned(),
        name: "Test".to_owned(),
        version: "1.0.0".to_owned(),
        mcp_servers,
        ..Default::default()
    }
}

/// Small helper to generate a unique ID for test directories without pulling
/// in uuid directly (the uuid crate is already a dev/build dep of Core).
pub(super) fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}")
}

// ── App-registered tool dispatch (tool-as-Runnable, M3) ────────────────────

/// Build a registry wired with a single enabled plugin whose manifest carries
/// the given tool runnables + grants — the same `with_self_build` seam prod
/// uses (`main.rs`), so dispatch can resolve each tool's backend live.
pub(super) async fn registry_with_plugin(
    plugin_id: &str,
    grants: Vec<&str>,
    runnables: Vec<PmRunnableEntry>,
) -> McpRegistry {
    let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(plugin_id, "1.0.0").await.unwrap();
    let approved: Vec<String> = grants.iter().map(|s| s.to_string()).collect();
    store.set_enabled(plugin_id, &approved).await.unwrap();

    let manifest = PluginManifest {
        id: plugin_id.to_owned(),
        name: "Test Plugin".to_owned(),
        version: "1.0.0".to_owned(),
        runnables,
        permission_grants: approved,
        companion: None,
        ..Default::default()
    };
    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![manifest]));
    McpRegistry::empty().with_self_build(manifests, store)
}

pub(super) fn tool_entry(id: &str, cfg: serde_json::Value) -> PmRunnableEntry {
    PmRunnableEntry {
        id: id.to_owned(),
        name: id.to_owned(),
        kind: RunnableKind::Tool,
        config: Some(cfg),
    }
}

impl McpRegistry {
    /// Test-only helper mirroring `tools_for_agent`'s allow decision without I/O.
    #[cfg(test)]
    pub(super) fn tools_for_agent_matches(
        tool: &RegistryTool,
        allowlist: Option<&[String]>,
    ) -> bool {
        match allowlist {
            None => true,
            Some(list) => tool_allowed(tool, list),
        }
    }

    /// Test-only: seed a widget-bearing tool (`<server>.<tool>`) plus its widget
    /// HTML resource directly into the registry, with no subprocess and no
    /// `_meta` round-trip.
    ///
    /// Why this exists: the promotion tests need a tool that ALREADY resolves to
    /// a [`WidgetBinding`], because [`Self::resolve_widget_promotion`] answers
    /// `WidgetPromotion::None` before it ever consults the manifest gate when the
    /// tool renders no widget. They used to get that from the in-process
    /// `sidecar::mcp::apps` provider (`checklist.render` and seven siblings),
    /// which was deleted in 1af518d8 when the inline-chat widget-apps were
    /// retired in favour of `ui.render`. Core now has ZERO in-process widget
    /// producers — the only live producer is an external MCP server whose
    /// `tools/list` `_meta` declares `ryu/outputTemplate` — so a fixture is the
    /// only way to keep exercising the grant gate without spawning one.
    ///
    /// The naive alternative — registering through
    /// [`Self::register_app_tool_tagged`] — does NOT work: it pins `server` to
    /// [`APP_TOOL_SERVER`] and drops the widget fields, so `split_tool_id` would
    /// yield the `app` namespace and never line up with the `resource_cache` key
    /// `build_widget_event` reads. Seeding both maps keeps the server namespace
    /// honest, exactly as `tools_for_server` would have populated them from a
    /// live server's `_meta`.
    #[cfg(test)]
    pub(crate) fn seed_widget_tool_for_test(&self, server: &str, tool: &str, template_uri: &str) {
        let id = Self::tool_id(server, tool);
        let binding = WidgetBinding {
            template_uri: template_uri.to_owned(),
            widget_accessible: false,
            invoking_label: None,
            invoked_label: None,
        };
        let registry_tool = RegistryTool {
            widget: Some(binding),
            output_template: Some(template_uri.to_owned()),
            ..RegistryTool::candidate(&id, server, tool)
        };
        // `app_tools` is the one tool source `list_all_tools` reads without any
        // I/O, so the binding resolves synchronously in tests.
        if let Ok(mut tools) = self.app_tools.lock() {
            tools.retain(|t| t.id != id);
            tools.push(registry_tool);
        }
        // `widget_resource` short-circuits on a cache hit, so pre-seeding the
        // HTML keeps `build_widget_event` off the `client::read_resource`
        // subprocess path (there is no server registered under `server`).
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.entry(server.to_owned()).or_default().insert(
                template_uri.to_owned(),
                CachedMcpValue {
                    value: WidgetResource {
                        uri: template_uri.to_owned(),
                        mime_type: "text/html+skybridge".to_owned(),
                        html: "<!doctype html><div id=\"root\"></div>".to_owned(),
                        meta: None,
                    },
                    expires_at: None,
                },
            );
        }
    }
}
