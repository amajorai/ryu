//! Built-in workspace-control actions for agents.
//!
//! These tools do not reach the desktop directly. Core publishes a typed,
//! user-scoped navigation request and the connected shell consumes it. The
//! destination is a page key rather than a raw route so an agent can open a
//! useful Ryu surface without gaining an arbitrary deep-link primitive.

use anyhow::Result;
use serde_json::{json, Value};

use super::{RegistryTool, ToolPrincipal};

/// Reserved registry server for agent-driven shell actions.
pub const SERVER_NAME: &str = "workspace";

/// The source label used by the desktop to distinguish safe page-key requests
/// from the legacy plugin `host.navigate` route requests.
const AGENT_SOURCE: &str = "agent";

/// The Core copy of the page-key vocabulary consumed by Desktop's `pageRoute`.
/// Keep this list conservative: adding a page here is an agent-facing navigation
/// contract and must be mirrored in `apps/desktop/src/lib/page-routes.ts`.
const PAGE_ROUTES: &[(&str, &str)] = &[
    ("chat", "/chat"),
    ("agents", "/library/agent"),
    ("models", "/models"),
    ("skills", "/skills"),
    ("tools", "/tools"),
    ("spaces", "/library/space"),
    ("workflows", "/library/workflow"),
    ("channels", "/library/channel"),
    ("identities", "/library/identity"),
    ("automations", "/library/workflow"),
    ("monitors", "/monitors"),
    ("approvals", "/approvals"),
    ("marketplace", "/marketplace"),
    ("settings", "/settings"),
    ("timeline", "/timeline"),
    ("review", "/review"),
    ("fleet", "/fleet"),
    ("extensions", "/extensions"),
    ("apps", "/apps"),
    ("plugins", "/apps"),
    ("engines", "/engines"),
    ("store", "/store"),
    ("calendar", "/calendar"),
];

/// Resolve one safe page key to its first-party route.
pub fn page_route(page: &str) -> Option<&'static str> {
    PAGE_ROUTES
        .iter()
        .find_map(|(key, route)| (*key == page).then_some(*route))
}

fn page_keys() -> Vec<&'static str> {
    PAGE_ROUTES.iter().map(|(key, _)| *key).collect()
}

fn page_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "page": {
                "type": "string",
                "enum": page_keys(),
                "description": "Safe Ryu page key to open. Use the page name, not a raw route or URL."
            },
            "force_new": {
                "type": "boolean",
                "description": "For open_tab only: open a fresh top-level tab instead of following the user's tab-reuse preference."
            }
        },
        "required": ["page"]
    })
}

fn browser_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "HTTP(S) URL to load in Ryu's embedded Browser panel."
            }
        },
        "required": ["url"]
    })
}

/// Built-in interface renderers that are not Marketplace-contributable but that a
/// user can still switch to (subject to the shell's own access gate).
const HOST_ONLY_INTERFACE_RENDERERS: &[&str] = &["bot", "console"];

/// Every built-in interface id (`ryu:<renderer>`), in switcher order.
fn builtin_interface_ids() -> Vec<String> {
    HOST_ONLY_INTERFACE_RENDERERS
        .iter()
        .chain(ryu_kernel_contracts::manifest::CONTRIBUTABLE_INTERFACE_RENDERERS.iter())
        .map(|renderer| {
            format!(
                "{}:{renderer}",
                ryu_kernel_contracts::manifest::BUILTIN_INTERFACE_NAMESPACE
            )
        })
        .collect()
}

fn interface_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "interface": {
                "type": "string",
                "description": format!(
                    "Interface id to switch to. Built-in ids: {}. Marketplace interfaces use \
                     '<plugin>:<id>' ids, listed under `interfaces` by \
                     ryu_api.get_api_plugins_contributions.",
                    builtin_interface_ids().join(", ")
                )
            }
        },
        "required": ["interface"]
    })
}

fn read_only_annotations() -> Value {
    json!({ "readOnlyHint": true, "destructiveHint": false })
}

