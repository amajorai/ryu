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

pub mod advisor;
pub mod apps;
pub mod catalog;
pub mod channel_tool;
pub mod client;
pub mod composio;
pub mod delegate;
pub mod exa;
pub mod artifact_tool;
pub mod notify_tool;
pub mod orchestrator;
pub mod research;
pub mod rtk;
pub mod sandbox;
pub mod search_conversations;
pub mod shadow;
pub mod skills_tool;
pub mod spider;
pub mod threads;
pub mod ui_tool;
pub mod web_fetch;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock as TokioRwLock;

use client::{McpStdioCommand, McpTool};

use crate::plugin_manifest::PluginManifest;
use crate::server::conversations::{ConversationStore, Tenancy};

/// The **server-derived principal an in-process agent tool call runs on behalf of**
/// — the thing that makes the conversation ACL bite on the agent plane.
///
/// An agent turn has no HTTP request and therefore no `VerifiedCaller`, which is why
/// the `threads` / `search_conversations` tools were completely ungated: on an
/// org-bound node Bob could tell his agent "search my past conversations" and it
/// would print Alice's chats into Bob's thread, defeating the HTTP gate in one hop.
///
/// But an agent turn ALWAYS runs on behalf of some **host conversation**, and that
/// conversation now carries an owner (see the [`Tenancy`] choke point). That owner is
/// the tool call's principal. **An agent must never be able to read what its
/// principal cannot read.**
///
/// Deliberately DISTINCT from the `user_id: Option<&str>` argument that already flows
/// through [`McpRegistry::call_tool_with_identity`]. That one is fed from
/// `body.user_id` on the HTTP tool-exec callback (`call_mcp_tool`) — **client-supplied
/// and therefore spoofable**. It is fine for Composio entity selection and audit (its
/// actual purpose); it must never become an authorization principal, which is why this
/// is a separate, server-derived type that cannot be confused with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPrincipal {
    /// Node UNBOUND (personal): no tenancy enforcement. There is exactly one
    /// principal and `RYU_TOKEN` is the boundary — byte-identical to the pre-gate
    /// behaviour, mirroring `enforce_permission`'s unbound rule.
    Unrestricted,
    /// Node ORG-BOUND, principal resolved from the host conversation's owner.
    Owned {
        user_id: String,
        org_id: Option<String>,
    },
    /// Node ORG-BOUND but no principal resolves (no host conversation — an ephemeral
    /// un-pooled ACP instance, a workflow/monitor/quest system call, the
    /// openai-compat tool-exec callback — or a host conversation that is itself
    /// untenanted). **FAIL CLOSED**: never fall back to "see everything".
    Unresolved,
}

impl ToolPrincipal {
    /// Resolve the principal for one tool call, **fresh at dispatch time** — never
    /// cached when the MCP bridge is built (the bridge is built once per ACP
    /// instance and reused across turns, so a cached caller would go stale, and a
    /// tenancy claim landing after the build would be missed).
    pub async fn resolve(store: &ConversationStore, host_conversation_id: Option<&str>) -> Self {
        Self::resolve_at(
            store,
            host_conversation_id,
            crate::sidecar::control_plane::registered_org()
                .map(|o| o.id)
                .as_deref(),
        )
        .await
    }

    /// [`Self::resolve`] with THIS node's org binding passed in — the pure form the
    /// unit tests drive (they cannot register an org). Mirrors
    /// `server::require_resource_read_at`.
    pub async fn resolve_at(
        store: &ConversationStore,
        host_conversation_id: Option<&str>,
        node_org: Option<&str>,
    ) -> Self {
        if node_org.is_none() {
            return Self::Unrestricted;
        }
        let Some(cid) = host_conversation_id.filter(|s| !s.is_empty()) else {
            return Self::Unresolved;
        };
        match store.get_access_meta(cid).await {
            Ok(Some(meta)) => match meta.owner_user_id {
                Some(user_id) => Self::Owned {
                    user_id,
                    org_id: meta.org_id,
                },
                None => Self::Unresolved,
            },
            _ => Self::Unresolved,
        }
    }

    /// The `(user_id, org_id, node_bound)` triple
    /// [`ConversationStore::visible_conversation_ids`] takes — i.e. the SAME
    /// `TENANCY_VISIBLE_PREDICATE` the HTTP plane filters with, so the two planes can
    /// never drift apart. `Unresolved` yields `(None, None, true)`: bound node,
    /// anonymous ⇒ the predicate matches nothing.
    pub fn filter_args(&self) -> (Option<&str>, Option<&str>, bool) {
        match self {
            Self::Unrestricted => (None, None, false),
            Self::Owned { user_id, org_id } => (Some(user_id.as_str()), org_id.as_deref(), true),
            Self::Unresolved => (None, None, true),
        }
    }

    /// Bound node with no resolvable principal ⇒ the tool must refuse.
    pub fn is_unresolved(&self) -> bool {
        matches!(self, Self::Unresolved)
    }

    /// The [`Tenancy`] a conversation CREATED by this tool call is born with. This is
    /// the coupling that stops a coordinator locking itself out of the worker threads
    /// its own agent created (`create_thread` / `fork_thread`).
    pub fn tenancy(&self) -> Tenancy {
        match self {
            Self::Owned { user_id, org_id } => Tenancy::Owned {
                user_id: user_id.clone(),
                org_id: org_id.clone(),
            },
            Self::Unrestricted | Self::Unresolved => Tenancy::Unattributed,
        }
    }

    /// Whether this principal OWNS `conversation_id` — the WRITE gate for the mutating
    /// thread tools. Deliberately **strict owner-match**, not `can_access`: an
    /// org-visible thread must NOT be writable by a colleague's agent. Fail-closed
    /// beats a role model the store cannot see.
    pub async fn owns(&self, store: &ConversationStore, conversation_id: &str) -> bool {
        match self {
            Self::Unrestricted => true,
            Self::Unresolved => false,
            Self::Owned { user_id, .. } => matches!(
                store.get_access_meta(conversation_id).await,
                Ok(Some(meta)) if meta.owner_user_id.as_deref() == Some(user_id.as_str())
            ),
        }
    }
}

tokio::task_local! {
    /// Set while a tool-use hook runs, so a hook that itself triggers a tool call
    /// (via `host.runAgent`) in the SAME task does not re-enter the tool-hook
    /// phase. Note: task-locals do not propagate to spawned sub-agent tasks, so a
    /// delegated sub-agent's tool calls ARE still governed (by design); runaway
    /// recursion is bounded by the delegation wall-time/depth caps.
    static IN_TOOL_HOOK: ();
}

fn in_tool_hook() -> bool {
    IN_TOOL_HOOK.try_with(|()| ()).is_ok()
}

/// How long a `pre_tool_use` hook may run before the call is allowed through
/// anyway. Fail-open: a stuck or slow hook must never wedge tool dispatch.
const PRE_TOOL_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Run `pre_tool_use` hooks for a tool call. Returns `Some(reason)` if a hook
/// blocked it (Claude's PreToolUse deny), else `None`. Fail-open on every error /
/// timeout / absent-Deno path (returns `None` = allow). Reentrancy-guarded.
async fn run_pre_tool_hooks(
    tool_id: &str,
    arguments: &Value,
    session_id: Option<&str>,
) -> Option<String> {
    if in_tool_hook() {
        return None;
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: session_id.map(str::to_string),
        tool_name: Some(tool_id.to_string()),
        tool_input: Some(arguments.clone()),
        ..Default::default()
    };
    let fut = IN_TOOL_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_PRE_TOOL_USE, ctx),
    );
    let directives = match tokio::time::timeout(PRE_TOOL_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!("plugin_host: pre_tool_use hook timed out for '{tool_id}'; allowing");
            return None;
        }
    };
    directives.into_iter().find_map(|d| match d {
        crate::plugin_host::HookDirective::Deny { reason } => Some(reason),
        _ => None,
    })
}

/// Fire `post_tool_use` hooks (Claude's PostToolUse) DETACHED — observation-only,
/// so it never adds latency or blocks the caller, and cannot fail the tool call.
/// Directives are ignored in v1.
fn fire_post_tool_hooks(tool_id: String, arguments: Value, output: Value) {
    if in_tool_hook() {
        return;
    }
    tokio::spawn(async move {
        let ctx = crate::plugin_host::HookContext {
            tool_name: Some(tool_id),
            tool_input: Some(arguments),
            tool_output: Some(output),
            ..Default::default()
        };
        let _ = IN_TOOL_HOOK
            .scope(
                (),
                crate::plugin_host::dispatch_global(crate::plugin_host::ON_POST_TOOL_USE, ctx),
            )
            .await;
    });
}

/// Process-global MCP registry, published once at startup.
///
/// The workflow executor ([`crate::workflow::executor`]) is a free function with
/// no `ServerState`, so the `Tool` node reads the registry from here to invoke
/// tools (e.g. `spider__crawl`) for real instead of echoing.
static GLOBAL_REGISTRY: OnceLock<Arc<McpRegistry>> = OnceLock::new();

/// Publish the global registry. Idempotent: a second call is ignored.
pub fn set_global_registry(registry: Arc<McpRegistry>) {
    let _ = GLOBAL_REGISTRY.set(registry);
}

/// The global registry, if it has been published.
pub fn global_registry() -> Option<Arc<McpRegistry>> {
    GLOBAL_REGISTRY.get().cloned()
}

/// A single MCP server as declared in config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Executable to spawn (e.g. `npx`, an absolute path, or a `~/.ryu/bin` name).
    pub command: String,
    /// Arguments passed to the command.
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables for the server process.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Optional human description for the listing endpoint.
    #[serde(default)]
    pub description: Option<String>,
    /// When false, the server is registered but skipped by list/call. Defaults
    /// to true so a bare `{ command, args }` entry just works.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Registry version recorded at install (the catalog `ServerJson.version`),
    /// compared against the current catalog version to detect updates. `None`
    /// for servers pasted manually or installed before this was captured — those
    /// simply can't report an available update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The catalog id this server was installed from (the registry server name),
    /// used to look up its current version. `None` for manually-added servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
}

/// The installed MCP servers as recorded in `~/.ryu/mcp.json` (the `mcpServers`
/// map). Best-effort: an unreadable/malformed file yields an empty map. Used by
/// the update check to compare each server's recorded `version` against the
/// catalog's current version.
pub fn installed_configs() -> BTreeMap<String, McpServerConfig> {
    let path = McpRegistry::config_path();
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<McpConfigFile>(&raw).ok())
        .map(|f| f.mcp_servers)
        .unwrap_or_default()
}

const fn default_true() -> bool {
    true
}

impl McpServerConfig {
    fn to_command(&self) -> McpStdioCommand {
        McpStdioCommand {
            command: self.command.clone(),
            args: self.args.clone(),
            env: self
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }
}

/// On-disk config shape. Matches the de-facto `mcpServers` map used by Claude
/// Desktop, Cursor, and friends, so users can paste an existing config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct McpConfigFile {
    #[serde(
        default,
        rename = "mcpServers",
        alias = "servers",
        alias = "mcp_servers"
    )]
    mcp_servers: BTreeMap<String, McpServerConfig>,
}

/// A tool exposed through the registry, tagged with its owning server.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RegistryTool {
    /// Fully-qualified id: `<server>__<tool>` — unique across servers.
    pub id: String,
    /// The server this tool belongs to.
    pub server: String,
    /// The tool's name as the MCP server reports it.
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
    /// `outputSchema`, verbatim (JSON Schema for `structuredContent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    /// `annotations`, verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    /// `_meta`, verbatim — carries the widget keys (`ryu/*` primary + `openai/*`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// Resolved widget binding when this tool declares an `outputTemplate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget: Option<WidgetBinding>,
    /// Flat mirror of `widget.widget_accessible` so `catalog.rs` and the
    /// provenance gate read it without re-parsing `meta`.
    #[serde(default)]
    pub widget_accessible: bool,
    /// Flat mirror of `widget.template_uri` (the `ui://widget/<slug>.html` uri).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_template: Option<String>,
}

impl RegistryTool {
    /// A bare tool descriptor used for allowlist checks and app-tool aliasing.
    /// New widget/metadata fields default to empty — call sites that need them
    /// (`tools_for_server`, the in-process apps provider) set them explicitly.
    pub fn candidate(id: &str, server: &str, name: &str) -> Self {
        Self {
            id: id.to_owned(),
            server: server.to_owned(),
            name: name.to_owned(),
            description: None,
            input_schema: None,
            output_schema: None,
            annotations: None,
            meta: None,
            widget: None,
            widget_accessible: false,
            output_template: None,
        }
    }
}

/// A widget binding resolved from a tool's `_meta` (Apps-SDK output template).
///
/// Present only on tools that declare an `outputTemplate`; carries the flags the
/// stream part and provenance gate need. Read from `ryu/*` keys first, then the
/// `openai/*` aliases (R10).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetBinding {
    /// `ui://widget/<slug>.html` — the resource uri of the widget HTML.
    pub template_uri: String,
    /// Whether the widget may originate `callTool`s (companion write tools).
    pub widget_accessible: bool,
    /// Optional "invoking…" status label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoking_label: Option<String>,
    /// Optional "invoked" (done) status label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoked_label: Option<String>,
}

