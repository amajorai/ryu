//! Home dashboards: a customizable, constantly-updating page of widgets.
//!
//! A **dashboard** is a named grid of **widgets**. Each widget has a fixed *kind*
//! (the visual: a stat, a chart, a table, a map, …), a *source* (where its live
//! data comes from: a curated Core endpoint, a monitor, a workflow run, a Composio
//! action, an arbitrary HTTP endpoint, or an agent that re-runs on an interval),
//! a *layout* (x/y/w/h on the grid), and a *refresh interval*. The desktop is a
//! thin renderer that draws widgets from a curated catalog using standard shadcn
//! components only — so every dashboard looks consistent. The AI builder (the
//! left-pane chat, mirroring the workflow/agent builders) authors and arranges
//! dashboards through the [`crate::runnable::dashboard_builder`] MCP tools.
//!
//! This is the [`crate::quests`] pattern applied to a live data surface: a SQLite
//! store holds dashboards + widgets, a [`refresh`] tick loop resolves each due
//! widget's source and caches the value, and every fresh value is broadcast over
//! SSE to the desktop. The "constrained catalog" idea (json-render.dev) is
//! realized here as the fixed [`WidgetKind`]/[`WidgetSource`] enums plus the
//! builder tool's JSON schema — that is what guarantees UI consistency, not
//! free-form generated markup.
//!
//! Placement (Core vs Gateway): a dashboard decides *what data is pulled and how
//! often* (orchestration) ⇒ Core. The model/tool calls a widget's source makes at
//! refresh time still route through the Gateway (the agent runner, the Composio
//! execute path) which governs *what is allowed* — nothing here is hardcoded.

pub mod refresh;
pub mod render;
pub mod sources;
pub mod store;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use sources::CORE_ENDPOINT_NAMES;
use store::DashboardStore;

/// Process-global dashboard engine, set once at startup from `main.rs`. The
/// state-free [`refresh`] loop reads it to resolve + cache widget data, mirroring
/// [`crate::quests::set_global_engine`].
static ENGINE: std::sync::OnceLock<DashboardEngine> = std::sync::OnceLock::new();

/// Publish the global engine. Idempotent: a second call is ignored.
pub fn set_global_engine(engine: DashboardEngine) {
    let _ = ENGINE.set(engine);
}

/// The global engine, if it has been published.
pub fn global_engine() -> Option<&'static DashboardEngine> {
    ENGINE.get()
}

/// A dashboard: a named grid of widgets. The widgets live in their own table
/// keyed by `dashboard_id`, so this record is just the dashboard's identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A **device dashboard**: the per-device binding that says "this hardware device
/// shows THIS dashboard, polling every `refresh_rate` seconds". The layout +
/// widget selection live in the normal [`Dashboard`]/[`Widget`] tables (so the same
/// `dashboard_builder` chat/tools author them); this record only scopes one of them
/// to a `device_id` and carries the device-side display knobs.
///
/// Stored in its own `hardware_dashboards` table keyed by `device_id` (1:1). The
/// bound `dashboard_id` is created on demand the first time a device asks for its
/// display, so every paired device always has a real dashboard to render.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceDashboard {
    /// The hardware device this dashboard belongs to (`rhw_…`).
    pub device_id: String,
    /// The bound [`Dashboard`] id (its widgets are this device's surface).
    pub dashboard_id: String,
    /// Seconds the device should wait between display polls. The firmware reads
    /// this from the display metadata; clamped to a sane floor at the API edge.
    pub refresh_rate: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// The visual kind of a widget. The desktop renders one fixed shadcn component
/// per kind — there is no free-form styling. Keep in sync with the desktop
/// `widgets/` catalog and the builder tool schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WidgetKind {
    /// A single number / KPI (optionally with a delta + label).
    Stat,
    /// A line chart (recharts via the shadcn chart wrapper).
    LineChart,
    /// A bar chart.
    BarChart,
    /// An area chart.
    AreaChart,
    /// A pie / donut chart.
    PieChart,
    /// A data table.
    Table,
    /// A simple list of items.
    List,
    /// Markdown / rich text (static or source-fed).
    Text,
    /// A MapLibre map (OpenFreeMap tiles) with markers from the source data.
    Map,
    /// A scrolling feed of agent output (for an agent-bound source).
    AgentFeed,
}

