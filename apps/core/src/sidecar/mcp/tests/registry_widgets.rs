//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

/// A plugin manifest that declares `tool_id` in `contributes.widgets` with the
/// given permission grants. Promotion also requires the persisted record to
/// carry the Gateway-approved grant; a declaration alone is not consent.
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

/// The widget fixture every promotion test drives. `checklist.render` was a
/// real in-process app tool until 1af518d8 retired the eight inline-chat
/// widget-apps; Core has had no in-process widget producer since, so the
/// tests seed one. It stands in for the ONE producer that is still live in
/// production — an external MCP server whose `tools/list` `_meta` carries
/// `ryu/outputTemplate` — which is exactly the case the `widget:render` gate
/// exists to govern.
const WIDGET_FIXTURE_SERVER: &str = "checklist";
const WIDGET_FIXTURE_TOOL: &str = "render";
const WIDGET_FIXTURE_URI: &str = "ui://widget/checklist.html";

/// A registry with `manifest` wired as the self-build governance context and a
/// lifecycle record for `record_id` in the given enabled state. An enabled
/// widget-bearing manifest receives the matching approved grant in the fixture
/// record, mirroring a successful Gateway validation.
///
/// The `checklist.render` widget binding is seeded too: `resolve_widget_promotion`
/// returns `None` for a tool that renders no widget BEFORE it consults the
/// governance gate, so without a binding every one of these tests would pass
/// or fail for the wrong reason.
async fn registry_with_governance(
    manifest: PluginManifest,
    record_id: &str,
    enabled: bool,
) -> McpRegistry {
    let store = crate::plugins::PluginStore::open_in_memory().expect("in-memory store");
    store
        .insert(record_id, "1.0.0")
        .await
        .expect("insert record");
    if enabled {
        let approved = if manifest
            .permission_grants
            .iter()
            .any(|grant| grant == WIDGET_RENDER_GRANT)
        {
            vec![WIDGET_RENDER_GRANT.to_owned()]
        } else {
            Vec::new()
        };
        store
            .set_enabled(record_id, &approved)
            .await
            .expect("enable record");
    }
    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![manifest]));
    let reg = McpRegistry::empty().with_self_build(manifests, std::sync::Arc::new(store));
    reg.seed_widget_tool_for_test(
        WIDGET_FIXTURE_SERVER,
        WIDGET_FIXTURE_TOOL,
        WIDGET_FIXTURE_URI,
    );
    reg
}

#[tokio::test]
async fn builtin_widget_promotes_via_unified_manifest_path() {
    // A synthetic plugin record whose manifest holds widget:render + a
    // contributes.widgets entry: the unified resolver promotes it —
    // contributes.widgets is the source of record (generic host machinery).
    let manifest = widget_manifest("checklist", "checklist.render", &[WIDGET_RENDER_GRANT]);
    let reg = registry_with_governance(manifest, "checklist", true).await;
    assert!(
        matches!(
            reg.resolve_widget_promotion("checklist.render").await,
            WidgetPromotion::Allow(_)
        ),
        "enabled + granted built-in app widget must promote via contributes.widgets"
    );
}

#[tokio::test]
async fn widget_without_grant_is_refused() {
    // Same enabled record, but the manifest does NOT declare widget:render.
    let manifest = widget_manifest("checklist", "checklist.render", &["chat.sendFollowUp"]);
    let reg = registry_with_governance(manifest, "checklist", true).await;
    assert!(
        matches!(
            reg.resolve_widget_promotion("checklist.render").await,
            WidgetPromotion::DeniedNoGrant { .. }
        ),
        "an enabled plugin without widget:render must NOT auto-promote"
    );
    // The log-reducing wrapper yields no binding (text-only delivery).
    assert!(reg
        .widget_promotion_or_log("checklist.render")
        .await
        .is_none());
}

#[tokio::test]
async fn widget_with_grant_promotes() {
    let manifest = widget_manifest("checklist", "checklist.render", &[WIDGET_RENDER_GRANT]);
    let reg = registry_with_governance(manifest, "checklist", true).await;
    assert!(reg
        .widget_promotion_or_log("checklist.render")
        .await
        .is_some());
}