impl WidgetBinding {
    /// Resolve a binding from a tool's `_meta`. `ryu/*` keys win; `openai/*` are
    /// the fallback aliases. Returns `None` when no `outputTemplate` is present.
    pub fn from_meta(meta: Option<&Value>) -> Option<Self> {
        let meta = meta?;
        let get_str = |ryu: &str, openai: &str| -> Option<String> {
            meta.get(ryu)
                .or_else(|| meta.get(openai))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let template_uri = get_str("ryu/outputTemplate", "openai/outputTemplate")?;
        let widget_accessible = meta
            .get("ryu/widgetAccessible")
            .or_else(|| meta.get("openai/widgetAccessible"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let invocation = meta
            .get("ryu/toolInvocation")
            .or_else(|| meta.get("openai/toolInvocation"));
        let invoking_label = invocation
            .and_then(|v| v.get("invoking"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let invoked_label = invocation
            .and_then(|v| v.get("invoked"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some(Self {
            template_uri,
            widget_accessible,
            invoking_label,
            invoked_label,
        })
    }
}

/// The permission grant a plugin must declare (and be enabled) for a tool it
/// contributes to auto-promote a sandboxed widget into chat.
///
/// This is the explicit consent that closes the implicit-trust gap: before, ANY
/// enabled MCP server whose tool advertised an `outputTemplate` had its widget
/// promoted with no per-app opt-in. Now the owning plugin manifest must hold
/// this grant. Built-in Ryu Apps declare it in their fixtures; a third-party MCP
/// server must have been granted it. Validated the same way as any other grant
/// (it is on the Gateway's grant allowlist), and gated the same way the app-tool
/// backend resolver gates on `permission_grants` for enabled plugins.
pub const WIDGET_RENDER_GRANT: &str = "widget:render";

/// The `category` a synthesized MCP-server plugin record carries (set by
/// `synthesize_mcp_manifest`). It is the SINGLE marker that distinguishes a
/// governance record standing in for an installed MCP server from an ordinary
/// plugin, and it gates security-relevant behaviour in several places:
///
/// - the widget-promotion **fail-CLOSED** join (a recorded-but-undeclared widget
///   tool of an enabled MCP server is denied, not fail-open — see
///   [`McpRegistry::widget_contribution`]);
/// - the `mcp.json` enable/disable/remove sync on the plugin lifecycle
///   (`activate_plugin` / `deactivate_plugin` / the uninstall handler).
///
/// One const, referenced everywhere: a typo in any one site would silently
/// fail-open a widget or strand the spawn toggle, so there is exactly one string.
/// No built-in fixture sets a `category`, so `Some(MCP_SERVER_CATEGORY)` is an
/// unambiguous discriminator for synth MCP records.
pub const MCP_SERVER_CATEGORY: &str = "MCP Server";

/// The outcome of the unified widget-promotion decision.
///
/// DEDUP: the single source of record for *whether* a tool may render a widget
/// is the plugin manifest `contributes.widgets[]` allowlist joined to the live
/// enabled/grant state (see [`McpRegistry::resolve_widget_promotion`]). The
/// binding DETAIL (template uri, labels) is fed in from the `_meta`/in-process
/// apps discovery via [`McpRegistry::widget_binding`] — one decision path, with
/// discovery feeding it, never a parallel promotion path.
pub enum WidgetPromotion {
    /// Promote — carries the resolved binding detail.
    Allow(WidgetBinding),
    /// An enabled plugin declares this widget but lacks the `widget:render`
    /// grant. The tool's result is delivered as text only.
    DeniedNoGrant { plugin_id: String },
    /// A plugin declares this widget but its lifecycle record is disabled.
    DeniedDisabled { plugin_id: String },
    /// An enabled **MCP-server** plugin record owns this tool's server
    /// namespace, but the tool_id is NOT declared in that record's
    /// `contributes.widgets`. A recorded server that never declared/consented to
    /// this specific widget is fail-CLOSED (text only) — closing the
    /// implicit-trust hole where any enabled MCP server whose tool advertised an
    /// `outputTemplate` had its HTML auto-promoted with no per-widget consent.
    DeniedUndeclared { plugin_id: String },
    /// The tool renders no widget at all.
    None,
}

/// The manifest-side state of a tool's widget contribution, resolved from the
/// enabled/grant state of the plugin that declares it in `contributes.widgets`.
enum WidgetContributionState {
    /// An enabled plugin declares this tool_id and holds the `widget:render` grant.
    EnabledGranted,
    /// An enabled plugin declares this tool_id but does NOT hold the grant.
    EnabledUngranted { plugin_id: String },
    /// A plugin declares this tool_id but its record is disabled.
    Disabled { plugin_id: String },
    /// An enabled **synth MCP-server** record (`category == MCP_SERVER_CATEGORY`,
    /// `id == server`) owns this tool's server namespace, but no
    /// `contributes.widgets` entry declares the tool_id. Recorded governance +
    /// undeclared widget ⇒ fail CLOSED (the widget:render gate is meaningful for
    /// the actor it targets — an installed third-party MCP server).
    RecordedUndeclared { plugin_id: String },
    /// No plugin declares this tool_id AND no synth MCP record owns its server.
    /// Either a genuinely record-less legacy external MCP server (fail-open
    /// delegate / back-compat), a manifest present but not yet recorded (protects
    /// built-ins from a missing-record anomaly), or the governance context is not
    /// wired (tests / CLI / bare registry). All fail OPEN.
    Unrecorded,
}

/// A prewarmed widget HTML resource resolved from an MCP server's
/// `resources/read` (or the in-process apps provider), cached per server.
#[derive(Debug, Clone, Serialize)]
pub struct WidgetResource {
    pub uri: String,
    pub mime_type: String,
    pub html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// Public summary of a registered server for the listing endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct ServerSummary {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub description: Option<String>,
    pub enabled: bool,
    /// Whether the server's command is present on disk. For a built-in like
    /// Ghost whose binary is installed on demand, this is `false` until the
    /// sidecar is installed — the UI uses it to show a "not yet available"
    /// state instead of a hard error. `None` when availability can't be
    /// determined cheaply (e.g. a bare command resolved via `PATH`).
    pub available: Option<bool>,
}

/// Name under which the built-in Ghost desktop-automation MCP server (U14) is
/// registered. Ghost is Windows-first; on other OSes the binary may be absent
/// and the registry degrades gracefully (see `builtin_servers`).
pub const GHOST_SERVER: &str = "ghost";

/// Name under which the built-in Agent Browser MCP server is registered. Agent
/// Browser is the default web-browsing tool (npm `agentbrowser`), launched via
/// `npx`. Like Ghost, the registry degrades gracefully when the package can't be
/// spawned (not installed / no Node), so registering it unconditionally is safe.
pub const AGENTBROWSER_SERVER: &str = "agentbrowser";

/// Separator between server name and tool name in a fully-qualified tool id.
const TOOL_ID_SEP: &str = "__";

/// Synthetic "server" name for tools an enabled plugin re-exposes
/// (tool-as-Runnable, M3). These ids look like `app__<target-tool-id>` and are
/// dispatched by aliasing to the target — see `call_tool_with_user`.
const APP_TOOL_SERVER: &str = "app";

/// Id prefix for app-registered tools (`APP_TOOL_SERVER` + `TOOL_ID_SEP`).
const APP_TOOL_PREFIX: &str = "app__";

/// A plugin app tool resolved to its dispatch-ready backend + the owning plugin's
/// grant set. Produced by [`McpRegistry::resolve_app_tool_backend`] from the LIVE
/// enabled-manifest set — mirroring `plugin_host::collect_enabled_hooks`, which
/// likewise sources grants from `manifest.permission_grants` filtered to enabled
/// plugins (so it diverges from `record.approved_grants` only under per-grant
/// revocation, an accepted minimum-viable match-hooks choice).
struct ResolvedAppTool {
    /// How this tool runs (`alias` re-enter | `inline_deno` sandbox | `http` proxy).
    backend: crate::plugin_manifest::schema::ToolBackend,
    /// The owning plugin's granted capabilities (gates `host.*` + http egress).
    grants: std::collections::HashSet<String>,
    /// The owning plugin id (sandbox storage owner + audit attribution).
    plugin_id: String,
    /// The owning plugin manifest's unified **runtime permission set**, lowered to
    /// Deno `--allow-*` flags when an `inline_deno` tool runs. `None` = the manifest
    /// declared no `permissions` block → the sandbox stays **deny-all** (its
    /// historical zero-permission posture).
    permissions: Option<crate::plugin_manifest::PermissionSet>,
}

/// The config-driven MCP server registry. Cheap to clone-share via `Arc`.
///
/// Interior mutability: `servers` uses `RwLock` (reads dominate) so the
/// registry can reload without a process restart. `tool_cache` uses `Mutex`
/// as before — it is only written when a server's tools are fetched for the
/// first time. Never hold either lock guard across an `.await` point.
pub struct McpRegistry {
    /// The live server map. Use `RwLock` so concurrent readers (tool listing,
    /// chat tool loop) are not blocked by the rare write (registry reload after
    /// a POST /api/mcp/servers).
    servers: RwLock<BTreeMap<String, McpServerConfig>>,
    /// Cache of `tools/list` results, keyed by server name. Populated lazily so
    /// startup never blocks on spawning every MCP server.
    tool_cache: Mutex<BTreeMap<String, Vec<RegistryTool>>>,
    /// Cache of prewarmed widget HTML resources, keyed `server → uri`. Populated
    /// on demand (`prewarm_widgets`/`widget_resource`) and invalidated wherever
    /// `tool_cache` is cleared. Never held across an `.await`.
    resource_cache: Mutex<HashMap<String, HashMap<String, WidgetResource>>>,
    /// In-memory tools registered by enabled apps (tool-as-Runnable, M3).
    /// These are always returned alongside server-provided tools; no spawning
    /// required. Protected by a `Mutex` because writes are rare.
    app_tools: Mutex<Vec<RegistryTool>>,
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
    /// Skill registry, wired so the `skills` built-in tools (`skills__search` /
    /// `skills__load`) can discover + load Agent Skills on demand (progressive
    /// disclosure). Cheap to clone (`Arc` inside). `None` in test/CLI contexts
    /// that don't wire it (the tools then report skills unavailable).
    pub skills: Option<ryu_skills::SkillRegistry>,
    /// Preferences store, wired so the built-in `advisor` tool can resolve the
    /// configured `advisor-model` (the stronger reviewer model). Cheap to clone
    /// (`Arc` inside). `None` in test/CLI contexts; the tool then falls back to
    /// env / the bundled default.
    pub preferences: Option<crate::server::preferences::PreferencesStore>,
    /// Loopback client for the out-of-process `ryu-teams` sidecar, wired so the
    /// `agent_builder__create_agent_team` tool can persist a team (over HTTP) after
    /// minting its members. Cheap to clone. `None` in test/CLI contexts; the tool
    /// then reports the team sink unavailable rather than partially creating agents
    /// with no team.
    pub teams_client: Option<crate::teams_client::TeamsClient>,
    /// Per-run worktree diff store, wired so the in-process `ryu.worktree` app
    /// (worktree-diff-review widget) resolves a run's diff and applies/discards it.
    /// Cheap to clone (`Arc` inside). `None` in test/CLI contexts; the app then
    /// reports its store unavailable rather than acting on the wrong tree.
    pub worktree_diffs: Option<crate::server::WorktreeDiffStore>,
    /// Spaces store, wired so the built-in `artifact__create` tool can save a
    /// generated file into a Space (default: the Artifacts system space) and the
    /// ACP auto-file hook can persist assistant-message media. Cheap to clone
    /// (`Arc` inside). `None` in test/CLI contexts; the tool then reports itself
    /// unavailable rather than dropping the artifact.
    pub spaces: Option<crate::server::spaces::SpaceStore>,
}

impl McpRegistry {
    /// Build an empty registry (no servers configured).
    pub fn empty() -> Self {
        Self {
            servers: RwLock::new(BTreeMap::new()),
            tool_cache: Mutex::new(BTreeMap::new()),
            resource_cache: Mutex::new(HashMap::new()),
            app_tools: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
            preferences: None,
            teams_client: None,
            worktree_diffs: None,
            spaces: None,
        }
    }

    /// Build a registry from a server map (used by config loading and tests).
    pub fn from_servers(servers: BTreeMap<String, McpServerConfig>) -> Self {
        Self {
            servers: RwLock::new(servers),
            tool_cache: Mutex::new(BTreeMap::new()),
            resource_cache: Mutex::new(HashMap::new()),
            app_tools: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
            preferences: None,
            teams_client: None,
            worktree_diffs: None,
            spaces: None,
        }
    }

    /// Wire the self-build context (manifests + app store) into the registry.
    /// Must be called after construction to enable the `ryu_self_build` tools.
    pub fn with_self_build(
        mut self,
        manifests: std::sync::Arc<TokioRwLock<Vec<PluginManifest>>>,
        app_store: std::sync::Arc<crate::plugins::PluginStore>,
    ) -> Self {
        self.self_build_manifests = Some(manifests);
        self.self_build_app_store = Some(app_store);
        self
    }

    /// Wire the agent config store into the registry. Must be called after
    /// construction to enable the `agent_builder` tools (chat-driven agent edits).
    pub fn with_agent_store(mut self, store: crate::agents::AgentStore) -> Self {
        self.agent_store = Some(store);
        self
    }

    /// Wire the teams sidecar client into the registry. Must be called after
    /// construction to enable `agent_builder__create_agent_team` (mint a roster of
    /// agents + persist them as a team over loopback HTTP).
    pub fn with_teams_client(mut self, client: crate::teams_client::TeamsClient) -> Self {
        self.teams_client = Some(client);
        self
    }

    /// Wire the per-run worktree diff store into the registry. Must be called after
    /// construction to let the in-process `ryu.worktree` app resolve a run's diff
    /// and apply/discard it (the worktree-diff-review widget).
    pub fn with_worktree_diffs(mut self, store: crate::server::WorktreeDiffStore) -> Self {
        self.worktree_diffs = Some(store);
        self
    }

    /// Wire the conversation store into the registry. Must be called after
    /// construction to enable the `search_conversations` built-in tool (semantic
    /// search over past chat messages).
    pub fn with_conversations(
        mut self,
        store: crate::server::conversations::ConversationStore,
    ) -> Self {
        self.conversations = Some(store);
        self
    }

    /// Wire the Spaces store into the registry. Must be called after construction
    /// to enable the built-in `artifact__create` tool + the ACP artifact auto-file
    /// hook to persist files into a Space.
    pub fn with_spaces(mut self, spaces: crate::server::spaces::SpaceStore) -> Self {
        self.spaces = Some(spaces);
        self
    }

    /// Wire the skill registry into the registry. Must be called after
    /// construction to enable the `skills` built-in tools (`skills__search` /
    /// `skills__load`, progressive disclosure of Agent Skills).
    pub fn with_skills(mut self, skills: ryu_skills::SkillRegistry) -> Self {
        self.skills = Some(skills);
        self
    }

    /// Wire the preferences store into the registry. Must be called after
    /// construction to let the built-in `advisor` tool resolve the configured
    /// `advisor-model` (the stronger reviewer model).
    pub fn with_preferences(
        mut self,
        preferences: crate::server::preferences::PreferencesStore,
    ) -> Self {
        self.preferences = Some(preferences);
        self
    }

    /// Resolve the config path: `RYU_MCP_CONFIG` if set, else `~/.ryu/mcp.json`.
    pub fn config_path() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_MCP_CONFIG") {
            return PathBuf::from(p);
        }
        crate::paths::ryu_dir().join("mcp.json")
    }

    /// Built-in MCP servers Core always registers — no config file required.
    ///
    /// Today this is just **Ghost** (U14), the desktop-automation server (29
    /// tools) shipped in `apps/ghost`. It is spawned per request as
    /// `~/.ryu/bin/ghost mcp` (the same binary + subcommand the `GhostManager`
    /// sidecar uses), so the registry's short-lived stdio client can list and
    /// call its tools without a long-lived process.
    ///
    /// Ghost is **Windows-first**: its perception/input backend targets Windows
    /// first, with partial support elsewhere. When the binary isn't installed
    /// (the common case off Windows, or before first install) the registry
    /// degrades gracefully — `tools/list` simply fails to spawn and the server
    /// is logged-and-skipped, so one unavailable built-in never hides the rest.
    fn builtin_servers() -> BTreeMap<String, McpServerConfig> {
        // Point Ghost at the island's loopback control server so its pointer/keyboard
        // actions drive the visible ghost-cursor overlay (POST /ghost-cursor). Always
        // injected — Core cannot know whether an island is running, but the sidecar's
        // POSTs are fire-and-forget, so a dead port is a harmless no-op. Profile-shifted
        // to match the island's own port math (control.ts: base 7989, +1000 for dev).
        let mut ghost_env = BTreeMap::new();
        ghost_env.insert(
            "RYU_GHOST_OVERLAY_URL".to_owned(),
            format!("http://127.0.0.1:{}/ghost-cursor", crate::profile::port(7989)),
        );
        let ghost = McpServerConfig {
            command: crate::sidecar::tools::ghost::ghost_bin_path()
                .to_string_lossy()
                .into_owned(),
            args: vec!["mcp".to_owned()],
            env: ghost_env,
            description: Some(
                "Ghost — desktop automation (29 tools: screen perception + input control). \
                 Windows-first; install the `ghost` sidecar to enable. Unavailable until installed."
                    .to_owned(),
            ),
            enabled: true,
            version: None,
            catalog_id: None,
        };
        // Agent Browser — default web-browsing tool, launched via `npx agentbrowser`.
        // Best-effort: the exact package entrypoint is provided by the npm package;
        // if it isn't installed (or Node/npx is absent) the stdio client fails to
        // spawn and this server is logged-and-skipped, so it never hides the rest.
        // A user config entry named `agentbrowser` overrides this (see `load`).
        let agentbrowser = McpServerConfig {
            command: "npx".to_owned(),
            args: vec!["-y".to_owned(), "agentbrowser".to_owned()],
            env: BTreeMap::new(),
            description: Some(
                "Agent Browser — AI-powered web browsing (navigate, extract, interact). \
                 Launched via `npx agentbrowser`; unavailable until the package (and Node) \
                 are installed."
                    .to_owned(),
            ),
            enabled: true,
            version: None,
            catalog_id: None,
        };
        let mut servers = BTreeMap::new();
        servers.insert(GHOST_SERVER.to_owned(), ghost);
        servers.insert(AGENTBROWSER_SERVER.to_owned(), agentbrowser);
        servers
    }

    /// Load the registry. Always starts from the built-in servers (Ghost, U14),
    /// then overlays the user's config file on top. A missing config file is
    /// fine (MCP is opt-in, matching the "modular" principle) and still yields
    /// the built-ins. A user entry with the same name as a built-in **wins**,
    /// so operators can repoint or disable a built-in deterministically.
    pub fn load() -> Self {
        let servers = Self::load_merged_servers();
        Self {
            servers: RwLock::new(servers),
            tool_cache: Mutex::new(BTreeMap::new()),
            resource_cache: Mutex::new(HashMap::new()),
            app_tools: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
            preferences: None,
            teams_client: None,
            worktree_diffs: None,
            spaces: None,
        }
    }

    /// Internal: compute the merged server map (built-ins + user file). Used by
    /// both `load()` and `reload()`.
    fn load_merged_servers() -> BTreeMap<String, McpServerConfig> {
        let mut servers = Self::builtin_servers();

        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<McpConfigFile>(&contents) {
                Ok(file) => {
                    let count = file.mcp_servers.len();
                    // Config overrides built-ins on name collision.
                    for (name, cfg) in file.mcp_servers {
                        servers.insert(name, cfg);
                    }
                    tracing::info!(
                        "loaded {count} MCP server(s) from {}; {} total with built-ins",
                        path.display(),
                        servers.len()
                    );
                }
                Err(e) => {
                    tracing::warn!("invalid MCP config at {}: {e}", path.display());
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::info!(
                    "no MCP config at {}; using {} built-in server(s)",
                    path.display(),
                    servers.len()
                );
            }
            Err(e) => {
                tracing::warn!("could not read MCP config at {}: {e}", path.display());
            }
        }

        servers
    }

    /// Reload the server map from disk without restarting the process.
    ///
    /// Re-derives built-ins then re-overlays the user's `mcp.json`, exactly as
    /// `load()` does. The `tool_cache` is cleared so freshly registered servers
    /// advertise their tools on the next `/api/mcp/tools` request.
    pub fn reload(&self) {
        let fresh = Self::load_merged_servers();
        let mut servers = self.servers.write().expect("mcp servers RwLock poisoned");
        *servers = fresh;
        drop(servers);
        if let Ok(mut cache) = self.tool_cache.lock() {
            cache.clear();
        }
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.clear();
        }
        tracing::info!("McpRegistry: reloaded from disk");
    }

    /// Whether a server with the given `name` is already registered (built-ins
    /// included). The built-in Shadow, Spider, and Exa providers are synthesized
    /// only in `server_summaries()` and are NOT in `servers`, so they are checked
    /// by name explicitly.
    pub fn contains_server(&self, name: &str) -> bool {
        if name == shadow::SERVER_NAME
            || name == spider::SERVER_NAME
            || name == rtk::SERVER_NAME
            || name == exa::SERVER_NAME
            || name == web_fetch::SERVER_NAME
            || name == sandbox::SERVER_NAME
            || name == notify_tool::SERVER_NAME
            || name == artifact_tool::SERVER_NAME
            || name == channel_tool::SERVER_NAME
            || name == search_conversations::SERVER_NAME
            || name == threads::SERVER_NAME
            || name == delegate::SERVER_NAME
            || name == orchestrator::SERVER_NAME
            || name == skills_tool::SERVER_NAME
            || name == advisor::SERVER_NAME
            || name == ui_tool::SERVER_NAME
            || name == research::SERVER_NAME
            || apps::owns(name)
        {
            return true;
        }
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .contains_key(name)
    }

    /// Summaries of every registered server (for `GET /api/mcp/servers`).
    /// Includes the built-in Shadow, Spider, and Exa providers alongside config
    /// servers.
    pub fn server_summaries(&self) -> Vec<ServerSummary> {
        let spider_bin = spider::spider_bin_path();
        let sandbox_enabled = sandbox::is_enabled();
        let sandbox_available = cfg!(feature = "sandbox-wasmtime");
        let mut summaries = vec![
            ServerSummary {
                name: shadow::SERVER_NAME.to_owned(),
                command: "(built-in HTTP)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in Shadow capture + search (Windows-first). Reachable when the Shadow sidecar is running on :3030.".to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: spider::SERVER_NAME.to_owned(),
                command: spider_bin.to_string_lossy().into_owned(),
                args: vec!["crawl".to_owned()],
                description: Some(
                    "Built-in Spider web crawler. Install the Spider sidecar to enable. Degrades gracefully when not installed.".to_owned(),
                ),
                enabled: true,
                available: Some(spider_bin.exists()),
            },
            ServerSummary {
                name: research::SERVER_NAME.to_owned(),
                command: "(built-in HTTP)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in autoresearch experiment runner. Install the Research sidecar (or run `python -m ryu_research`) to enable. Degrades gracefully when not running.".to_owned(),
                ),
                enabled: true,
                available: Some(crate::sidecar::tools::research::is_installed()),
            },
            ServerSummary {
                name: rtk::SERVER_NAME.to_owned(),
                command: rtk::rtk_bin_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "rtk".to_owned()),
                args: vec!["run".to_owned()],
                description: Some(
                    "Built-in RTK (Rust Token Killer): runs a dev command and returns a token-compressed version of its output. BYO — detected on PATH (or RYU_RTK_BIN). Degrades gracefully when not installed.".to_owned(),
                ),
                enabled: true,
                available: Some(rtk::is_available()),
            },
            ServerSummary {
                name: exa::SERVER_NAME.to_owned(),
                command: "(built-in HTTP)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in Exa neural web search (BYOK: set RYU_EXA_API_KEY). Degrades gracefully when key is absent.".to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: web_fetch::SERVER_NAME.to_owned(),
                command: "(built-in HTTPS)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in authenticated web fetch. Fetches a page over HTTPS, injecting the \
                     user's Identity Vault session for the URL's domain server-side (acts AS the \
                     user; the credential never reaches the model)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            // Built-in wasmtime sandbox provider (M6 / issue #190).
            // Availability reflects whether the feature was compiled in.
            // Enabled reflects the runtime toggle (RYU_SANDBOX_DISABLED env var).
            ServerSummary {
                name: sandbox::SERVER_NAME.to_owned(),
                command: "(built-in wasmtime)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in wasmtime sandbox: run WASM/WASI modules with default-deny capabilities. \
                     Toggle with the enable/disable endpoint or from the Services page."
                        .to_owned(),
                ),
                enabled: sandbox_enabled,
                available: Some(sandbox_available),
            },
            ServerSummary {
                name: notify_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in action: show a native desktop notification to the user.".to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: channel_tool::SERVER_NAME.to_owned(),
                command: "(built-in HTTP)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in action: post a message to a Slack/Discord incoming-webhook URL."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: search_conversations::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in: semantic search over the user's past conversation messages."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: threads::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in coordinator threads: spin up and manage worker threads \
                     (create/list/read, send a message that runs a worker's agent in its own \
                     worktree, pin/archive/title/fork)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: delegate::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in delegation: fan out independent subtasks to sub-agents that run \
                     in parallel in a clean context, returning all results in one call \
                     (ephemeral; for durable workers use the threads tools)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: orchestrator::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in orchestration discovery: list the other agents available to \
                     delegate to, with each one's id/name/description, so an orchestrator can \
                     find the right specialist (orchestrator__discover_agents) before handing \
                     it a subtask via delegate__fanout."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: skills_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in skills: discover and load Agent Skills on demand \
                     (skills__search / skills__load) instead of injecting every skill body \
                     up front — progressive disclosure for low-context models. \
                     skills__author writes a new structured, reusable SKILL.md and \
                     refines it on reuse."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: advisor::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in advisor: consult a stronger model for a second opinion on the \
                     current task (advisor__consult) — before committing to an approach, when \
                     stuck, or before declaring done."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
            ServerSummary {
                name: ui_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in generative UI: render a rich interactive UI inline in the chat \
                     (ui__render) from a json-render spec, using the app's own shadcn components."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
            },
        ];
        let servers = self.servers.read().expect("mcp servers RwLock poisoned");
        summaries.extend(servers.iter().map(|(name, cfg)| ServerSummary {
            name: name.clone(),
            command: cfg.command.clone(),
            args: cfg.args.clone(),
            description: cfg.description.clone(),
            enabled: cfg.enabled,
            available: command_availability(&cfg.command),
        }));
        summaries
    }

    /// Fully-qualified id for a server's tool.
    fn tool_id(server: &str, tool: &str) -> String {
        format!("{server}{TOOL_ID_SEP}{tool}")
    }

    /// Split a fully-qualified tool id back into `(server, tool)`.
    pub fn split_tool_id(id: &str) -> Option<(&str, &str)> {
        id.split_once(TOOL_ID_SEP)
    }

    /// List tools for one enabled server, using the cache when warm.
    ///
    /// The config is extracted under a short read lock, then the lock is dropped
    /// before any `.await` — never hold an `RwLock` guard across an await point.
    async fn tools_for_server(&self, name: &str) -> Result<Vec<RegistryTool>> {
        // Extract owned config values under the read lock; drop immediately.
        let (enabled, cmd) = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let cfg = servers
                .get(name)
                .ok_or_else(|| anyhow!("unknown MCP server: {name}"))?;
            (cfg.enabled, cfg.to_command())
        };
        if !enabled {
            return Ok(vec![]);
        }

        if let Some(cached) = self
            .tool_cache
            .lock()
            .ok()
            .and_then(|c| c.get(name).cloned())
        {
            return Ok(cached);
        }

        let mcp_tools: Vec<McpTool> = client::list_tools(&cmd).await?;
        let tools: Vec<RegistryTool> = mcp_tools
            .into_iter()
            .map(|t| {
                let widget = WidgetBinding::from_meta(t.meta.as_ref());
                let widget_accessible = widget.as_ref().is_some_and(|w| w.widget_accessible);
                let output_template = widget.as_ref().map(|w| w.template_uri.clone());
                RegistryTool {
                    id: Self::tool_id(name, &t.name),
                    server: name.to_owned(),
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                    output_schema: t.output_schema,
                    annotations: t.annotations,
                    meta: t.meta,
                    widget,
                    widget_accessible,
                    output_template,
                }
            })
            .collect();

        if let Ok(mut cache) = self.tool_cache.lock() {
            cache.insert(name.to_owned(), tools.clone());
        }
        Ok(tools)
    }

    /// Resolve a tool's [`WidgetBinding`] by its fully-qualified id, if it has one.
    ///
    /// The in-process apps provider answers synchronously; other servers are
    /// resolved via `list_all_tools` (cached). Returns `None` for tools that do
    /// not render a widget.
    pub async fn widget_binding(&self, tool_id: &str) -> Option<WidgetBinding> {
        let (server, _tool) = Self::split_tool_id(tool_id)?;
        if apps::owns(server) {
            return apps::tools()
                .into_iter()
                .find(|t| t.id == tool_id)
                .and_then(|t| t.widget);
        }
        self.list_all_tools()
            .await
            .into_iter()
            .find(|t| t.id == tool_id)
            .and_then(|t| t.widget)
    }

    /// Resolve the unified widget-promotion decision for `tool_id` (D-dedup + the
    /// `widget:render` grant gate).
    ///
    /// This is the SINGLE promotion decision path both emit planes share (via
    /// [`crate::sidecar::adapters::mcp_bridge::build_widget_event`]). It composes
    /// two things that used to run as separate concerns:
    ///
    /// 1. **Detail** — the binding (template uri, labels, `widget_accessible`) is
    ///    resolved from the in-process apps provider or the live `_meta`
    ///    discovery via [`Self::widget_binding`]. No binding ⇒ no widget.
    /// 2. **Decision** — whether the tool may promote is decided ONLY by the
    ///    plugin manifest `contributes.widgets[]` allowlist joined to the owning
    ///    plugin's enabled + `widget:render` grant state (see
    ///    [`Self::widget_contribution`]). The `_meta`/apps discovery no longer
    ///    *authorises* promotion on its own; it only supplies the detail the
    ///    manifest decision consumes.
    pub async fn resolve_widget_promotion(&self, tool_id: &str) -> WidgetPromotion {
        let Some(binding) = self.widget_binding(tool_id).await else {
            return WidgetPromotion::None;
        };
        match self.widget_contribution(tool_id).await {
            WidgetContributionState::EnabledGranted | WidgetContributionState::Unrecorded => {
                WidgetPromotion::Allow(binding)
            }
            WidgetContributionState::EnabledUngranted { plugin_id } => {
                WidgetPromotion::DeniedNoGrant { plugin_id }
            }
            WidgetContributionState::Disabled { plugin_id } => {
                WidgetPromotion::DeniedDisabled { plugin_id }
            }
            WidgetContributionState::RecordedUndeclared { plugin_id } => {
                WidgetPromotion::DeniedUndeclared { plugin_id }
            }
        }
    }

    /// [`Self::resolve_widget_promotion`] reduced to the binding, logging a clear
    /// reason when promotion is refused for lack of grant / a disabled owner.
    /// `None` ⇒ deliver the tool result as text only (no widget side-channel).
    pub async fn widget_promotion_or_log(&self, tool_id: &str) -> Option<WidgetBinding> {
        match self.resolve_widget_promotion(tool_id).await {
            WidgetPromotion::Allow(binding) => Some(binding),
            WidgetPromotion::DeniedNoGrant { plugin_id } => {
                tracing::info!(
                    tool_id,
                    plugin_id,
                    grant = WIDGET_RENDER_GRANT,
                    "widget promotion refused: the owning plugin is enabled but does not hold \
                     the `widget:render` grant; delivering the tool result as text only"
                );
                None
            }
            WidgetPromotion::DeniedDisabled { plugin_id } => {
                tracing::debug!(
                    tool_id,
                    plugin_id,
                    "widget promotion refused: the owning plugin is disabled"
                );
                None
            }
            WidgetPromotion::DeniedUndeclared { plugin_id } => {
                tracing::info!(
                    tool_id,
                    plugin_id,
                    "widget promotion refused: an enabled MCP-server plugin record owns this \
                     tool's server but never declared the tool in `contributes.widgets`, so \
                     there is no per-widget consent; delivering the tool result as text only"
                );
                None
            }
            WidgetPromotion::None => None,
        }
    }

    /// Resolve the manifest-side widget-contribution state for `tool_id`.
    ///
    /// The join to the owning plugin is by `contributes.widgets[].tool_id` (the
    /// runtime `server__tool` id), NEVER by server name — a built-in app's server
    /// namespace differs from its plugin id (server `app.form` ↔ plugin
    /// `smart-intake-form`). The grant source is `manifest.permission_grants`
    /// filtered to plugins whose lifecycle record is enabled, mirroring
    /// [`Self::resolve_app_tool_backend`] / `plugin_host::collect_enabled_hooks`.
    ///
    /// Fails OPEN ([`WidgetContributionState::Unrecorded`]) when the governance
    /// context is not wired, or when neither a declaring manifest NOR a synth
    /// MCP-server record owns the tool — so genuinely record-less legacy external
    /// servers keep rendering and no missing-record anomaly can dark a built-in.
    /// Fails CLOSED ([`WidgetContributionState::RecordedUndeclared`]) when an
    /// enabled synth MCP-server record owns the tool's server but never declared
    /// the widget: an installed third-party server cannot auto-promote a widget it
    /// did not consent to (goal (c)).
    async fn widget_contribution(&self, tool_id: &str) -> WidgetContributionState {
        let (Some(manifests), Some(store)) = (
            self.self_build_manifests.as_ref(),
            self.self_build_app_store.as_ref(),
        ) else {
            // No governance context (tests / CLI / bare registry) → fail-open.
            return WidgetContributionState::Unrecorded;
        };

        // The tool's server namespace (`<server>__<tool>`) — used for the
        // fail-CLOSED join against a synth MCP-server record when no manifest
        // declares the tool_id.
        let server = Self::split_tool_id(tool_id).map(|(s, _)| s.to_owned());

        // Snapshot under the read lock and drop it before touching the store
        // (never hold across .await). Two things resolved in one pass:
        //   * `declared`   — the installed manifest that declares this tool_id in
        //                    contributes.widgets, plus whether it holds the grant.
        //   * `synth_owner`— an installed SYNTH MCP-server record (category ==
        //                    MCP_SERVER_CATEGORY) whose id == the tool's server.
        let (declared, synth_owner) = {
            let guard = manifests.read().await;
            let declared = guard.iter().find_map(|m| {
                let contributes = m.contributes.as_ref()?;
                contributes
                    .widgets
                    .iter()
                    .any(|w| w.tool_id == tool_id)
                    .then(|| {
                        let has_grant = m
                            .permission_grants
                            .iter()
                            .any(|g| g == WIDGET_RENDER_GRANT);
                        (m.id.clone(), has_grant)
                    })
            });
            let synth_owner = server.as_ref().and_then(|srv| {
                guard
                    .iter()
                    .find(|m| {
                        m.id == *srv && m.category.as_deref() == Some(MCP_SERVER_CATEGORY)
                    })
                    .map(|m| m.id.clone())
            });
            (declared, synth_owner)
        };

        // A manifest explicitly declares this widget: honour its enabled + grant
        // state (the normal path for the 8 built-ins and any plugin that authored
        // a contributes.widgets entry).
        if let Some((plugin_id, has_grant)) = declared {
            return match store.get(&plugin_id).await {
                Ok(Some(rec)) if rec.enabled => {
                    if has_grant {
                        WidgetContributionState::EnabledGranted
                    } else {
                        WidgetContributionState::EnabledUngranted { plugin_id }
                    }
                }
                Ok(Some(_)) => WidgetContributionState::Disabled { plugin_id },
                // Manifest present but no lifecycle record yet (e.g. a seed
                // anomaly), or a store read error — fail OPEN rather than dark a
                // widget on the chat path. The manifest existing is enough signal
                // that this is ours.
                Ok(None) | Err(_) => WidgetContributionState::Unrecorded,
            };
        }

        // Undeclared. If a synth MCP-server record owns this tool's server, fail
        // CLOSED: the server is governed but never declared/consented to THIS
        // widget, so its sandboxed HTML must NOT auto-promote (goal (c) — the
        // widget:render gate is meaningful for the installed third-party server it
        // targets, not a no-op). Only a genuinely record-less server (no synth
        // owner) keeps the fail-open lane.
        if let Some(plugin_id) = synth_owner {
            return match store.get(&plugin_id).await {
                Ok(Some(rec)) if rec.enabled => {
                    WidgetContributionState::RecordedUndeclared { plugin_id }
                }
                Ok(Some(_)) => WidgetContributionState::Disabled { plugin_id },
                // Record row missing / store error: the server is not actually
                // governed yet, so fall back to the legacy fail-open lane rather
                // than dark a widget on an anomaly.
                Ok(None) | Err(_) => WidgetContributionState::Unrecorded,
            };
        }

        WidgetContributionState::Unrecorded
    }

    /// Resolve (and cache) a widget HTML resource for `server` by its `uri`.
    ///
    /// The in-process apps provider serves its bundled HTML directly; a config
    /// MCP server is asked over `resources/read`. Never holds the cache lock
    /// across an `.await`.
    pub async fn widget_resource(&self, server: &str, uri: &str) -> Option<WidgetResource> {
        if apps::owns(server) {
            return apps::read_resource(uri);
        }
        // Cache hit?
        if let Ok(cache) = self.resource_cache.lock() {
            if let Some(res) = cache.get(server).and_then(|m| m.get(uri)) {
                return Some(res.clone());
            }
        }
        // Extract the command under the read lock, drop before .await.
        let cmd = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let cfg = servers.get(server)?;
            if !cfg.enabled {
                return None;
            }
            cfg.to_command()
        };
        let contents = client::read_resource(&cmd, uri).await.ok()?;
        let first = contents.into_iter().find(|c| c.text.is_some())?;
        let resource = WidgetResource {
            uri: uri.to_owned(),
            mime_type: first
                .mime_type
                .unwrap_or_else(|| "text/html+skybridge".to_owned()),
            html: first.text.unwrap_or_default(),
            meta: first.meta,
        };
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache
                .entry(server.to_owned())
                .or_default()
                .insert(uri.to_owned(), resource.clone());
        }
        Some(resource)
    }

    /// Prewarm every widget resource a server advertises so the emit path can
    /// resolve HTML without a round-trip. In-process apps are already warm.
    pub async fn prewarm_widgets(&self, server: &str) -> Result<()> {
        if apps::owns(server) {
            return Ok(());
        }
        let cmd = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let Some(cfg) = servers.get(server) else {
                return Ok(());
            };
            if !cfg.enabled {
                return Ok(());
            }
            cfg.to_command()
        };
        let resources = client::list_resources(&cmd).await.unwrap_or_default();
        for r in resources {
            if r.uri.starts_with("ui://widget/") {
                let _ = self.widget_resource(server, &r.uri).await;
            }
        }
        Ok(())
    }

    /// The fully-qualified ids of the widget-accessible (companion) tools on
    /// `server` — used to bound which tools a mounted widget may `callTool`.
    pub async fn widget_accessible_tool_ids(&self, server: &str) -> Vec<String> {
        if apps::owns(server) {
            return apps::widget_accessible_tool_ids(server);
        }
        self.tools_for_server(server)
            .await
            .map(|tools| {
                tools
                    .into_iter()
                    .filter(|t| t.widget_accessible)
                    .map(|t| t.id)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every tool across every enabled server. A server that fails to start is
    /// logged and skipped so one broken server can't hide the rest.
    ///
    /// Includes the built-in Shadow tools (U15) and self-build tools (U57) so
    /// an agent can always discover them; Shadow calls report unavailable when
    /// Shadow isn't running, and self-build calls require the context to be wired.
    ///
    /// Server names are snapshotted under the read lock and then the lock is
    /// dropped before any `.await` call.
    pub async fn list_all_tools(&self) -> Vec<RegistryTool> {
        let names: Vec<String> = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            servers.keys().cloned().collect()
        };

        let mut all = shadow::tools();
        all.extend(spider::tools());
        // Built-in autoresearch tools — drive the research sidecar's experiment
        // loop. Always listed; dispatch reports unavailable when the sidecar is
        // not running (opt-in / not installed).
        all.extend(research::tools());
        all.extend(rtk::tools());
        all.extend(exa::tools());
        // Built-in authenticated web fetch (Identity Vault credential consumer).
        all.extend(web_fetch::tools());
        // Built-in wasmtime sandbox tools (M6 / issue #190) — always listed;
        // dispatch returns `available: false` when disabled or feature absent.
        all.extend(sandbox::tools());
        // Built-in actions (#456): desktop notification + send-to-channel.
        all.extend(notify_tool::tools());
        all.extend(artifact_tool::tools());
        all.extend(channel_tool::tools());
        // Built-in semantic search over past chat messages — always listed;
        // dispatch returns `available: false` when the conversation store / index
        // is not wired (test / CLI contexts).
        all.extend(search_conversations::tools());
        // Built-in coordinator-threads tools — always listed; dispatch reports
        // unavailable when the conversation store / agent runner is not wired.
        all.extend(threads::tools());
        // Built-in delegation tool — ephemeral parallel sub-agent fan-out. Always
        // listed; per-delegate failures surface in the results envelope.
        all.extend(delegate::tools());
        all.extend(orchestrator::tools());
        // Built-in skills tools — progressive disclosure (search + load Agent
        // Skills on demand). Always listed; dispatch reports unavailable when the
        // skill registry is not wired (test / CLI contexts).
        all.extend(skills_tool::tools());
        // Built-in advisor tool — consult a stronger reviewer model for a second
        // opinion. Always listed; dispatch reports a structured error if the
        // Gateway call fails so the agent's turn continues.
        all.extend(advisor::tools());
        // Built-in generative-UI tool — render a rich UI inline in chat from a
        // json-render spec. Always listed; client-rendered (Core dispatch is a no-op).
        all.extend(ui_tool::tools());
        // Include self-build tools (U57) — always listed, dispatch fails gracefully
        // if the self_build context was not wired (test / CLI contexts).
        all.extend(crate::runnable::self_build::tools());
        // Agent-builder tools — chat edits an agent record. Dispatch fails
        // gracefully when the agent_store was not wired (test / CLI contexts).
        all.extend(crate::runnable::agent_builder::tools());
        // Workflow-builder tools — chat authors/edits a workflow definition.
        // Backed by the global file-backed workflow store (no handle to wire).
        all.extend(crate::runnable::workflow_builder::tools());
        // Dashboard-builder tools — chat authors/arranges a Home dashboard's
        // widget grid. Backed by the process-global dashboard engine (no handle
        // to wire); dispatch reports unavailable in test/CLI contexts.
        all.extend(crate::runnable::dashboard_builder::tools());
        for name in &names {
            match self.tools_for_server(name).await {
                Ok(tools) => all.extend(tools),
                Err(e) => tracing::warn!("MCP server '{name}' tools/list failed: {e}"),
            }
        }
        // In-process Ryu Apps provider (widget-rendering tools) — always listed;
        // dispatch runs in-process. Their widget `_meta` binding drives the
        // widget-emit path.
        all.extend(apps::tools());
        // Include in-memory tools registered by enabled apps (tool-as-Runnable).
        if let Ok(app) = self.app_tools.lock() {
            all.extend(app.iter().cloned());
        }
        all
    }

    /// Tools visible to an agent, honoring its allowlist.
    ///
    /// `allowlist` semantics:
    ///   - `None`  → no restriction; every registered tool is allowed.
    ///   - `Some([])` → an explicit empty allowlist; no tools allowed.
    ///   - `Some([…])` → only tools whose fully-qualified id OR bare name OR
    ///     owning server appears in the list. Matching on server name lets an
    ///     agent allow a whole server with one entry.
    pub async fn tools_for_agent(&self, allowlist: Option<&[String]>) -> Vec<RegistryTool> {
        let all = self.list_all_tools().await;
        match allowlist {
            None => all,
            Some(list) => all.into_iter().filter(|t| tool_allowed(t, list)).collect(),
        }
    }

    /// Resolve an agent's orchestration capabilities from the config store.
    ///
    /// Falls back to the safe defaults ([`AgentCapabilities::default`]:
    /// delegation on, creation off) when the store is unwired (test/CLI
    /// contexts) or the id is unknown (e.g. a bare transport-id caller). Because
    /// the default leaves delegation on, an agent never loses delegation merely
    /// because its config row could not be loaded.
    pub async fn agent_capabilities(&self, agent_id: &str) -> AgentCapabilities {
        if let Some(store) = &self.agent_store {
            if let Ok(Some(record)) = store.get(agent_id).await {
                return AgentCapabilities {
                    orchestrator: record.orchestrator_enabled(),
                    can_create_agents: record.can_create_agents_enabled(),
                };
            }
        }
        AgentCapabilities::default()
    }

    /// Invoke a registered tool by its fully-qualified id (`<server>__<tool>`),
    /// honoring the agent allowlist. Returns the MCP server's `tools/call`
    /// result. This is the entry point the chat tool loop (U12) calls.
    ///
    /// Config is extracted under the read lock then the lock is dropped before
    /// any `.await` — never hold an `RwLock` guard across an await point.
    pub async fn call_tool(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
    ) -> Result<Value> {
        self.call_tool_with_user(tool_id, arguments, allowlist, None)
            .await
    }

    /// Invoke a tool with an optional caller `user_id` (Composio entity +
    /// per-user audit). [`call_tool`](Self::call_tool) delegates here with
    /// `user_id = None`. Keeping the three-arg `call_tool` shape preserves the
    /// locked P4 invoker contract; only the HTTP `call_mcp_tool` handler, which
    /// carries a `user_id` from the request body, calls this richer variant.
    ///
    /// **Composio (#474):** `composio__<slug>` ids route to
    /// [`composio::dispatch`]; the allowlist is matched on the **fully-qualified
    /// id only** (`e == tool_id`) — never bare name/server — to close the
    /// cross-plane allowlist bypass (spec security #2). `user_id` selects the
    /// Composio entity (fallback to env/`"default"` only when absent).
    pub async fn call_tool_with_user(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
    ) -> Result<Value> {
        // No identity binding on the plain path (workflows/monitors/recipes have
        // no agent card). Route through the NO-GATE core: the approval gate is for
        // *agent* tool calls (the chat/ACP/PTC planes call `call_tool_with_identity`
        // directly), not for autonomous internal engine operations, which cannot
        // consume an `approval_pending` result and would stall under manual mode.
        // `host_conversation_id = None`: these callers (workflows, monitors, quests,
        // recipes) are autonomous engine operations with no host conversation, so on
        // an ORG-BOUND node they resolve to `ToolPrincipal::Unresolved` and the
        // conversation-reading tools refuse. On an unbound node they resolve to
        // `Unrestricted` — byte-identical to before. (Verified: no such caller
        // invokes a `threads__*` / `search_conversations__*` tool today.)
        self.call_tool_with_identity_no_gate(
            tool_id, arguments, allowlist, user_id, &[], None, None,
        )
        .await
    }

    /// Invoke a tool with the caller's bound Identity Vault profiles (epic #517,
    /// Unit 6). This is the variant the chat/ACP and PTC planes use: before any
    /// dispatch, it consults the vault for the call's target domain
    /// ([`crate::identity::consult_for_tool_call`]). If a bound connection for that
    /// domain is `NEEDS_AUTH`, the call is **not** dispatched and the
    /// `__ryu_elicitation__` envelope is returned as the result (the caller pauses
    /// for login, mirroring Composio's connection-required path). If it is
    /// `AUTHENTICATED`, the credential is read through the gateway-governed
    /// `identity.read` grant + audit at the boundary (never exposed to the LLM),
    /// then dispatch proceeds.
    ///
    /// `profile_ids` empty = no vault consult (the binding is opt-in). The other
    /// arguments behave exactly as [`call_tool_with_user`](Self::call_tool_with_user).
    ///
    /// This is the **gated** entry: before the identity consult it runs the
    /// human-in-the-loop approval gate ([`crate::approvals::gate_tool_call`]). If
    /// the global approval mode gates this tool, the call is **not** executed —
    /// a plain `approval_pending` result is returned (queued in the inbox) and the
    /// approval engine runs the tool on approve via
    /// [`call_tool_with_identity_no_gate`](Self::call_tool_with_identity_no_gate).
    /// Default mode `off` ⇒ the gate never fires ⇒ behavior is identical to before.
    ///
    /// `host_conversation_id` is the **server-derived** conversation this agent turn
    /// runs on behalf of (the ACP bridge's `permission_scope_id`). It is lowered to a
    /// [`ToolPrincipal`] at dispatch time and is the ONLY authorization principal on
    /// the agent plane — never `user_id`, which is client-supplied and spoofable.
    pub async fn call_tool_with_identity(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        if let Some(err) = crate::approvals::gate_tool_call(
            tool_id,
            &arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id.clone(),
            host_conversation_id,
        )
        .await
        {
            // Gated: return the "approval required" error instead of dispatching.
            // Every plane treats a tool error as not-done, so the call cannot be
            // mistaken for a completed side effect; the engine runs it on approve.
            return Err(err);
        }

        // PreToolUse hooks (Claude parity): a plugin tool-firewall may block the
        // call. This is a per-agent plugin layer ON TOP of the Gateway's own tool
        // governance, not a replacement for it. Fail-open + bounded timeout +
        // reentrancy-guarded, so installing a hook plugin can never wedge or break
        // tool dispatch. Skipped instantly (DB-free) when no tool-hook plugin is
        // loaded (`any_manifest_declares`).
        if let Some(reason) = run_pre_tool_hooks(tool_id, &arguments, session_id.as_deref()).await {
            return Err(anyhow!("tool '{tool_id}' blocked by a plugin hook: {reason}"));
        }
        // Keep a copy for the (detached) post-hook before `arguments` is consumed.
        let tool_input = arguments.clone();

        let result = self
            .call_tool_with_identity_no_gate(
                tool_id,
                arguments,
                allowlist,
                user_id,
                profile_ids,
                session_id,
                host_conversation_id,
            )
            .await;

        // PostToolUse hooks: observe-only, fired detached so they add no latency
        // and cannot fail the call. Only on a successful result.
        if let Ok(ref output) = result {
            fire_post_tool_hooks(tool_id.to_string(), tool_input, output.clone());
        }
        result
    }

    /// The ungated tool-dispatch core: identity consult + provider dispatch, with
    /// **no** approval gate. Called by [`call_tool_with_identity`] after the gate
    /// permits the call, and directly by the approval engine to run an approved
    /// tool call exactly once (without re-raising an approval).
    pub(crate) async fn call_tool_with_identity_no_gate(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        // Identity Vault consult (epic #517): for a bound agent, a tool call
        // targeting a NEEDS_AUTH domain returns the elicitation envelope as its
        // result (no dispatch); an AUTHENTICATED domain reads the credential under
        // the gateway grant + audit at this boundary. No-op when the agent has no
        // bound profiles. Skipped internally for `composio__…` (it owns its own
        // connection-required path).
        // An AUTHENTICATED bound domain for a credential-consuming tool (web_fetch)
        // returns the decrypted credential here so the tool can act AS the user;
        // it is threaded out-of-band to the tool (never into `arguments`, never to
        // the model). For every other tool this is `None`.
        let injected_credential = match crate::identity::consult_for_tool_call(
            profile_ids,
            tool_id,
            &arguments,
            session_id.clone(),
        )
        .await
        {
            crate::identity::ConsultOutcome::Elicit(envelope) => return Ok(envelope),
            crate::identity::ConsultOutcome::Proceed => None,
            crate::identity::ConsultOutcome::ProceedWithCredential(secret) => Some(secret),
        };

        // Built-in Composio provider (#474): searchable-not-listed, executed by
        // id prefix. Detected before split because the allowlist guard is
        // id-only (no bare name/server fallback).
        if tool_id.starts_with("composio__") {
            if let Some(list) = allowlist {
                if !list.iter().any(|e| e == tool_id) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let slug = tool_id.strip_prefix("composio__").unwrap_or(tool_id);
            return composio::dispatch(&self.http, slug, arguments, user_id).await;
        }

        let (server, tool) = Self::split_tool_id(tool_id)
            .ok_or_else(|| anyhow!("malformed tool id '{tool_id}' (expected server__tool)"))?;

        // Core self-API provider (agents driving Ryu itself): OpenAPI-derived tools
        // dispatched by looping back over HTTP to THIS Core with its own token.
        //
        // TENANCY FAIL-CLOSED: the loopback request carries the node's own
        // `RYU_TOKEN` = full node power, NOT this agent's scoped principal. On an
        // org-bound node that is a tenancy bypass, so CoreApi tools refuse unless the
        // resolved principal is `Unrestricted` (⟺ the node is unbound/personal —
        // there is exactly one principal and the node token IS its boundary). We
        // resolve the principal from the host conversation when a store is wired,
        // else fall back to the node's org binding directly.
        if server == crate::self_api::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let unrestricted = match self.conversations.as_ref() {
                Some(store) => matches!(
                    ToolPrincipal::resolve(store, host_conversation_id).await,
                    ToolPrincipal::Unrestricted
                ),
                None => crate::sidecar::control_plane::registered_org().is_none(),
            };
            if let Some(reason) = crate::self_api::refuse_reason_if_tenant_bound(unrestricted) {
                return Err(anyhow!("{reason}"));
            }
            return crate::self_api::dispatch(&self.http, tool_id, arguments).await;
        }

        // App-registered tool (tool-as-Runnable, M3): an enabled plugin re-exposes
        // an existing registry tool under its own `app__` namespace. The plugin's
        // Tool Runnable `slug` IS the target tool id (e.g. `app__exa__search` →
        // `exa__search`), so dispatch resolves the target and re-enters `call_tool`.
        //
        // The allowlist is enforced HERE, on the `app__` id (the granted
        // capability). The inner dispatch runs with NO allowlist because the
        // target is fixed by the manifest, not chosen by the caller — the app tool
        // itself is the grant (the Shopify/Figma capability model). Without this
        // arm an `app__*` id falls through to the generic server lookup and errors
        // with "unknown MCP server: app", so registered app tools were listable
        // and searchable but not callable.
        if server == APP_TOOL_SERVER {
            // Only dispatch ids an enabled app actually registered — never an
            // arbitrary `app__`-prefixed id a caller invents.
            let known = self
                .app_tools
                .lock()
                .map(|tools| tools.iter().any(|t| t.id == tool_id))
                .unwrap_or(false);
            if !known {
                return Err(anyhow!("unknown app tool '{tool_id}'"));
            }
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }

            // Backend dispatch (plugin-tools, M3): a plugin tool may ship NEW
            // behavior, not just alias. Resolve the owning enabled plugin's backend
            // + grant set from the live manifests. `None` (no self-build wiring, or
            // no enabled owner) → the legacy alias re-enter below, so this is purely
            // additive. `Alias` also falls through to that same legacy path.
            if let Some(resolved) = self.resolve_app_tool_backend(tool_id).await {
                use crate::plugin_manifest::schema::ToolBackend;
                match resolved.backend {
                    ToolBackend::InlineDeno { code } => {
                        // Grant-gated (same model as a turn hook): the plugin must
                        // hold `tool:execute`.
                        if !resolved.grants.contains(crate::tool_exec::GRANT_TOOL_EXECUTE) {
                            return Err(anyhow!(
                                "inline tool '{tool_id}' requires the '{}' grant",
                                crate::tool_exec::GRANT_TOOL_EXECUTE
                            ));
                        }
                        // Run in the Deno sandbox via the SAME host bridge a hook
                        // uses — the `Bridge` invoker, NEVER the `Registry` invoker.
                        // This is what keeps a plugin tool off the MCP registry: it
                        // cannot call `threads__*`/memory/`search_conversations` and
                        // so cannot bypass the ORG-BOUND ACL principal gates.
                        let Some(state) = crate::learning::global_state() else {
                            return Err(anyhow!(
                                "inline tool '{tool_id}' unavailable: server state not initialized"
                            ));
                        };
                        let bridge = std::sync::Arc::new(crate::plugin_host::PluginHookBridge::new(
                            resolved.plugin_id.clone(),
                            resolved.grants.clone(),
                            state,
                        ));
                        let invoker =
                            std::sync::Arc::new(crate::tool_exec::SandboxToolInvoker::bridge(bridge));
                        let program =
                            crate::tool_exec::build_inline_tool_program(&arguments, &code);
                        // Lower the owning manifest's unified permission set to the
                        // Deno sandbox. `None` (no `permissions` block) keeps the
                        // historical deny-all posture; a declared set opens exactly
                        // the FS/net/subprocess it names.
                        //
                        // A `child_process`-capable inline tool reaches Ryu's
                        // capability broker through PATH shims. Materialize this
                        // plugin's cap-shims and hand the sandbox a SCOPED
                        // `--allow-run` allow-list (the shim NAMES — Deno's allow-run
                        // matches the spawned program name, never a directory) plus
                        // the env the shims authenticate the broker with: the
                        // shim-prepended `PATH` + `RYU_CORE_PORT` (via
                        // `inject_shim_env`) and the per-plugin
                        // `RYU_EXT_TOKEN`/`RYU_EXT_PLUGIN_ID`. The token is layered
                        // POST-scrub inside the backend so it is delivered (not
                        // stripped by the secret-key env scrubber). Best-effort: any
                        // failure logs and falls back to today's bare `--allow-run`
                        // + no shim env, never blocking the tool call.
                        let augment = if resolved
                            .permissions
                            .as_ref()
                            .is_some_and(|p| p.child_process)
                        {
                            build_cap_shim_augment(&resolved.plugin_id).await
                        } else {
                            ryu_tool_exec::SandboxAugment::default()
                        };
                        // Box the sandbox future: `run_sandboxed*` → the `Bridge`
                        // invoker can transitively re-enter tool dispatch, so this
                        // edge must be boxed to keep the async future finite-sized.
                        // Called on the crate directly (not via the `crate::tool_exec`
                        // facade) so the wiring stays inside this change's file set.
                        let outcome = Box::pin(ryu_tool_exec::run_sandboxed_with_augment(
                            program,
                            invoker,
                            &resolved.plugin_id,
                            resolved.permissions.as_ref(),
                            &augment,
                        ))
                        .await;
                        return match outcome {
                            crate::tool_exec::ExecOutcome::Completed {
                                result,
                                is_error,
                                error,
                                ..
                            } => {
                                if is_error {
                                    Err(anyhow!(
                                        "inline tool '{tool_id}' failed: {}",
                                        error.unwrap_or_default()
                                    ))
                                } else {
                                    Ok(result.unwrap_or(Value::Null))
                                }
                            }
                            crate::tool_exec::ExecOutcome::Paused { .. } => Err(anyhow!(
                                "inline tool '{tool_id}' paused (unsupported for tools)"
                            )),
                        };
                    }
                    ToolBackend::Http { url, method } => {
                        // Gateway-governed egress; the domain grant is checked first
                        // (deterministic refusal) inside `run_http_tool`.
                        return crate::tool_exec::run_http_tool(
                            &url,
                            &method,
                            arguments,
                            &resolved.grants,
                            &resolved.plugin_id,
                            session_id.as_deref(),
                        )
                        .await
                        .map_err(|e| anyhow!(e));
                    }
                    // Alias: fall through to the legacy re-enter (target is `slug`,
                    // which equals the split `tool` — byte-identical to before).
                    ToolBackend::Alias { .. } => {}
                }
            }

            // Guard against an app tool aliasing another app tool (loop / privilege
            // chain) or an empty target.
            if tool.is_empty() || tool.starts_with(APP_TOOL_PREFIX) {
                return Err(anyhow!(
                    "app tool '{tool_id}' has an invalid target '{tool}'"
                ));
            }
            // Re-enter for the target. The recursive future is boxed because an
            // async fn cannot name its own type. No allowlist: the app-layer check
            // above is the gate; the target is manifest-fixed. Use the NO-GATE
            // entry: the approval gate (if any) applies to the granted `app__` id,
            // not to the manifest-fixed target — otherwise an app tool would raise
            // a second approval for its inner target.
            return Box::pin(self.call_tool_with_identity_no_gate(
                tool,
                arguments,
                None,
                user_id,
                &[],
                None,
                host_conversation_id,
            ))
            .await;
        }

        // In-process Ryu Apps provider (widget-rendering tools). Allowlist-gated
        // like the other built-ins. Widget-initiated `callTool`s additionally
        // require the tool to be `widget_accessible` — enforced upstream at
        // `/api/widgets/tools/call` (provenance gate), not here.
        if apps::owns(server) {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let ctx = apps::AppDispatchCtx {
                http: &self.http,
                worktree_diffs: self.worktree_diffs.as_ref(),
                conversation_id: session_id.clone(),
                agent_id: None,
                user_id: user_id.map(str::to_owned),
            };
            return apps::dispatch(server, tool, arguments, ctx).await;
        }

        // Built-in Shadow provider (U15): dispatched over HTTP.
        if server == shadow::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return shadow::dispatch(&self.http, tool, arguments).await;
        }

        // Built-in Spider provider (U040): dispatched by shelling out to the binary.
        if server == spider::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return spider::dispatch(tool, arguments).await;
        }

        // Built-in Research provider: dispatched over HTTP to the sidecar.
        // Degrades gracefully to `available: false` when the sidecar is down.
        if server == research::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                    ..Default::default()
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return research::dispatch(&self.http, tool, arguments).await;
        }

        // Built-in RTK provider: dispatched by shelling out to the `rtk` binary
        // (detect-on-PATH). Degrades gracefully to `available: false` when absent.
        if server == rtk::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return rtk::dispatch(tool, arguments).await;
        }

        // Built-in Exa provider (U040): dispatched over HTTP with a BYOK key.
        if server == exa::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return exa::dispatch(&self.http, tool, arguments).await;
        }

        // Built-in wasmtime sandbox provider (M6 / issue #190).
        if server == sandbox::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return sandbox::dispatch(tool, arguments).await;
        }

        // Built-in desktop-notification provider (#456): dispatched in-process,
        // publishing to the events channel the desktop subscribes to.
        if server == notify_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return notify_tool::dispatch(tool, arguments).await;
        }

        // Built-in artifact provider: saves a generated file into a Space (default
        // Artifacts). Dispatched in-process against the wired SpaceStore.
        if server == artifact_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return artifact_tool::dispatch(tool, arguments, self.spaces.as_ref()).await;
        }

        // Built-in generative-UI provider: client-rendered (no-op in Core). The
        // desktop renders the spec from the tool input; dispatch only sanity-checks.
        if server == ui_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return ui_tool::dispatch(tool, arguments).await;
        }

        // Built-in send-to-channel provider (#456): posts to a Slack/Discord
        // incoming-webhook URL over HTTP.
        if server == channel_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return channel_tool::dispatch(&self.http, tool, arguments).await;
        }

        // Built-in semantic conversation-history search. Allowlist-gated like the
        // other built-ins; reports the index unavailable (not an error) when the
        // conversation store is not wired (test / CLI contexts).
        if server == search_conversations::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let Some(store) = self.conversations.as_ref() else {
                return Ok(serde_json::json!({
                    "ok": false,
                    "available": false,
                    "error": "conversation search is not available on this node",
                    "results": [],
                    "count": 0
                }));
            };
            // The agent plane's authorization principal (see `ToolPrincipal`).
            let principal = ToolPrincipal::resolve(store, host_conversation_id).await;
            if principal.is_unresolved() {
                // BOUND node + no resolvable principal ⇒ fail closed. Agents already
                // degrade gracefully on the `available: false` envelope, so this is
                // not a new failure mode.
                return Ok(serde_json::json!({
                    "ok": false,
                    "available": false,
                    "error": "conversation search is not available: this agent turn has no identifiable owner on a shared node",
                    "results": [],
                    "count": 0
                }));
            }
            return search_conversations::dispatch(tool, arguments, store, &principal).await;
        }

        // Built-in coordinator-threads provider (Codex-style cross-thread
        // orchestration). Allowlist-gated like the other built-ins so coordination
        // is opt-in per agent; reports unavailable (not an error) when the
        // conversation store is not wired. `send_message_to_thread` further checks
        // the global agent runner and degrades gracefully when it is absent.
        if server == threads::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let Some(store) = self.conversations.as_ref() else {
                return Ok(serde_json::json!({
                    "ok": false,
                    "available": false,
                    "error": "coordinator threads are not available on this node"
                }));
            };
            // The agent plane's authorization principal (see `ToolPrincipal`).
            let principal = ToolPrincipal::resolve(store, host_conversation_id).await;
            if principal.is_unresolved() {
                return Ok(serde_json::json!({
                    "ok": false,
                    "available": false,
                    "error": "coordinator threads are not available: this agent turn has no identifiable owner on a shared node"
                }));
            }
            return threads::dispatch(tool, arguments, store, &principal).await;
        }

        // Built-in delegation provider (ephemeral parallel sub-agent fan-out).
        // Allowlist-gated like the other built-ins so it is opt-in when an agent
        // carries an explicit allowlist, and offered by default when it does not.
        // Needs no conversation store; the engine routes each delegate through the
        // global agent runner (or the gateway default LLM when no runner is wired).
        if server == delegate::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return delegate::dispatch(tool, arguments).await;
        }

        // Built-in orchestration discovery provider: list peer agents by
        // description so an orchestrator can pick a specialist to delegate to.
        // Allowlist-gated like the other built-ins. Reads the agent config store
        // (wired via `with_agent_store`), so it fails clearly if that is absent.
        if server == orchestrator::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let store = self.agent_store.clone().ok_or_else(|| {
                anyhow!(
                    "orchestrator tool '{tool_id}' called but agent_store is not wired; \
                     call McpRegistry::with_agent_store at startup"
                )
            })?;
            return orchestrator::dispatch(tool, arguments, store, None).await;
        }

        // Built-in skills provider (progressive disclosure): discover + load Agent
        // Skills on demand. Allowlist-gated like the other built-ins (offered by
        // default to an unrestricted agent such as the flagship `ryu`). Returns
        // instruction text, never executes it — a skill stays instruction text.
        if server == skills_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let Some(skills) = self.skills.as_ref() else {
                return Ok(serde_json::json!({
                    "ok": false,
                    "available": false,
                    "error": "skills are not available on this node"
                }));
            };
            return skills_tool::dispatch(tool, arguments, skills).await;
        }

        // Built-in advisor tool — consult a stronger reviewer model. Always
        // available (the Gateway call needs only the registry's http client); the
        // preferences store, when wired, supplies the configured `advisor-model`.
        if server == advisor::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return advisor::dispatch(tool, arguments, &self.http, self.preferences.as_ref()).await;
        }

        // Built-in authenticated web-fetch provider (Identity Vault consumer):
        // fetches a page over HTTPS, injecting the user's sealed session for the
        // URL's domain (resolved by the consult above) server-side. The credential
        // is passed out-of-band — never through `arguments`, never to the model.
        if server == web_fetch::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return web_fetch::dispatch(tool, arguments, injected_credential).await;
        }

        // Built-in self-build provider (U57): scaffold_runnable, install_app,
        // write_ryu_json. Dispatched in-process; requires `self_build_manifests`
        // and `self_build_app_store` to be wired via `with_self_build`.
        if server == crate::runnable::self_build::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let manifests = self.self_build_manifests.clone().ok_or_else(|| {
                anyhow!(
                    "self-build tool '{tool_id}' called but self_build context is not wired; \
                     call McpRegistry::with_self_build at startup"
                )
            })?;
            let app_store = self.self_build_app_store.clone().ok_or_else(|| {
                anyhow!("self-build tool '{tool_id}' called but self_build app_store is not wired")
            })?;
            return crate::runnable::self_build::dispatch(tool, arguments, manifests, app_store)
                .await;
        }

        // Built-in agent-builder provider: get_agent, configure_agent,
        // create_agent. Lets the builder meta-agent edit an agent record in
        // chat. Requires `agent_store` wired via `with_agent_store` at startup.
        if server == crate::runnable::agent_builder::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            let store = self.agent_store.clone().ok_or_else(|| {
                anyhow!(
                    "agent_builder tool '{tool_id}' called but agent_store is not wired; \
                     call McpRegistry::with_agent_store at startup"
                )
            })?;
            return crate::runnable::agent_builder::dispatch(
                tool,
                arguments,
                store,
                self.teams_client.clone(),
            )
            .await;
        }

        // Built-in workflow-builder provider: get_workflow, create_workflow,
        // configure_workflow. Lets the builder meta-agent author a workflow
        // definition in chat. Backed by the global file-backed workflow store, so
        // no handle needs wiring (unlike agent_builder).
        if server == crate::runnable::workflow_builder::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return crate::runnable::workflow_builder::dispatch(tool, arguments).await;
        }

        // Built-in dashboard-builder provider: get_dashboard, create_dashboard,
        // configure_dashboard. Lets the builder meta-agent author a Home
        // dashboard's widget grid in chat. Backed by the process-global dashboard
        // engine, so no handle needs wiring (like workflow_builder).
        if server == crate::runnable::dashboard_builder::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool::candidate(tool_id, server, tool);
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return crate::runnable::dashboard_builder::dispatch(tool, arguments).await;
        }

        // Extract owned values under the read lock; drop the guard before .await.
        let (enabled, cmd) = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            let cfg = servers
                .get(server)
                .ok_or_else(|| anyhow!("unknown MCP server: {server}"))?;
            if !cfg.enabled {
                return Err(anyhow!("MCP server '{server}' is disabled"));
            }
            (cfg.enabled, cfg.to_command())
        };

        if !enabled {
            return Err(anyhow!("MCP server '{server}' is disabled"));
        }

        // Enforce the per-agent allowlist before spawning anything.
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }

        client::call_tool(&cmd, tool, arguments).await
    }

    /// Register an in-memory tool exposed by an enabled app (tool-as-Runnable,
    /// M3). The tool is immediately visible in `list_all_tools()` without any
    /// process spawn. If a tool with the same id is already registered, the
    /// existing entry is replaced so re-enabling an app is idempotent.
    ///
    /// The `server` field is set to `"app"` so the tool can be found in
    /// allowlists with the entry `"app"`.
    pub fn register_app_tool(&self, id: String, name: String, description: Option<String>) {
        let tool = RegistryTool {
            description,
            ..RegistryTool::candidate(&id, APP_TOOL_SERVER, &name)
        };
        if let Ok(mut tools) = self.app_tools.lock() {
            tools.retain(|t| t.id != id);
            tools.push(tool);
        }
    }

    /// Remove an app-registered tool by id. Called when a plugin is disabled so
    /// its tools stop being listable, searchable, and callable. Idempotent:
    /// removing an id that isn't present is a no-op.
    pub fn unregister_app_tool(&self, id: &str) {
        if let Ok(mut tools) = self.app_tools.lock() {
            tools.retain(|t| t.id != id);
        }
    }

    /// Resolve the dispatch backend + grants for an `app__<slug>` tool id by
    /// scanning the LIVE enabled-plugin manifests (the same source
    /// `plugin_host::collect_enabled_hooks` reads). Returns `None` when the
    /// registry has no self-build wiring (bare/test registries) or no enabled
    /// plugin owns this id — the dispatcher then falls back to the legacy alias
    /// behavior, so this is purely additive.
    ///
    /// Never holds the `app_tools` mutex (or any std lock) across the `.await`s.
    async fn resolve_app_tool_backend(&self, tool_id: &str) -> Option<ResolvedAppTool> {
        let manifests = self.self_build_manifests.as_ref()?;
        let store = self.self_build_app_store.as_ref()?;

        // Only enabled plugins may own a live tool (matches the hook collector).
        let enabled: std::collections::HashSet<String> = store
            .list()
            .await
            .ok()?
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect();
        if enabled.is_empty() {
            return None;
        }

        let guard = manifests.read().await;
        for manifest in guard.iter() {
            if !enabled.contains(&manifest.id) {
                continue;
            }
            for entry in &manifest.runnables {
                if entry.kind != crate::runnable::RunnableKind::Tool {
                    continue;
                }
                let Some(cfg) = entry
                    .config
                    .as_ref()
                    .and_then(|v| {
                        serde_json::from_value::<crate::plugin_manifest::schema::ToolConfig>(
                            v.clone(),
                        )
                        .ok()
                    })
                else {
                    continue;
                };
                if format!("{APP_TOOL_PREFIX}{}", cfg.slug) != tool_id {
                    continue;
                }
                // A malformed backend was already rejected at manifest validation;
                // if it somehow fails here, skip (dispatcher falls back to alias).
                let backend = cfg.resolve_backend().ok()?;
                let grants: std::collections::HashSet<String> =
                    manifest.permission_grants.iter().cloned().collect();
                return Some(ResolvedAppTool {
                    backend,
                    grants,
                    plugin_id: manifest.id.clone(),
                    permissions: manifest.permissions.clone(),
                });
            }
        }
        None
    }

    /// Number of registered servers (for diagnostics/tests).
    pub fn len(&self) -> usize {
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .is_empty()
    }
}

