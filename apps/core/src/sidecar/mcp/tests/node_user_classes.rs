//! What puts a tool into a class of the node-user rule, on test data and on the
//! manifests that ship with Core. Text and data only: nothing is called.

use super::fixtures::class_apps;
use super::*;
use crate::plugin_manifest::schema::{ToolBackend, ToolConfig};
use serde_json::json;

fn backend(config: Value) -> ToolBackend {
    serde_json::from_value::<ToolConfig>(config)
        .expect("a tool config")
        .resolve_backend()
        .expect("a tool backend")
}

fn command_with_env(env: Value) -> ToolBackend {
    backend(json!({
        "slug": "cecommand",
        "backend": "command",
        "bin": "ce36-no-such-bin",
        "command_env": env,
    }))
}

#[test]
fn a_command_backend_that_is_handed_a_saved_key_is_a_credential_tool() {
    for source in ["secret:ce36-key", "vault:ce36/key", "env:CE36_TEST_TOKEN"] {
        assert_eq!(
            app_tool_class(&command_with_env(json!({ "TOKEN": source })), false, false),
            Some(NodeUserToolClass::Credential),
            "{source}"
        );
    }
    // Core's own signed agent lane is not a saved key, and no env is no key.
    assert_eq!(
        app_tool_class(
            &command_with_env(json!({ "RYU_TOKEN": "env:RYU_TOKEN" })),
            false,
            false
        ),
        None
    );
    assert_eq!(
        app_tool_class(&command_with_env(json!({})), false, false),
        None
    );
}

#[test]
fn a_key_in_a_request_header_puts_a_tool_in_no_class() {
    // A keyed search app stays usable by members: the key travels in a header
    // of a request Core sends, the member cannot read it, and the
    // organization's tool policy is the control.
    let keyed = backend(json!({
        "slug": "cesearch",
        "backend": "http",
        "url": "https://ce36.invalid/search",
        "secret_headers": { "X-Api-Key": "env:CE36_TEST_KEY" },
    }));
    assert_eq!(app_tool_class(&keyed, false, false), None);
    // The manifest's own mark puts any backend into the credential class.
    assert_eq!(
        app_tool_class(&keyed, true, false),
        Some(NodeUserToolClass::Credential)
    );
}

#[test]
fn a_backend_that_reads_the_capture_api_is_a_captures_tool() {
    let captures = backend(json!({
        "slug": "cecapture",
        "backend": "http",
        "method": "GET",
        "url": "core:/api/shadow/search",
    }));
    assert_eq!(
        app_tool_class(&captures, false, false),
        Some(NodeUserToolClass::Captures)
    );
    // The route decides, whatever else the app provides.
    assert_eq!(
        app_tool_class(&captures, false, true),
        Some(NodeUserToolClass::Captures)
    );
    let other_core_route = backend(json!({
        "slug": "cenotes",
        "backend": "http",
        "method": "GET",
        "url": "core:/api/spaces",
    }));
    assert_eq!(app_tool_class(&other_core_route, false, false), None);
}

#[test]
fn an_app_that_provides_the_node_session_makes_its_tools_desktop_or_browser_tools() {
    let plain = backend(json!({
        "slug": "cepage",
        "backend": "http",
        "url": "https://ce36.invalid/page",
    }));
    assert_eq!(app_tool_class(&plain, false, false), None);
    assert_eq!(
        app_tool_class(&plain, false, true),
        Some(NodeUserToolClass::DesktopOrBrowser)
    );

    let drives: Vec<(String, bool)> = class_apps()
        .iter()
        .map(|manifest| (manifest.id.clone(), manifest_drives_node_session(manifest)))
        .collect();
    for (id, drives) in drives {
        assert_eq!(drives, id == "com.test.ce36.browser", "{id}");
    }

    // Each of the three capabilities counts on this machine, none on another.
    let provider =
        |capability: &str, target: crate::plugin_manifest::ProviderTarget| PluginManifest {
            id: "com.test.ce36.provider".to_owned(),
            provides: vec![crate::plugin_manifest::ProvidesEntry {
                capability: capability.to_owned(),
                version: "1.0.0".to_owned(),
                target: Some(target),
                ..Default::default()
            }],
            ..Default::default()
        };
    for capability in ["computer.control", "browser.control", "browser.session"] {
        assert!(
            manifest_drives_node_session(&provider(
                capability,
                crate::plugin_manifest::ProviderTarget::LocalMachine
            )),
            "{capability} on this machine"
        );
        assert!(
            !manifest_drives_node_session(&provider(
                capability,
                crate::plugin_manifest::ProviderTarget::RemoteDesktop
            )),
            "{capability} on another machine"
        );
    }
    assert!(!manifest_drives_node_session(&provider(
        "web.search",
        crate::plugin_manifest::ProviderTarget::LocalMachine
    )));
}