/// Where a widget's live data comes from. A tagged union: the `type` field
/// selects the variant. This is the security + consistency contract — only these
/// source kinds exist, and each is resolved by a dedicated [`sources`] path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WidgetSource {
    /// Literal inline data; never refreshed. Used for text/layout widgets.
    Static {
        #[serde(default)]
        data: Value,
    },
    /// A curated, allowlisted internal Core endpoint (no arbitrary URL). The
    /// optional `selector` is a dotted path into the JSON response.
    CoreEndpoint {
        endpoint: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
    },
    /// A website monitor's latest check result.
    Monitor { monitor_id: String },
    /// Run a saved workflow and read a key from its output map.
    Workflow {
        workflow_id: String,
        #[serde(default)]
        input: std::collections::HashMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_key: Option<String>,
    },
    /// Execute a Composio action through the Gateway.
    Composio {
        action: String,
        #[serde(default)]
        args: Value,
    },
    /// Poll an arbitrary external HTTP endpoint (SSRF-guarded). The optional
    /// `selector` is a dotted path into the JSON response.
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default)]
        headers: std::collections::HashMap<String, String>,
    },
    /// Re-run a configured agent on an interval and render its (JSON) reply.
    Agent { agent_id: String, prompt: String },
}

impl WidgetSource {
    /// Whether this source costs money/tokens or hits the network hard, so the
    /// refresh loop should skip it when no client is watching and hold it to a
    /// slower minimum interval.
    pub fn is_expensive(&self) -> bool {
        matches!(
            self,
            Self::Workflow { .. } | Self::Composio { .. } | Self::Http { .. } | Self::Agent { .. }
        )
    }

    /// Whether this source produces new data over time (so the loop refreshes it).
    /// `Static` data never changes.
    pub fn is_refreshable(&self) -> bool {
        !matches!(self, Self::Static { .. })
    }

    /// The minimum refresh interval (seconds) allowed for this source. Cheap
    /// internal reads can tick fast; LLM/Composio/HTTP-backed widgets are clamped
    /// to a slower floor so an open dashboard cannot burn quota.
    pub fn min_interval_secs(&self) -> u64 {
        match self {
            Self::Static { .. } => u64::MAX,
            Self::CoreEndpoint { .. } | Self::Monitor { .. } => 5,
            Self::Http { .. } => 30,
            Self::Workflow { .. } | Self::Composio { .. } | Self::Agent { .. } => 30,
        }
    }

    /// The default refresh interval (seconds) when the widget sets none.
    pub fn default_interval_secs(&self) -> u64 {
        match self {
            Self::Static { .. } => u64::MAX,
            Self::CoreEndpoint { .. } | Self::Monitor { .. } => 15,
            Self::Http { .. } => 60,
            Self::Workflow { .. } | Self::Composio { .. } | Self::Agent { .. } => 120,
        }
    }
}

/// A widget's position + size on the grid. First-class persisted state (the AI
/// builder arranges widgets, so layout must round-trip through Core — unlike the
/// workflow canvas which keeps positions client-side because Core has no field).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GridLayout {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Default for GridLayout {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            w: 4,
            h: 4,
        }
    }
}

/// A single widget on a dashboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Widget {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub dashboard_id: String,
    pub kind: WidgetKind,
    #[serde(default)]
    pub title: String,
    /// Kind-specific display config (e.g. chart series keys, table columns,
    /// map center/zoom). Opaque to Core; the desktop renderer interprets it.
    #[serde(default)]
    pub config: Value,
    pub source: WidgetSource,
    /// Humantime refresh cadence (e.g. "30s", "5m"). Clamped to the source's
    /// minimum at refresh time. None = the source's per-kind default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_interval: Option<String>,
    #[serde(default)]
    pub layout: GridLayout,
    // ---- cached live state (written by the refresh loop) ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refresh_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl Widget {
    /// The effective refresh interval in seconds: the parsed `refresh_interval`
    /// clamped up to the source's minimum, or the per-kind default when unset or
    /// unparseable.
    pub fn effective_interval_secs(&self) -> u64 {
        let parsed = self
            .refresh_interval
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| humantime::parse_duration(s).ok())
            .map(|d| d.as_secs());
        match parsed {
            Some(secs) => secs.max(self.source.min_interval_secs()),
            None => self.source.default_interval_secs(),
        }
    }
}

/// A change event fanned out to SSE subscribers (the desktop Home grid).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DashboardEvent {
    /// A widget refreshed with fresh data.
    WidgetData {
        dashboard_id: String,
        widget_id: String,
        value: Value,
        at: String,
    },
    /// A widget's refresh failed (the source errored).
    WidgetError {
        dashboard_id: String,
        widget_id: String,
        error: String,
        at: String,
    },
    /// A widget was created or edited (definition changed).
    WidgetUpdated {
        dashboard_id: String,
        widget: Widget,
    },
    /// A widget was removed.
    WidgetDeleted {
        dashboard_id: String,
        widget_id: String,
    },
    /// A dashboard was created, renamed, or deleted.
    DashboardUpdated { dashboard_id: String },
}

