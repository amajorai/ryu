//! Chat-driven dashboard builder tools: `get_dashboard`, `create_dashboard`,
//! `configure_dashboard`.
//!
//! These let a builder meta-agent (the left pane of the desktop Home page) author
//! and arrange a Home dashboard by tool call — describe a
//! dashboard in natural language and the model assembles the widget grid: add
//! widgets of an allowed kind, bind each to a data source, set its refresh
//! interval, and place it (x/y/w/h) on the grid. They are the dashboard analog of
//! [`crate::runnable::workflow_builder`] / [`crate::runnable::agent_builder`] and
//! are exposed through the MCP registry using the same in-process built-in pattern.
//!
//! # The constrained catalog
//!
//! The tool schema enumerates every allowed widget *kind* and *source type* (and
//! the curated set of internal endpoint names). That enumeration — plus the
//! desktop rendering only standard shadcn components — is the consistency
//! guarantee (the json-render.dev "constrained catalog" idea): the model cannot
//! invent a widget kind or emit free-form styling.
//!
//! # Core-vs-Gateway placement
//!
//! Authoring *what a dashboard is* (its widgets + sources + layout) is
//! orchestration ⇒ Core. The model/tool calls a widget's source makes at refresh
//! time still route through the Gateway; these tools only write the local store.
//!
//! Backed by whichever enabled app provides the `dashboards.*` capabilities,
//! reached through the registry's Core-as-consumer helper and the
//! [`DashboardAuthoring`] seam (`crate::dashboard_capabilities`): the widget shape
//! + source allowlist are validated provider-side, where the store is owned. A hard
//! error is returned when the consumer is not wired (test / CLI contexts) or no
//! enabled app provides dashboards.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::dashboard_capabilities::DashboardAuthoring;
use crate::sidecar::capability_consumer::CapabilityConsumer;
use crate::sidecar::mcp::RegistryTool;

/// Reserved server name for the dashboard-builder tool provider. Must not contain
/// `.` (the tool-id namespace separator).
pub const SERVER_NAME: &str = "dashboard_builder";

/// Compact reference for the widget object shape + the allowed kinds and sources,
/// folded into the create/configure tool descriptions so the model authors valid
/// widgets. Keep in sync with the `ryu_dashboards` `WidgetKind` / `WidgetSource`
/// AND with the source kinds the Dashboards sidecar host actually resolves
/// ([`AUTHORABLE_SOURCE_TYPES`]): the Core-read kinds (`core_endpoint`, `monitor`,
/// `workflow`) and `agent` are rejected on write there, so the model is never
/// offered them for a new widget. A widget that already carries one (an old seeded
/// Home preset) is accepted only with that stored source resent unchanged, which is
/// how the builder moves or retitles it ([`LEGACY_SOURCE_TYPES`]).
const WIDGET_REFERENCE: &str = "\
Widget object shape: { \"id\"?: string, \"kind\": \"<kind>\", \"title\"?: string, \"config\"?: object, \
\"source\": { \"type\": \"<source>\", ...fields }, \"refresh_interval\"?: \"30s\"|\"5m\", \
\"layout\"?: { \"x\": int, \"y\": int, \"w\": int, \"h\": int } }.\n\
Grid is 12 columns wide; typical widget w=3..6, h=3..6. Omit id to add a new widget; pass an existing id to replace it.\n\
Kinds: stat (one KPI number), line_chart, bar_chart, area_chart, pie_chart, table, list, text (markdown), map (MapLibre/OpenFreeMap), agent_feed (agent output stream).\n\
Sources (the source.type field):\n\
- static { data: any }  (inline literal data; never refreshes — good for text)\n\
- composio { action: string, args?: object }  (executes a Composio action through the Gateway)\n\
- http { url: \"https://…\", selector?: string, headers?: object }  (polls an external HTTPS JSON endpoint; private/loopback hosts are blocked)\n\
No other source type is accepted for a new or changed source: core_endpoint, monitor, workflow, and agent widgets are not available yet, so do not offer or create them. An existing widget that already has one of those sources can still be moved, resized, retitled or removed: resend its source exactly as get_dashboard returned it.\n\
config hints by kind: stat → { value_key?, label?, unit? }; *_chart → { data_key?, x_key?, series?: [string] }; table → { columns?: [string], rows_key? }; list → { items_key? }; text → { markdown? }; map → { center?: [lng,lat], zoom?, markers_key? }.";

