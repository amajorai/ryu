//! `McpServerConfig`: one configured MCP server and its transport target.

use super::*;

/// A single MCP server as declared in config — **either** a stdio command to
/// spawn, a Streamable HTTP endpoint, or a legacy HTTP+SSE endpoint.
///
/// The two halves are `command`+`args`+`env` and `url`+`headers`; `type`
/// disambiguates when both or neither are present. `command` is optional
/// precisely so a remote entry pasted from Cursor / Claude Desktop —
/// `{"type":"http","url":"https://…","headers":{"Authorization":"Bearer …"}}` —
/// parses as-is instead of being skipped for a missing required field.
///
/// **`headers`, not `env`.** A remote server has no process to inherit
/// environment, every hosted MCP provider documents auth as a request header, and
/// the config dialect users copy from writes `headers`. Mapping auth onto `env`
/// would be a Ryu-only dialect that silently drops the credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Executable to spawn (e.g. `npx`, an absolute path, or a `~/.ryu/bin` name).
    /// Absent for a remote (`url`) entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Transport hint, as written in the config file's `type` key: `stdio`,
    /// `http`, `streamable-http`, or `sse`. Absent ⇒ inferred from which of
    /// `command`/`url` is present. `sse` selects the legacy event-stream
    /// transport; see [`McpServerConfig::transport_kind`].
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// Endpoint URL for a remote (HTTP) server. Absent for a stdio entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Request headers sent with every call to a remote server (auth lives here).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// Core-owned OAuth declaration for a manifest-provided remote server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<crate::plugin_manifest::McpServerAuthDecl>,
    /// Runtime ownership, never read from or written to `mcp.json`.
    #[serde(skip)]
    pub owner_plugin_id: Option<String>,
    /// Manifest map key paired with `owner_plugin_id`; runtime-only.
    #[serde(skip)]
    pub owner_server_name: Option<String>,
    /// Working directory for a stdio child; runtime-only, like the owner fields.
    /// [`register_manifest_mcp_servers`] sets it to the owning plugin's installed
    /// directory so a plugin-relative script (`node server.mjs`) resolves against
    /// the files the package shipped rather than Core's own cwd. `None` ⇒ the child
    /// inherits Core's cwd (every `mcp.json` entry, and a built-in with no
    /// on-disk package).
    #[serde(skip)]
    pub cwd: Option<std::path::PathBuf>,
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
///
/// "Malformed" means the *file* — a single malformed entry only drops itself, see
/// [`McpConfigFile::servers`]. The `.ok()` below is what makes that distinction
/// load-bearing: it turns a failure into an empty map, so before the per-entry
/// split one remote-shaped entry made the update check believe nothing at all was
/// installed.
pub fn installed_configs() -> BTreeMap<String, McpServerConfig> {
    let path = McpRegistry::config_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<McpConfigFile>(&raw).ok())
        .map(|f| f.servers(&path))
        .unwrap_or_default()
}

const fn default_true() -> bool {
    true
}

impl Default for McpServerConfig {
    /// A blank stdio entry with `enabled: true` — matching what serde produces
    /// for `{}`. Same reason as [`McpServerDecl`]'s: the struct now spans two
    /// transports, and a stdio construction site should not have to name three
    /// remote fields it never uses.
    fn default() -> Self {
        Self {
            command: None,
            transport: None,
            url: None,
            headers: BTreeMap::new(),
            auth: None,
            owner_plugin_id: None,
            owner_server_name: None,
            cwd: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            description: None,
            enabled: default_true(),
            version: None,
            catalog_id: None,
        }
    }
}

