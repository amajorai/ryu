//! MCP server registry (U13).
//!
//! Core holds the MCP transport client (`client.rs`); this module is the
//! *registry* on top of it. MCP servers are declared once in config, registered
//! at startup, and every agent can reach the registered tools through the tool
//! loop — "install once, every agent can use." The scoped/org-hierarchy version
//! of this registry lives in the control plane (U30); this is the flat,
//! config-driven Core slice.
//!
//! Config-vs-policy placement (CLAUDE.md §1): deciding *what tools run* is Core,
//! so the registry and its call path live here. Deciding *what is allowed* per
//! org/team is Gateway/control-plane — out of scope (U30). The one allowlist we
//! honor here is the per-agent `tools` list, which is part of "what runs."

pub mod agent_inbox_alias;
pub mod agent_inbox_tool;
#[cfg(test)]
mod agent_react_registry_runtime_test;
mod agent_tools;
pub(crate) mod app_tool_namespace;
pub(crate) mod app_visibility;
pub mod artifact_tool;
pub(crate) mod box_desktop;
pub(crate) mod builtin_servers;
mod capability_bridge;
pub mod capability_tools;
pub mod catalog;
pub mod challenges_tool;
pub mod channel_tool;
pub mod client;
pub mod cloud;
mod command_resolve;
pub mod composio;
pub(crate) mod composio_treg_route;
mod config_store;
pub mod consent_tool;
pub mod delegate;
pub mod device_tool;
mod discovery;
mod discovery_backoff;
mod dispatch;
mod dispatch_support;
pub mod forms;
#[cfg(test)]
mod honcho_registry_runtime_test;
pub(crate) mod http_headers;
mod manifest_servers;
pub mod marketplace_tool;
pub mod notify_tool;
mod oauth_dispatch;
pub mod orchestrator;
mod owner_host_env;
mod principal;
pub(crate) mod provider_target_guard;
mod registry;
mod registry_types;
pub mod routines_tool;
pub mod sandbox;
pub mod search_conversations;
mod secret_refs;
mod server_config;
pub mod skills_tool;
pub mod spaces_tool;
pub mod suggestions;
pub mod tasks_tool;
pub mod threads;
mod tool_hooks;
mod tool_ids;
pub mod treg_tool;
pub mod ui_extensions;
pub mod ui_tool;
pub mod usage_tool;
pub mod web_fetch;
pub mod web_search_access;
mod widget_types;
pub mod working_memory_tool;
pub mod workspace_tool;

mod authenticated_scope;
pub(crate) use authenticated_scope::with_verified_tool_caller;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock, RwLock,
};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex as TokioMutex, RwLock as TokioRwLock};

tokio::task_local! {
    static CAPABILITY_PROVIDER_DISPATCH: bool;
    /// Set only around the HTTP `call_mcp_tool` handler's own dispatch of a
    /// `composio.*` tool: that handler strips the billing receipt and records
    /// the charge itself, so the Composio arm must not charge it again.
    static CALLER_RECORDS_COMPOSIO_CHARGE: bool;
}

/// Run `fut` as a caller that strips the Composio billing receipt from the
/// result and records the tool charge itself. Every other dispatch of a
/// Composio action (ACP bridge, approval replay, workflows, aliases) is
/// charged by the Composio arm. The marker is task-local, so it never reaches
/// spawned work such as a later approval replay.
pub(crate) async fn with_caller_recorded_composio_charge<F: std::future::Future>(
    fut: F,
) -> F::Output {
    CALLER_RECORDS_COMPOSIO_CHARGE.scope(true, fut).await
}