/// The widget source types the builder may author: the ones the Dashboards sidecar
/// host resolves. The other `WidgetSource` kinds are refused provider-side.
const AUTHORABLE_SOURCE_TYPES: &[&str] = &["static", "composio", "http"];

/// Source types the provider still stores but no longer resolves. The provider
/// accepts them only on an existing widget whose stored source is resent
/// unchanged, so they stay in the schema enum (a strict tool schema would
/// otherwise make a legacy widget impossible to re-arrange) and the field
/// description says when they may be used.
const LEGACY_SOURCE_TYPES: &[&str] = &["core_endpoint", "monitor", "workflow", "agent"];

/// The `source.type` enum: the authorable types first, then the legacy ones.
fn source_type_enum() -> Vec<&'static str> {
    AUTHORABLE_SOURCE_TYPES
        .iter()
        .chain(LEGACY_SOURCE_TYPES)
        .copied()
        .collect()
}

/// The tools exposed through the dashboard-builder provider.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: "dashboard_builder.get_dashboard".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "get_dashboard".to_owned(),
            description: Some(
                "Read the current definition of a Home dashboard by id, including its widgets \
                 (each with kind, title, config, source, refresh interval, and grid layout). Call \
                 this first to see what exists before changing anything. Required: dashboard_id."
                    .to_owned(),
            ),
            input_schema: Some(get_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "dashboard_builder.create_dashboard".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "create_dashboard".to_owned(),
            description: Some(format!(
                "Create a new Home dashboard and return its id. Prefer editing the dashboard \
                 already being built (configure_dashboard) when one exists. Optionally pass the \
                 initial `widgets` array. Required: name.\n\n{WIDGET_REFERENCE}"
            )),
            input_schema: Some(create_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "dashboard_builder.configure_dashboard".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "configure_dashboard".to_owned(),
            description: Some(format!(
                "Apply a partial patch to an existing dashboard. Set `name` to rename. Use \
                 `widgets_upsert` (add new widgets, or replace existing ones by id — this is also \
                 how you re-arrange: set each widget's layout) and `widgets_remove` (widget ids to \
                 delete). Required: dashboard_id.\n\n{WIDGET_REFERENCE}"
            )),
            input_schema: Some(configure_schema()),
            ..Default::default()
        },
    ]
}

fn widget_array_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "kind": { "type": "string", "enum": [
                    "stat", "line_chart", "bar_chart", "area_chart", "pie_chart",
                    "table", "list", "text", "map", "agent_feed"
                ] },
                "title": { "type": "string" },
                "config": { "type": "object" },
                "source": {
                    "type": "object",
                    "properties": { "type": {
                        "type": "string",
                        "enum": source_type_enum(),
                        "description": "static, composio or http. core_endpoint, monitor, workflow and agent are not available yet: use them only to resend an existing widget's source unchanged."
                    } },
                    "required": ["type"],
                    "additionalProperties": true
                },
                "refresh_interval": { "type": "string" },
                "layout": {
                    "type": "object",
                    "properties": {
                        "x": { "type": "integer" }, "y": { "type": "integer" },
                        "w": { "type": "integer" }, "h": { "type": "integer" }
                    }
                }
            },
            "required": ["kind", "source"],
            "additionalProperties": false
        }
    })
}

/// Shared description for the `device_id` targeting field (folded into the tool
/// schemas so "add a calendar widget to my desk" resolves to that device's
/// dashboard without the model knowing the internal dashboard id).
const DEVICE_ID_DESC: &str = "Optional hardware device id (rhw_…) to target THAT \
    device's dashboard instead of passing dashboard_id. The device's bound dashboard \
    is created on first use. Use this for 'add X to my desk/watch'.";

fn get_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "dashboard_id": { "type": "string", "description": "The dashboard id to read (omit when using device_id)." },
            "device_id": { "type": "string", "description": DEVICE_ID_DESC }
        }
    })
}

fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "Display name for the new dashboard." },
            "widgets": widget_array_schema()
        },
        "required": ["name"]
    })
}

