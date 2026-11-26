//! The uninstall cleanup and the member folder list of a shared node.
//!
//! An app's manifest names its settings keys freely, so it can name
//! `member-workspace-roots`, the list that bounds every turn on a shared node.
//! These tests call the cleanup and the preview count the way the uninstall
//! does. They pin that the cleanup leaves that key in the store, that the
//! preview does not count it, and that every other setting an app names is
//! still counted and removed.

use std::future::Future;
use std::sync::OnceLock;

use super::*;
use crate::plugin_manifest::PluginManifest;
use crate::server::chat_checkpoints::turn_folders::{
    parse_member_roots, stored_folder_allowed, with_test_member_roots,
    MEMBER_WORKSPACE_ROOTS_PREF_KEY,
};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

/// A setting of the test app itself.
const VIEW_KEY: &str = "notes.default-view";
const VIEW_VALUE: &str = "board";

/// One server state for the whole test process (a second one locks the
/// database), with a preference store of its own for each test in `directory`.
fn state_in(directory: &std::path::Path) -> ServerState {
    static STATE: OnceLock<(tempfile::TempDir, ServerState)> = OnceLock::new();
    let mut state = STATE
        .get_or_init(|| {
            crate::crypto_host::install();
            let directory = tempfile::tempdir().expect("data");
            let state = crate::server::isolated_plugin_hook_test_state(directory.path());
            (directory, state)
        })
        .1
        .clone();
    state.preferences =
        crate::server::preferences::PreferencesStore::open(directory.join("preferences.db"))
            .expect("preferences");
    state
}

/// An installed app whose one settings tab holds `fields`.
fn app_with_settings(fields: Value) -> PluginManifest {
    serde_json::from_value(json!({
        "id": "com.example.notes", "name": "Notes", "version": "1.0.0", "runnables": [],
        "contributes": { "settings_tabs": [
            { "id": "notes.settings", "title": "Notes", "scope": "node", "fields": fields }
        ]}
    }))
    .expect("test manifest deserializes")
}

/// The preference value that lists `folder` as the one member folder.
fn list_value(folder: &std::path::Path) -> String {
    json!([{ "path": folder.to_string_lossy() }]).to_string()
}

/// Run `fut` on a shared node (registered, scope Org) that has loaded the
/// member folders of the preference value `list`, read by the real parser.
async fn on_shared_node<F: Future>(list: &str, fut: F) -> F::Output {
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    let loaded = with_test_member_roots(parse_member_roots(list), fut);
    with_test_node_binding(true, Some(node), loaded).await
}

/// The settings cleanup of an uninstall, as `uninstall_app_handler` runs it
/// when the caller checked "Saved app settings".
async fn clean_settings(state: &ServerState, manifest: &PluginManifest) -> Vec<String> {
    let caller = None;
    let selected = [CLEANUP_SETTINGS.to_owned()];
    apply_cleanup(state, manifest, &selected, caller_doc_filter(&caller)).await
}

async fn stored(state: &ServerState, key: &str) -> Option<String> {
    state.preferences.get(key).await.expect("read")
}

/// CE-32: an app whose manifest names the member folder list as one of its
/// settings does not take the list out of the store when it is uninstalled.
#[tokio::test]
async fn uninstall_cleanup_keeps_the_member_folder_list() {
    let data = tempfile::tempdir().expect("data");
    let folder = tempfile::tempdir().expect("member folder");
    let state = state_in(data.path());
    let list = list_value(folder.path());
    let preferences = &state.preferences;
    preferences
        .set(MEMBER_WORKSPACE_ROOTS_PREF_KEY, &list)
        .await
        .expect("list");
    preferences.set(VIEW_KEY, VIEW_VALUE).await.expect("view");
    let manifest = app_with_settings(json!([
        { "type": "text", "pref_key": MEMBER_WORKSPACE_ROOTS_PREF_KEY, "label": "Folders" },
        { "type": "text", "pref_key": VIEW_KEY, "label": "Default view" }
    ]));

    on_shared_node(&list, async {
        assert!(
            stored_folder_allowed(folder.path()),
            "the node has loaded the list"
        );
        assert_eq!(
            clean_settings(&state, &manifest).await,
            Vec::<String>::new()
        );
        assert_eq!(
            stored(&state, VIEW_KEY).await,
            None,
            "the app's own setting is removed"
        );
        assert_eq!(
            stored(&state, MEMBER_WORKSPACE_ROOTS_PREF_KEY).await,
            Some(list.clone()),
            "the member folder list stays in the store"
        );
        assert!(
            stored_folder_allowed(folder.path()),
            "and the list the node holds is the stored one, as before"
        );
    })
    .await;
}

/// The uninstall preview counts what the cleanup would remove, so it does not
/// count the member folder list either, however the manifest spells the field.
#[tokio::test]
async fn the_uninstall_preview_does_not_count_the_member_folder_list() {
    let data = tempfile::tempdir().expect("data");
    let folder = tempfile::tempdir().expect("member folder");
    let state = state_in(data.path());
    let preferences = &state.preferences;
    preferences
        .set(MEMBER_WORKSPACE_ROOTS_PREF_KEY, &list_value(folder.path()))
        .await
        .expect("list");
    preferences.set(VIEW_KEY, VIEW_VALUE).await.expect("view");
    let manifest = app_with_settings(json!([
        { "type": "group", "fields": [
            { "type": "text", "prefKey": MEMBER_WORKSPACE_ROOTS_PREF_KEY, "label": "Folders" }
        ]},
        { "type": "text", "pref_key": VIEW_KEY, "label": "Default view" }
    ]));

    assert_eq!(
        settings_usage(&state, &manifest).await,
        (1, VIEW_VALUE.len() as u64),
        "one saved setting, the app's own"
    );
}

/// The refusal is for that one key. A setting the app names is counted and
/// removed as before, and a preference the manifest does not name is left alone.
#[tokio::test]
async fn an_ordinary_setting_is_still_counted_and_removed() {
    const SORT_KEY: &str = "notes.sort";
    const OTHER_KEY: &str = "calendar.week-start";
    let data = tempfile::tempdir().expect("data");
    let state = state_in(data.path());
    let preferences = &state.preferences;
    preferences.set(VIEW_KEY, VIEW_VALUE).await.expect("view");
    preferences.set(SORT_KEY, "newest").await.expect("sort");
    preferences.set(OTHER_KEY, "monday").await.expect("other");
    let manifest = app_with_settings(json!([
        { "type": "text", "pref_key": VIEW_KEY, "label": "Default view" },
        { "type": "text", "prefKey": SORT_KEY, "label": "Sort order" }
    ]));

    let saved = (VIEW_VALUE.len() + "newest".len()) as u64;
    assert_eq!(settings_usage(&state, &manifest).await, (2, saved));
    assert_eq!(
        clean_settings(&state, &manifest).await,
        Vec::<String>::new()
    );
    assert_eq!(stored(&state, VIEW_KEY).await, None);
    assert_eq!(stored(&state, SORT_KEY).await, None);
    assert_eq!(settings_usage(&state, &manifest).await, (0, 0));
    assert_eq!(
        stored(&state, OTHER_KEY).await.as_deref(),
        Some("monday"),
        "a preference the app does not name is not touched"
    );
}