/// Build the [`ryu_tool_exec::SandboxAugment`] for a `child_process`-capable
/// inline plugin tool: materialize the plugin's capability CLI shims and return a
/// scoped `--allow-run` allow-list (the shim program NAMES) plus the env the shims
/// authenticate the broker with.
///
/// The env layers, in order: the shim-prepended `PATH` + `RYU_CORE_PORT`
/// (`cli_shims::inject_shim_env`) and the per-plugin `RYU_EXT_TOKEN` +
/// `RYU_EXT_PLUGIN_ID` (`ext_proxy::ext_token`) — the same three vars a native
/// sidecar receives at spawn. These are handed to the backend as `extra_env` and
/// applied AFTER the secret-key scrub, so the freshly-minted token is delivered
/// rather than stripped (the scrubber blocks LEAKING Core's inherited secrets, not
/// the host handing the child a token minted for exactly this run).
///
/// Best-effort: on a materialize failure it logs and returns
/// [`ryu_tool_exec::SandboxAugment::default`] (today's bare `--allow-run`, no shim
/// env), never blocking the tool call.
async fn build_cap_shim_augment(plugin_id: &str) -> ryu_tool_exec::SandboxAugment {
    let plugin_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir().join(plugin_id);
    // The plugin's DECLARED capability edges → convenience-alias shims + the
    // scoped run allow-list. Empty is fine (the `ryu-cap` multiplexer still covers
    // every capability); only the convenience aliases are gated on this set.
    let declared: Vec<String> = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == plugin_id)
        .map(|m| {
            m.required_capabilities()
                .iter()
                .map(|c| c.capability.clone())
                .collect()
        })
        .unwrap_or_default();

    match crate::sidecar::cli_shims::materialize(&plugin_dir, &declared).await {
        Ok(shim_dir) => {
            let mut env = std::collections::BTreeMap::new();
            crate::sidecar::cli_shims::inject_shim_env(&mut env, &shim_dir);
            let token = crate::sidecar::ext_proxy::ext_token(
                crate::sidecar::ext_proxy::node_token().as_deref(),
                plugin_id,
            );
            env.insert(
                crate::sidecar::ext_proxy::ENV_EXT_TOKEN.to_owned(),
                token,
            );
            env.insert(
                crate::sidecar::ext_proxy::ENV_EXT_PLUGIN_ID.to_owned(),
                plugin_id.to_owned(),
            );
            ryu_tool_exec::SandboxAugment {
                run_allow: crate::sidecar::cli_shims::shim_names(&declared),
                extra_env: env.into_iter().collect(),
            }
        }
        Err(e) => {
            tracing::warn!(
                plugin_id = %plugin_id,
                error = %e,
                "could not materialize capability CLI shims for inline tool; \
                 running with bare --allow-run and no shim env"
            );
            ryu_tool_exec::SandboxAugment::default()
        }
    }
}

