use crate::plugin_manifest::{schema::RunnableEntry, PluginManifest};
use crate::plugins::PluginRecord;
use crate::runnable::RunnableKind;
use crate::server::{app_tool_claim_sets, app_tool_hide_filters};

fn make_manifest(id: &str, grants: &[&str]) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: "Test App".to_owned(),
        version: "1.0.0".to_owned(),
        runnables: vec![RunnableEntry {
            id: "r1".to_owned(),
            name: "R1".to_owned(),
            kind: RunnableKind::Tool,
            config: None,
        }],
        permission_grants: grants.iter().map(|s| s.to_string()).collect(),
        companion: None,
        ..Default::default()
    }
}

fn make_record(id: &str, enabled: bool) -> PluginRecord {
    PluginRecord {
        id: id.to_owned(),
        version: "1.0.0".to_owned(),
        enabled,
        approved_grants: vec![],
        channel: crate::update::STABLE_CHANNEL.to_owned(),
        provenance: None,
        created_at: None,
        updated_at: None,
    }
}

// ── Declarative tool-hide (`contributes.tool_filters`) ───────────────────

fn make_hider(id: &str, patterns: &[&str]) -> PluginManifest {
    let mut m = make_manifest(id, &[]);
    m.contributes = Some(ryu_kernel_contracts::manifest::Contributes {
        tool_filters: patterns
            .iter()
            .map(|p| ryu_kernel_contracts::manifest::ToolFilterContribution {
                tool: (*p).to_owned(),
                reason: None,
            })
            .collect(),
        ..Default::default()
    });
    m
}

/// The whole point of the primitive: an enabled plugin's declared pattern
/// removes the tool from the list offered to the model, so the model never
/// spends a round-trip discovering it is unavailable.
#[test]
fn enabled_plugin_hide_pattern_matches_exactly() {
    let manifests = vec![make_hider("com.test.hider", &["shell.exec"])];
    let lifecycle = vec![make_record("com.test.hider", true)];

    let filters = app_tool_hide_filters(&manifests, &lifecycle);
    assert_eq!(filters.len(), 1);
    assert!(filters[0].matches("shell.exec"));
    assert!(
        !filters[0].matches("shell.exec_many"),
        "an exact pattern must not behave like a prefix"
    );
}

/// A trailing `*` hides a whole server namespace.
#[test]
fn trailing_wildcard_hides_the_namespace() {
    let manifests = vec![make_hider("com.test.hider", &["shell.*"])];
    let lifecycle = vec![make_record("com.test.hider", true)];

    let filters = app_tool_hide_filters(&manifests, &lifecycle);
    assert!(filters[0].matches("shell.exec"));
    assert!(filters[0].matches("shell.write"));
    assert!(
        !filters[0].matches("browser.navigate"),
        "the wildcard must stay scoped to its server namespace"
    );
}

/// A DISABLED plugin must stop hiding. Otherwise disabling a plugin would
/// leave its policy silently in force — the user disabled it to stop it acting.
#[test]
fn disabled_plugin_contributes_no_hide_filters() {
    let manifests = vec![make_hider("com.test.hider", &["shell.exec"])];
    let lifecycle = vec![make_record("com.test.hider", false)];

    assert!(
        app_tool_hide_filters(&manifests, &lifecycle).is_empty(),
        "a disabled plugin must not keep hiding tools"
    );
}

/// A plugin with no `contributes` at all (the overwhelmingly common case) must
/// not panic or contribute anything.
#[test]
fn plugin_without_contributes_hides_nothing() {
    let manifests = vec![make_manifest("com.test.plain", &["mcp:web_search"])];
    let lifecycle = vec![make_record("com.test.plain", true)];

    assert!(app_tool_hide_filters(&manifests, &lifecycle).is_empty());
}

/// A tool claimed by a disabled app (not claimed by any enabled app) is
/// in `disabled_claimed` but not `enabled_claimed` — filter it out.
#[test]
fn disabled_app_tool_is_in_disabled_set() {
    let manifests = vec![make_manifest("com.test.app", &["mcp:web_search"])];
    let lifecycle = vec![make_record("com.test.app", false)];

    let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
    assert!(
        disabled.contains("web_search"),
        "disabled app's tool must be in disabled_claimed"
    );
    assert!(
        !enabled.contains("web_search"),
        "disabled app's tool must not be in enabled_claimed"
    );
}

/// A tool claimed by an enabled app is in `enabled_claimed` — always show it.
#[test]
fn enabled_app_tool_is_in_enabled_set() {
    let manifests = vec![make_manifest("com.test.app", &["mcp:web_search"])];
    let lifecycle = vec![make_record("com.test.app", true)];

    let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
    assert!(!disabled.contains("web_search"));
    assert!(
        enabled.contains("web_search"),
        "enabled app's tool must be in enabled_claimed"
    );
}

/// When two apps claim the same tool and one is enabled, the tool is visible
/// (enabled_claimed wins over disabled_claimed).
#[test]
fn one_enabled_claimant_keeps_tool_visible() {
    let manifests = vec![
        make_manifest("com.test.app-a", &["mcp:web_search"]),
        make_manifest("com.test.app-b", &["mcp:web_search"]),
    ];
    let lifecycle = vec![
        make_record("com.test.app-a", false), // disabled
        make_record("com.test.app-b", true),  // enabled
    ];

    let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
    // Both sets include web_search — caller checks enabled wins.
    assert!(disabled.contains("web_search"));
    assert!(
        enabled.contains("web_search"),
        "at least one enabled claimant — tool must stay visible"
    );
}

/// Grants that don't start with "mcp:" are not MCP tool slugs and must not
/// appear in either set.
#[test]
fn non_mcp_grants_are_ignored() {
    let manifests = vec![make_manifest(
        "com.test.app",
        &["file:read", "storage:write"],
    )];
    let lifecycle = vec![make_record("com.test.app", false)];

    let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
    assert!(
        disabled.is_empty(),
        "non-mcp grants should not populate disabled_claimed"
    );
    assert!(
        enabled.is_empty(),
        "non-mcp grants should not populate enabled_claimed"
    );
}

/// A manifest with no lifecycle record is treated as disabled (not installed).
#[test]
fn manifest_without_lifecycle_record_treated_as_disabled() {
    let manifests = vec![make_manifest("com.test.app", &["mcp:file_search"])];
    let lifecycle: Vec<PluginRecord> = vec![];

    let (disabled, enabled) = app_tool_claim_sets(&manifests, &lifecycle);
    assert!(disabled.contains("file_search"));
    assert!(!enabled.contains("file_search"));
}
