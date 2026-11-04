use super::*;

// ── all-marketplaces view ────────────────────────────────────────────────
//
// The default store view browses every registered plugin source at once. What
// it must NOT fold in is the security-relevant half of that: `github-topic` is
// the unreviewed community feed, fetched separately via `?origin=community` so
// its rows always carry a trust notice. A copy of those rows reaching this view
// would render them under a marketplace heading with no notice at all.
#[test]
fn all_plugin_view_excludes_the_community_and_commerce_sources() {
    assert!(!is_all_plugin_view_source("github-topic"));
    // The hosted commerce backend is already folded INTO the merged first-party
    // view; browsing it again would duplicate every paid listing.
    assert!(!is_all_plugin_view_source("ryu-marketplace"));
}

#[test]
fn all_plugin_view_browses_the_canonical_first_party_view_once() {
    assert!(is_all_plugin_view_source(PLUGIN_MERGED_VIEW_ID));
    // Every id in the merged pair other than the canonical one is suppressed, so
    // the first-party listings can only be emitted under a single heading.
    for id in PLUGIN_MERGED_SOURCE_IDS {
        if id != PLUGIN_MERGED_VIEW_ID {
            assert!(!is_all_plugin_view_source(id));
        }
    }
}

#[test]
fn all_plugin_view_admits_federated_and_custom_marketplaces() {
    assert!(is_all_plugin_view_source("integrations-sh"));
    assert!(is_all_plugin_view_source("mp-my-team"));
}

// The sentinel is a VIEW, not a registered source: it must never collide with
// an id the merged-view test would also claim, or a request for "all" would
// resolve to a single source and the default store page would lose every
// marketplace but one.
#[test]
fn all_sources_sentinel_is_not_a_merged_view_id() {
    assert!(!is_merged_plugin_view(PLUGIN_ALL_SOURCES_ID));
    assert!(!PLUGIN_ALL_EXCLUDED_SOURCES.contains(&PLUGIN_ALL_SOURCES_ID));
}

// ── app_space_name ───────────────────────────────────────────────────────
#[test]
fn app_space_name_maps_only_the_seeded_apps() {
    assert_eq!(app_space_name("@ryu/canvas"), Some("Canvas"));
    assert_eq!(app_space_name("@ryu/whiteboard"), Some("Whiteboard"));
    assert_eq!(app_space_name("@ryu/meetings"), None);
    assert_eq!(app_space_name(""), None);
}

// ── unbound-node tenancy invariants ──────────────────────────────────────
//
// In tests `node_org_id()` is `None` (no managed-node registration), so these
// resolvers MUST reproduce the pre-ACL local-first behavior byte-for-byte:
// one principal, no restriction, the `local` sentinel. This is the regression
// guard that stops the ACL from locking a personal install out of its own data.
#[test]
fn caller_tenancy_is_unattributed_on_an_unbound_node() {
    assert_eq!(
        caller_tenancy(&Some(caller("alice", Some("org1")))),
        conversations::Tenancy::Unattributed
    );
    assert_eq!(caller_tenancy(&None), conversations::Tenancy::Unattributed);
}

#[test]
fn memory_owner_is_local_sentinel_on_an_unbound_node() {
    assert_eq!(
        memory_owner_user_id(&Some(caller("alice", Some("org1")))),
        memory::LOCAL_USER
    );
    assert_eq!(memory_owner_user_id(&None), memory::LOCAL_USER);
}

#[test]
fn a_reaction_is_attributed_to_the_person_not_the_tenant() {
    // The deliberate divergence from `memory_owner_user_id` above: a reaction
    // row is keyed `(message_id, user_id, emoji)`, so collapsing every signed-in
    // caller onto the `local` sentinel would merge two people's reactions into
    // one. A verified caller keeps their own id even on an unbound node.
    assert_eq!(
        reaction_user_id(&Some(caller("alice", Some("org1")))),
        "alice"
    );
    // Anonymous (loopback / node-token single-tenant) → the local sentinel.
    assert_eq!(reaction_user_id(&None), memory::LOCAL_USER);
}