/// Best-effort check of whether a server's `command` is present on disk.
///
/// An absolute or relative path (e.g. the built-in Ghost binary at
/// `~/.ryu/bin/ghost`) can be checked with a filesystem probe, surfacing a
/// clear "not yet available" state in `GET /api/mcp/servers` before the user
/// installs the sidecar. A bare command resolved via `PATH` (e.g. `npx`,
/// `uvx`) returns `None` — we don't walk `PATH` here; the lazy `tools/list`
/// already degrades gracefully if such a server can't be spawned.
fn command_availability(command: &str) -> Option<bool> {
    let path = std::path::Path::new(command);
    let looks_like_path = path.is_absolute() || command.contains(['/', '\\']);
    if looks_like_path {
        Some(path.exists())
    } else {
        None
    }
}

/// The fully-qualified id of the privileged agent-creation tool — gated by
/// [`AgentCapabilities::can_create_agents`]. Other `agent_builder__*` tools
/// (read/configure existing agents) are not creation and stay available.
pub const CREATE_AGENT_TOOL_ID: &str = "agent_builder__create_agent";

/// The fully-qualified id of the team-creation tool. It mints permanent agents
/// (a whole roster), so it is gated by the same [`AgentCapabilities::can_create_agents`]
/// as [`CREATE_AGENT_TOOL_ID`].
pub const CREATE_AGENT_TEAM_TOOL_ID: &str = "agent_builder__create_agent_team";

