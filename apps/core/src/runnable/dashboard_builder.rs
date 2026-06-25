//! Chat-driven dashboard builder tools: `get_dashboard`, `create_dashboard`,
//! `configure_dashboard`.
//!
//! These let a builder meta-agent (the left pane of the desktop Home page) author
//! and arrange a Home [`crate::dashboard::Dashboard`] by tool call — describe a
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
//! Backed by the process-global [`crate::dashboard::global_engine`] (a SQLite
//! store), so — like the workflow builder — no per-call handle needs wiring; a
//! soft error is returned when the engine is absent (test / CLI contexts).

use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::dashboard::{
    Dashboard, GridLayout, Widget, WidgetKind, WidgetSource, CORE_ENDPOINT_NAMES,
};
use crate::sidecar::mcp::RegistryTool;

/// Reserved server name for the dashboard-builder tool provider. Must not contain
/// `__` (the tool-id separator).
pub const SERVER_NAME: &str = "dashboard_builder";

/// Compact reference for the widget object shape + the allowed kinds and sources,
/// folded into the create/configure tool descriptions so the model authors valid
/// widgets. Keep in sync with [`crate::dashboard::WidgetKind`] / `WidgetSource`.
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
/// or the dashboard bound to a hardware `device_id` (created on first use so "add a
/// widget to my desk" always has a real surface). Returns the id, or a soft error
/// describing what was missing.
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
    let engine = engine()?;
    // Reuse an existing binding when the bound dashboard still exists.
    if let Ok(Some(dd)) = engine.store.get_device_dashboard(device_id).await {
        if engine
            .store
            .get_dashboard(&dd.dashboard_id)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return Ok(Ok(dd.dashboard_id));
        }
    }
    // Create a fresh dashboard + binding for the device.
    let now = chrono::Utc::now().to_rfc3339();
    let dashboard = Dashboard {
        id: format!("dash_{}", uuid::Uuid::new_v4().simple()),
        name: format!("{device_id} display"),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    engine.store.upsert_dashboard(&dashboard).await?;
    let dd = crate::dashboard::DeviceDashboard {
        device_id: device_id.to_string(),
        dashboard_id: dashboard.id.clone(),
        refresh_rate: 300,
        created_at: now.clone(),
        updated_at: now,
    };
    engine.store.upsert_device_dashboard(&dd).await?;
    Ok(Ok(dashboard.id))
}

/// A soft, model-readable failure (not a hard tool error) so the model can read
/// the message and retry within the same turn.
fn soft_error(message: impl Into<String>) -> Value {
    json!({ "success": false, "error": message.into() })
}

fn engine() -> Result<&'static crate::dashboard::DashboardEngine> {
    crate::dashboard::global_engine().ok_or_else(|| {
        anyhow!("dashboard engine is not available in this context (test/CLI without dashboards)")
    })
}

/// The mutable, model-authored shape of a widget (no dashboard_id or cached state).
#[derive(Debug, Deserialize)]
struct BuilderWidget {
    #[serde(default)]
    id: Option<String>,
    kind: WidgetKind,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    config: Option<Value>,
    source: WidgetSource,
    #[serde(default)]
    refresh_interval: Option<String>,
    #[serde(default)]
    layout: Option<GridLayout>,
}

impl BuilderWidget {
    fn into_widget(self, dashboard_id: &str) -> Widget {
        Widget {
            id: self
                .id
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("wgt_{}", uuid::Uuid::new_v4().simple())),
            dashboard_id: dashboard_id.to_string(),
            kind: self.kind,
            title: self.title.unwrap_or_default(),
            config: self.config.unwrap_or(Value::Null),
            source: self.source,
            refresh_interval: self.refresh_interval.filter(|s| !s.trim().is_empty()),
            layout: self.layout.unwrap_or_default(),
            last_value: None,
            last_refresh_at: None,
            last_error: None,
        }
    }
}

/// Validate that a widget's source names only allowed targets (the curated
/// endpoint allowlist). Other source kinds are structurally validated by serde.
fn validate_source(source: &WidgetSource) -> Result<(), String> {
    if let WidgetSource::CoreEndpoint { endpoint, .. } = source {
        if crate::dashboard::sources::core_endpoint_path(endpoint).is_none() {
            return Err(format!(
                "'{endpoint}' is not an allowed core_endpoint. Allowed: {}",
                CORE_ENDPOINT_NAMES.join(", ")
            ));
        }
    }
    Ok(())
}

fn parse_widgets(value: &Value, dashboard_id: &str) -> Result<Vec<Widget>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "expected an array of widget objects".to_owned())?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let bw: BuilderWidget = serde_json::from_value(item.clone())
            .map_err(|e| format!("widget #{i} is invalid: {e}"))?;
        validate_source(&bw.source).map_err(|e| format!("widget #{i}: {e}"))?;
        out.push(bw.into_widget(dashboard_id));
    }
    Ok(out)
}

