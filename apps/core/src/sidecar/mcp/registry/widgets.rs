//! Widget bindings and widget promotion.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Resolve a tool's [`WidgetBinding`] by its fully-qualified id, if it has one.
    ///
    /// The in-process apps provider answers synchronously; other servers are
    /// resolved via `list_all_tools` (cached). Returns `None` for tools that do
    /// not render a widget.
    pub async fn widget_binding(&self, tool_id: &str) -> Option<WidgetBinding> {
        let normalized_tool_id = self.canonical_tool_id_for_registry(tool_id);
        let (_server, _tool) = self.split_registered_tool_id(&normalized_tool_id)?;
        let listed = self
            .list_all_tools()
            .await
            .into_iter()
            .find(|t| t.id == normalized_tool_id)
            .and_then(|t| t.widget);
        if listed.is_some() {
            return listed;
        }
        let manifests = self.self_build_manifests.as_ref()?.read().await;
        self_build_tool_metadata(&manifests, &normalized_tool_id)
            .and_then(|metadata| metadata.widget)
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
    /// runtime `server.tool` id), NEVER by server name — a built-in app's server
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
        let normalized_tool_id = self.canonical_tool_id_for_registry(tool_id);
        let tool_id = normalized_tool_id.as_str();
        let (Some(manifests), Some(store)) = (
            self.self_build_manifests.as_ref(),
            self.self_build_app_store.as_ref(),
        ) else {
            // No governance context (tests / CLI / bare registry) → fail-open.
            return WidgetContributionState::Unrecorded;
        };

        // The tool's server namespace (`<server>.<tool>`) — used for the
        // fail-CLOSED join against a synth MCP-server record when no manifest
        // declares the tool_id.
        let server = self
            .split_registered_tool_id(tool_id)
            .map(|(s, _)| s.to_owned());

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
                    .any(|w| canonical_tool_id(&w.tool_id) == tool_id)
                    .then(|| {
                        let declares_grant =
                            m.permission_grants.iter().any(|g| g == WIDGET_RENDER_GRANT);
                        (m.id.clone(), declares_grant)
                    })
            });
            let synth_owner = server.as_ref().and_then(|srv| {
                guard
                    .iter()
                    .find(|m| m.id == *srv && m.category.as_deref() == Some(MCP_SERVER_CATEGORY))
                    .map(|m| m.id.clone())
            });
            (declared, synth_owner)
        };

        // A manifest explicitly declares this widget: honour its enabled + grant
        // state (the normal path for the 8 built-ins and any plugin that authored
        // a contributes.widgets entry).
        if let Some((plugin_id, declares_grant)) = declared {
            return match store.get(&plugin_id).await {
                Ok(Some(rec)) if rec.enabled => {
                    if declares_grant
                        && rec
                            .approved_grants
                            .iter()
                            .any(|grant| grant == WIDGET_RENDER_GRANT)
                    {
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
        if let Some(plugin_id) =
            synth_owner.or_else(|| self.plugin_server_owner(server.as_deref()?))
        {
            let registered_entrypoint = self.list_all_tools().await.iter().any(|tool| {
                tool.id == tool_id && ui_extensions::resource_uri(tool.meta.as_ref()).is_some()
            });
            return match store.get(&plugin_id).await {
                Ok(Some(rec))
                    if rec.enabled
                        && registered_entrypoint
                        && rec
                            .approved_grants
                            .iter()
                            .any(|grant| grant == WIDGET_RENDER_GRANT) =>
                {
                    WidgetContributionState::EnabledGranted
                }
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
}

#[cfg(test)]
#[path = "../tests/registry_widgets.rs"]
mod tests;
