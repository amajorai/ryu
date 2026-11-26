//! Agents may not switch on an MCP server that was installed from a registry.
//!
//! A catalog install writes the server to `mcp.json` switched off and adds a
//! switched-off app record of the "MCP Server" category, so a registry package
//! never starts just because it was installed. Switching that app record on is
//! what sets `enabled` on the `mcp.json` entry, and from then on Core starts the
//! package (`npx`, `uvx` or `docker`) with the user's own access the next time
//! its tools are listed or called.
//!
//! That step stays with the person. The approval prompt for the enable tool
//! shows an app id, not the program that will run, and "Allow for this chat" is
//! kept per tool, so one approved enable of a harmless app would cover every
//! later one. The call is therefore refused before the loopback, whatever was
//! approved, and every other app is left alone.

use super::*;
use crate::plugin_manifest::PluginManifest;

/// The routes that switch an installed app on. The `/api/apps` alias is mounted
/// but is not in the OpenAPI document, so it is no tool today; it is listed so
/// that documenting it later does not open a second way in.
const APP_ENABLE_ROUTES: &[&str] = &["/api/plugins/{id}/enable", "/api/apps/{id}/enable"];

/// The app id a self-API call asks Core to switch on, or `None` when the tool
/// is not the app enable route.
pub fn app_enable_target(tool_id: &str, arguments: &Value) -> Option<String> {
    let route = route_for(tool_id)?;
    if route.method != "POST" || !APP_ENABLE_ROUTES.contains(&route.path_template.as_str()) {
        return None;
    }
    Some(
        arguments
            .get("id")
            .filter(|id| !id.is_null())
            .map(value_to_string)
            .unwrap_or_default(),
    )
}

/// Whether `manifest` is the app record of an MCP server from a registry. This
/// is the test the app lifecycle applies before it writes `enabled` to the
/// server's `mcp.json` entry.
pub fn is_mcp_server_record(manifest: &PluginManifest) -> bool {
    manifest.category.as_deref() == Some(crate::sidecar::mcp::MCP_SERVER_CATEGORY)
}

/// Why an agent may not make this self-API call: it would switch on an MCP
/// server that was installed from a registry. `None` when the call may go on.
///
/// `installed` holds the manifests of the installed apps and `enabled` the ids
/// that are switched on now. The enable route also switches on every app the
/// target requires, so the whole enable order is checked, not only the id in
/// the call. A required server that is already on is left alone, because this
/// call would not change it. The target itself is always checked: enabling it
/// again writes `enabled` to `mcp.json` again.
pub fn mcp_server_enable_refusal(
    tool_id: &str,
    arguments: &Value,
    installed: &[PluginManifest],
    enabled: &HashSet<String>,
) -> Option<String> {
    let target = app_enable_target(tool_id, arguments)?;
    let lowered = crate::plugins::binding::lower_manifests(
        installed,
        &crate::plugins::binding::active_config(),
    );
    // A dependency error stops the real enable before anything is switched on,
    // so only the target is left to check.
    let order = crate::plugins::graph::resolve_enable_order(&target, &lowered)
        .unwrap_or_else(|_| vec![target.clone()]);
    let servers: Vec<String> = order
        .into_iter()
        .filter(|id| *id == target || !enabled.contains(id))
        .filter(|id| {
            installed
                .iter()
                .any(|manifest| manifest.id == *id && is_mcp_server_record(manifest))
        })
        .map(|id| format!("'{id}'"))
        .collect();
    if servers.is_empty() {
        return None;
    }
    let noun = if servers.len() == 1 {
        "the MCP server"
    } else {
        "the MCP servers"
    };
    Some(format!(
        "enabling '{target}' would switch on {noun} {}, installed from a registry. That starts \
         a program on this computer with the user's access, so an agent cannot do it. Ask the \
         user to switch it on themselves in Settings.",
        servers.join(", ")
    ))
}