/// Agent-visible workspace actions. Opening a surface is a read-only shell
/// operation; it does not write Ryu data, send a message, or change a routine.
pub fn tools() -> Vec<RegistryTool> {
    let annotations = read_only_annotations();
    vec![
        RegistryTool {
            id: format!("{SERVER_NAME}.open_tab"),
            server: SERVER_NAME.to_owned(),
            name: "open_tab".to_owned(),
            description: Some(
                "Open or focus a normal Ryu workspace tab for a safe page key. Use this to \
                 take the user to Agents, Spaces, Workflows, Settings, Calendar, or another \
                 first-party page. The page key is allowlisted; raw routes and external URLs \
                 belong to browser.open or web tools. Returns queued=true when the shell request \
                 has been published."
                    .to_owned(),
            ),
            input_schema: Some(page_schema()),
            annotations: Some(annotations.clone()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.open_panel"),
            server: SERVER_NAME.to_owned(),
            name: "open_panel".to_owned(),
            description: Some(
                "Open or focus a safe Ryu page in the current chat's workspace panel. Use this \
                 when the user should keep the current conversation visible beside the page. \
                 Returns queued=true; the focused chat shell consumes the request."
                    .to_owned(),
            ),
            input_schema: Some(page_schema()),
            annotations: Some(annotations.clone()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.open_browser"),
            server: SERVER_NAME.to_owned(),
            name: "open_browser".to_owned(),
            description: Some(
                "Open Ryu's embedded Browser workspace panel and load an HTTP(S) URL. This \
                 brings the browser surface to the user; use browser.* tools for page inspection \
                 and control when the browser capability is enabled."
                    .to_owned(),
            ),
            input_schema: Some(browser_schema()),
            annotations: Some(annotations),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.switch_interface"),
            server: SERVER_NAME.to_owned(),
            name: "switch_interface".to_owned(),
            description: Some(
                "Switch the user's Ryu interface (the presentation layer: Bot, the OS desktop, \
                 Console, Channels, Feed, Board, the 2D/3D worlds, or a Marketplace interface). \
                 Only do this when the user asks. The user is asked to confirm first, and the \
                 shell ignores an interface its own switcher would not offer them (for example \
                 Console without organization authority, or one that is not rolled out). \
                 Returns queued=true once the request is published."
                    .to_owned(),
            ),
            input_schema: Some(interface_schema()),
            // Not read-only: it changes the user's remembered interface. Not
            // destructive: switching back is one click.
            annotations: Some(json!({ "readOnlyHint": false, "destructiveHint": false })),
            ..Default::default()
        },
    ]
}

fn target_user_id(principal: &ToolPrincipal) -> Result<Option<String>> {
    match principal {
        ToolPrincipal::Unrestricted => Ok(None),
        ToolPrincipal::Owned { user_id, .. } => Ok(Some(user_id.clone())),
        ToolPrincipal::Unresolved => Err(anyhow::anyhow!(
            "workspace actions are unavailable: this shared-node agent turn has no identifiable owner"
        )),
    }
}

fn required_page(arguments: &Value) -> Result<&str> {
    let page = arguments
        .get("page")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|page| !page.is_empty())
        .ok_or_else(|| anyhow::anyhow!("workspace action requires a non-empty 'page'"))?;
    page_route(page)
        .map(|_| page)
        .ok_or_else(|| anyhow::anyhow!("unknown workspace page '{page}'"))
}

fn force_new(arguments: &Value) -> Result<bool> {
    match arguments.get("force_new") {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(anyhow::anyhow!("'force_new' must be a boolean")),
    }
}

fn browser_url(arguments: &Value) -> Result<String> {
    let url = arguments
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| anyhow::anyhow!("workspace.open_browser requires a non-empty 'url'"))?;
    if url.len() > 4096 || url.chars().any(char::is_control) {
        return Err(anyhow::anyhow!("browser URL is invalid or too long"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(anyhow::anyhow!(
            "workspace.open_browser accepts only http:// or https:// URLs"
        ));
    }
    Ok(url.to_owned())
}

fn interface_id(arguments: &Value) -> Result<String> {
    let id = arguments
        .get("interface")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("workspace.switch_interface requires a non-empty 'interface'")
        })?;
    let builtin_prefix = format!(
        "{}:",
        ryu_kernel_contracts::manifest::BUILTIN_INTERFACE_NAMESPACE
    );
    if id.starts_with(&builtin_prefix) {
        return if builtin_interface_ids().iter().any(|builtin| builtin == id) {
            Ok(id.to_owned())
        } else {
            Err(anyhow::anyhow!("unknown built-in interface '{id}'"))
        };
    }
    // A Marketplace interface: `<plugin>:<local-id>`, same shape the manifest
    // validator accepts. The shell still checks it against installed plugins.
    let (plugin, local) = id
        .rsplit_once(':')
        .ok_or_else(|| anyhow::anyhow!("interface id '{id}' must look like '<plugin>:<id>'"))?;
    let local_ok = !local.is_empty()
        && local.len() <= 96
        && local
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && local
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    let plugin_ok = !plugin.is_empty()
        && plugin.len() <= 128
        && !plugin.chars().any(|c| c.is_control() || c.is_whitespace());
    if local_ok && plugin_ok {
        Ok(id.to_owned())
    } else {
        Err(anyhow::anyhow!(
            "interface id '{id}' is not a valid interface id"
        ))
    }
}

