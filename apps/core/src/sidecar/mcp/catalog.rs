//! Core-side binding for the extracted unified tool catalog (#474, P1).
//!
//! The catalog *contract + ranker + describe-shaping* (the portable data layer)
//! now lives in the [`ryu_tool_registry`] crate. This module is the thin kernel
//! glue that binds it to the [`McpRegistry`] sidecar object:
//!
//! - the `RegistryTool` → [`ToolDescriptor`] ingest adapter ([`descriptor_from`]),
//! - the built-in server inventory classification ([`classify_kind`]), which
//!   depends on Core's concrete sidecar server modules (`apps::owns`,
//!   `SELF_BUILD_SERVER`) and so cannot live in the crate,
//! - the live, key-gated Composio fetch ([`composio_candidates`]), and
//! - the two [`McpRegistry`] methods ([`McpRegistry::search`] /
//!   [`McpRegistry::describe`]) that gather kernel state and delegate the pure
//!   work to [`ryu_tool_registry::run_search`] /
//!   [`ryu_tool_registry::describe_from_parts`] / [`ryu_tool_registry::describe_composio`].
//!
//! The Contract-1 types are re-exported so existing `mcp::catalog::…` call sites
//! (the `/api/tools/{search,describe}` handlers, the mcp_bridge meta-tool) keep
//! resolving unchanged.
//!
//! Placement (CLAUDE.md §1): discovering *what tools exist* and ranking them is
//! orchestration → Core. The allowlist verdict / budget / audit is Gateway.

use serde_json::Value;

pub use ryu_tool_registry::{
    DescribedArg, DescribedTool, ToolDescriptor, ToolKind, ToolRanker, RANKER_PREF_KEY,
};

use super::{McpRegistry, RegistryTool};

/// Built-in server names — their tools are classified [`ToolKind::Builtin`].
const BUILTIN_SERVERS: &[&str] = &[
    super::shadow::SERVER_NAME,
    super::spider::SERVER_NAME,
    super::exa::SERVER_NAME,
    super::sandbox::SERVER_NAME,
    super::notify_tool::SERVER_NAME,
    super::artifact_tool::SERVER_NAME,
    super::channel_tool::SERVER_NAME,
    super::search_conversations::SERVER_NAME,
    super::threads::SERVER_NAME,
    super::delegate::SERVER_NAME,
    super::skills_tool::SERVER_NAME,
    super::advisor::SERVER_NAME,
    super::ui_tool::SERVER_NAME,
];

/// Classify a fully-qualified tool id (`<server>__<tool>`) into a [`ToolKind`].
///
/// `composio__*` → Composio; a built-in server segment → Builtin; the synthetic
/// `app` server (tool-as-Runnable) → App; the self-build server → Builtin;
/// anything else → Mcp. Bound to Core's sidecar server inventory, so it stays
/// kernel-side rather than in the crate.
pub fn classify_kind(id: &str, server: &str) -> ToolKind {
    if server == super::composio::SERVER_NAME {
        return ToolKind::Composio;
    }
    let _ = id;
    if server == "app" || super::apps::owns(server) {
        return ToolKind::App;
    }
    if server == super::SELF_BUILD_SERVER || BUILTIN_SERVERS.contains(&server) {
        return ToolKind::Builtin;
    }
    ToolKind::Mcp
}

/// Build a descriptor from a registry tool (`Option<String>` → `String`). The
/// `RegistryTool`→[`ToolDescriptor`] ingest adapter — bound to Core's registry
/// row type, so it stays kernel-side; the arg extraction reuses the crate's
/// [`ryu_tool_registry::arg_summary`].
fn descriptor_from(tool: &RegistryTool) -> ToolDescriptor {
    let (arg_names, arg_descriptions) = ryu_tool_registry::arg_summary(tool.input_schema.as_ref());
    ToolDescriptor {
        id: tool.id.clone(),
        name: tool.name.clone(),
        description: tool.description.clone().unwrap_or_default(),
        kind: classify_kind(&tool.id, &tool.server),
        arg_names,
        arg_descriptions,
        score: None,
        meta: tool.meta.clone(),
        widget_accessible: tool.widget_accessible,
        output_template: tool.output_template.clone(),
    }
}

