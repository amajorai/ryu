use super::*;

const OWNER: &str = "@acme/notes";

fn manifest(contributes: serde_json::Value) -> PluginManifest {
    serde_json::from_value(serde_json::json!({
        "id": OWNER,
        "name": "Notes",
        "version": "1.0.0",
        "runnables": [],
        "contributes": contributes,
    }))
    .expect("manifest shape")
}

/// A view whose automatic source reads `path`.
fn view_with_source(path: &str) -> PluginManifest {
    manifest(serde_json::json!({
        "views": [{
            "id": "notes",
            "view": "list-detail",
            "spec": {
                "view": "list-detail",
                "items": [],
                "source": { "http": { "path": path } }
            }
        }]
    }))
}

/// A view whose one action posts to `path`.
fn view_with_action(path: &str) -> PluginManifest {
    manifest(serde_json::json!({
        "views": [{
            "id": "notes",
            "view": "list-detail",
            "spec": {
                "view": "list-detail",
                "items": [],
                "actions": [{
                    "id": "create",
                    "label": "Create",
                    "http": { "method": "POST", "path": path }
                }]
            }
        }]
    }))
}

/// `/api/ext/@acme/notes/.<c>./.<c>./.<c>./conversations`, which a URL parser sends
/// as `/api/conversations` when `c` is a tab, a line feed or a carriage return
/// (three hops up, because this owner id has two segments).
fn smuggled(separator: char) -> String {
    let hop = format!(".{separator}.");
    format!("/api/ext/{OWNER}/{hop}/{hop}/{hop}/conversations?preview=1")
}

fn assert_community_refuses(path: &str, what: &str) {
    for candidate in [view_with_source(path), view_with_action(path)] {
        assert!(
            candidate
                .validate_declarative_http_authority(false)
                .is_err(),
            "a Community app must not declare {what}: {path:?}"
        );
    }
}

#[test]
fn community_declarative_http_refuses_a_tab_in_the_path() {
    assert_community_refuses(&smuggled('\t'), "a path with a tab");
}

#[test]
fn community_declarative_http_refuses_a_line_feed_in_the_path() {
    assert_community_refuses(&smuggled('\n'), "a path with a line feed");
}

#[test]
fn community_declarative_http_refuses_a_carriage_return_in_the_path() {
    assert_community_refuses(&smuggled('\r'), "a path with a carriage return");
}

#[test]
fn trusted_core_declarative_http_refuses_control_characters_too() {
    for separator in ['\t', '\n', '\r', '\u{0}', '\u{1f}', '\u{7f}', '\u{85}'] {
        let path = format!("/api/workflows/.{separator}./.{separator}./preferences");
        assert!(
            view_with_source(&path)
                .validate_declarative_http_authority(true)
                .is_err(),
            "a Core tier manifest must not declare {path:?}"
        );
    }
}

#[test]
fn the_parser_resolves_the_smuggled_path_outside_the_mount() {
    for separator in ['\t', '\n', '\r'] {
        assert_eq!(
            normalized_pathname(&smuggled(separator)).as_deref(),
            Some("/api/conversations"),
            "separator {separator:?}"
        );
    }
}

#[test]
fn the_owner_mount_test_runs_on_the_normalized_path() {
    // The route rule alone, without the character rule in front of it.
    for separator in ['\t', '\n', '\r'] {
        let error = check_normalized_route(OWNER, &smuggled(separator), false)
            .expect_err("the normalized path leaves the mount");
        assert!(error.contains("'/api/conversations'"), "{error}");
    }
    // A single dot segment stays inside the mount and is harmless.
    check_normalized_route(OWNER, "/api/ext/@acme/notes/./items", false)
        .expect("resolves inside the mount");
    assert!(check_normalized_route(OWNER, "/api/ext/@acme/notes-two/items", false).is_err());
    assert!(check_normalized_route("../agents", "/api/ext/../agents/x", false).is_err());
    // Core tier keeps the route families, tested on the normalized path too.
    check_normalized_route(OWNER, "/api/workflows/catalog", true).expect("Core route");
    check_normalized_route(OWNER, "/workflows", true).expect("workflows root");
    assert!(check_normalized_route(OWNER, "/api/\t../\t../health", true).is_err());
}