#[test]
fn a_reaction_emoji_is_trimmed_bounded_and_never_empty() {
    // It lands in a TEXT PRIMARY KEY column with no other constraint, so the
    // route is the only bound on it.
    assert_eq!(normalize_reaction_emoji(" 🎉 ").unwrap(), "🎉");
    assert!(normalize_reaction_emoji("").is_err());
    assert!(normalize_reaction_emoji("   ").is_err());
    // A ZWJ family sequence with modifiers is well under the cap.
    assert!(normalize_reaction_emoji("👩🏽‍👩🏻‍👧🏼‍👦🏾").is_ok());
    assert!(normalize_reaction_emoji(&"a".repeat(MAX_REACTION_EMOJI_BYTES + 1)).is_err());
}

#[test]
fn agent_ui_state_writes_are_bounded_objects_with_a_real_key() {
    assert!(validate_agent_ui_state("call-1", &json!({ "done": [true] })).is_ok());
    assert!(validate_agent_ui_state("", &json!({})).is_err());
    assert!(validate_agent_ui_state("   ", &json!({})).is_err());
    assert!(
        validate_agent_ui_state(&"c".repeat(MAX_AGENT_UI_TOOL_CALL_ID_BYTES + 1), &json!({}))
            .is_err()
    );
    // Only an object: a bare array or string is not a widget state.
    assert!(validate_agent_ui_state("call-1", &json!([1, 2])).is_err());
    assert!(validate_agent_ui_state("call-1", &json!("x")).is_err());
    let huge = json!({ "blob": "x".repeat(64 * 1024) });
    assert!(validate_agent_ui_state("call-1", &huge).is_err());
}

#[test]
fn read_receipt_batch_uses_the_camel_case_wire_field_and_accepts_legacy_alias() {
    let body: MarkConversationReadBody =
        serde_json::from_value(json!({ "messageIds": ["m1", "m2"] })).unwrap();
    assert_eq!(body.message_ids, vec!["m1", "m2"]);

    let legacy: MarkConversationReadBody =
        serde_json::from_value(json!({ "message_ids": ["m1"] })).unwrap();
    assert_eq!(legacy.message_ids, vec!["m1"]);
}

#[test]
fn memory_access_is_unrestricted_on_an_unbound_node() {
    // Even a user-scoped fact owned by someone else is readable — an unbound
    // node has exactly one principal, so the per-user gate does not apply.
    let entry: memory::LongTermEntry = serde_json::from_value(json!({
        "id": "m1",
        "content": "secret",
        "created_at": 0,
        "scope": "user",
        "owner_user_id": "someone-else"
    }))
    .expect("entry deserializes");
    assert!(memory_access_ok(&None, &entry));
    assert!(memory_access_ok(
        &Some(caller("alice", Some("org1"))),
        &entry
    ));
}

#[test]
fn tenancy_filter_args_extracts_ids_and_flags_unbound() {
    // The caller's ids and verified team set are extracted; the bool is the
    // node-bound flag, which is false in tests.
    let (uid, org, teams, bound) = tenancy_filter_args(&Some(caller("alice", Some("org1"))));
    assert_eq!(uid.as_deref(), Some("alice"));
    assert_eq!(org.as_deref(), Some("org1"));
    assert_eq!(teams.as_deref(), Some("[]"));
    assert!(!bound);

    let (uid, org, teams, bound) = tenancy_filter_args(&None);
    assert_eq!(uid, None);
    assert_eq!(org, None);
    assert_eq!(teams, None);
    assert!(!bound);
}

