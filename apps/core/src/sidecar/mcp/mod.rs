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

pub mod catalog;
pub mod channel_tool;
pub mod client;
pub mod composio;
pub mod delegate;
pub mod exa;
pub mod notify_tool;
pub mod sandbox;
pub mod search_conversations;
pub mod shadow;
pub mod skills_tool;
pub mod spider;
pub mod threads;
pub mod web_fetch;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock as TokioRwLock;

use client::{McpStdioCommand, McpTool};

use crate::plugin_manifest::PluginManifest;

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
#[derive(Debug, Clone, Serialize)]
pub struct RegistryTool {
    /// Fully-qualified id: `<server>__<tool>` — unique across servers.
    pub id: String,
    /// The server this tool belongs to.
    pub server: String,
    /// The tool's name as the MCP server reports it.
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
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

/// Separator between server name and tool name in a fully-qualified tool id.
const TOOL_ID_SEP: &str = "__";

/// Synthetic "server" name for tools an enabled plugin re-exposes
/// (tool-as-Runnable, M3). These ids look like `app__<target-tool-id>` and are
/// dispatched by aliasing to the target — see `call_tool_with_user`.
const APP_TOOL_SERVER: &str = "app";

/// Id prefix for app-registered tools (`APP_TOOL_SERVER` + `TOOL_ID_SEP`).
const APP_TOOL_PREFIX: &str = "app__";

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
    pub skills: Option<crate::skills::SkillRegistry>,
}

impl McpRegistry {
    /// Build an empty registry (no servers configured).
    pub fn empty() -> Self {
        Self {
            servers: RwLock::new(BTreeMap::new()),
            tool_cache: Mutex::new(BTreeMap::new()),
            app_tools: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
        }
    }

    /// Build a registry from a server map (used by config loading and tests).
    pub fn from_servers(servers: BTreeMap<String, McpServerConfig>) -> Self {
        Self {
            servers: RwLock::new(servers),
            tool_cache: Mutex::new(BTreeMap::new()),
            app_tools: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
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

    /// Wire the skill registry into the registry. Must be called after
    /// construction to enable the `skills` built-in tools (`skills__search` /
    /// `skills__load`, progressive disclosure of Agent Skills).
    pub fn with_skills(mut self, skills: crate::skills::SkillRegistry) -> Self {
        self.skills = Some(skills);
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
        let ghost = McpServerConfig {
            command: crate::sidecar::tools::ghost::ghost_bin_path()
                .to_string_lossy()
                .into_owned(),
            args: vec!["mcp".to_owned()],
            env: BTreeMap::new(),
            description: Some(
                "Ghost — desktop automation (29 tools: screen perception + input control). \
                 Windows-first; install the `ghost` sidecar to enable. Unavailable until installed."
                    .to_owned(),
            ),
            enabled: true,
        };
        let mut servers = BTreeMap::new();
        servers.insert(GHOST_SERVER.to_owned(), ghost);
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
            app_tools: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
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
        tracing::info!("McpRegistry: reloaded from disk");
    }

    /// Whether a server with the given `name` is already registered (built-ins
    /// included). The built-in Shadow, Spider, and Exa providers are synthesized
    /// only in `server_summaries()` and are NOT in `servers`, so they are checked
    /// by name explicitly.
    pub fn contains_server(&self, name: &str) -> bool {
        if name == shadow::SERVER_NAME
            || name == spider::SERVER_NAME
            || name == exa::SERVER_NAME
            || name == web_fetch::SERVER_NAME
            || name == sandbox::SERVER_NAME
            || name == notify_tool::SERVER_NAME
            || name == channel_tool::SERVER_NAME
            || name == search_conversations::SERVER_NAME
            || name == threads::SERVER_NAME
            || name == delegate::SERVER_NAME
            || name == skills_tool::SERVER_NAME
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
                name: skills_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in skills: discover and load Agent Skills on demand \
                     (skills__search / skills__load) instead of injecting every skill body \
                     up front — progressive disclosure for low-context models."
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
    pub(super) fn split_tool_id(id: &str) -> Option<(&str, &str)> {
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
            .map(|t| RegistryTool {
                id: Self::tool_id(name, &t.name),
                server: name.to_owned(),
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
            })
            .collect();

        if let Ok(mut cache) = self.tool_cache.lock() {
            cache.insert(name.to_owned(), tools.clone());
        }
        Ok(tools)
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
        all.extend(exa::tools());
        // Built-in authenticated web fetch (Identity Vault credential consumer).
        all.extend(web_fetch::tools());
        // Built-in wasmtime sandbox tools (M6 / issue #190) — always listed;
        // dispatch returns `available: false` when disabled or feature absent.
        all.extend(sandbox::tools());
        // Built-in actions (#456): desktop notification + send-to-channel.
        all.extend(notify_tool::tools());
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
        // Built-in skills tools — progressive disclosure (search + load Agent
        // Skills on demand). Always listed; dispatch reports unavailable when the
        // skill registry is not wired (test / CLI contexts).
        all.extend(skills_tool::tools());
        // Include self-build tools (U57) — always listed, dispatch fails gracefully
        // if the self_build context was not wired (test / CLI contexts).
        all.extend(crate::runnable::self_build::tools());
        // Agent-builder tools — chat edits an agent record. Dispatch fails
        // gracefully when the agent_store was not wired (test / CLI contexts).
        all.extend(crate::runnable::agent_builder::tools());
        // Workflow-builder tools — chat authors/edits a workflow definition.
        // Backed by the global file-backed workflow store (no handle to wire).
        all.extend(crate::runnable::workflow_builder::tools());
        for name in &names {
            match self.tools_for_server(name).await {
                Ok(tools) => all.extend(tools),
                Err(e) => tracing::warn!("MCP server '{name}' tools/list failed: {e}"),
            }
        }
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
        // no agent card). The richer `call_tool_with_identity` carries it.
        self.call_tool_with_identity(tool_id, arguments, allowlist, user_id, &[], None)
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
    pub async fn call_tool_with_identity(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
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
            session_id,
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
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
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
            // above is the gate; the target is manifest-fixed.
            return Box::pin(self.call_tool_with_user(tool, arguments, None, user_id)).await;
        }

        // Built-in Shadow provider (U15): dispatched over HTTP.
        if server == shadow::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return shadow::dispatch(&self.http, tool, arguments).await;
        }

        // Built-in Spider provider (U040): dispatched by shelling out to the binary.
        if server == spider::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return spider::dispatch(tool, arguments).await;
        }

        // Built-in Exa provider (U040): dispatched over HTTP with a BYOK key.
        if server == exa::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return exa::dispatch(&self.http, tool, arguments).await;
        }

        // Built-in wasmtime sandbox provider (M6 / issue #190).
        if server == sandbox::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return notify_tool::dispatch(tool, arguments).await;
        }