async fn get_dashboard(args: Value) -> Result<Value> {
    let id = match resolve_target_dashboard(&args).await? {
        Ok(id) => id,
        Err(soft) => return Ok(soft),
    };
    let id = id.as_str();
    let engine = engine()?;
    match engine.store.get_dashboard(id).await {
        Ok(Some(dashboard)) => {
            let widgets = engine.store.list_widgets(id).await.unwrap_or_default();
            Ok(json!({
                "found": true,
                "dashboard": dashboard,
                "widgets": widgets,
            }))
        }
        Ok(None) => Ok(json!({ "found": false, "dashboard_id": id })),
        Err(e) => Err(anyhow!("failed to read dashboard '{id}': {e}")),
    }
}

async fn create_dashboard(args: Value) -> Result<Value> {
    let name = require_str(&args, "name")?.trim().to_owned();
    if name.is_empty() {
        return Ok(soft_error("name must not be empty"));
    }
    let engine = engine()?;
    let now = chrono::Utc::now().to_rfc3339();
    let dashboard = Dashboard {
        id: format!("dash_{}", uuid::Uuid::new_v4().simple()),
        name: name.clone(),
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(e) = engine.store.upsert_dashboard(&dashboard).await {
        return Err(anyhow!("failed to create dashboard: {e}"));
    }

    let mut widget_count = 0;
    if let Some(w) = args.get("widgets").filter(|v| v.is_array()) {
        let widgets = match parse_widgets(w, &dashboard.id) {
            Ok(ws) => ws,
            Err(e) => return Ok(soft_error(e)),
        };
        for widget in &widgets {
            if let Err(e) = engine.store.upsert_widget(widget).await {
                return Err(anyhow!("failed to add widget: {e}"));
            }
        }
        widget_count = widgets.len();
    }

    Ok(json!({
        "success": true,
        "dashboard_id": dashboard.id,
        "message": format!("Created dashboard '{}' with {widget_count} widget(s).", dashboard.name),
    }))
}

async fn configure_dashboard(args: Value) -> Result<Value> {
    let id = match resolve_target_dashboard(&args).await? {
        Ok(id) => id,
        Err(soft) => return Ok(soft),
    };
    let id = id.as_str();
    let engine = engine()?;
    let mut dashboard = match engine.store.get_dashboard(id).await {
        Ok(Some(d)) => d,
        Ok(None) => {
            return Ok(soft_error(format!(
                "no dashboard with id '{id}'. Use create_dashboard to make a new one."
            )))
        }
        Err(e) => return Err(anyhow!("failed to read dashboard '{id}': {e}")),
    };

    if let Some(name) = args["name"].as_str() {
        let name = name.trim();
        if !name.is_empty() {
            dashboard.name = name.to_owned();
            dashboard.updated_at = chrono::Utc::now().to_rfc3339();
            if let Err(e) = engine.store.upsert_dashboard(&dashboard).await {
                return Err(anyhow!("failed to rename dashboard: {e}"));
            }
        }
    }

    let mut upserted = 0;
    if let Some(w) = args.get("widgets_upsert").filter(|v| v.is_array()) {
        let widgets = match parse_widgets(w, id) {
            Ok(ws) => ws,
            Err(e) => return Ok(soft_error(e)),
        };
        for widget in &widgets {
            if let Err(e) = engine.store.upsert_widget(widget).await {
                return Err(anyhow!("failed to upsert widget: {e}"));
            }
        }
        upserted = widgets.len();
    }

    let mut removed = 0;
    if let Some(rm) = args.get("widgets_remove").and_then(Value::as_array) {
        for item in rm {
            if let Some(wid) = item.as_str() {
                if engine
                    .store
                    .delete_widget_for_dashboard(id, wid)
                    .await
                    .unwrap_or(false)
                {
                    removed += 1;
                }
            }
        }
    }

    Ok(json!({
        "success": true,
        "message": format!(
            "Updated dashboard '{}' ({upserted} widget(s) upserted, {removed} removed).",
            dashboard.name
        ),
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

    #[test]
    fn parse_widgets_reads_kind_and_source() {
        let value = json!([
            { "kind": "stat", "title": "Online",
              "source": { "type": "core_endpoint", "endpoint": "connections", "selector": "clients" } }
        ]);
        let widgets = parse_widgets(&value, "dash_1").expect("valid widgets");
        assert_eq!(widgets.len(), 1);
        assert_eq!(widgets[0].dashboard_id, "dash_1");
        assert!(widgets[0].id.starts_with("wgt_"));
        assert!(matches!(widgets[0].kind, WidgetKind::Stat));
    }

    #[test]
    fn parse_widgets_rejects_unknown_core_endpoint() {
        let value = json!([
            { "kind": "stat", "source": { "type": "core_endpoint", "endpoint": "secrets" } }
        ]);
        let err = parse_widgets(&value, "dash_1").expect_err("bad endpoint must fail");
        assert!(err.contains("not an allowed core_endpoint"), "got: {err}");
    }

    #[test]
    fn parse_widgets_reports_bad_widget() {
        // Missing `source` is a parse error pointing at #0.
        let value = json!([{ "kind": "stat" }]);
        let err = parse_widgets(&value, "dash_1").expect_err("missing source must fail");
        assert!(err.contains("widget #0"), "got: {err}");
    }

    #[test]
    fn unknown_tool_errors() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(dispatch("nope", json!({})))
            .expect_err("unknown tool must error");
        assert!(err.to_string().contains("unknown dashboard_builder tool"));
    }
}