#[test]
fn collect_plugin_slash_commands_only_walks_enabled_plugins() {
    let manifests = vec![
        manifest(json!({
            "id": "proof", "name": "Proof", "version": "1.0.0", "runnables": [],
            "contributes": { "slash_commands": [
                { "id": "proof.run", "command": "/proof", "description": "Prove it" }
            ]}
        })),
        manifest(json!({
            "id": "goal", "name": "Goal", "version": "1.0.0", "runnables": [],
            "contributes": { "slash_commands": [
                { "id": "goal.set", "command": "/goal", "description": "Pursue a goal" }
            ]}
        })),
    ];
    let out = collect_plugin_slash_commands(&manifests, &enabled_set(&["proof"]), None);
    assert_eq!(out.len(), 1, "a disabled plugin contributes nothing");
    assert_eq!(out[0]["command"], "/proof");
    // Each entry is tagged in place with its owning plugin id.
    assert_eq!(out[0]["plugin"], "proof");
}

#[test]
fn collect_plugin_slash_commands_filters_by_surface_but_none_means_all() {
    use crate::plugin_manifest::Surface;
    let manifests = vec![manifest(json!({
        "id": "proof", "name": "Proof", "version": "1.0.0", "runnables": [],
        "targets": ["desktop"],
        "contributes": { "slash_commands": [
            { "id": "proof.run", "command": "/proof", "description": "Prove it" }
        ]}
    }))];
    let enabled = enabled_set(&["proof"]);
    assert_eq!(
        collect_plugin_slash_commands(&manifests, &enabled, Some(Surface::Desktop)).len(),
        1
    );
    assert_eq!(
        collect_plugin_slash_commands(&manifests, &enabled, Some(Surface::Island)).len(),
        0
    );
    // No surface (a channel bot) means "do not filter", never "filter all out".
    assert_eq!(
        collect_plugin_slash_commands(&manifests, &enabled, None).len(),
        1
    );
}

#[test]
fn chat_widget_templates_are_enabled_and_surface_filtered_and_tagged() {
    let manifests = vec![
        manifest(json!({
            "id": "proof", "name": "Proof", "version": "1.0.0", "runnables": [],
            "targets": ["desktop"],
            "contributes": { "chat_widget_templates": [{
                "id": "proof.chat", "title": "Proof widget", "triggers": ["proof"],
                "examples": ["Show proof"], "backing": { "view_id": "proof.view" },
                "display_mode": "inline", "safe_action_ids": []
            }]}
        })),
        manifest(json!({
            "id": "disabled", "name": "Disabled", "version": "1.0.0", "runnables": [],
            "contributes": { "chat_widget_templates": [{
                "id": "disabled.chat", "title": "Disabled widget", "backing": {},
                "display_mode": "inline", "availability": "coming-soon"
            }]}
        })),
    ];
    let out = collect_plugin_chat_widget_templates(
        &manifests,
        &enabled_set(&["proof"]),
        Some(crate::plugin_manifest::Surface::Desktop),
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["plugin"], "proof");
    assert_eq!(out[0]["backing"]["view_id"], "proof.view");
}

/// THE invariant of this family, and the reason it is not enabled-filtered like
/// every sibling: every opt-in feature app is absent until explicit install, so on
/// a fresh profile the Workflows app has no store record at all. If its tab were
/// gated on that record, the Store would lose the very tab you install workflow
/// templates from — on exactly the machine that has never installed one.
#[test]
fn store_tabs_are_served_for_an_app_that_is_not_installed() {
    let manifests = vec![store_tab_manifest("@ryu/workflows", "workflows")];
    let none = enabled_set(&[]);
    let out = collect_plugin_store_tabs(&manifests, &none, &none, None);
    assert_eq!(
        out.len(),
        1,
        "an absent app still contributes its store tab"
    );
    assert_eq!(out[0]["plugin"], "@ryu/workflows");
    assert_eq!(out[0]["http_policy"], "owner");
    assert_eq!(out[0]["app_installed"], false);
    assert_eq!(out[0]["app_enabled"], false);
}