#[tokio::test]
async fn widget_without_approved_grant_is_refused() {
    let manifest = widget_manifest("checklist", "checklist.render", &[WIDGET_RENDER_GRANT]);
    let store = crate::plugins::PluginStore::open_in_memory().expect("in-memory store");
    store
        .insert("checklist", "1.0.0")
        .await
        .expect("insert record");
    store
        .set_enabled("checklist", &[])
        .await
        .expect("enable record without widget grant");
    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![manifest]));
    let reg = McpRegistry::empty().with_self_build(manifests, std::sync::Arc::new(store));
    reg.seed_widget_tool_for_test(
        WIDGET_FIXTURE_SERVER,
        WIDGET_FIXTURE_TOOL,
        WIDGET_FIXTURE_URI,
    );

    assert!(matches!(
        reg.resolve_widget_promotion("checklist.render").await,
        WidgetPromotion::DeniedNoGrant { .. }
    ));
}

#[tokio::test]
async fn disabled_owner_refuses_widget() {
    let manifest = widget_manifest("checklist", "checklist.render", &[WIDGET_RENDER_GRANT]);
    let reg = registry_with_governance(manifest, "checklist", false).await;
    assert!(
        matches!(
            reg.resolve_widget_promotion("checklist.render").await,
            WidgetPromotion::DeniedDisabled { .. }
        ),
        "a disabled owning plugin must not render its widget"
    );
}

#[tokio::test]
async fn bare_registry_fails_open_for_builtins() {
    // No governance context wired (tests / CLI / bare registry) → fail-open so
    // a widget-bearing tool keeps binding (backward-compat rule 3).
    let reg = McpRegistry::empty();
    reg.seed_widget_tool_for_test(
        WIDGET_FIXTURE_SERVER,
        WIDGET_FIXTURE_TOOL,
        WIDGET_FIXTURE_URI,
    );
    assert!(
        matches!(
            reg.resolve_widget_promotion("checklist.render").await,
            WidgetPromotion::Allow(_)
        ),
        "bare registry must fail open so built-in widgets keep rendering"
    );
}

#[tokio::test]
async fn legacy_external_server_with_no_record_fails_open() {
    // Governance IS wired, but no installed manifest declares checklist.render
    // (the wired manifest claims a different tool). A tool no manifest claims is
    // the legacy external server case → fail OPEN (documented delegate).
    let manifest = widget_manifest("other-plugin", "other.render", &[WIDGET_RENDER_GRANT]);
    let reg = registry_with_governance(manifest, "other-plugin", true).await;
    assert!(
        matches!(
            reg.resolve_widget_promotion("checklist.render").await,
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
        reg.resolve_widget_promotion("checklist.update").await,
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
            reg.resolve_widget_promotion("checklist.render").await,
            WidgetPromotion::DeniedUndeclared { .. }
        ),
        "an enabled MCP-server record that never declared the widget must NOT auto-promote"
    );
    // The chat-path wrapper yields no binding → the result is delivered as text.
    assert!(reg
        .widget_promotion_or_log("checklist.render")
        .await
        .is_none());
}

#[tokio::test]
async fn recorded_mcp_server_disabled_undeclared_stays_closed() {
    // A DISABLED synth MCP-server record: still no widget (disabled owner).
    let manifest = synth_mcp_manifest("checklist", None);
    let reg = registry_with_governance(manifest, "checklist", false).await;
    assert!(matches!(
        reg.resolve_widget_promotion("checklist.render").await,
        WidgetPromotion::DeniedDisabled { .. }
    ));
}

#[tokio::test]
async fn recorded_mcp_server_declared_widget_promotes() {
    // The closed loop opens: once spawn-time widget discovery records the
    // widget tool in the MCP server's contributes.widgets (and the record is
    // enabled + holds widget:render), the SAME unified path promotes it.
    let manifest = synth_mcp_manifest("checklist", Some("checklist.render"));
    let reg = registry_with_governance(manifest, "checklist", true).await;
    assert!(
        matches!(
            reg.resolve_widget_promotion("checklist.render").await,
            WidgetPromotion::Allow(_)
        ),
        "a declared + granted + enabled MCP-server widget must promote"
    );
}