        // Built-in send-to-channel provider (#456): posts to a Slack/Discord
        // incoming-webhook URL over HTTP.
        if server == channel_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
            return search_conversations::dispatch(tool, arguments, store).await;
        }

        // Built-in coordinator-threads provider (Codex-style cross-thread
        // orchestration). Allowlist-gated like the other built-ins so coordination
        // is opt-in per agent; reports unavailable (not an error) when the
        // conversation store is not wired. `send_message_to_thread` further checks
        // the global agent runner and degrades gracefully when it is absent.
        if server == threads::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
            return threads::dispatch(tool, arguments, store).await;
        }

        // Built-in delegation provider (ephemeral parallel sub-agent fan-out).
        // Allowlist-gated like the other built-ins so it is opt-in when an agent
        // carries an explicit allowlist, and offered by default when it does not.
        // Needs no conversation store; the engine routes each delegate through the
        // global agent runner (or the gateway default LLM when no runner is wired).
        if server == delegate::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return delegate::dispatch(tool, arguments).await;
        }

        // Built-in skills provider (progressive disclosure): discover + load Agent
        // Skills on demand. Allowlist-gated like the other built-ins (offered by
        // default to an unrestricted agent such as the flagship `ryu`). Returns
        // instruction text, never executes it — a skill stays instruction text.
        if server == skills_tool::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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

        // Built-in authenticated web-fetch provider (Identity Vault consumer):
        // fetches a page over HTTPS, injecting the user's sealed session for the
        // URL's domain (resolved by the consult above) server-side. The credential
        // is passed out-of-band — never through `arguments`, never to the model.
        if server == web_fetch::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
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
            return crate::runnable::agent_builder::dispatch(tool, arguments, store).await;
        }

        // Built-in workflow-builder provider: get_workflow, create_workflow,
        // configure_workflow. Lets the builder meta-agent author a workflow
        // definition in chat. Backed by the global file-backed workflow store, so
        // no handle needs wiring (unlike agent_builder).
        if server == crate::runnable::workflow_builder::SERVER_NAME {
            if let Some(list) = allowlist {
                let candidate = RegistryTool {
                    id: tool_id.to_owned(),
                    server: server.to_owned(),
                    name: tool.to_owned(),
                    description: None,
                    input_schema: None,
                };
                if !tool_allowed(&candidate, list) {
                    return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
                }
            }
            return crate::runnable::workflow_builder::dispatch(tool, arguments).await;
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
            let candidate = RegistryTool {
                id: tool_id.to_owned(),
                server: server.to_owned(),
                name: tool.to_owned(),
                description: None,
                input_schema: None,
            };
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
            id: id.clone(),
            server: APP_TOOL_SERVER.to_owned(),
            name,
            description,
            input_schema: None,
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

    fn sample_tool() -> RegistryTool {
        RegistryTool {
            id: "fs__read_file".into(),
            server: "fs".into(),
            name: "read_file".into(),
            description: None,
            input_schema: None,
        }
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
        // Two config servers plus the always-present built-in providers
        // (Shadow, Spider, Exa, Sandbox, notify, channel, search_conversations).
        let summaries = reg.server_summaries();
        assert_eq!(summaries.len(), 9);
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
