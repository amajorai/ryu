//! Loading, reloading and registering configured servers.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Resolve the config path: `RYU_MCP_CONFIG` if set, else `~/.ryu/mcp.json`.
    pub fn config_path() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_MCP_CONFIG") {
            return PathBuf::from(p);
        }
        crate::paths::state_path("mcp.json")
    }

    /// How many servers the user's `mcp.json` declares, read straight from disk.
    ///
    /// Deliberately independent of the live `servers` map: under Safe Mode that map
    /// holds built-ins only, so counting it would report zero and the safe-mode
    /// diagnostic would claim it is suppressing nothing. This answers "how many
    /// external MCP processes would a normal boot spawn?", which is the number the
    /// user is weighing. A missing or invalid file is zero, not an error.
    ///
    /// Counts *lowered* entries ([`McpConfigFile::servers`]), not raw declared
    /// ones, to keep answering that same question: an entry Core cannot parse
    /// spawns nothing, so safe mode is not suppressing it and it must not inflate
    /// the "held back" number. Counting per-entry is also what stops one bad entry
    /// from reporting **zero** — the whole-file parse used to fail, and the
    /// diagnostic then claimed safe mode was suppressing nothing at all.
    pub fn user_configured_server_count() -> usize {
        let path = Self::config_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str::<McpConfigFile>(&contents).ok())
            .map_or(0, |file| file.servers(&path).len())
    }

    /// Built-in MCP servers Core always registers — no config file required.
    ///
    /// **Empty by design.** The two former hardcoded built-ins — **Ghost** (U14,
    /// desktop automation) and **Agent Browser** (`npx agentbrowser`) — moved to
    /// the manifest-owned path: they are declared under `mcp_servers` in their
    /// plugin fixtures (`fixtures/{ghost,agentbrowser}.manifest.json`) and register
    /// via [`register_manifest_mcp_servers`] on plugin activation (both are
    /// pre-installed, so the boot `fire_activation_event("onStartup")` loop re-adds
    /// them on every start). Ghost's profile-aware values that a static manifest
    /// can't express — the `~/.ryu{profile}/bin/ghost` binary path
    /// (`command_env: "RYU_GHOST_BIN"`), the island overlay URL, and the
    /// per-profile `GHOST_DATA_DIR` — are seeded into Core's process env in
    /// `main.rs` (see `seed_ghost_sidecar_env`) and reach the child via the
    /// `RYU_GHOST_BIN` lowering + the `mcp_safe_env` allowlist.
    ///
    /// Kept as a seam (rather than deleted) so `load_merged_servers` still has a
    /// base map and a future non-plugin built-in has a home.
    fn builtin_servers() -> BTreeMap<String, McpServerConfig> {
        BTreeMap::new()
    }

    /// Load the registry. Always starts from the built-in servers (Ghost, U14),
    /// then overlays the user's config file on top. A missing config file is
    /// fine (MCP is opt-in, matching the "modular" principle) and still yields
    /// the built-ins. A user entry with the same name as a built-in **wins**,
    /// so operators can repoint or disable a built-in deterministically.
    pub fn load() -> Self {
        // No plugin-declared servers at construction — those are overlaid later by
        // `register_server` as enabled plugins activate (and re-applied by `reload`).
        let servers = Self::load_merged_servers(&BTreeMap::new());
        Self {
            servers: RwLock::new(servers),
            plugin_servers: RwLock::new(BTreeMap::new()),
            plugin_runtime: RwLock::new(None),
            sidecar_wake: RwLock::new(SidecarWake::default()),
            tool_cache: Mutex::new(BTreeMap::new()),
            discovery_backoff: DiscoveryBackoff::default(),
            resource_cache: Mutex::new(HashMap::new()),
            app_tools: Mutex::new(Vec::new()),
            ext_api: Mutex::new(BTreeMap::new()),
            capability_cache: Mutex::new(None),
            node_display_cache: Mutex::new(None),
            http: reqwest::Client::new(),
            self_build_manifests: None,
            self_build_app_store: None,
            agent_store: None,
            conversations: None,
            skills: None,
            preferences: None,
            capabilities: None,
            spaces: None,
            memory: None,
        }
    }

    /// Internal: compute the merged server map. Precedence, lowest first:
    /// built-ins → plugin-declared (`plugin_servers`) → user `mcp.json`. A plugin
    /// server overrides a built-in of the same name (the whole point of the
    /// manifest-owned successor), and a user config entry still overrides both.
    /// Used by both `load()` and `reload()`.
    fn load_merged_servers(
        plugin_servers: &BTreeMap<String, (String, McpServerConfig)>,
    ) -> BTreeMap<String, McpServerConfig> {
        let mut servers = Self::builtin_servers();

        // ── Safe Mode: built-ins only ────────────────────────────────────────
        //
        // The built-ins are in-process Core tools — they spawn nothing and chat
        // itself uses them, so removing them would break the session the user is
        // troubleshooting in. Everything below this line spawns an EXTERNAL
        // process (`npx …`, a host binary), which is exactly the class of cost
        // safe mode exists to take off the table. The plugin overlay would already
        // be empty (nothing registers while the plugin mask holds), but it is
        // skipped explicitly so a stale registration can't sneak through a reload.
        if crate::safe_mode::is_active() {
            tracing::info!(
                "safe mode: skipping plugin + user MCP servers; {} built-in server(s) only",
                servers.len()
            );
            return servers;
        }

        // Plugin-declared servers overlay built-ins (user config below still wins).
        // The owner id is dropped here: `servers` is the flat spawn map, and
        // ownership only governs who may write `plugin_servers` in the first place.
        for (name, (_owner, cfg)) in plugin_servers {
            servers.insert(name.clone(), cfg.clone());
        }

        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<McpConfigFile>(&contents) {
                Ok(file) => {
                    // Per-entry lowering: one entry Core cannot parse must not take
                    // the user's other servers down with it (see
                    // `McpConfigFile::servers`). `declared` is logged alongside
                    // `count` so a skipped entry is visible here, not only in the
                    // per-entry warning.
                    let declared = file.raw_servers.len();
                    let parsed = file.servers(&path);
                    let count = parsed.len();
                    // Config overrides built-ins on name collision.
                    for (name, cfg) in parsed {
                        servers.insert(name, cfg);
                    }
                    tracing::info!(
                        "loaded {count} of {declared} MCP server(s) from {}; {} total with \
                         built-ins",
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

        // Fleet state is a separate, signed overlay. It never rewrites the
        // user's mcp.json; required entries win name collisions, while blocked
        // names disappear even if a user-owned config remains on disk.
        servers.retain(|name, _| !crate::fleet::is_artifact_blocked(name));
        for (name, config) in crate::fleet::managed_mcp_configs() {
            if !crate::fleet::is_artifact_blocked(&name) {
                servers.insert(name, config);
            }
        }

        servers
    }

    /// Reload the server map from disk without restarting the process.
    ///
    /// Re-derives built-ins, re-overlays the plugin-declared servers (so a session
    /// reload never drops a plugin's MCP server), then re-overlays the user's
    /// `mcp.json`, exactly as `load()` + the active registrations do. The
    /// `tool_cache` is cleared so freshly registered servers advertise their tools
    /// on the next `/api/mcp/tools` request.
    pub fn reload(&self) {
        self.rebuild_servers();
        tracing::info!("McpRegistry: reloaded from disk");
    }

    /// Recompute the live `servers` map from built-ins + `plugin_servers` + the
    /// user `mcp.json`, and clear the tool/resource caches. The single place that
    /// re-derives `servers`, shared by `reload()` and
    /// `register_server`/`deregister_server` so plugin overlays are applied
    /// consistently. Never holds a lock across the recompute (the file read + the
    /// plugin-map snapshot both complete before the `servers` write lock is taken).
    fn rebuild_servers(&self) {
        // An MCP-server-backed plugin (agentbrowser, ghost, …) can be a capability
        // provider whose verbs map onto its `<server>.<tool>` ids, so registering or
        // deregistering one changes what the facade can serve. Every register /
        // deregister path funnels through here, which is why the invalidation sits at
        // this choke point rather than on each caller.
        capability_tools::invalidate();
        let plugin_snapshot = self
            .plugin_servers
            .read()
            .expect("mcp plugin_servers RwLock poisoned")
            .clone();
        let fresh = Self::load_merged_servers(&plugin_snapshot);
        {
            let mut servers = self.servers.write().expect("mcp servers RwLock poisoned");
            *servers = fresh;
        }
        if let Ok(mut cache) = self.tool_cache.lock() {
            cache.clear();
        }
        self.discovery_backoff.clear();
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.clear();
        }
    }

    /// Register a plugin-declared MCP server into the live registry, **owned** by
    /// `plugin_id`.
    ///
    /// Records it in `plugin_servers` (so a session `reload()` re-applies it) and
    /// rebuilds `servers`. Idempotent for the OWNER: re-registering the same name
    /// from the same plugin overwrites the prior declaration (that is what makes
    /// re-activation cheap). A user `mcp.json` entry of the same name still wins
    /// after the rebuild (user-overrides-plugin precedence). Called from the plugin
    /// enable/activation path via [`register_manifest_mcp_servers`].
    ///
    /// Returns `false` — registering nothing — when the name is already owned by a
    /// DIFFERENT plugin. The plugin-declared overlay sits ABOVE the built-ins in
    /// [`Self::load_merged_servers`], so without this a plugin declaring
    /// `mcp_servers: { "ghost": … }` would silently repoint every `ghost.*` tool
    /// call at its own command while keeping Ghost's tool descriptions (and the
    /// user's trust in them). First registration wins, mirroring the manifest
    /// loader's first-occurrence-wins rule for plugin IDs.
    pub fn register_server(&self, plugin_id: &str, name: String, cfg: McpServerConfig) -> bool {
        {
            let mut plugins = self
                .plugin_servers
                .write()
                .expect("mcp plugin_servers RwLock poisoned");
            if let Some((owner, _)) = plugins.get(&name) {
                if owner != plugin_id {
                    tracing::warn!(
                        "plugin '{plugin_id}' declares MCP server '{name}', which is already \
                         registered by plugin '{owner}'; the registration is refused (a plugin \
                         may not take over another plugin's server name)"
                    );
                    return false;
                }
            }
            plugins.insert(name, (plugin_id.to_owned(), cfg));
        }
        self.rebuild_servers();
        true
    }

    /// Deregister a plugin-declared MCP server **owned by `plugin_id`**. Removes it
    /// from `plugin_servers` and rebuilds `servers` (so a built-in of the same name,
    /// if any, resurfaces). Returns whether a plugin server by that name was present
    /// AND owned by this plugin. Called from the plugin disable/uninstall path via
    /// [`deregister_manifest_mcp_servers`].
    ///
    /// A no-op when the recorded owner differs: disabling a plugin that merely
    /// *declared* a name someone else owns must not tear down the real registration
    /// (it would stay dead until the next Core restart re-ran the `onStartup`
    /// re-register — a cross-plugin denial of service).
    pub fn deregister_server(&self, plugin_id: &str, name: &str) -> bool {
        let removed = {
            let mut plugins = self
                .plugin_servers
                .write()
                .expect("mcp plugin_servers RwLock poisoned");
            match plugins.get(name) {
                Some((owner, _)) if owner == plugin_id => plugins.remove(name).is_some(),
                Some((owner, _)) => {
                    tracing::warn!(
                        "plugin '{plugin_id}' tried to deregister MCP server '{name}', which is \
                         owned by plugin '{owner}'; ignored"
                    );
                    false
                }
                None => false,
            }
        };
        if removed {
            self.rebuild_servers();
        }
        removed
    }

    /// Whether a server with the given `name` is already registered (built-ins
    /// included). The built-in Shadow and Exa providers are synthesized
    /// only in `server_summaries()` and are NOT in `servers`, so they are checked
    /// by name explicitly.
    pub fn contains_server(&self, name: &str) -> bool {
        if name == web_fetch::SERVER_NAME
            || name == cloud::SERVER_NAME
            || name == sandbox::SERVER_NAME
            || name == notify_tool::SERVER_NAME
            || name == device_tool::SERVER_NAME
            || name == artifact_tool::SERVER_NAME
            || name == consent_tool::SERVER_NAME
            || name == tasks_tool::SERVER_NAME
            || name == spaces_tool::SERVER_NAME
            || name == working_memory_tool::SERVER_NAME
            || name == channel_tool::SERVER_NAME
            || name == agent_inbox_tool::SERVER_NAME
            || name == search_conversations::SERVER_NAME
            || name == crate::agent_control::SERVER_NAME
            || name == threads::SERVER_NAME
            || name == delegate::SERVER_NAME
            || name == orchestrator::SERVER_NAME
            || name == skills_tool::SERVER_NAME
            || name == ui_tool::SERVER_NAME
            || name == usage_tool::SERVER_NAME
            || name == treg_tool::SERVER_NAME
            || name == challenges_tool::SERVER_NAME
            || name == marketplace_tool::SERVER_NAME
            || name == workspace_tool::SERVER_NAME
            || name == routines_tool::SERVER_NAME
            || name == crate::safe_actions::SERVER_NAME
            // The capability facade's reserved names (`web`, `browser`, `computer`,
            // `memory`). Reserved unconditionally, not only while a provider is
            // bound, so a plugin can never squat a name the facade may later serve.
            || capability_tools::is_server(name)
        {
            return true;
        }
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .contains_key(name)
    }

    /// Which plugin, if any, currently owns the **plugin-declared** server `name`.
    ///
    /// Deliberately narrower than [`contains_server`](Self::contains_server), which also
    /// answers `true` for every reserved built-in name (`threads`, `delegate`, the
    /// capability facade, …) whether or not anything is registered. A caller asking
    /// "would registering this declaration change anything?" must not be told yes-it-is-
    /// already-there by a mere name reservation: a plugin server overlays a built-in of
    /// the same name in `rebuild_servers`, so that registration is real work. The
    /// managed-bin ready notifier
    /// ([`manifest_sidecar::notify_managed_binary_ready`](crate::sidecar::manifest_sidecar))
    /// is that caller — with `contains_server` its skip-if-nothing-to-do guard would fire
    /// permanently for exactly the apps whose server name Core still reserves.
    ///
    /// `Some(other_plugin)` is still a "nothing would change" answer: `register_server`
    /// refuses a name owned by a different plugin.
    pub fn plugin_server_owner(&self, name: &str) -> Option<String> {
        self.plugin_servers
            .read()
            .expect("mcp plugin_servers RwLock poisoned")
            .get(name)
            .map(|(owner, _)| owner.clone())
    }
}

#[cfg(test)]
#[path = "../tests/builtin_manifests.rs"]
mod tests;