/// The control-plane grant slug for a `composio.<ACTION>` tool id. Composio
/// grants are keyed by lowercase toolkit (`github`), while tool ids name the
/// action (`composio.GITHUB_CREATE_ISSUE`), so the action maps to its toolkit
/// the same way the Composio dispatch arm resolves connections. An action with
/// no derivable toolkit yields an empty slug, which no grant matches, so it
/// fails closed wherever grants are enforced. `None` for non-Composio ids.
fn composio_grant_slug(tool_id: &str) -> Option<String> {
    tool_id.strip_prefix("composio.")?;
    Some(crate::connection_policy::composio_toolkit_for_action(tool_id).unwrap_or_default())
}

/// Refusal for a direct call to a selected-only provider tool (Ryu Cloud Search).
const SELECTED_ONLY_TOOL_REFUSAL: &str = "this provider tool is reachable only through its layer tool (web.search) after Ryu Cloud Search is selected as the web search provider";

use client::{McpHttpEndpoint, McpStdioCommand, McpTarget};

use crate::plugin_manifest::PluginManifest;
use crate::server::conversations::{ConversationStore, Tenancy};

pub use agent_tools::*;
pub(crate) use capability_bridge::*;
pub(crate) use command_resolve::*;
pub use config_store::*;
use discovery_backoff::*;
pub(crate) use dispatch_support::*;
pub use manifest_servers::*;
use oauth_dispatch::*;
pub use principal::*;
pub use registry_types::*;
use secret_refs::*;
pub use server_config::*;
pub(crate) use tool_hooks::*;
pub use tool_ids::*;
pub use widget_types::*;

/// Process-global MCP registry, published once at startup.
///
/// The workflow executor ([`crate::workflow::executor`]) is a free function with
/// no `ServerState`, so the `Tool` node reads the registry from here to invoke
/// tools (e.g. `spider.crawl`) for real instead of echoing.
static GLOBAL_REGISTRY: OnceLock<Arc<McpRegistry>> = OnceLock::new();

/// Publish the global registry. Idempotent: a second call is ignored.
pub fn set_global_registry(registry: Arc<McpRegistry>) {
    let _ = GLOBAL_REGISTRY.set(registry);
}

/// The global registry, if it has been published.
pub fn global_registry() -> Option<Arc<McpRegistry>> {
    GLOBAL_REGISTRY.get().cloned()
}

#[cfg(test)]
mod verified_caller_secret_tests;

/// How long a tool call waits for an app's lazy sidecar to come up before it
/// answers "still starting, retry shortly" (the ext-proxy's warm-up budget).
const SIDECAR_WAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// What a manifest app's stdio MCP server needs woken before a tool call.
///
/// Such a server holds no key and forwards each call to its app's own sidecar,
/// which is `lazy` / idle-stopped. Core wakes a lazy sidecar only on an
/// ext-proxy hit, so without this an agent or routine calling the app's tool
/// after the app went idle would get the keyless process's "open the app"
/// refusal, and nothing a headless caller can do starts the sidecar.
#[derive(Default)]
struct SidecarWake {
    /// Set at boot, after the sidecar manager exists. `None` in tests and CLI
    /// contexts, where there is nothing to wake.
    manager: Option<std::sync::Arc<crate::sidecar::manager::SidecarManager>>,
    /// Owning plugin id -> its lazy or idle-stopped sidecars (namespaced names).
    sidecars: BTreeMap<String, Vec<String>>,
}