impl McpServerConfig {
    /// Lower this config into the spawnable command `client::connect` runs.
    ///
    /// The **only** seam between a registry config and `Command::new`: all four
    /// callers (`tools_for_server`, `call_tool`, `widget_resource`,
    /// `prewarm_widgets`) pass the result straight to `client::*`, and none of them
    /// uses the program for identity or comparison. The one place it is *displayed*
    /// is `client.rs`'s spawn-error context (`spawn MCP server '{}'`), which the
    /// rewrite below improves — the resolved `…\npx.cmd` is more diagnostic than the
    /// bare name. The `GET /api/mcp/servers` listing reads `cfg.command` directly and
    /// is unaffected.
    ///
    /// That makes this the right place to make `command` *spawnable* — see
    /// [`spawn_program_for`] for the whitespace trim and the two Windows `PATH`
    /// rewrites it applies (a `.cmd`/`.bat` shim, and an extensionless hit with no
    /// `<name>.exe` anywhere on `PATH`).
    ///
    /// "Only seam" was audited across the crate, not assumed (2026-07-30), because a
    /// second `McpStdioCommand` constructor would silently skip the rewrite: the one
    /// other construction site is `recipes_host.rs`'s `ghost_command`, and it needs
    /// nothing from here — its program is `ghost_bin_path()`, an absolute
    /// `~/.ryu/bin/ghost[.exe]`, which [`spawn_program_for`] returns verbatim anyway
    /// (it carries a path separator) and which is Ryu's own `.exe`, never a shim. If
    /// a third constructor ever appears, route it through here rather than widening
    /// that one.
    ///
    /// Now returns an [`McpTarget`], not an `McpStdioCommand`: the same seam, one
    /// level wider, because a config entry may describe an HTTP endpoint instead
    /// of a spawnable command. The stdio branch is unchanged and still the only
    /// path to `Command::new`, so everything above about `spawn_program_for`
    /// still holds; the HTTP branch never spawns anything at all. `Result`
    /// because a malformed entry (a `type: "http"` with no `url`, a stdio entry
    /// with no `command`) can now only be caught here — the file-level parse
    /// deliberately accepts it so ONE bad entry never costs the user the file.
    pub(super) fn to_target(&self) -> Result<McpTarget> {
        match self.transport_kind() {
            McpTransportKind::Http | McpTransportKind::Sse => {
                let url = self
                    .url
                    .as_deref()
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                    .ok_or_else(|| {
                        anyhow!("MCP server declares a remote transport but no 'url'")
                    })?;
                let endpoint = McpHttpEndpoint {
                    url: url.to_owned(),
                    headers: self.headers.clone(),
                };
                Ok(match self.transport_kind() {
                    McpTransportKind::Http => McpTarget::Http(endpoint),
                    McpTransportKind::Sse => McpTarget::Sse(endpoint),
                    McpTransportKind::Stdio => unreachable!("matched remote transport"),
                })
            }
            McpTransportKind::Stdio => {
                let command = self
                    .command
                    .as_deref()
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .ok_or_else(|| {
                        anyhow!(
                            "MCP server declares neither a 'command' (stdio) nor a 'url' (remote)"
                        )
                    })?;
                Ok(McpTarget::Stdio(McpStdioCommand {
                    command: spawn_program_for(command),
                    args: self.args.clone(),
                    env: self
                        .env
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    cwd: self.cwd.clone(),
                }))
            }
        }
    }

    /// Which transport this entry describes.
    ///
    /// Explicit `type` wins, normalized the same way the MCP registry catalog
    /// normalizes a package's transport string (`PackageJson::transport_str`):
    /// lowercased, with `stdio` as the default when unstated. `http`,
    /// `streamable-http` (the current name) uses the Streamable HTTP client, while
    /// `sse` selects the predecessor's long-lived GET stream plus POST message
    /// endpoint. The latter remains common in published configs, so it stays a
    /// distinct runtime transport rather than being silently treated as POST-only.
    ///
    /// An **unrecognized** `type` is not guessed into a transport: it falls
    /// through to the same shape inference as an absent one (a `url` ⇒ HTTP,
    /// otherwise stdio), so a typo'd `"typ": "htp"` with a `url` still works
    /// rather than trying to spawn a process named after nothing.
    pub fn transport_kind(&self) -> McpTransportKind {
        let declared = self
            .transport
            .as_deref()
            .map(|t| t.trim().to_ascii_lowercase());
        match declared.as_deref() {
            Some("stdio") => McpTransportKind::Stdio,
            Some("sse") => McpTransportKind::Sse,
            Some("http" | "streamable-http" | "streamable_http") => McpTransportKind::Http,
            // Unstated or unrecognized: infer from which half is filled in.
            _ if self.url.as_deref().is_some_and(|u| !u.trim().is_empty()) => {
                McpTransportKind::Http
            }
            _ => McpTransportKind::Stdio,
        }
    }

    /// The transport name to report to clients (`GET /api/mcp/servers`).
    pub(super) fn transport_label(&self) -> &'static str {
        match self
            .transport
            .as_deref()
            .map(|transport| transport.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("sse") => "sse",
            Some("streamable-http" | "streamable_http") => "streamable-http",
            Some("http") => "http",
            Some("stdio") => "stdio",
            _ => match self.transport_kind() {
                McpTransportKind::Http => "streamable-http",
                McpTransportKind::Sse => "sse",
                McpTransportKind::Stdio => "stdio",
            },
        }
    }
}

#[cfg(test)]
#[path = "tests/server_config.rs"]
mod tests;
