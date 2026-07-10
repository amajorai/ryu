//! In-process Ryu Apps provider (Ryu Apps v1).
//!
//! Eight first-party "apps" whose tools render interactive widgets in chat. This
//! provider is the MCP-server side: it advertises the tools (with the widget
//! `_meta` binding) via [`tools`], answers `owns`/`dispatch`, and serves the
//! widget HTML via [`read_resource`]. It requires no subprocess — the tools run
//! in-process and return `structuredContent`/`_meta` shaped exactly like an MCP
//! `tools/call` result, so the existing widget-emit path treats them uniformly.
//!
//! Five apps are **pure-data** (checklist, smart-intake-form, data-grid-explorer,
//! chart-studio, decision-wizard): their tools compute deterministic structured
//! data from their arguments. Three apps (quest-board, worktree-diff-review,
//! gateway-budget-dial) ship **stub** render tools returning sample data so their
//! widgets render; wiring them to the real subsystems (quests store, git-native
//! diff/apply, Gateway rule API) is workflow B2.
//!
//! Placement (AGENTS.md §1): these tools *run* things, so they are Core. Egress
//! governance for widget-initiated calls stays with the Gateway via the
//! `/api/widgets/tools/call` → `/v1/exec/tool` round-trip.

pub mod budget;
pub mod chart;
pub mod checklist;
pub mod datagrid;
pub mod decision;
pub mod generated;
pub mod intake;
pub mod quests;
pub mod worktree;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{RegistryTool, WidgetBinding, WidgetResource};
use generated::{AppBundle, APP_BUNDLES};

/// Whether `server` is one of the in-process app namespaces.
pub fn owns(server: &str) -> bool {
    APP_BUNDLES.iter().any(|b| b.server == server)
}

/// Find the bundle for a server namespace.
fn bundle_for(server: &str) -> Option<&'static AppBundle> {
    APP_BUNDLES.iter().find(|b| b.server == server)
}

/// Every tool the in-process apps advertise, with the widget `_meta` binding.
///
/// Render tools carry the `outputTemplate` (both `ryu/*` and `openai/*`, R10) so
/// the emit path resolves the widget; their `widgetAccessible` flag reflects
/// whether the resulting widget may call *any* tool (i.e. the app declares a
/// companion tool). Companion tools carry `widgetAccessible:true` so the
/// provenance gate accepts them as call targets.
pub fn tools() -> Vec<RegistryTool> {
    let mut out = Vec::new();
    for b in APP_BUNDLES {
        let has_companions = b.tools.iter().any(|t| t.widget_accessible);
        for t in b.tools {
            let id = format!("{}__{}", b.server, t.name);
            let mut meta = serde_json::Map::new();
            let (widget, output_template, widget_accessible_flag) = if t.renders_widget {
                // The widget spawned by this render tool may call tools iff the
                // app declares companion (widgetAccessible) tools.
                let may_call = has_companions;
                meta.insert("ryu/outputTemplate".into(), json!(b.uri));
                meta.insert("openai/outputTemplate".into(), json!(b.uri));
                meta.insert("ryu/uiResource".into(), json!(b.uri));
                meta.insert("ryu/widgetAccessible".into(), json!(may_call));
                meta.insert("openai/widgetAccessible".into(), json!(may_call));
                if !t.invoking.is_empty() || !t.invoked.is_empty() {
                    let inv = json!({ "invoking": t.invoking, "invoked": t.invoked });
                    meta.insert("ryu/toolInvocation".into(), inv.clone());
                    meta.insert("openai/toolInvocation".into(), inv);
                }
                let binding = WidgetBinding {
                    template_uri: b.uri.to_owned(),
                    widget_accessible: may_call,
                    invoking_label: (!t.invoking.is_empty()).then(|| t.invoking.to_owned()),
                    invoked_label: (!t.invoked.is_empty()).then(|| t.invoked.to_owned()),
                };
                (Some(binding), Some(b.uri.to_owned()), may_call)
            } else {
                // Companion write/mutation tool: a call target for a mounted widget.
                meta.insert("ryu/widgetAccessible".into(), json!(t.widget_accessible));
                meta.insert("openai/widgetAccessible".into(), json!(t.widget_accessible));
                (None, None, t.widget_accessible)
            };
            let input_schema: Option<Value> = serde_json::from_str(t.input_schema).ok();
            out.push(RegistryTool {
                id,
                server: b.server.to_owned(),
                name: t.name.to_owned(),
                description: Some(t.description.to_owned()),
                input_schema,
                output_schema: None,
                annotations: None,
                meta: Some(Value::Object(meta)),
                widget,
                widget_accessible: widget_accessible_flag,
                output_template,
            });
        }
    }
    out
}

