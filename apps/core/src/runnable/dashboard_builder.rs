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
//! Backed by the out-of-process `ryu-dashboards` sidecar, reached over loopback
//! through the process-global [`crate::dashboards_client::DashboardsClient`]: these
//! tools author dashboards/widgets through the sidecar's REST surface (the widget
//! shape + source allowlist are validated sidecar-side, where the store is owned).
//! A hard error is returned when the client is absent (test / CLI contexts).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::dashboards_client::{global_client, DashboardsClient};
use crate::sidecar::mcp::RegistryTool;

/// Reserved server name for the dashboard-builder tool provider. Must not contain
/// `__` (the tool-id separator).
pub const SERVER_NAME: &str = "dashboard_builder";

/// Compact reference for the widget object shape + the allowed kinds and sources,
/// folded into the create/configure tool descriptions so the model authors valid
/// widgets. Keep in sync with the `ryu_dashboards` `WidgetKind` / `WidgetSource`.
const WIDGET_REFERENCE: &str = "\
Widget object shape: { \"id\"?: string, \"kind\": \"<kind>\", \"title\"?: string, \"config\"?: object, \
\"source\": { \"type\": \"<source>\", ...fields }, \"refresh_interval\"?: \"30s\"|\"5m\", \
\"layout\"?: { \"x\": int, \"y\": int, \"w\": int, \"h\": int } }.\n\
Grid is 12 columns wide; typical widget w=3..6, h=3..6. Omit id to add a new widget; pass an existing id to replace it.\n\
Kinds: stat (one KPI number), line_chart, bar_chart, area_chart, pie_chart, table, list, text (markdown), map (MapLibre/OpenFreeMap), agent_feed (agent output stream).\n\
Sources (the source.type field):\n\
- static { data: any }  (inline literal data; never refreshes — good for text)\n\
- core_endpoint { endpoint: <name>, selector?: \"a.b.0\" }  (a curated internal metric; see endpoints below)\n\
- monitor { monitor_id: string }  (a website monitor's latest result)\n\
- workflow { workflow_id: string, input?: object, output_key?: string }  (runs a saved workflow on the interval, reads an output key)\n\
- composio { action: string, args?: object }  (executes a Composio action through the Gateway)\n\
- http { url: \"https://…\", selector?: string, headers?: object }  (polls an external HTTPS JSON endpoint; private/loopback hosts are blocked)\n\
- agent { agent_id: string, prompt: string }  (re-runs a configured agent on the interval; reply parsed as JSON)\n\
Allowed core_endpoint names: system_status, sidecar_status, connections, quests, monitors, engines, agents, workflows, meetings.\n\
config hints by kind: stat → { value_key?, label?, unit? }; *_chart → { data_key?, x_key?, series?: [string] }; table → { columns?: [string], rows_key? }; list → { items_key? }; text → { markdown? }; map → { center?: [lng,lat], zoom?, markers_key? }.";

/// The tools exposed through the dashboard-builder provider.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: "dashboard_builder__get_dashboard".to_owned(),
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
            id: "dashboard_builder__create_dashboard".to_owned(),
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
            id: "dashboard_builder__configure_dashboard".to_owned(),
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
                    "properties": { "type": { "type": "string", "enum": [
                        "static", "core_endpoint", "monitor", "workflow", "composio", "http", "agent"
                    ] } },
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

/// Dispatch a tool call from the MCP registry to the right handler. Uses the
/// process-global dashboard engine; no handle to wire.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "get_dashboard" => get_dashboard(arguments).await,
        "create_dashboard" => create_dashboard(arguments).await,
        "configure_dashboard" => configure_dashboard(arguments).await,
        other => Err(anyhow!("unknown dashboard_builder tool: '{other}'")),
    }
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().ok_or_else(|| anyhow!("missing '{key}'"))
}

/// Resolve the dashboard id a tool call targets: either an explicit `dashboard_id`,
/// or the dashboard bound to a hardware `device_id` (created on first use via the
/// sidecar so "add a widget to my desk" always has a real surface). Returns the id,
/// or a soft error describing what was missing.
async fn resolve_target_dashboard(args: &Value) -> Result<std::result::Result<String, Value>> {
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
    let dashboard_id = client()?.ensure_device_dashboard(device_id).await?;
    Ok(Ok(dashboard_id))
}

/// A soft, model-readable failure (not a hard tool error) so the model can read
/// the message and retry within the same turn.
fn soft_error(message: impl Into<String>) -> Value {
    json!({ "success": false, "error": message.into() })
}

/// The process-global dashboards client, or a hard error when dashboards is not
/// wired (test / CLI contexts without the sidecar).
fn client() -> Result<&'static DashboardsClient> {
    global_client()
        .ok_or_else(|| anyhow!("dashboards sidecar client is not available in this context"))
}

/// Upsert an array of model-authored widget objects onto a dashboard through the
/// sidecar's REST surface (the source allowlist + widget shape are validated
/// sidecar-side). Returns `Ok(Ok(count))` on success, or `Ok(Err(soft))` — a
/// model-readable soft-error value — when a widget is rejected (a 4xx), mapping the
/// sidecar's client error to the same soft contract the in-process builder used.
async fn upsert_widgets(
    client: &DashboardsClient,
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

async fn get_dashboard(args: Value) -> Result<Value> {
    let id = match resolve_target_dashboard(&args).await? {
        Ok(id) => id,
        Err(soft) => return Ok(soft),
    };
    match client()?.get_dashboard(&id).await? {
        // The sidecar returns `{ dashboard, widgets }`; preserve the builder's shape.
        Some(body) => Ok(json!({
            "found": true,
            "dashboard": body.get("dashboard").cloned().unwrap_or(Value::Null),
            "widgets": body.get("widgets").cloned().unwrap_or_else(|| json!([])),
        })),
        None => Ok(json!({ "found": false, "dashboard_id": id })),
    }
}

async fn create_dashboard(args: Value) -> Result<Value> {
    let name = require_str(&args, "name")?.trim().to_owned();
    if name.is_empty() {
        return Ok(soft_error("name must not be empty"));
    }
    let client = client()?;
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

async fn configure_dashboard(args: Value) -> Result<Value> {
    let id = match resolve_target_dashboard(&args).await? {
        Ok(id) => id,
        Err(soft) => return Ok(soft),
    };
    let client = client()?;
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

    #[test]
    fn tools_have_stable_ids_and_server() {
        let tools = tools();
        assert_eq!(tools.len(), 3);
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.id.starts_with("dashboard_builder__"));
            assert!(!t.name.contains("__"));
        }
    }

    // Widget parsing + the core_endpoint allowlist now live in the `ryu-dashboards`
    // sidecar (`api::validate_widget_source` / `create_widget`), where the store is
    // owned; the builder is a thin HTTP mapper and surfaces the sidecar's 4xx as a
    // soft error. See the sidecar crate's tests for that coverage.

    #[test]
    fn unknown_tool_errors() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(dispatch("nope", json!({})))
            .expect_err("unknown tool must error");
        assert!(err.to_string().contains("unknown dashboard_builder tool"));
    }
}
