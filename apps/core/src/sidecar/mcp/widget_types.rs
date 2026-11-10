//! Widget bindings, promotion states and self-build widget metadata.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use super::*;

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
        let template_uri =
            get_str("ryu/outputTemplate", "openai/outputTemplate").or_else(|| {
                meta.get("ui")?
                    .get("resourceUri")?
                    .as_str()
                    .filter(|uri| uri.starts_with("ui://") && uri.len() <= 2048)
                    .map(str::to_owned)
            })?;
        let widget_accessible = meta
            .get("ryu/widgetAccessible")
            .or_else(|| meta.get("openai/widgetAccessible"))
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                // MCP Apps permit app-originated tools unless visibility explicitly
                // excludes them. This is a capability declaration, not a grant:
                // promotion and calls still pass the owning plugin/Gateway gates.
                meta.get("ui")
                    .and_then(|ui| ui.get("visibility"))
                    .and_then(Value::as_array)
                    .map(|visibility| visibility.iter().any(|v| v.as_str() == Some("app")))
                    .unwrap_or_else(|| meta.get("ui").is_some())
            });
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
pub(super) enum WidgetContributionState {
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

/// Metadata recovered from an SDK-authored tool runnable. The app-tool registry
/// keeps only the stable id/name pair, so discovery and widget emission read the
/// richer fields back from the enabled plugin manifest.
pub(super) struct SelfBuildToolMetadata {
    pub(super) description: Option<String>,
    pub(super) input_schema: Option<Value>,
    pub(super) output_schema: Option<Value>,
    pub(super) annotations: Option<Value>,
    pub(super) widget: Option<WidgetBinding>,
}

/// Find the manifest-owned metadata for one registered self-build tool.
///
/// `defineApp` emits the widget flags beside the executable `ToolConfig`, while
/// `register_app_tool_tagged` intentionally stores a small registry row. Keeping
/// this join here means the registration path remains compatible with older
/// callers and the manifest stays the source of truth for discovery.
pub(super) fn self_build_tool_metadata(
    manifests: &[PluginManifest],
    tool_id: &str,
) -> Option<SelfBuildToolMetadata> {
    let target = canonical_tool_id(tool_id);
    for manifest in manifests {
        for entry in &manifest.runnables {
            if entry.kind != crate::runnable::RunnableKind::Tool {
                continue;
            }
            let Some(config) = entry.config.as_ref() else {
                continue;
            };
            let Ok(tool_config) = serde_json::from_value::<
                crate::plugin_manifest::schema::ToolConfig,
            >(config.clone()) else {
                continue;
            };
            if app_tool_registered_id(&tool_config) != target {
                continue;
            }

            let widget = manifest
                .contributes
                .as_ref()
                .and_then(|contributes| {
                    contributes
                        .widgets
                        .iter()
                        .find(|candidate| canonical_tool_id(&candidate.tool_id) == target)
                })
                .map(|candidate| WidgetBinding {
                    template_uri: candidate.uri.clone(),
                    widget_accessible: config
                        .get("widget_accessible")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    invoking_label: config
                        .get("invoking")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    invoked_label: config
                        .get("invoked")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });

            return Some(SelfBuildToolMetadata {
                description: config
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input_schema: config.get("input_schema").cloned(),
                output_schema: config.get("output_schema").cloned(),
                annotations: config.get("annotations").cloned(),
                widget,
            });
        }
    }
    None
}

/// Resolve the installed plugin and MIME type for a self-built widget resource.
/// The `server` prefix is the runtime namespace (`<server>.<tool>`), not the
/// plugin id, so apps may use an explicit MCP namespace without losing the join.
pub(super) fn self_build_widget_identity(
    manifests: &[PluginManifest],
    server: &str,
    uri: &str,
) -> Option<(String, String)> {
    let prefix = format!("{server}.");
    manifests.iter().find_map(|manifest| {
        let widget = manifest
            .contributes
            .as_ref()?
            .widgets
            .iter()
            .find(|candidate| {
                let tool_id = canonical_tool_id(&candidate.tool_id);
                tool_id.starts_with(&prefix) && candidate.uri == uri
            })?;
        Some((manifest.id.clone(), widget.mime.clone()))
    })
}