/// The fully-qualified ids of the widget-accessible (companion) tools on
/// `server`. Used by the `WidgetInstanceStore` to bound which tools a mounted
/// widget may `callTool` (provenance gate, §4.1).
pub fn widget_accessible_tool_ids(server: &str) -> Vec<String> {
    bundle_for(server)
        .map(|b| {
            b.tools
                .iter()
                .filter(|t| t.widget_accessible)
                .map(|t| format!("{}__{}", b.server, t.name))
                .collect()
        })
        .unwrap_or_default()
}

/// Serve a widget HTML resource by its `ui://widget/<slug>.html` uri.
pub fn read_resource(uri: &str) -> Option<WidgetResource> {
    APP_BUNDLES.iter().find(|b| b.uri == uri).map(|b| WidgetResource {
        uri: b.uri.to_owned(),
        mime_type: b.mime.to_owned(),
        html: b.html.to_owned(),
        meta: None,
    })
}

/// Context threaded into a tool dispatch so the subsystem-wired apps (quest-board,
/// worktree-diff-review, gateway-budget-dial) can reach the live Core state they
/// mutate. Borrowed for the duration of the call; the pure-data apps ignore it.
///
/// `conversation_id` is the owning run/session — load-bearing for worktree ops,
/// which key their diff/apply on the run. `http` talks to the Gateway over
/// loopback (budget). `quests`/`worktree_diffs` are the optional store handles the
/// `McpRegistry` carries; when absent the quests app falls back to the process
/// global engine and the worktree app reports its store unavailable.
pub struct AppDispatchCtx<'a> {
    pub http: &'a reqwest::Client,
    pub quests: Option<&'a crate::quests::store::QuestStore>,
    pub worktree_diffs: Option<&'a crate::server::WorktreeDiffStore>,
    pub conversation_id: Option<String>,
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
}

/// Dispatch a tool call on one of the in-process apps. Returns an MCP
/// `tools/call`-shaped result value (`structuredContent`/`content`/`_meta`).
///
/// The five pure-data apps compute deterministically from their arguments and
/// ignore `ctx`; the three subsystem-wired apps read `ctx` for their live state.
pub async fn dispatch(
    server: &str,
    tool: &str,
    arguments: Value,
    ctx: AppDispatchCtx<'_>,
) -> Result<Value> {
    match server {
        "checklist" => checklist::dispatch(tool, arguments),
        "app.form" => intake::dispatch(tool, arguments),
        "table" => datagrid::dispatch(tool, arguments),
        "chart" => chart::dispatch(tool, arguments),
        "app.decision" => decision::dispatch(tool, arguments),
        "ryu.quests" => quests::dispatch(tool, arguments, &ctx).await,
        "ryu.worktree" => worktree::dispatch(tool, arguments, &ctx).await,
        "ryu.gateway" => budget::dispatch(tool, arguments, &ctx).await,
        other => Err(anyhow!("unknown app server '{other}'")),
    }
}

// ── Shared helpers for the per-app modules ───────────────────────────────────

/// Build an MCP `tools/call`-shaped result carrying `structuredContent` (what the
/// model + widget read) and an optional `_meta` (widget-only payload, e.g. full
/// data-grid rows) plus a short human summary in `content`.
pub(super) fn app_result(structured: Value, meta: Option<Value>, summary: &str) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("structuredContent".into(), structured);
    obj.insert(
        "content".into(),
        json!([{ "type": "text", "text": summary }]),
    );
    if let Some(m) = meta {
        obj.insert("_meta".into(), m);
    }
    obj.insert("isError".into(), json!(false));
    Value::Object(obj)
}