/// Installed-but-disabled is the other half: the tab is listed, and the two bits
/// tell the shell to offer "Enable" rather than "Install".
#[test]
fn store_tabs_report_installed_and_enabled_separately() {
    let manifests = vec![store_tab_manifest("@ryu/meetings", "meeting-templates")];
    let installed = enabled_set(&["@ryu/meetings"]);
    let none = enabled_set(&[]);

    let disabled = collect_plugin_store_tabs(&manifests, &installed, &none, None);
    assert_eq!(disabled[0]["app_installed"], true);
    assert_eq!(disabled[0]["app_enabled"], false);

    let on = collect_plugin_store_tabs(&manifests, &installed, &installed, None);
    assert_eq!(on[0]["app_enabled"], true);
}

/// Dropping the ENABLED filter must not drop the SURFACE filter with it: a shell
/// the app does not target cannot render the tab whatever its enabled bit says.
#[test]
fn store_tabs_still_respect_the_surface_filter() {
    use crate::plugin_manifest::Surface;
    let manifests = vec![manifest(json!({
        "id": "@ryu/workflows", "name": "Workflows", "version": "1.0.0", "runnables": [],
        "targets": ["desktop"],
        "contributes": { "store_tabs": [{ "id": "workflows", "title": "Workflows" }] }
    }))];
    let none = enabled_set(&[]);
    assert_eq!(
        collect_plugin_store_tabs(&manifests, &none, &none, Some(Surface::Desktop)).len(),
        1
    );
    assert_eq!(
        collect_plugin_store_tabs(&manifests, &none, &none, Some(Surface::Island)).len(),
        0
    );
    // No surface header (a non-desktop reader) means "do not filter".
    assert_eq!(
        collect_plugin_store_tabs(&manifests, &none, &none, None).len(),
        1
    );
}

/// The packaged manifest is the shipped article, so assert against IT rather than
/// a fixture: the Workflows tab must survive the move out of the desktop's
/// hardcoded section list, pointed at the catalog route that actually exists.
#[test]
fn the_workflows_app_registers_its_store_tab() {
    let manifests: Vec<_> = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .filter(|m| m.id == "@ryu/workflows")
        .collect();
    assert_eq!(manifests.len(), 1, "the Workflows manifest is compiled in");
    let none = enabled_set(&[]);
    let out = collect_plugin_store_tabs(&manifests, &none, &none, None);
    assert_eq!(out.len(), 1, "Workflows registers exactly one store tab");
    assert_eq!(out[0]["id"], "workflows");
    assert_eq!(out[0]["http_policy"], "core");
    assert_eq!(
        out[0]["spec"]["source"]["http"]["path"], "/api/workflows/catalog",
        "the tab must point at the catalog route Core actually serves"
    );
    assert_eq!(
        out[0]["spec"]["install"]["http"]["path"],
        "/api/workflows/catalog/install"
    );
}

#[test]
fn community_store_tabs_cannot_escape_their_owner_mount() {
    let hostile = manifest(json!({
        "id": "@acme/notes", "name": "Notes", "version": "1.0.0", "runnables": [],
        "contributes": { "store_tabs": [{
            "id": "notes", "title": "Notes",
            "spec": {
                "source": { "http": { "path": "/api/preferences" } },
                "install": { "http": { "method": "DELETE", "path": "/api/spaces/victim" } }
            }
        }]}
    }));
    let none = enabled_set(&[]);
    assert!(collect_plugin_store_tabs(&[hostile], &none, &none, None).is_empty());
}

#[test]
fn copied_official_id_does_not_inherit_core_http_authority() {
    let spoof = manifest(json!({
        "id": "@ryu/workflows", "name": "Spoof", "version": "99.0.0", "runnables": [],
        "contributes": { "store_tabs": [{
            "id": "spoof", "title": "Spoof",
            "spec": { "source": { "http": { "path": "/api/workflows/catalog" } } }
        }]}
    }));
    let none = enabled_set(&[]);
    assert!(collect_plugin_store_tabs(&[spoof], &none, &none, None).is_empty());
}
