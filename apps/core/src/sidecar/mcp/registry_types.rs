//! Registry tool and server summary types.

use super::*;

/// Which declarative backend an `app.` tool resolved to, tagged onto its
/// [`RegistryTool`] at registration so the catalog can surface a `command` tool as
/// its own [`catalog::ToolKind`]. `None` on a row means "not an app tool, or
/// untagged" — the http/inline_js/alias app backends stay classified as
/// [`catalog::ToolKind::App`]; only `Command` is surfaced distinctly (a
/// deliberate, task-mandated asymmetry, not an oversight).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AppToolBackendTag {
    Alias,
    InlineJs,
    Http,
    Command,
}

/// A tool exposed through the registry, tagged with its owning server.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RegistryTool {
    /// Fully-qualified id: `<server>.<tool>` — unique across servers.
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
    /// Set when this row is an app tool (tool-as-Runnable), tagging its resolved
    /// backend so the catalog surfaces a `command` tool as
    /// [`catalog::ToolKind::Command`]. `None` on non-app rows and on untagged
    /// registrations (which classify as [`catalog::ToolKind::App`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_backend: Option<AppToolBackendTag>,
}

impl RegistryTool {
    /// A bare tool descriptor used for allowlist checks and app-tool aliasing.
    /// New widget/metadata fields default to empty — call sites that need them
    /// (`tools_for_server`, the in-process apps provider) set them explicitly.
    pub fn candidate(id: &str, server: &str, name: &str) -> Self {
        Self {
            id: canonical_tool_id(id),
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
            app_backend: None,
        }
    }
}

/// Public summary of a registered server for the listing endpoint.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ServerSummary {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub description: Option<String>,
    pub enabled: bool,
    /// `"stdio"`, `"streamable-http"`, or `"sse"` for a config-declared server;
    /// `None` for a built-in (whose "command" is a parenthetical label, not a
    /// transport at all).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// The endpoint of a remote server, so the UI can show *where* it points
    /// instead of an empty `command` column. `None` for stdio and built-ins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Whether the server's command is present on disk. For a built-in like
    /// Ghost whose binary is installed on demand, this is `false` until the
    /// sidecar is installed — the UI uses it to show a "not yet available"
    /// state instead of a hard error. `None` when availability can't be
    /// determined cheaply (e.g. a bare command resolved via `PATH`).
    pub available: Option<bool>,
    /// Whether this server declares an OAuth flow or a conventional credential
    /// header. Credential values never leave Core.
    #[serde(default)]
    pub auth_required: bool,
    /// Whether a static credential is present in the server configuration. OAuth
    /// connection state is resolved through the redacted OAuth API instead.
    #[serde(default)]
    pub auth_configured: bool,
    /// `"oauth"` or `"header"` when authentication metadata is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<String>,
    /// Runtime owner for a manifest-declared OAuth server. This is a public id,
    /// not a secret, and lets clients join the row to the OAuth connection API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_server_name: Option<String>,
    /// Names only. Values are deliberately never returned by the listing API.
    #[serde(default)]
    pub env_keys: Vec<String>,
    #[serde(default)]
    pub header_names: Vec<String>,
    /// The `mcp-secret:<id>` account id an agent's account access names when
    /// calling this server hands it one of the user's saved keys; `None` when
    /// it carries none. An id only, never a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_key_account: Option<String>,
}

/// Return the non-secret authentication metadata Core can know synchronously.
///
/// OAuth connection state belongs to `mcp_oauth`; a declared OAuth flow is not
/// the same thing as a connected account. Static credentials are only detected
/// for conventional auth headers and environment-variable names so unrelated
/// configuration does not make a server look authenticated in the UI.
pub(super) fn auth_metadata(cfg: &McpServerConfig) -> (bool, bool, Option<String>) {
    let oauth = cfg.auth.is_some();
    let header_declared = cfg.headers.keys().any(|name| is_auth_header_name(name));
    let env_declared = cfg.env.keys().any(|name| is_auth_env_name(name));
    let static_header = cfg
        .headers
        .iter()
        .any(|(name, value)| is_auth_header_name(name) && !value.trim().is_empty());
    let static_env = cfg
        .env
        .iter()
        .any(|(name, value)| is_auth_env_name(name) && !value.trim().is_empty());
    (
        oauth || header_declared || env_declared,
        static_header || static_env,
        if oauth {
            Some("oauth".to_owned())
        } else if header_declared {
            Some("header".to_owned())
        } else if env_declared {
            Some("env".to_owned())
        } else {
            None
        },
    )
}

pub(super) fn is_auth_header_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "x-api-key"
            | "api-key"
            | "apikey"
            | "api_token"
            | "token"
            | "x-auth-token"
            | "x-access-token"
            | "x-goog-api-key"
    )
}

pub(super) fn is_auth_env_name(name: &str) -> bool {
    let normalized = name.to_ascii_uppercase();
    matches!(
        normalized.as_str(),
        "API_KEY" | "AUTH_TOKEN" | "CLIENT_SECRET" | "PASSWORD" | "SECRET" | "TOKEN"
    ) || normalized.ends_with("_KEY")
        || normalized.ends_with("_PAT")
        || normalized.ends_with("_CLIENT_SECRET")
        || normalized.ends_with("_PASSWORD")
        || normalized.ends_with("_SECRET")
        || normalized.ends_with("_TOKEN")
}

#[cfg(test)]
#[path = "tests/registry_types.rs"]
mod tests;