pub struct McpRegistry {
    /// The live server map. Use `RwLock` so concurrent readers (tool listing,
    /// chat tool loop) are not blocked by the rare write (registry reload after
    /// a POST /api/mcp/servers).
    servers: RwLock<BTreeMap<String, McpServerConfig>>,
    /// MCP servers registered by ENABLED plugins from their manifest
    /// `mcp_servers` block (the manifest-owned successor to hardcoded built-in
    /// servers). Tracked separately from `servers` so a `reload()` — which
    /// rebuilds `servers` from built-ins + `mcp.json` — re-overlays them instead
    /// of dropping them within a session. Precedence when merged into `servers`:
    /// built-in < plugin < user `mcp.json` (a user entry with the same name still
    /// wins). Written only by `register_server`/`deregister_server`.
    ///
    /// The value carries the **owning plugin id** alongside the config. The name
    /// namespace is otherwise unowned — unlike the plugin-id namespace, which the
    /// manifest loader protects with first-occurrence-wins dedup — so without an
    /// owner any plugin could overwrite (`ghost` → its own command, inheriting
    /// ghost's tool descriptions and the user's trust) or, on uninstall, delete
    /// another plugin's registration.
    plugin_servers: RwLock<BTreeMap<String, (String, McpServerConfig)>>,
    /// Shared lifecycle coordinator, installed before plugin activation.
    plugin_runtime: RwLock<Option<crate::plugins::runtime::PluginRuntime>>,
    /// Lazy sidecars to wake before a tool call on a manifest app's stdio server
    /// (see [`SidecarWake`]).
    sidecar_wake: RwLock<SidecarWake>,
    /// Cache of `tools/list` results, keyed by server name. Public modern results
    /// expire at `ttlMs`; private/zero-TTL responses are never shared. Legacy
    /// responses without cache hints keep the prior process-local cache behavior.
    /// Populated lazily so startup never blocks on spawning every MCP server.
    tool_cache: Mutex<BTreeMap<String, CachedMcpValue<Vec<RegistryTool>>>>,
    /// Servers skipped by discovery for a while after timing out. Cleared with
    /// `tool_cache` whenever the server map is rebuilt.
    discovery_backoff: DiscoveryBackoff,
    /// Cache of prewarmed widget HTML resources, keyed `server → uri`. Remote
    /// resources honor `cacheScope`/`ttlMs`; in-process app resources are cleared
    /// with their owning tool. Never held across an `.await`.
    resource_cache: Mutex<HashMap<String, HashMap<String, CachedMcpValue<WidgetResource>>>>,
    /// Cached capability-verb resolutions, tagged with the
    /// `capability_tools::generation()` they were computed at. Invalidated by
    /// generation bump rather than by clearing, so a concurrent reader never sees a
    /// half-built map. `Mutex` because writes are rare and never held across `.await`.
    capability_cache: Mutex<Option<(u64, Vec<capability_tools::ResolvedVerb>)>>,
    /// The MCP servers whose tools drive this node's display
    /// (`box_desktop::node_display_servers`), cached like `capability_cache`.
    node_display_cache: Mutex<Option<(u64, std::collections::BTreeSet<String>)>>,
    /// In-memory tools registered by enabled apps (tool-as-Runnable, M3).
    /// These are always returned alongside server-provided tools; no spawning
    /// required. Protected by a `Mutex` because writes are rare.
    app_tools: Mutex<Vec<RegistryTool>>,
    /// Derived-from-OpenAPI routes ([`crate::ext_api`]), keyed by **sidecar**
    /// ([`crate::sidecar::manifest_sidecar::namespaced_name`], i.e.
    /// `<plugin_id>/<spec.name>`). Populated on the sidecar Healthy edge, cleared on
    /// deactivate/update.
    ///
    /// **Deliberately not the `self_api` shape.** `self_api` keeps its routes in a
    /// process-lifetime `OnceLock` free function, which is right there: they are
    /// lowered from a compile-time OpenAPI document that cannot change while the
    /// process runs. These routes come from a *live sidecar* that starts, stops,
    /// gets upgraded and gets uninstalled, so the same structure here would be a
    /// stale-forever cache — a tool row still advertised for an app the user
    /// removed, dispatching into a proxy that now 404s. Hence a `Mutex`ed map with
    /// an explicit clear, modelled on `app_tools` above.
    ///
    /// Keyed at all (not flattened into one `Vec`) precisely so
    /// [`Self::clear_ext_api_routes`] can be an ownership-scoped removal rather
    /// than `app_tools`' unowned `retain(|t| t.id != id)` — see
    /// [`Self::set_ext_api_routes_for_sidecar`] for why that difference is not
    /// cosmetic, and [`ext_api_key_owned_by`] for the plugin⇄sidecar keying
    /// invariant that lets a plugin-scoped clear still reach every one of its
    /// sidecars.
    ///
    /// Never held across an `.await`.
    ext_api: Mutex<BTreeMap<String, Vec<crate::ext_api::ExtApiRoute>>>,
    /// HTTP client for built-in HTTP-backed providers (e.g. Shadow, U15).
    /// Stdio MCP servers don't use it; it's cheap to hold either way.
    http: reqwest::Client,
    /// Hot manifest store for the self-build provider (U57). When set, the
    /// `ryu_self_build` built-in tools can write new manifests and hot-install
    /// them without a process restart. `None` when the registry is used in
    /// contexts that don't need self-build (tests, CLI, bare registry).
    pub self_build_manifests: Option<std::sync::Arc<TokioRwLock<Vec<PluginManifest>>>>,
    /// App store for the self-build `install_app` tool. Mirrors the lifecycle
    /// store wired in `ServerState`. `None` in contexts that don't need it.
    pub self_build_app_store: Option<std::sync::Arc<crate::plugins::PluginStore>>,
    /// Agent config store, wired so the `agent_builder` built-in tools can edit
    /// agent records in chat (the desktop agent-edit page's builder). Cheap to
    /// clone (`Arc` inside). `None` in test/CLI contexts that don't wire it.
    pub agent_store: Option<crate::agents::AgentStore>,
    /// Conversation store, wired so the `search_conversations` built-in tool can
    /// run semantic search over past chat messages. Cheap to clone (`Arc` inside).
    /// `None` in test/CLI contexts that don't wire it (the tool then reports the
    /// index unavailable rather than failing the call).
    pub conversations: Option<crate::server::conversations::ConversationStore>,
    /// Skill registry, wired so the `skills` built-in tools (`skills.search` /
    /// `skills.load`) can discover + load Agent Skills on demand (progressive
    /// disclosure). Cheap to clone (`Arc` inside). `None` in test/CLI contexts
    /// that don't wire it (the tools then report skills unavailable).
    pub skills: Option<ryu_skills::SkillRegistry>,
    /// Preferences store, wired at boot. Cheap to clone (`Arc` inside). The
    /// registry reads per-layer defaults and the node's web search access mode.
    pub preferences: Option<crate::server::preferences::PreferencesStore>,
    /// Core-as-consumer capability helper, wired so the
    /// `agent_builder.create_agent_team` tool can persist a team through the
    /// `teams.create` capability after minting its members, and the
    /// `dashboard_builder` tools can author through the `dashboards.*` capabilities.
    /// Cheap to clone. `None` in test/CLI contexts; those tools then report the
    /// consumer unavailable rather than partially applying a change.
    pub capabilities: Option<crate::sidecar::capability_consumer::CapabilityConsumer>,
    /// Spaces store, wired so the built-in `artifact.create` tool can save a
    /// generated file into a Space (default: the Artifacts system space) and the
    /// ACP auto-file hook can persist assistant-message media. Cheap to clone
    /// (`Arc` inside). `None` in test/CLI contexts; the tool then reports itself
    /// unavailable rather than dropping the artifact.
    pub spaces: Option<crate::server::spaces::SpaceStore>,
    /// Memory store, wired so the built-in `working_memory.update_working_memory`
    /// tool can write the calling agent's scratchpad. `None` in test/CLI contexts;
    /// the tool then reports itself unavailable.
    pub memory: Option<crate::server::memory::MemoryStore>,
}

impl Default for McpRegistry {
    fn default() -> Self {
        Self::empty()
    }
}

/// Name under which the built-in self-build MCP server (U57) is registered.
pub use crate::runnable::self_build::SERVER_NAME as SELF_BUILD_SERVER;

#[cfg(test)]
mod tests;