#[test]
fn owner_paths_as_apps_write_them_stay_valid() {
    for path in [
        "/api/ext/@acme/notes",
        "/api/ext/@acme/notes/",
        "/api/ext/@acme/notes/items?window=today",
        "/api/ext/@acme/notes/items/{{item.id}}/done",
        "/api/ext/@acme/notes/items/{{ item.id }}",
        "/api/ext/@acme/notes/items?q={{ query }}&page={{page}}",
    ] {
        view_with_source(path)
            .validate_declarative_http_authority(false)
            .unwrap_or_else(|error| panic!("{path} must stay valid: {error}"));
        view_with_action(path)
            .validate_declarative_http_authority(false)
            .unwrap_or_else(|error| panic!("{path} must stay valid: {error}"));
    }
    manifest(serde_json::json!({}))
        .validate_declarative_http_authority(false)
        .expect("no contributions, nothing to refuse");
}

#[test]
fn a_space_is_allowed_only_as_padding_inside_a_template_token() {
    for path in [
        "/api/ext/@acme/notes/my items",
        "/api/ext/@acme/notes/items ",
        "/api/ext/@acme/notes/items?q=a b",
        "/api/ext/@acme/notes/{{ item id }}",
        "/api/ext/@acme/notes/{{ }}",
        "/api/ext/@acme/notes/{{ item.id }",
    ] {
        assert_community_refuses(path, "a path with a stray space");
    }
    assert_eq!(forbidden_character("/a/{{ item.id }}/b"), None);
    assert_eq!(forbidden_character("/a/{{item.id}} /b"), Some(' '));
    assert_eq!(forbidden_character("/a/\u{7f}"), Some('\u{7f}'));
}

#[test]
fn the_rules_of_the_manifest_gate_still_apply() {
    for path in [
        "/api/preferences",
        "/api/ext/@acme/other/items",
        "/api/ext/@acme/notes/%2e%2e/other/items",
        "/api/ext/@acme/notes/x%2f..%2fother",
        "//evil.example/api/ext/@acme/notes",
    ] {
        assert_community_refuses(path, "a path outside its mount");
    }
    let delete_source = manifest(serde_json::json!({
        "sidebar_sections": [{
            "id": "notes",
            "title": "Notes",
            "spec": {
                "source": {
                    "http": { "method": "DELETE", "path": "/api/ext/@acme/notes/items" }
                }
            }
        }]
    }));
    let error = delete_source
        .validate_declarative_http_authority(false)
        .expect_err("automatic DELETE must be rejected");
    assert!(error.contains("automatic sources must use GET"), "{error}");
}

#[test]
fn every_contribution_kind_is_walked_and_opaque_data_is_skipped() {
    let hostile = smuggled('\t');
    for contributes in [
        serde_json::json!({ "composer_controls": [{
            "id": "status", "type": "chip", "label": "Status", "flag": "status",
            "source": { "http": { "path": hostile } }
        }] }),
        serde_json::json!({ "sidebar_sections": [{
            "id": "notes", "title": "Notes",
            "spec": { "source": { "http": { "path": hostile } } }
        }] }),
        serde_json::json!({ "store_tabs": [{
            "id": "templates", "title": "Templates",
            "spec": { "install": { "http": { "method": "POST", "path": hostile } } }
        }] }),
        serde_json::json!({ "message_actions": [{
            "id": "save", "label": "Save",
            "http": { "method": "POST", "path": hostile }
        }] }),
    ] {
        assert!(
            manifest(contributes.clone())
                .validate_declarative_http_authority(false)
                .is_err(),
            "must be refused: {contributes}"
        );
    }
    // A request body is data. An `http` key inside it is not a declaration.
    let body_only = manifest(serde_json::json!({
        "message_actions": [{
            "id": "save",
            "label": "Save",
            "http": {
                "method": "POST",
                "path": "/api/ext/@acme/notes/items",
                "body": { "http": { "path": hostile } }
            }
        }]
    }));
    body_only
        .validate_declarative_http_authority(false)
        .expect("a body is not walked");
}