fn configure_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "dashboard_id": { "type": "string", "description": "The dashboard id to edit (omit when using device_id)." },
            "device_id": { "type": "string", "description": DEVICE_ID_DESC },
            "name": { "type": "string", "description": "New display name." },
            "widgets_upsert": widget_array_schema(),
            "widgets_remove": { "type": "array", "items": { "type": "string" }, "description": "Widget ids to remove." }
        }
    })
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/// Dispatch a tool call from the MCP registry to the right handler, authoring
/// through the registry's capability consumer (`None` in test / CLI contexts).
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    capabilities: Option<CapabilityConsumer>,
) -> Result<Value> {
    if crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some()
    {
        anyhow::bail!(
            "dashboard builder is disabled on managed nodes until dashboard and device ownership is bound to the verified caller"
        );
    }
    let Some(capabilities) = capabilities else {
        // Checked after the tool name so an unknown tool still reads as one.
        if !matches!(
            tool,
            "get_dashboard" | "create_dashboard" | "configure_dashboard"
        ) {
            return Err(anyhow!("unknown dashboard_builder tool: '{tool}'"));
        }
        anyhow::bail!(
            "dashboard_builder tool '{tool}' called but no capability consumer is wired; \
             call McpRegistry::with_capabilities at startup"
        );
    };
    run(tool, arguments, &capabilities).await
}

/// Drop each widget's cached `last_value` and `last_error` from a
/// `get_dashboard` result. A widget's refresh runs with the user's own accounts,
/// so its cached output can hold data an account-limited agent may not read; the
/// widget definitions stay readable.
pub fn strip_cached_widget_output(result: &mut Value) {
    let Some(widgets) = result.get_mut("widgets").and_then(Value::as_array_mut) else {
        return;
    };
    for widget in widgets {
        if let Some(fields) = widget.as_object_mut() {
            fields.remove("last_value");
            fields.remove("last_error");
        }
    }
}

/// The tool bodies, over any [`DashboardAuthoring`] (the capability consumer in
/// prod, an in-memory double in tests).
async fn run(tool: &str, arguments: Value, dashboards: &dyn DashboardAuthoring) -> Result<Value> {
    match tool {
        "get_dashboard" => get_dashboard(arguments, dashboards).await,
        "create_dashboard" => create_dashboard(arguments, dashboards).await,
        "configure_dashboard" => configure_dashboard(arguments, dashboards).await,
        other => Err(anyhow!("unknown dashboard_builder tool: '{other}'")),
    }
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().ok_or_else(|| anyhow!("missing '{key}'"))
}

/// Resolve the dashboard id a tool call targets: either an explicit `dashboard_id`,
/// or the dashboard bound to a hardware `device_id` (created on first use by the
/// provider so "add a widget to my desk" always has a real surface). Returns the id,
/// or a soft error describing what was missing.
async fn resolve_target_dashboard(
    args: &Value,
    dashboards: &dyn DashboardAuthoring,
) -> Result<std::result::Result<String, Value>> {
    if let Some(id) = args.get("dashboard_id").and_then(Value::as_str) {
        if !id.trim().is_empty() {
            return Ok(Ok(id.to_string()));
        }
    }
    let Some(device_id) = args
        .get("device_id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok(Err(soft_error(
            "provide either `dashboard_id` or `device_id`",
        )));
    };
    let dashboard_id = dashboards.ensure_device_dashboard(device_id).await?;
    Ok(Ok(dashboard_id))
}

/// A soft, model-readable failure (not a hard tool error) so the model can read
/// the message and retry within the same turn.
fn soft_error(message: impl Into<String>) -> Value {
    json!({ "success": false, "error": message.into() })
}

/// Upsert an array of model-authored widget objects onto a dashboard through the
/// `dashboards.upsertWidget` capability (the source allowlist + widget shape are
/// validated provider-side). Returns `Ok(Ok(count))` on success, or `Ok(Err(soft))`
/// — a model-readable soft-error value — when a widget is rejected (a 4xx), mapping
/// the provider's client error to the same soft contract the in-process builder used.
async fn upsert_widgets(
    client: &dyn DashboardAuthoring,
    dashboard_id: &str,
    widgets: &Value,
) -> Result<std::result::Result<usize, Value>> {
    let Some(arr) = widgets.as_array() else {
        return Ok(Err(soft_error("expected an array of widget objects")));
    };
    let mut count = 0;
    for (i, item) in arr.iter().enumerate() {
        match client.upsert_widget(dashboard_id, item).await? {
            Ok(()) => count += 1,
            Err(msg) => return Ok(Err(soft_error(format!("widget #{i}: {msg}")))),
        }
    }
    Ok(Ok(count))
}