/// Generate a short, unguessable-enough id with a type prefix. Monotonic-ish via
/// a nanosecond clock plus a process-atomic counter (no external uuid dep).
pub(super) fn gen_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{n:x}{c:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_recognizes_app_servers() {
        assert!(owns("checklist"));
        assert!(owns("app.form"));
        assert!(owns("ryu.gateway"));
        assert!(!owns("exa"));
        assert!(!owns("some-random-mcp"));
    }

    #[test]
    fn tools_carry_widget_binding_on_render_only() {
        let tools = tools();
        // Render tool has a binding + output_template; companion does not.
        let render = tools
            .iter()
            .find(|t| t.id == "checklist__render")
            .expect("checklist__render present");
        assert!(render.widget.is_some(), "render tool must carry a WidgetBinding");
        assert_eq!(
            render.output_template.as_deref(),
            Some("ui://widget/checklist.html")
        );
        // The app has a companion tool, so the widget may call tools.
        assert!(render.widget_accessible, "render widget may call companions");

        let update = tools
            .iter()
            .find(|t| t.id == "checklist__update")
            .expect("checklist__update present");
        assert!(update.widget.is_none(), "companion tool renders no widget");
        assert!(update.widget_accessible, "companion is a call target");
    }

    #[test]
    fn meta_carries_both_namespaces() {
        let tools = tools();
        let render = tools.iter().find(|t| t.id == "checklist__render").unwrap();
        let meta = render.meta.as_ref().unwrap();
        assert!(meta.get("ryu/outputTemplate").is_some());
        assert!(meta.get("openai/outputTemplate").is_some());
        // from_meta resolves the binding from the emitted meta (round-trip).
        let binding = crate::sidecar::mcp::WidgetBinding::from_meta(Some(meta)).unwrap();
        assert_eq!(binding.template_uri, "ui://widget/checklist.html");
    }

    #[test]
    fn widget_accessible_ids_are_companions_only() {
        let ids = widget_accessible_tool_ids("checklist");
        assert_eq!(ids, vec!["checklist__update".to_owned()]);
    }

    #[tokio::test]
    async fn checklist_render_dispatch_shapes_structured_content() {
        // The checklist app is pure-data and ignores the dispatch context, so an
        // empty ctx (no store handles) suffices for this shape test.
        let http = reqwest::Client::new();
        let ctx = AppDispatchCtx {
            http: &http,
            quests: None,
            worktree_diffs: None,
            conversation_id: None,
            agent_id: None,
            user_id: None,
        };
        let out = dispatch(
            "checklist",
            "render",
            serde_json::json!({ "title": "Groceries", "items": [{ "text": "milk" }, { "text": "eggs", "done": true }] }),
            ctx,
        )
        .await
        .unwrap();
        let sc = out.get("structuredContent").unwrap();
        assert_eq!(sc.get("title").unwrap(), "Groceries");
        let items = sc.get("items").unwrap().as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].get("done").unwrap(), true);
        assert_eq!(out.get("isError").unwrap(), false);
    }

    #[test]
    fn read_resource_resolves_bundle_html() {
        let res = read_resource("ui://widget/checklist.html").expect("bundle resolves");
        assert_eq!(res.mime_type, "text/html+skybridge");
        assert!(res.html.contains("ryu-root") || res.html.contains("ryu:widget"));
        assert!(read_resource("ui://widget/does-not-exist.html").is_none());
    }

    /// Every embedded bundle MUST be fully self-contained: no external `./chunk.js`
    /// import/src. A relative asset cannot load in the null-origin `srcdoc` iframe
    /// under CSP `default-src 'none'` (D3), so a stray external ref = a blank widget.
    /// Guards against a multi-entry Vite build re-hoisting a shared react chunk.
    #[test]
    fn embedded_bundles_are_self_contained() {
        for bundle in generated::APP_BUNDLES {
            let html = bundle.html;
            for needle in ["src=\"./", "src='./", "from\"./", "from './", "from\"/", "href=\"./"]
            {
                assert!(
                    !html.contains(needle),
                    "bundle '{}' has an external asset reference ({needle}); the widget \
                     would fail to load under the CSP iframe. Rebuild with the per-app \
                     single-input Vite build (scripts/build-all.ts).",
                    bundle.slug
                );
            }
            // Sanity: the entry script and a mount root are present inline.
            assert!(
                html.contains("<script"),
                "bundle '{}' has no inline script",
                bundle.slug
            );
        }
    }
}