/// An agent's orchestration capabilities, resolved from its config record.
#[derive(Debug, Clone, Copy)]
pub struct AgentCapabilities {
    /// May discover peers (`orchestrator__*`) and delegate to them (`delegate__*`).
    pub orchestrator: bool,
    /// May mint new agents (`agent_builder__create_agent`).
    pub can_create_agents: bool,
}

impl Default for AgentCapabilities {
    /// The safe defaults: delegation **on** (historical default-available
    /// behaviour), agent-creation **off** (privileged, opt-in per agent).
    fn default() -> Self {
        Self {
            orchestrator: true,
            can_create_agents: false,
        }
    }
}

/// Remove capability-gated tools from an offered set per an agent's
/// [`AgentCapabilities`]. Withholds the delegation/discovery providers when
/// `orchestrator` is off and the agent-creation tool when `can_create_agents`
/// is off. Tools unrelated to these capabilities pass through untouched.
pub fn filter_capability_tools(
    tools: Vec<RegistryTool>,
    caps: AgentCapabilities,
) -> Vec<RegistryTool> {
    tools
        .into_iter()
        .filter(|tool| {
            if !caps.orchestrator
                && (tool.server == delegate::SERVER_NAME
                    || tool.server == orchestrator::SERVER_NAME)
            {
                return false;
            }
            if !caps.can_create_agents
                && (tool.id == CREATE_AGENT_TOOL_ID || tool.id == CREATE_AGENT_TEAM_TOOL_ID)
            {
                return false;
            }
            true
        })
        .collect()
}