async fn get_dashboard(args: Value, dashboards: &dyn DashboardAuthoring) -> Result<Value> {
    let id = match resolve_target_dashboard(&args, dashboards).await? {
        Ok(id) => id,
        Err(soft) => return Ok(soft),
    };
    match dashboards.get_dashboard(&id).await? {
        // The provider returns `{ dashboard, widgets }`; preserve the builder's shape.
        Some(body) => Ok(json!({
            "found": true,
            "dashboard": body.get("dashboard").cloned().unwrap_or(Value::Null),
            "widgets": body.get("widgets").cloned().unwrap_or_else(|| json!([])),
        })),
        None => Ok(json!({ "found": false, "dashboard_id": id })),
    }
}

async fn create_dashboard(args: Value, client: &dyn DashboardAuthoring) -> Result<Value> {
    let name = require_str(&args, "name")?.trim().to_owned();
    if name.is_empty() {
        return Ok(soft_error("name must not be empty"));
    }
    let dashboard_id = client.create_dashboard(&name).await?;

    let mut widget_count = 0;
    if let Some(w) = args.get("widgets").filter(|v| v.is_array()) {
        match upsert_widgets(client, &dashboard_id, w).await? {
            Ok(n) => widget_count = n,
            Err(soft) => return Ok(soft),
        }
    }

    Ok(json!({
        "success": true,
        "dashboard_id": dashboard_id,
        "message": format!("Created dashboard '{name}' with {widget_count} widget(s)."),
    }))
}