#[test]
fn a_local_server_that_is_handed_a_saved_key_is_a_credential_server() {
    let mut local = McpServerConfig::default();
    local.command = Some("ce36-no-such-bin".to_owned());
    local.owner_plugin_id = Some("com.test.ce36.server".to_owned());
    assert_eq!(server_config_class(&local, false), None);
    local
        .env
        .insert("TOKEN".to_owned(), "secret:ce36-key".to_owned());
    assert_eq!(
        server_config_class(&local, false),
        Some(NodeUserToolClass::Credential)
    );

    // A remote server with a token in a header stays usable by members.
    let mut remote = McpServerConfig::default();
    remote.url = Some("https://ce36.invalid/mcp".to_owned());
    remote.owner_plugin_id = Some("com.test.ce36.server".to_owned());
    remote
        .headers
        .insert("Authorization".to_owned(), "secret:ce36-key".to_owned());
    assert_eq!(server_config_class(&remote, false), None);
    // A server of an app that drives the node user's session is in the class.
    assert_eq!(
        server_config_class(&remote, true),
        Some(NodeUserToolClass::DesktopOrBrowser)
    );
}

fn shipped(id: &str) -> PluginManifest {
    crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .chain(crate::plugin_manifest::PluginManifestLoader::load_builtins())
        .find(|manifest| manifest.id == id)
        .unwrap_or_else(|| panic!("{id} is compiled into Core"))
}

fn shipped_tool_class(manifest: &PluginManifest, slug: &str) -> Option<NodeUserToolClass> {
    let config = manifest
        .runnables
        .iter()
        .filter_map(|entry| entry.config.as_ref())
        .find(|config| config.get("slug").and_then(Value::as_str) == Some(slug))
        .unwrap_or_else(|| panic!("{slug} is a tool of {}", manifest.id));
    let returns_credential = config
        .get("returns_credential")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    app_tool_class(
        &backend(config.clone()),
        returns_credential,
        manifest_drives_node_session(manifest),
    )
}

#[test]
fn the_classes_of_the_shipped_manifests() {
    let bitwarden = shipped("@ryu/bitwarden");
    for slug in ["bitwarden.projects", "bitwarden.list", "bitwarden.get"] {
        assert_eq!(
            shipped_tool_class(&bitwarden, slug),
            Some(NodeUserToolClass::Credential),
            "{slug}"
        );
    }
    // The status tool is handed no credential.
    assert_eq!(shipped_tool_class(&bitwarden, "bitwarden.status"), None);

    let shadow = shipped("@ryu/shadow");
    for slug in [
        "shadow.search",
        "shadow.semantic_search",
        "shadow.timeline",
        "shadow.recent_context",
        "shadow.computer_use",
    ] {
        assert_eq!(
            shipped_tool_class(&shadow, slug),
            Some(NodeUserToolClass::Captures),
            "{slug}"
        );
    }

    for id in ["@ryu/ghost", "@ryu/agentbrowser", "@ryu/browser"] {
        assert!(manifest_drives_node_session(&shipped(id)), "{id}");
    }
    assert_eq!(
        shipped_tool_class(&shipped("@ryu/browser"), "chromium.list_tabs"),
        Some(NodeUserToolClass::DesktopOrBrowser)
    );
    assert!(!manifest_drives_node_session(&bitwarden));
}
