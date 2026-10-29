use super::*;

/// Fully-resolved payload for [`AcpEvent::ToolWidget`], mapped 1:1 onto the
/// `data-tool-widget-available` stream part (spec §1.1). The MCP bridge mints the
/// `instance_id`, resolves the widget HTML, and strips `ryu/widget` from the
/// forwarded `_meta`; the adapter only serializes.
#[derive(Debug, Clone)]
pub struct ToolWidgetEvent {
    /// The tool-call row this widget attaches to (best-effort correlation).
    pub tool_call_id: String,
    /// Fully-qualified tool id (`<server>.<tool>`).
    pub tool_name: String,
    /// Minted `WidgetInstanceStore` id (round-trip identity).
    pub instance_id: String,
    /// Origin MCP server (same-server provenance gate).
    pub server_id: String,
    /// `ui://widget/<slug>.html`.
    pub template_uri: String,
    /// Widget HTML (embedded live, R9).
    pub widget_html: String,
    /// Widget MIME dialect.
    pub widget_mime: String,
    /// Tool arguments (`toolInput`).
    pub tool_input: serde_json::Value,
    /// `structuredContent` (`toolOutput`).
    pub tool_output: serde_json::Value,
    /// `_meta` minus `ryu/widget` (`toolResponseMetadata`).
    pub tool_response_metadata: serde_json::Value,
    /// Whether the widget may `callTool` (gates the local capability).
    pub widget_accessible: bool,
    /// Gateway-validated grant subset.
    pub approved_grants: Vec<String>,
    /// "invoking…" label.
    pub invoking: Option<String>,
    /// "invoked" label.
    pub invoked: Option<String>,
    /// Rehydrated widget state (persistence), if any.
    pub initial_widget_state: Option<serde_json::Value>,
    /// `"inline" | "fullscreen" | "pip"`.
    pub display_mode: String,
    /// The widget's declared remote-asset hosts (`resource_domains`), parsed from
    /// the widget resource's `_meta`. Threaded to the SSE `csp.resource_domains`
    /// so the client widens `img-src`/`font-src`/`media-src` to the Core asset
    /// proxy and rewrites these hosts' URLs through it (governed egress). Empty ⇒
    /// the CSP stays fully locked (`data:` only).
    pub resource_domains: Vec<String>,
}

/// User-chosen ACP session controls applied to a single turn, all read from the
/// agent's own `session/new` advertisement (Ryu hardcodes none). The ACP session
/// is reused across a chat's turns, but these controls are re-applied every turn
/// (sticky on the client). Empty fields mean "leave the agent's default".
#[derive(Debug, Clone, Default)]
pub struct AcpTurnConfig {
    /// `SessionModeId` to switch into (e.g. `plan`, `bypassPermissions`).
    pub session_mode: Option<String>,
    /// `(config_id, value_id)` pairs for select config options (e.g. a
    /// reasoning-effort / `thought_level` selector).
    pub config_options: Vec<(String, String)>,
    /// `ModelId` to select (unstable ACP capability; ignored if unsupported).
    pub model_id: Option<String>,
    /// Agent-requested reasoning effort. Unlike a client-selected config option,
    /// this remains available when Simple mode intentionally strips all model
    /// controls from the request. ACP does not have one stable effort id, so the
    /// turn path tries the conventional ids until the agent accepts one.
    pub agent_effort: Option<String>,
    /// When `true` (desktop streaming), a tool-permission request is surfaced to
    /// the user as a `PermissionRequest` event and the handler awaits their
    /// choice (cancel on timeout). When `false` (headless/bots/CLI/legacy), the
    /// handler auto-approves the first offered option — preserving the prior
    /// non-interactive behaviour so tool use keeps working without a UI.
    pub interactive: bool,
}

/// `ConfigWarning::field` Ryu uses when it refuses a session setting because the
/// agent's workspace is not trusted. The desktop keys its "Trust folder" action
/// on this value.
pub(crate) const WORKSPACE_TRUST_WARNING_FIELD: &str = "workspace_trust";

/// How much autonomy an ACP instance gets from the folder it works in. Fixed for
/// the instance's lifetime because the OS sandbox profile is chosen at spawn;
/// the trust bit is part of the pool key, so changing trust starts a new
/// instance on the next turn. See [`crate::workspace_trust`].
#[derive(Debug, Clone)]
pub(crate) struct WorkspaceAutonomy {
    pub trusted: bool,
    pub is_claude_code: bool,
}

impl WorkspaceAutonomy {
    pub(crate) fn evaluate(cwd: &Path, additional: &[PathBuf], is_claude_code: bool) -> Self {
        let trusted = crate::workspace_trust::is_trusted(cwd)
            && additional
                .iter()
                .all(|path| crate::workspace_trust::is_trusted(path));
        Self {
            trusted,
            is_claude_code,
        }
    }

    /// `Some(reason)` when `mode` would stop the agent asking before it runs
    /// commands and the workspace is untrusted.
    pub(super) fn refuse_mode(&self, mode: &str) -> Option<String> {
        if self.trusted
            || !crate::workspace_trust::mode_skips_permission_prompts(mode, self.is_claude_code)
        {
            return None;
        }
        Some(format!(
            "Ryu kept the agent asking before it runs commands: the '{mode}' mode skips \
             permission prompts, and this folder is not trusted. Trust the folder to use it."
        ))
    }
}