async fn configure_dashboard(args: Value, client: &dyn DashboardAuthoring) -> Result<Value> {
    let id = match resolve_target_dashboard(&args, client).await? {
        Ok(id) => id,
        Err(soft) => return Ok(soft),
    };
    // Confirm the dashboard exists (a device-target path already ensured one).
    if client.get_dashboard(&id).await?.is_none() {
        return Ok(soft_error(format!(
            "no dashboard with id '{id}'. Use create_dashboard to make a new one."
        )));
    }

    if let Some(name) = args["name"].as_str() {
        let name = name.trim();
        if !name.is_empty() {
            client.rename_dashboard(&id, name).await?;
        }
    }

    let mut upserted = 0;
    if let Some(w) = args.get("widgets_upsert").filter(|v| v.is_array()) {
        match upsert_widgets(client, &id, w).await? {
            Ok(n) => upserted = n,
            Err(soft) => return Ok(soft),
        }
    }

    let mut removed = 0;
    if let Some(rm) = args.get("widgets_remove").and_then(Value::as_array) {
        for item in rm {
            if let Some(wid) = item.as_str() {
                if client.delete_widget(&id, wid).await.unwrap_or(false) {
                    removed += 1;
                }
            }
        }
    }

    Ok(json!({
        "success": true,
        "message": format!("Updated dashboard ({upserted} widget(s) upserted, {removed} removed)."),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use tokio::sync::Mutex;

    /// In-memory [`DashboardAuthoring`] double: dashboards are `id → (name, widgets)`;
    /// a widget whose `kind` is `"bogus"` is rejected the way a provider 4xx is.
    #[derive(Default)]
    struct FakeDashboards {
        boards: Mutex<BTreeMap<String, (String, Vec<Value>)>>,
        devices: Mutex<BTreeMap<String, String>>,
    }

    #[async_trait]
    impl DashboardAuthoring for FakeDashboards {
        async fn get_dashboard(&self, id: &str) -> Result<Option<Value>> {
            Ok(self.boards.lock().await.get(id).map(|(name, widgets)| {
                json!({ "dashboard": { "id": id, "name": name }, "widgets": widgets })
            }))
        }
        async fn create_dashboard(&self, name: &str) -> Result<String> {
            let mut boards = self.boards.lock().await;
            let id = format!("dash_{}", boards.len() + 1);
            boards.insert(id.clone(), (name.to_owned(), Vec::new()));
            Ok(id)
        }
        async fn rename_dashboard(&self, id: &str, name: &str) -> Result<()> {
            let mut boards = self.boards.lock().await;
            let board = boards.get_mut(id).ok_or_else(|| anyhow!("not found"))?;
            name.clone_into(&mut board.0);
            Ok(())
        }
        async fn upsert_widget(
            &self,
            dashboard_id: &str,
            widget: &Value,
        ) -> Result<std::result::Result<(), String>> {
            if widget["kind"] == json!("bogus") {
                return Ok(Err("unknown widget kind 'bogus'".to_owned()));
            }
            let mut boards = self.boards.lock().await;
            let Some(board) = boards.get_mut(dashboard_id) else {
                return Ok(Err("dashboard not found".to_owned()));
            };
            board
                .1
                .retain(|w| widget["id"].is_null() || w["id"] != widget["id"]);
            board.1.push(widget.clone());
            Ok(Ok(()))
        }
        async fn delete_widget(&self, dashboard_id: &str, widget_id: &str) -> Result<bool> {
            let mut boards = self.boards.lock().await;
            let Some(board) = boards.get_mut(dashboard_id) else {
                return Ok(false);
            };
            let before = board.1.len();
            board.1.retain(|w| w["id"] != json!(widget_id));
            Ok(board.1.len() < before)
        }
        async fn ensure_device_dashboard(&self, device_id: &str) -> Result<String> {
            if let Some(id) = self.devices.lock().await.get(device_id) {
                return Ok(id.clone());
            }
            let id = self.create_dashboard(device_id).await?;
            self.devices
                .lock()
                .await
                .insert(device_id.to_owned(), id.clone());
            Ok(id)
        }
    }

    #[test]
    fn tools_have_stable_ids_and_server() {
        let tools = tools();
        assert_eq!(tools.len(), 3);
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.id.starts_with("dashboard_builder."));
            assert!(!t.name.contains('.'));
        }
    }

    // Widget parsing + the supported-source gate live with the provider (the
    // Dashboards sidecar's `api::ensure_source_supported` / `create_widget`), where
    // the store is owned; the builder is a thin mapper and surfaces the provider's 4xx
    // as a soft error. See the sidecar crate's tests for that coverage.

    #[test]
    fn builder_offers_unavailable_source_kinds_only_to_keep_existing_widgets() {
        let schema = widget_array_schema();
        let source_type = schema
            .pointer("/items/properties/source/properties/type")
            .expect("source type schema");
        let offered = source_type["enum"].as_array().expect("source type enum");
        assert_eq!(
            offered[..AUTHORABLE_SOURCE_TYPES.len()],
            [json!("static"), json!("composio"), json!("http")]
        );
        let description = source_type["description"].as_str().expect("description");
        assert!(description.contains("unchanged"), "{description}");
        for unsupported in ["core_endpoint", "monitor", "workflow", "agent"] {
            // Still in the enum, so an old seeded widget can be re-upserted to move
            // it (the provider accepts only its stored source, unchanged).
            assert!(offered.contains(&json!(unsupported)), "{unsupported}");
            assert!(description.contains(unsupported), "{unsupported}");
            // The prose reference may name them only to say they are unavailable.
            assert!(
                !WIDGET_REFERENCE.contains(&format!("- {unsupported} {{")),
                "{unsupported} is still documented as a usable source"
            );
        }
        assert!(WIDGET_REFERENCE.contains("not available yet"));
        assert!(WIDGET_REFERENCE.contains("resend its source exactly"));
    }

    #[test]
    fn strip_cached_widget_output_keeps_definitions_and_drops_fetched_data() {
        let mut result = json!({
            "found": true,
            "dashboard": { "id": "dash_1" },
            "widgets": [
                { "id": "w1", "kind": "composio", "last_value": { "mail": ["x"] }, "last_error": "boom" },
                { "id": "w2", "kind": "text" }
            ],
        });
        strip_cached_widget_output(&mut result);
        assert_eq!(
            result["widgets"],
            json!([{ "id": "w1", "kind": "composio" }, { "id": "w2", "kind": "text" }])
        );
        assert_eq!(result["dashboard"]["id"], "dash_1");
        let mut missing = json!({ "found": false });
        strip_cached_widget_output(&mut missing);
        assert_eq!(missing, json!({ "found": false }));
    }

    #[tokio::test]
    async fn unknown_tool_errors() {
        let err = dispatch("nope", json!({}), None)
            .await
            .expect_err("unknown tool must error");
        assert!(err.to_string().contains("unknown dashboard_builder tool"));
        let err = run("nope", json!({}), &FakeDashboards::default())
            .await
            .expect_err("unknown tool must error");
        assert!(err.to_string().contains("unknown dashboard_builder tool"));
    }

    #[tokio::test]
    async fn an_unwired_consumer_is_a_hard_error() {
        let err = dispatch("get_dashboard", json!({ "dashboard_id": "d" }), None)
            .await
            .expect_err("no consumer wired");
        assert!(err.to_string().contains("with_capabilities"), "{err}");
    }

    /// With no enabled app providing dashboards, a builder call is a legible hard
    /// error naming the missing capability.
    #[tokio::test]
    async fn a_missing_provider_names_the_capability() {
        let consumer =
            crate::sidecar::capability_consumer::test_support::consumer_without_providers();
        let err = dispatch("create_dashboard", json!({ "name": "Ops" }), Some(consumer))
            .await
            .expect_err("no provider");
        assert!(
            err.to_string()
                .contains(crate::dashboard_capabilities::CAP_CREATE),
            "{err}"
        );
    }

    #[tokio::test]
    async fn create_then_configure_round_trips_through_the_seam() {
        let dashboards = FakeDashboards::default();
        let created = run(
            "create_dashboard",
            json!({ "name": " Ops ", "widgets": [
                { "id": "w1", "kind": "stat", "source": { "type": "static", "data": 1 } }
            ] }),
            &dashboards,
        )
        .await
        .unwrap();
        assert_eq!(created["success"], json!(true));
        let id = created["dashboard_id"].as_str().unwrap().to_owned();

        let configured = run(
            "configure_dashboard",
            json!({
                "dashboard_id": id,
                "name": "Operations",
                "widgets_upsert": [
                    { "id": "w2", "kind": "text", "source": { "type": "static", "data": "hi" } }
                ],
                "widgets_remove": ["w1", "missing"]
            }),
            &dashboards,
        )
        .await
        .unwrap();
        assert_eq!(configured["success"], json!(true), "{configured}");
        assert!(configured["message"]
            .as_str()
            .unwrap()
            .contains("1 widget(s) upserted, 1 removed"));

        let read = run("get_dashboard", json!({ "dashboard_id": id }), &dashboards)
            .await
            .unwrap();
        assert_eq!(read["found"], json!(true));
        assert_eq!(read["dashboard"]["name"], json!("Operations"));
        assert_eq!(read["widgets"].as_array().unwrap().len(), 1);
        assert_eq!(read["widgets"][0]["id"], json!("w2"));
    }

    #[tokio::test]
    async fn rejections_and_missing_targets_are_soft_errors() {
        let dashboards = FakeDashboards::default();
        let rejected = run(
            "create_dashboard",
            json!({ "name": "Ops", "widgets": [{ "kind": "bogus", "source": { "type": "static" } }] }),
            &dashboards,
        )
        .await
        .unwrap();
        assert_eq!(rejected["success"], json!(false));
        assert!(rejected["error"]
            .as_str()
            .unwrap()
            .contains("widget #0: unknown widget kind"));

        let blank = run("create_dashboard", json!({ "name": "  " }), &dashboards)
            .await
            .unwrap();
        assert_eq!(blank["success"], json!(false));

        let missing = run(
            "configure_dashboard",
            json!({ "dashboard_id": "dash_nope" }),
            &dashboards,
        )
        .await
        .unwrap();
        assert!(missing["error"]
            .as_str()
            .unwrap()
            .contains("no dashboard with id 'dash_nope'"));

        let untargeted = run("get_dashboard", json!({}), &dashboards).await.unwrap();
        assert!(untargeted["error"]
            .as_str()
            .unwrap()
            .contains("dashboard_id"));

        let unknown = run(
            "get_dashboard",
            json!({ "dashboard_id": "dash_nope" }),
            &dashboards,
        )
        .await
        .unwrap();
        assert_eq!(
            unknown,
            json!({ "found": false, "dashboard_id": "dash_nope" })
        );
    }

    /// A `device_id` target resolves (and on first use creates) that device's
    /// dashboard through the seam.
    #[tokio::test]
    async fn a_device_target_resolves_its_bound_dashboard() {
        let dashboards = FakeDashboards::default();
        let configured = run(
            "configure_dashboard",
            json!({
                "device_id": "rhw_desk",
                "widgets_upsert": [
                    { "id": "cal", "kind": "list", "source": { "type": "static", "data": [] } }
                ]
            }),
            &dashboards,
        )
        .await
        .unwrap();
        assert_eq!(configured["success"], json!(true), "{configured}");
        let read = run(
            "get_dashboard",
            json!({ "device_id": "rhw_desk" }),
            &dashboards,
        )
        .await
        .unwrap();
        assert_eq!(read["found"], json!(true));
        assert_eq!(read["widgets"][0]["id"], json!("cal"));
        assert_eq!(dashboards.devices.lock().await.len(), 1);
    }
}