/// The refusal for an app enable call when Core cannot read which apps are
/// installed, and so cannot rule out that the call switches on an MCP server.
/// `None` for every other tool.
pub fn app_enable_unchecked_refusal(tool_id: &str, arguments: &Value) -> Option<String> {
    let target = app_enable_target(tool_id, arguments)?;
    Some(format!(
        "cannot check whether enabling '{target}' would switch on an MCP server, because the \
         installed apps cannot be read here. Ask the user to enable it in Settings."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{AppDependency, Requires};

    const ENABLE: &str = "ryu_api.post_api_plugins_id_enable";

    fn app(id: &str, requires: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            requires: (!requires.is_empty()).then(|| Requires {
                apps: requires
                    .iter()
                    .map(|dependency| AppDependency {
                        id: (*dependency).to_owned(),
                        min_version: None,
                    })
                    .collect(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn mcp_server(id: &str) -> PluginManifest {
        PluginManifest {
            category: Some(crate::sidecar::mcp::MCP_SERVER_CATEGORY.to_owned()),
            ..app(id, &[])
        }
    }

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    fn enable(id: &str) -> Value {
        json!({ "id": id })
    }

    #[test]
    fn the_enable_route_is_an_agent_tool_and_its_alias_is_not() {
        let route = route_for(ENABLE).expect("POST /api/plugins/{id}/enable is a self-API tool");
        assert_eq!(route.method, "POST");
        assert_eq!(route.path_template, "/api/plugins/{id}/enable");
        assert!(is_mutating(ENABLE));
        assert!(!is_denied(&route.path_template, "post"));
        // The alias is mounted but undocumented, so it is not a tool today.
        assert!(route_for("ryu_api.post_api_apps_id_enable").is_none());
    }

    #[test]
    fn only_the_enable_tool_names_an_enable_target() {
        assert_eq!(
            app_enable_target(ENABLE, &enable("context7")).as_deref(),
            Some("context7")
        );
        assert_eq!(app_enable_target(ENABLE, &json!({})).as_deref(), Some(""));
        for other in [
            "ryu_api.post_api_plugins_id_disable",
            "ryu_api.get_api_plugins",
            "ryu_api.post_api_mcp_servers",
            "workspace.switch_interface",
        ] {
            assert_eq!(
                app_enable_target(other, &enable("context7")),
                None,
                "{other}"
            );
            assert_eq!(
                app_enable_unchecked_refusal(other, &enable("context7")),
                None,
                "{other}"
            );
        }
    }

    #[test]
    fn enabling_an_mcp_server_record_is_refused_on_or_off() {
        let installed = [mcp_server("context7"), app("notes", &[])];
        for enabled in [ids(&[]), ids(&["context7"])] {
            let refusal =
                mcp_server_enable_refusal(ENABLE, &enable("context7"), &installed, &enabled)
                    .expect("an agent may not switch an MCP server record on");
            assert!(refusal.contains("the MCP server 'context7'"), "{refusal}");
            assert!(refusal.contains("in Settings"), "{refusal}");
        }
    }

    #[test]
    fn an_ordinary_app_keeps_todays_behaviour() {
        let installed = [mcp_server("context7"), app("notes", &[])];
        assert_eq!(
            mcp_server_enable_refusal(ENABLE, &enable("notes"), &installed, &ids(&[])),
            None
        );
        // An id Core does not know is left to the handler, which answers 404.
        assert_eq!(
            mcp_server_enable_refusal(ENABLE, &enable("missing"), &installed, &ids(&[])),
            None
        );
        // Another tool is never refused here, whatever its arguments name.
        assert_eq!(
            mcp_server_enable_refusal(
                "ryu_api.post_api_plugins_id_disable",
                &enable("context7"),
                &installed,
                &ids(&["context7"])
            ),
            None
        );
    }

    #[test]
    fn an_app_that_requires_a_switched_off_server_is_refused() {
        let installed = [
            mcp_server("context7"),
            mcp_server("fetcher"),
            app("helper", &["context7", "fetcher"]),
            app("wrapper", &["helper"]),
        ];
        // Both required servers are off: the enable order would switch on both.
        let refusal = mcp_server_enable_refusal(ENABLE, &enable("wrapper"), &installed, &ids(&[]))
            .expect("the enable order reaches two MCP server records");
        for expected in ["the MCP servers ", "'context7'", "'fetcher'"] {
            assert!(refusal.contains(expected), "{expected}: {refusal}");
        }
        assert!(!refusal.contains("'helper'"), "{refusal}");
        // One is already on, so only the other would change.
        let refusal =
            mcp_server_enable_refusal(ENABLE, &enable("helper"), &installed, &ids(&["context7"]))
                .expect("one required server is still off");
        assert!(refusal.contains("the MCP server 'fetcher'"), "{refusal}");
        // Both already run: enabling the app starts nothing new.
        assert_eq!(
            mcp_server_enable_refusal(
                ENABLE,
                &enable("helper"),
                &installed,
                &ids(&["context7", "fetcher"])
            ),
            None
        );
    }

    #[test]
    fn an_enable_call_that_cannot_be_checked_is_refused() {
        let refusal = app_enable_unchecked_refusal(ENABLE, &enable("context7"))
            .expect("fails closed for the enable tool");
        assert!(refusal.contains("'context7'"), "{refusal}");
    }
}