/// Whether `tool` passes an allowlist. A list entry matches if it equals the
/// tool's fully-qualified id, its bare name, or its owning server name.
pub(super) fn tool_allowed(tool: &RegistryTool, allowlist: &[String]) -> bool {
    allowlist
        .iter()
        .any(|entry| entry == &tool.id || entry == &tool.name || entry == &tool.server)
}

impl Default for McpRegistry {
    fn default() -> Self {
        Self::empty()
    }
}

/// Name under which the built-in self-build MCP server (U57) is registered.
pub use crate::runnable::self_build::SERVER_NAME as SELF_BUILD_SERVER;

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that mutate the process-global `RYU_MCP_CONFIG` env
    /// var (they point `load`/`reload` at different temp configs). Poison-tolerant.
    static MCP_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_mcp_env() -> std::sync::MutexGuard<'static, ()> {
        MCP_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sample_tool() -> RegistryTool {
        RegistryTool::candidate("fs__read_file", "fs", "read_file")
    }

    #[test]
    fn allowlist_none_allows_all() {
        let t = sample_tool();
        assert!(McpRegistry::tools_for_agent_matches(&t, None));
    }

    #[test]
    fn allowlist_matches_fully_qualified_id() {
        let t = sample_tool();
        assert!(tool_allowed(&t, &["fs__read_file".to_owned()]));
    }

    #[test]
    fn allowlist_matches_bare_name() {
        let t = sample_tool();
        assert!(tool_allowed(&t, &["read_file".to_owned()]));
    }

    #[test]
    fn allowlist_matches_server_name() {
        let t = sample_tool();
        assert!(tool_allowed(&t, &["fs".to_owned()]));
    }

    #[test]
    fn allowlist_rejects_unlisted() {
        let t = sample_tool();
        assert!(!tool_allowed(&t, &["other__tool".to_owned()]));
        assert!(!tool_allowed(&t, &[]));
    }

    #[test]
    fn tool_id_round_trips() {
        let id = McpRegistry::tool_id("git", "commit");
        assert_eq!(id, "git__commit");
        assert_eq!(McpRegistry::split_tool_id(&id), Some(("git", "commit")));
    }

    #[test]
    fn builtin_includes_ghost_with_mcp_subcommand() {
        let builtins = McpRegistry::builtin_servers();
        let ghost = builtins
            .get(GHOST_SERVER)
            .expect("ghost built-in is registered");
        assert_eq!(ghost.args, vec!["mcp".to_owned()]);
        assert!(ghost.enabled);
        // Command must resolve to the ghost binary, not a bare name.
        let cmd = ghost.command.to_lowercase();
        assert!(
            cmd.ends_with("ghost") || cmd.ends_with("ghost.exe"),
            "unexpected ghost command: {}",
            ghost.command
        );
    }

    #[test]
    fn load_survives_missing_config_and_keeps_builtins() {
        let _lock = lock_mcp_env();
        // Point at a path that cannot exist so `load()` takes the NotFound arm.
        let missing = std::env::temp_dir().join("ryu-mcp-does-not-exist-u14.json");
        let _ = std::fs::remove_file(&missing);
        std::env::set_var("RYU_MCP_CONFIG", &missing);
        let reg = McpRegistry::load();
        std::env::remove_var("RYU_MCP_CONFIG");
        assert!(
            reg.servers.read().expect("lock").contains_key(GHOST_SERVER),
            "ghost built-in must survive a missing config"
        );
    }

    #[test]
    fn availability_probes_paths_only() {
        // A bare command (PATH-resolved) is unknown.
        assert_eq!(command_availability("npx"), None);
        // A path-like command is probed; a guaranteed-missing path is false.
        let missing = if cfg!(windows) {
            "C:\\ryu-u14-nope\\ghost.exe"
        } else {
            "/ryu-u14-nope/ghost"
        };
        assert_eq!(command_availability(missing), Some(false));
    }

    #[test]
    fn config_parses_mcp_servers_map() {
        let json = r#"{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
                "git": { "command": "uvx", "args": ["mcp-server-git"], "enabled": false }
            }
        }"#;
        let file: McpConfigFile = serde_json::from_str(json).unwrap();
        assert_eq!(file.mcp_servers.len(), 2);
        assert!(file.mcp_servers["fs"].enabled);
        assert!(!file.mcp_servers["git"].enabled);
        let reg = McpRegistry::from_servers(file.mcp_servers);
        assert_eq!(reg.len(), 2);
        // Two config servers plus the 16 always-present built-in providers
        // (shadow, spider, research, rtk, exa, web_fetch, sandbox, notify,
        // channel, search_conversations, threads, delegate, orchestrator,
        // skills, advisor, ui) — all unconditionally listed by
        // `server_summaries`. `research` (the autoresearch experiment runner)
        // was added in 94060a75 alongside the research sidecar.
        let summaries = reg.server_summaries();
        assert_eq!(summaries.len(), 18);
        assert!(summaries.iter().any(|s| s.name == shadow::SERVER_NAME));
        assert!(summaries.iter().any(|s| s.name == spider::SERVER_NAME));
        assert!(summaries.iter().any(|s| s.name == exa::SERVER_NAME));
        assert!(summaries.iter().any(|s| s.name == sandbox::SERVER_NAME));
        assert!(summaries
            .iter()
            .any(|s| s.name == search_conversations::SERVER_NAME));
    }

    #[test]
    fn builtin_tools_are_always_listed_even_with_no_config() {
        let reg = McpRegistry::empty();
        // `list_all_tools` is async but built-in tools are produced synchronously
        // (no I/O for listing); verify each provider surface directly.
        let shadow_tools = shadow::tools();
        assert!(!shadow_tools.is_empty());
        assert!(shadow_tools.iter().all(|t| t.server == shadow::SERVER_NAME));

        let spider_tools = spider::tools();
        assert!(!spider_tools.is_empty());
        assert!(spider_tools.iter().all(|t| t.server == spider::SERVER_NAME));

        let exa_tools = exa::tools();
        assert!(!exa_tools.is_empty());
        assert!(exa_tools.iter().all(|t| t.server == exa::SERVER_NAME));

        let web_fetch_tools = web_fetch::tools();
        assert!(!web_fetch_tools.is_empty());
        assert!(web_fetch_tools
            .iter()
            .all(|t| t.server == web_fetch::SERVER_NAME));

        // The built-in servers are always summarized.
        let summaries = reg.server_summaries();
        assert!(summaries.iter().any(|s| s.name == shadow::SERVER_NAME));
        assert!(summaries.iter().any(|s| s.name == spider::SERVER_NAME));
        assert!(summaries.iter().any(|s| s.name == exa::SERVER_NAME));
        assert!(summaries.iter().any(|s| s.name == web_fetch::SERVER_NAME));
        // web_fetch is recognized as a built-in server (allowlist/catalog).
        assert!(reg.contains_server(web_fetch::SERVER_NAME));
    }

    #[test]
    fn reload_picks_up_written_entry() {
        use std::io::Write as _;

        let _lock = lock_mcp_env();
        // Write a temp mcp.json with one user server.
        let dir = std::env::temp_dir().join(format!("ryu-mcp-reload-test-{}", uuid_simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg_path = dir.join("mcp.json");
        let json = r#"{"mcpServers":{"testserver":{"command":"npx","args":[]}}}"#;
        let mut f = std::fs::File::create(&cfg_path).unwrap();
        f.write_all(json.as_bytes()).unwrap();

        std::env::set_var("RYU_MCP_CONFIG", &cfg_path);
        let reg = McpRegistry::load();
        std::env::remove_var("RYU_MCP_CONFIG");

        assert!(
            reg.servers.read().expect("lock").contains_key("testserver"),
            "initial load must include testserver"
        );

        // Now update the file with a second entry and reload.
        let json2 = r#"{"mcpServers":{"testserver":{"command":"npx","args":[]},"testserver2":{"command":"uvx","args":[]}}}"#;
        std::fs::write(&cfg_path, json2).unwrap();

        std::env::set_var("RYU_MCP_CONFIG", &cfg_path);
        reg.reload();
        std::env::remove_var("RYU_MCP_CONFIG");

        assert!(
            reg.servers
                .read()
                .expect("lock")
                .contains_key("testserver2"),
            "reload must pick up new testserver2 entry"
        );
        // Built-ins survive reload.
        assert!(
            reg.servers.read().expect("lock").contains_key(GHOST_SERVER),
            "ghost built-in must survive reload"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn contains_server_includes_shadow_spider_exa_and_ghost() {
        let reg = McpRegistry::empty();
        // Shadow, Spider, and Exa are special built-ins not in `servers`.
        assert!(reg.contains_server(shadow::SERVER_NAME));
        assert!(reg.contains_server(spider::SERVER_NAME));
        assert!(reg.contains_server(exa::SERVER_NAME));
        // empty() has no ghost (no builtins), so it should not be found.
        assert!(!reg.contains_server(GHOST_SERVER));
        // A loaded registry includes ghost.
        let loaded = McpRegistry::from_servers(McpRegistry::builtin_servers());
        assert!(loaded.contains_server(GHOST_SERVER));
    }

    #[test]
    fn duplicate_server_name_detected() {
        let reg = McpRegistry::from_servers(McpRegistry::builtin_servers());
        // ghost is already in the built-ins.
        assert!(reg.contains_server(GHOST_SERVER));
        // shadow is always reserved.
        assert!(reg.contains_server(shadow::SERVER_NAME));
    }

    /// Small helper to generate a unique ID for test directories without pulling
    /// in uuid directly (the uuid crate is already a dev/build dep of Core).
    fn uuid_simple() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{t:x}")
    }

    // ── App-registered tool dispatch (tool-as-Runnable, M3) ────────────────────

    #[tokio::test]
    async fn app_tool_dispatch_resolves_target_not_app_server() {
        // Registering `app__foo__bar` then calling it must alias to `foo__bar`
        // (re-entering call_tool), NOT error with "unknown MCP server: app".
        let reg = McpRegistry::empty();
        reg.register_app_tool("app__foo__bar".into(), "foo__bar".into(), None);

        let err = reg
            .call_tool("app__foo__bar", serde_json::json!({}), None)
            .await
            .expect_err("foo is not a configured server, so dispatch must fail at the target");
        let msg = err.to_string();
        assert!(
            msg.contains("unknown MCP server: foo"),
            "alias must re-dispatch to the target server 'foo', got: {msg}"
        );
        assert!(
            !msg.contains("unknown MCP server: app"),
            "must NOT fall through to the generic 'app' server lookup: {msg}"
        );
    }

    #[tokio::test]
    async fn app_tool_unknown_id_is_rejected() {
        // An `app__`-prefixed id that no enabled app registered must be rejected,
        // not silently re-dispatched.
        let reg = McpRegistry::empty();
        let err = reg
            .call_tool("app__never__registered", serde_json::json!({}), None)
            .await
            .expect_err("unregistered app tool must be rejected");
        assert!(err.to_string().contains("unknown app tool"), "got: {err}");
    }

    #[tokio::test]
    async fn app_tool_enforces_allowlist_at_the_app_layer() {
        let reg = McpRegistry::empty();
        reg.register_app_tool("app__foo__bar".into(), "foo__bar".into(), None);

        // Not in the allowlist → rejected before any target dispatch.
        let denied = reg
            .call_tool(
                "app__foo__bar",
                serde_json::json!({}),
                Some(&["something_else".to_owned()]),
            )
            .await
            .expect_err("app tool absent from allowlist must be denied");
        assert!(
            denied.to_string().contains("not in this agent's allowlist"),
            "got: {denied}"
        );

        // Allowlisting the `app` server passes the app-layer gate; the call then
        // re-dispatches to the target (which fails at the unknown target server,
        // proving the gate was passed).
        let passed = reg
            .call_tool(
                "app__foo__bar",
                serde_json::json!({}),
                Some(&["app".to_owned()]),
            )
            .await
            .expect_err("target server 'foo' is unknown");
        assert!(
            passed.to_string().contains("unknown MCP server: foo"),
            "allowlisting 'app' must let the alias re-dispatch to its target: {passed}"
        );
    }

    #[tokio::test]
    async fn app_tool_rejects_aliasing_another_app_tool() {
        // Guard against an app tool whose target is itself an `app__` id
        // (privilege chain / loop).
        let reg = McpRegistry::empty();
        reg.register_app_tool("app__app__x".into(), "app__x".into(), None);
        let err = reg
            .call_tool("app__app__x", serde_json::json!({}), None)
            .await
            .expect_err("app→app aliasing must be rejected");
        assert!(err.to_string().contains("invalid target"), "got: {err}");
    }

    #[tokio::test]
    async fn unregister_app_tool_makes_it_uncallable() {
        let reg = McpRegistry::empty();
        reg.register_app_tool("app__foo__bar".into(), "foo__bar".into(), None);
        reg.unregister_app_tool("app__foo__bar");
        let err = reg
            .call_tool("app__foo__bar", serde_json::json!({}), None)
            .await
            .expect_err("unregistered app tool must be uncallable");
        assert!(err.to_string().contains("unknown app tool"), "got: {err}");
    }

    // ── plugin-tools: net-new tool backends (inline_deno + http) ────────────────

    use crate::plugin_manifest::schema::{RunnableEntry as PmRunnableEntry, ToolBackend};
    use crate::plugin_manifest::PluginManifest;
    use crate::runnable::RunnableKind;

    /// Build a registry wired with a single enabled plugin whose manifest carries
    /// the given tool runnables + grants — the same `with_self_build` seam prod
    /// uses (`main.rs`), so dispatch can resolve each tool's backend live.
    async fn registry_with_plugin(
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

    fn tool_entry(id: &str, cfg: serde_json::Value) -> PmRunnableEntry {
        PmRunnableEntry {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: RunnableKind::Tool,
            config: Some(cfg),
        }
    }

    #[tokio::test]
    async fn plugin_inline_deno_tool_is_discoverable_and_resolves_not_alias() {
        // A plugin ships an inline_deno tool (NEW behavior, not an alias).
        let reg = registry_with_plugin(
            "com.test.tools",
            vec!["tool:execute"],
            vec![tool_entry(
                "weather",
                serde_json::json!({
                    "slug": "weather",
                    "backend": "inline_deno",
                    "code": "return await ((input, host) => ({ city: input.city, ok: true }))(input, host);",
                    "description": "Look up weather",
                }),
            )],
        )
        .await;
        // Discovery: register it the way the server Tool handler does, then confirm
        // it shows up in the flat tool listing that backs `/api/tools/search`.
        reg.register_app_tool(
            "app__weather".into(),
            "weather".into(),
            Some("Look up weather".into()),
        );
        let all = reg.list_all_tools().await;
        assert!(
            all.iter().any(|t| t.id == "app__weather"),
            "inline_deno tool must be discoverable via the tool listing"
        );

        // It resolves to the inline_deno backend — NOT an alias.
        let resolved = reg
            .resolve_app_tool_backend("app__weather")
            .await
            .expect("enabled plugin owns app__weather");
        assert!(
            matches!(resolved.backend, ToolBackend::InlineDeno { .. }),
            "must resolve to inline_deno, not alias"
        );
        assert!(resolved.grants.contains("tool:execute"));

        // Calling it takes the inline sandbox path, never the alias re-enter. With
        // no `deno` binary + no global ServerState in the test harness it fails on
        // the runtime, but the message proves it is NOT the alias path (which would
        // say "unknown MCP server: weather").
        let err = reg
            .call_tool("app__weather", serde_json::json!({ "city": "SG" }), None)
            .await
            .err();
        if let Some(e) = err {
            let msg = e.to_string();
            assert!(
                !msg.contains("unknown MCP server"),
                "inline tool must NOT fall through the alias path, got: {msg}"
            );
            assert!(
                msg.contains("inline tool"),
                "expected an inline-runtime error, got: {msg}"
            );
        }
        // If a real Deno backend + ServerState were present the call would succeed;
        // that path is exercised only when `tool_exec::is_available()`.
    }

    #[tokio::test]
    async fn plugin_http_tool_ungranted_domain_is_refused() {
        // A plugin ships an http tool but holds NO egress grant for its domain.
        let reg = registry_with_plugin(
            "com.test.http",
            vec!["tool:execute"], // note: no tool:http-egress:api.example.com
            vec![tool_entry(
                "quote",
                serde_json::json!({
                    "slug": "quote",
                    "backend": "http",
                    "url": "https://api.example.com/quote",
                }),
            )],
        )
        .await;
        reg.register_app_tool("app__quote".into(), "quote".into(), None);

        let err = reg
            .call_tool("app__quote", serde_json::json!({ "q": "hi" }), None)
            .await
            .expect_err("ungranted http egress domain must be refused");
        let msg = err.to_string();
        assert!(
            msg.contains("not granted") && msg.contains("api.example.com"),
            "expected a deterministic egress-grant refusal, got: {msg}"
        );
        assert!(
            msg.contains("tool:http-egress:api.example.com"),
            "refusal must name the required grant, got: {msg}"
        );
    }

    #[tokio::test]
    async fn plugin_inline_deno_tool_requires_tool_execute_grant() {
        // Same inline tool, but the plugin lacks `tool:execute` → refused before
        // any sandbox spawn (deterministic, no deno needed).
        let reg = registry_with_plugin(
            "com.test.nogrant",
            vec![], // no grants
            vec![tool_entry(
                "weather",
                serde_json::json!({
                    "slug": "weather",
                    "backend": "inline_deno",
                    "code": "return await ((input, host) => ({ ok: true }))(input, host);",
                }),
            )],
        )
        .await;
        reg.register_app_tool("app__weather".into(), "weather".into(), None);

        let err = reg
            .call_tool("app__weather", serde_json::json!({}), None)
            .await
            .expect_err("inline tool without tool:execute must be refused");
        assert!(
            err.to_string().contains("tool:execute"),
            "refusal must name the required grant, got: {err}"
        );
    }

    // ── Unified widget promotion: dedup + the `widget:render` grant gate ──────

    /// A plugin manifest that declares `tool_id` in `contributes.widgets` with the
    /// given permission grants. The grant gate reads `permission_grants` (NOT the
    /// record's approved_grants), mirroring the app-tool backend resolver.
    fn widget_manifest(id: &str, tool_id: &str, grants: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            contributes: Some(crate::plugin_manifest::Contributes {
                widgets: vec![crate::plugin_manifest::WidgetContribution {
                    tool_id: tool_id.to_owned(),
                    uri: "ui://widget/checklist.html".to_owned(),
                    ui_entry: None,
                    mime: "text/html+skybridge".to_owned(),
                    default_display_mode: "inline".to_owned(),
                }],
                ..Default::default()
            }),
            permission_grants: grants.iter().map(|g| (*g).to_owned()).collect(),
            ..Default::default()
        }
    }

    /// A registry with `manifest` wired as the self-build governance context and a
    /// lifecycle record for `record_id` in the given enabled state. The record is
    /// enabled with EMPTY approved_grants on purpose — so a passing grant test
    /// proves the gate reads `manifest.permission_grants`, not the record.
    async fn registry_with_governance(
        manifest: PluginManifest,
        record_id: &str,
        enabled: bool,
    ) -> McpRegistry {
        let store = crate::plugins::PluginStore::open_in_memory().expect("in-memory store");
        store.insert(record_id, "1.0.0").await.expect("insert record");
        if enabled {
            store.set_enabled(record_id, &[]).await.expect("enable record");
        }
        let manifests = std::sync::Arc::new(TokioRwLock::new(vec![manifest]));
        McpRegistry::empty().with_self_build(manifests, std::sync::Arc::new(store))
    }

    #[tokio::test]
    async fn builtin_widget_promotes_via_unified_manifest_path() {
        // checklist__render binds through apps::tools(); with an enabled checklist
        // plugin record whose manifest holds widget:render, the unified resolver
        // promotes it — contributes.widgets is the source of record.
        let manifest = widget_manifest("checklist", "checklist__render", &[WIDGET_RENDER_GRANT]);
        let reg = registry_with_governance(manifest, "checklist", true).await;
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::Allow(_)
            ),
            "enabled + granted built-in app widget must promote via contributes.widgets"
        );
    }

    #[tokio::test]
    async fn widget_without_grant_is_refused() {
        // Same enabled record, but the manifest does NOT declare widget:render.
        let manifest =
            widget_manifest("checklist", "checklist__render", &["chat.sendFollowUp"]);
        let reg = registry_with_governance(manifest, "checklist", true).await;
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::DeniedNoGrant { .. }
            ),
            "an enabled plugin without widget:render must NOT auto-promote"
        );
        // The log-reducing wrapper yields no binding (text-only delivery).
        assert!(reg
            .widget_promotion_or_log("checklist__render")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn widget_with_grant_promotes() {
        let manifest = widget_manifest("checklist", "checklist__render", &[WIDGET_RENDER_GRANT]);
        let reg = registry_with_governance(manifest, "checklist", true).await;
        assert!(reg
            .widget_promotion_or_log("checklist__render")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn disabled_owner_refuses_widget() {
        let manifest = widget_manifest("checklist", "checklist__render", &[WIDGET_RENDER_GRANT]);
        let reg = registry_with_governance(manifest, "checklist", false).await;
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::DeniedDisabled { .. }
            ),
            "a disabled owning plugin must not render its widget"
        );
    }

    #[tokio::test]
    async fn bare_registry_fails_open_for_builtins() {
        // No governance context wired (tests / CLI / bare registry) → fail-open so
        // every built-in widget keeps binding (backward-compat rule 3).
        let reg = McpRegistry::empty();
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::Allow(_)
            ),
            "bare registry must fail open so built-in widgets keep rendering"
        );
    }

    #[tokio::test]
    async fn legacy_external_server_with_no_record_fails_open() {
        // Governance IS wired, but no installed manifest declares checklist__render
        // (the wired manifest claims a different tool). A tool no manifest claims is
        // the legacy external server case → fail OPEN (documented delegate).
        let manifest = widget_manifest("other-plugin", "other__render", &[WIDGET_RENDER_GRANT]);
        let reg = registry_with_governance(manifest, "other-plugin", true).await;
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::Allow(_)
            ),
            "an undeclared tool_id must fail open (legacy external delegate)"
        );
    }

    #[tokio::test]
    async fn non_widget_tool_yields_none() {
        // A companion (non-render) tool has no binding at all → no widget.
        let reg = McpRegistry::empty();
        assert!(matches!(
            reg.resolve_widget_promotion("checklist__update").await,
            WidgetPromotion::None
        ));
    }

    /// A synth MCP-server governance record (`category == MCP_SERVER_CATEGORY`,
    /// `id == server`), with an optional declared widget contribution.
    fn synth_mcp_manifest(server: &str, declared_widget: Option<&str>) -> PluginManifest {
        let contributes = declared_widget.map(|tid| crate::plugin_manifest::Contributes {
            widgets: vec![crate::plugin_manifest::WidgetContribution {
                tool_id: tid.to_owned(),
                uri: "ui://widget/checklist.html".to_owned(),
                ui_entry: None,
                mime: "text/html+skybridge".to_owned(),
                default_display_mode: "inline".to_owned(),
            }],
            ..Default::default()
        });
        PluginManifest {
            id: server.to_owned(),
            name: server.to_owned(),
            version: "1.0.0".to_owned(),
            category: Some(MCP_SERVER_CATEGORY.to_owned()),
            permission_grants: vec![WIDGET_RENDER_GRANT.to_owned()],
            contributes,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn recorded_mcp_server_undeclared_widget_fails_closed() {
        // Fix 2 / goal (c): an ENABLED synth MCP-server record owns the tool's
        // server namespace but its contributes.widgets is EMPTY (the state every
        // freshly catalog-installed third-party server is in). Even though the
        // tool advertises a widget binding, promotion must fail CLOSED — no
        // per-widget consent ⇒ no auto-promotion of sandboxed HTML.
        let manifest = synth_mcp_manifest("checklist", None);
        let reg = registry_with_governance(manifest, "checklist", true).await;
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::DeniedUndeclared { .. }
            ),
            "an enabled MCP-server record that never declared the widget must NOT auto-promote"
        );
        // The chat-path wrapper yields no binding → the result is delivered as text.
        assert!(reg
            .widget_promotion_or_log("checklist__render")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn recorded_mcp_server_disabled_undeclared_stays_closed() {
        // A DISABLED synth MCP-server record: still no widget (disabled owner).
        let manifest = synth_mcp_manifest("checklist", None);
        let reg = registry_with_governance(manifest, "checklist", false).await;
        assert!(matches!(
            reg.resolve_widget_promotion("checklist__render").await,
            WidgetPromotion::DeniedDisabled { .. }
        ));
    }

    #[tokio::test]
    async fn recorded_mcp_server_declared_widget_promotes() {
        // The closed loop opens: once spawn-time widget discovery records the
        // widget tool in the MCP server's contributes.widgets (and the record is
        // enabled + holds widget:render), the SAME unified path promotes it.
        let manifest = synth_mcp_manifest("checklist", Some("checklist__render"));
        let reg = registry_with_governance(manifest, "checklist", true).await;
        assert!(
            matches!(
                reg.resolve_widget_promotion("checklist__render").await,
                WidgetPromotion::Allow(_)
            ),
            "a declared + granted + enabled MCP-server widget must promote"
        );
    }
}

impl McpRegistry {
    /// Test-only helper mirroring `tools_for_agent`'s allow decision without I/O.
    #[cfg(test)]
    fn tools_for_agent_matches(tool: &RegistryTool, allowlist: Option<&[String]>) -> bool {
        match allowlist {
            None => true,
            Some(list) => tool_allowed(tool, list),
        }
    }
}