/// Publish one workspace action. The desktop consumes this through the existing
/// navigation SSE bus, so agents and plugins share the same shell event path.
pub async fn dispatch(tool: &str, arguments: Value, principal: &ToolPrincipal) -> Result<Value> {
    let target_user_id = target_user_id(principal)?;
    match tool {
        "open_tab" => {
            let page = required_page(&arguments)?;
            let route = page_route(page).expect("required_page validates the key");
            let force_new = force_new(&arguments)?;
            crate::events::publish_navigation(crate::events::NavigationRequest {
                plugin_id: AGENT_SOURCE.to_owned(),
                target: page.to_owned(),
                params: Some(json!({ "route": route })),
                kind: crate::events::NavigationKind::Tab,
                force_new,
                target_user_id,
            });
            Ok(json!({
                "queued": true,
                "surface": "tab",
                "page": page,
                "route": route,
                "force_new": force_new
            }))
        }
        "open_panel" => {
            let page = required_page(&arguments)?;
            let route = page_route(page).expect("required_page validates the key");
            crate::events::publish_navigation(crate::events::NavigationRequest {
                plugin_id: AGENT_SOURCE.to_owned(),
                target: page.to_owned(),
                params: Some(json!({ "route": route })),
                kind: crate::events::NavigationKind::Panel,
                force_new: false,
                target_user_id,
            });
            Ok(json!({
                "queued": true,
                "surface": "panel",
                "page": page,
                "route": route
            }))
        }
        "open_browser" => {
            let url = browser_url(&arguments)?;
            crate::events::publish_navigation(crate::events::NavigationRequest {
                plugin_id: AGENT_SOURCE.to_owned(),
                target: url.clone(),
                params: None,
                kind: crate::events::NavigationKind::Browser,
                force_new: false,
                target_user_id,
            });
            Ok(json!({
                "queued": true,
                "surface": "browser",
                "url": url
            }))
        }
        "switch_interface" => {
            let interface = interface_id(&arguments)?;
            crate::events::publish_navigation(crate::events::NavigationRequest {
                plugin_id: AGENT_SOURCE.to_owned(),
                target: interface.clone(),
                params: None,
                kind: crate::events::NavigationKind::Interface,
                force_new: false,
                target_user_id,
            });
            Ok(json!({
                "queued": true,
                "surface": "interface",
                "interface": interface
            }))
        }
        other => Err(anyhow::anyhow!("unknown workspace tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_keys_resolve_only_first_party_routes() {
        assert_eq!(page_route("agents"), Some("/library/agent"));
        assert_eq!(page_route("review"), Some("/review"));
        assert_eq!(page_route("toString"), None);
        assert_eq!(page_route("https://example.com"), None);
    }

    #[test]
    fn browser_urls_are_http_only() {
        assert!(browser_url(&json!({ "url": "https://example.com" })).is_ok());
        assert!(browser_url(&json!({ "url": "http://localhost:3000" })).is_ok());
        assert!(browser_url(&json!({ "url": "javascript:alert(1)" })).is_err());
        assert!(browser_url(&json!({ "url": "data:text/html,hello" })).is_err());
    }

    #[test]
    fn shared_node_without_principal_is_refused() {
        assert!(target_user_id(&ToolPrincipal::Unresolved).is_err());
        assert_eq!(
            target_user_id(&ToolPrincipal::Owned {
                user_id: "u1".to_owned(),
                org_id: Some("o1".to_owned()),
            })
            .unwrap(),
            Some("u1".to_owned())
        );
    }

    #[test]
    fn interface_ids_are_builtins_or_plugin_scoped() {
        assert_eq!(
            interface_id(&json!({ "interface": "ryu:channels" })).unwrap(),
            "ryu:channels"
        );
        assert!(interface_id(&json!({ "interface": "ryu:console" })).is_ok());
        assert!(interface_id(&json!({ "interface": "ryu:bot" })).is_ok());
        assert!(interface_id(&json!({ "interface": "ryu:not-a-renderer" })).is_err());
        assert!(interface_id(&json!({ "interface": "@acme/pack:retro-feed" })).is_ok());
        assert!(interface_id(&json!({ "interface": "acme:Bad Id" })).is_err());
        assert!(interface_id(&json!({ "interface": "channels" })).is_err());
        assert!(interface_id(&json!({ "interface": "" })).is_err());
        assert!(interface_id(&json!({})).is_err());
    }

    #[test]
    fn switch_interface_is_listed_and_not_read_only() {
        let tool = tools()
            .into_iter()
            .find(|tool| tool.id == "workspace.switch_interface")
            .expect("switch_interface is advertised");
        assert_eq!(tool.annotations.unwrap()["readOnlyHint"], false);
    }

    #[tokio::test]
    async fn switch_interface_publishes_an_interface_request() {
        let mut rx = crate::events::subscribe_navigation();
        let result = dispatch(
            "switch_interface",
            json!({ "interface": "ryu:feed" }),
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("workspace dispatch succeeds");
        assert_eq!(result["surface"], "interface");
        let event = loop {
            let event = rx.try_recv().expect("navigation event published");
            if event.kind == crate::events::NavigationKind::Interface {
                break event;
            }
        };
        assert_eq!(event.target, "ryu:feed");
    }

    #[tokio::test]
    async fn open_panel_publishes_a_panel_request() {
        let mut rx = crate::events::subscribe_navigation();
        let result = dispatch(
            "open_panel",
            json!({ "page": "agents" }),
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("workspace dispatch succeeds");
        assert_eq!(result["surface"], "panel");
        let event = rx.try_recv().expect("navigation event published");
        assert_eq!(event.kind, crate::events::NavigationKind::Panel);
        assert_eq!(event.target, "agents");
    }
}