impl McpRegistry {
    /// Search the unified tool catalog. `kind` filters by source plane (`None` =
    /// any). Composio is pulled in **live** (capped at 50) only when a key is
    /// configured and `kind` includes Composio; it is never in `list_all_tools`.
    ///
    /// Gathers kernel state (registry rows + live Composio) and delegates the
    /// filter/merge/rank to [`ryu_tool_registry::run_search`]. Ranking uses the
    /// pref-selected [`ToolRanker`] (BM25 default); the Semantic ranker's
    /// embedder is built lazily via [`crate::tool_registry_host`].
    pub async fn search(
        &self,
        query: &str,
        kind: Option<ToolKind>,
        limit: usize,
    ) -> Vec<ToolDescriptor> {
        let mut builtins: Vec<ToolDescriptor> =
            self.list_all_tools().await.iter().map(descriptor_from).collect();
        // Core self-API tools (agents driving Ryu itself): OpenAPI-derived, always
        // present, merged HERE so they rank through the same BM25/semantic pass as
        // everything else rather than being appended after truncation. Kind-filtered
        // by `run_search` like any other descriptor.
        builtins.extend(crate::self_api::descriptors());

        // Composio: searchable-not-listed. Pull live, capped, key-gated.
        let want_composio = matches!(kind, None | Some(ToolKind::Composio));
        let composio = if want_composio && super::composio::is_configured() {
            composio_candidates(&self.http, query).await
        } else {
            Vec::new()
        };

        let ranker = self.resolve_ranker().await;
        let embedder = matches!(ranker, ToolRanker::Semantic)
            .then(crate::tool_registry_host::CoreToolEmbedder::from_registry);
        ryu_tool_registry::run_search(
            query,
            builtins,
            composio,
            kind,
            limit,
            ranker,
            embedder
                .as_ref()
                .map(|e| e as &dyn ryu_tool_registry::ToolEmbedder),
        )
        .await
    }

    /// Describe a single tool by its fully-qualified id. Returns `None` when the
    /// id is not found. A `composio__*` id is `shallow:true` with a single
    /// freeform `arguments` row (the action's full schema is not listed).
    pub async fn describe(&self, id: &str) -> Option<DescribedTool> {
        // Composio: not in list_all_tools — describe shallowly.
        if id.starts_with("composio__") {
            return Some(ryu_tool_registry::describe_composio(id));
        }

        // Core self-API: not in list_all_tools — described from the OpenAPI route.
        if crate::self_api::is_core_api(id) {
            return crate::self_api::describe(id);
        }

        let tool = self.list_all_tools().await.into_iter().find(|t| t.id == id)?;
        Some(ryu_tool_registry::describe_from_parts(
            &tool.id,
            &tool.name,
            tool.description.as_deref().unwrap_or_default(),
            classify_kind(&tool.id, &tool.server),
            tool.input_schema.as_ref(),
        ))
    }

    /// Resolve the active ranker from preferences (BM25 default).
    async fn resolve_ranker(&self) -> ToolRanker {
        let pref = match crate::server::preferences::PreferencesStore::open_default() {
            Ok(p) => p.get(RANKER_PREF_KEY).await.ok().flatten(),
            Err(_) => None,
        };
        ToolRanker::from_pref(pref.as_deref())
    }
}

/// Fetch a capped slice of Composio actions as descriptors. Toolkit-agnostic
/// (empty toolkit → catalog drops the empty filter), capped at 50/search. Bound
/// to Core's Composio client, so it stays kernel-side.
async fn composio_candidates(http: &reqwest::Client, query: &str) -> Vec<ToolDescriptor> {
    const CAP: usize = 50;
    let raw = match crate::composio_catalog::list_actions(http, "", query, CAP).await {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!("composio search skipped: {e}");
            return Vec::new();
        }
    };
    raw.get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let slug = a.get("name").and_then(Value::as_str)?;
                    if slug.is_empty() {
                        return None;
                    }
                    let name = a
                        .get("display_name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(slug)
                        .to_string();
                    Some(ToolDescriptor {
                        id: format!("composio__{slug}"),
                        name,
                        description: a
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: ToolKind::Composio,
                        arg_names: Vec::new(),
                        arg_descriptions: Vec::new(),
                        score: None,
                        meta: None,
                        widget_accessible: false,
                        output_template: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_kind_by_server() {
        assert_eq!(
            classify_kind("exa__search", super::super::exa::SERVER_NAME),
            ToolKind::Builtin
        );
        assert_eq!(classify_kind("foo__bar", "foo"), ToolKind::Mcp);
        assert_eq!(
            classify_kind("composio__slack", "composio"),
            ToolKind::Composio
        );
        assert_eq!(classify_kind("app__thing", "app"), ToolKind::App);
        assert_eq!(
            classify_kind("spider__crawl", super::super::spider::SERVER_NAME),
            ToolKind::Builtin
        );
    }

    #[test]
    fn description_option_maps_to_empty_string() {
        let tool = RegistryTool::candidate("foo__bar", "foo", "bar");
        let d = descriptor_from(&tool);
        assert_eq!(d.description, "");
        assert_eq!(d.kind, ToolKind::Mcp);
    }

    #[tokio::test]
    async fn search_excludes_composio_without_key() {
        // Serialize against every test that mutates the composio auth cache /
        // key env (process-global), so the "no key" state holds for this body.
        let _lock = crate::sidecar::gateway::lock_managed_node_env();
        crate::composio_auth::set_key("");
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        std::env::remove_var("COMPOSIO_API_KEY");
        let reg = McpRegistry::empty();
        let results = reg.search("anything", None, 25).await;
        assert!(
            results.iter().all(|d| d.kind != ToolKind::Composio),
            "no Composio results when no key configured"
        );
    }
}