/// The dashboard runtime: holds the store + a shared HTTP client (loopback Core
/// self-calls for curated endpoints, the Gateway for Composio, external GETs for
/// HTTP sources). Cheap to clone. Shared by the HTTP API and the refresh loop.
#[derive(Clone)]
pub struct DashboardEngine {
    pub store: DashboardStore,
    pub http: reqwest::Client,
}

impl DashboardEngine {
    pub fn new(store: DashboardStore, http: reqwest::Client) -> Self {
        Self { store, http }
    }
}

/// Replace a dashboard's entire widget set from a JSON array of widget objects
/// (the same shape the `dashboard_builder` tools accept). Used by the device
/// dashboard PUT endpoint so a device's widget selection round-trips through the
/// same store the desktop builder writes. Validates each widget's source against
/// the curated allowlist and rejects the whole batch on the first bad widget (so a
/// partial apply never leaves a half-built surface).
pub async fn replace_widgets(
    engine: &DashboardEngine,
    dashboard_id: &str,
    widgets: &Value,
) -> anyhow::Result<usize> {
    let arr = widgets
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("`widgets` must be an array of widget objects"))?;
    let mut parsed = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let mut widget: Widget = serde_json::from_value(item.clone())
            .map_err(|e| anyhow::anyhow!("widget #{i} is invalid: {e}"))?;
        // Assign ids + bind to this dashboard; clear any caller-sent cached state.
        if widget.id.trim().is_empty() {
            widget.id = format!("wgt_{}", uuid::Uuid::new_v4().simple());
        }
        widget.dashboard_id = dashboard_id.to_string();
        widget.last_value = None;
        widget.last_refresh_at = None;
        widget.last_error = None;
        if let WidgetSource::CoreEndpoint { endpoint, .. } = &widget.source {
            if sources::core_endpoint_path(endpoint).is_none() {
                return Err(anyhow::anyhow!(
                    "widget #{i}: '{endpoint}' is not an allowed core_endpoint. Allowed: {}",
                    CORE_ENDPOINT_NAMES.join(", ")
                ));
            }
        }
        parsed.push(widget);
    }
    // Replace: drop existing widgets, then insert the new set.
    for existing in engine
        .store
        .list_widgets(dashboard_id)
        .await
        .unwrap_or_default()
    {
        let _ = engine.store.delete_widget(&existing.id).await;
    }
    let count = parsed.len();
    for widget in &parsed {
        engine.store.upsert_widget(widget).await?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn widget_with(source: WidgetSource, interval: Option<&str>) -> Widget {
        Widget {
            id: "w1".into(),
            dashboard_id: "d1".into(),
            kind: WidgetKind::Stat,
            title: "t".into(),
            config: Value::Null,
            source,
            refresh_interval: interval.map(str::to_owned),
            layout: GridLayout::default(),
            last_value: None,
            last_refresh_at: None,
            last_error: None,
        }
    }

    #[test]
    fn interval_clamps_up_to_source_floor() {
        // An agent widget asking for 1s is clamped up to the expensive floor (30s).
        let w = widget_with(
            WidgetSource::Agent {
                agent_id: "a".into(),
                prompt: "p".into(),
            },
            Some("1s"),
        );
        assert_eq!(w.effective_interval_secs(), 30);
    }

    #[test]
    fn interval_defaults_per_kind_when_unset() {
        let cheap = widget_with(
            WidgetSource::CoreEndpoint {
                endpoint: "connections".into(),
                selector: None,
            },
            None,
        );
        assert_eq!(cheap.effective_interval_secs(), 15);
    }

    #[test]
    fn expensive_and_refreshable_classification() {
        assert!(WidgetSource::Agent {
            agent_id: "a".into(),
            prompt: "p".into()
        }
        .is_expensive());
        assert!(!WidgetSource::CoreEndpoint {
            endpoint: "connections".into(),
            selector: None
        }
        .is_expensive());
        assert!(!WidgetSource::Static { data: Value::Null }.is_refreshable());
    }

    #[test]
    fn source_round_trips_through_tagged_json() {
        let src = WidgetSource::CoreEndpoint {
            endpoint: "quests".into(),
            selector: Some("quests".into()),
        };
        let v = serde_json::to_value(&src).unwrap();
        assert_eq!(v["type"], "core_endpoint");
        let back: WidgetSource = serde_json::from_value(v).unwrap();
        assert!(matches!(back, WidgetSource::CoreEndpoint { .. }));
    }

    #[test]
    fn selector_walks_objects_and_arrays() {
        let body = json!({ "items": [{ "n": 5 }, { "n": 9 }] });
        assert_eq!(sources::select(&body, Some("items.1.n")), json!(9));
        assert_eq!(sources::select(&body, Some("missing")), Value::Null);
        assert_eq!(sources::select(&body, None), body);
    }
}
