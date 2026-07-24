//! Core-side binding for the extracted unified tool catalog (#474, P1).
//!
//! The catalog *contract + ranker + describe-shaping* (the portable data layer)
//! now lives in the [`ryu_tool_registry`] crate. This module is the thin kernel
//! glue that binds it to the [`McpRegistry`] sidecar object:
//!
//! - the `RegistryTool` → [`ToolDescriptor`] ingest adapter ([`descriptor_from`]),
//! - the built-in server inventory classification ([`classify_kind`]), which
//!   depends on Core's concrete sidecar server inventory (`SELF_BUILD_SERVER`,
//!   the built-in server list) and so cannot live in the crate,
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

use super::{AppToolBackendTag, McpRegistry, RegistryTool};

/// Built-in server names — their tools are classified [`ToolKind::Builtin`].
const BUILTIN_SERVERS: &[&str] = &[
    super::sandbox::SERVER_NAME,
    super::notify_tool::SERVER_NAME,
    super::artifact_tool::SERVER_NAME,
    super::channel_tool::SERVER_NAME,
    super::search_conversations::SERVER_NAME,
    super::threads::SERVER_NAME,
    super::delegate::SERVER_NAME,
    super::skills_tool::SERVER_NAME,
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
    if server == "app" {
        return ToolKind::App;
    }
    if server == super::SELF_BUILD_SERVER || BUILTIN_SERVERS.contains(&server) {
        return ToolKind::Builtin;
    }
    ToolKind::Mcp
}

/// Resolve a registry row's [`ToolKind`], honoring its `app_backend` tag: a
/// `command`-tagged app tool surfaces as [`ToolKind::Command`] (so `?kind=command`
/// selects it); every other row — including http/inline_deno/alias app tools —
/// falls back to inventory-based [`classify_kind`]. This is the ONE place the
/// deliberate command-vs-App asymmetry lives; `classify_kind`'s signature (and its
/// tests) are untouched.
fn kind_for(tool: &RegistryTool) -> ToolKind {
    if tool.app_backend == Some(AppToolBackendTag::Command) {
        return ToolKind::Command;
    }
    classify_kind(&tool.id, &tool.server)
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
        kind: kind_for(tool),
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
        let mut builtins: Vec<ToolDescriptor> = self
            .list_all_tools()
            .await
            .iter()
            .map(descriptor_from)
            .collect();
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

        let tool = self
            .list_all_tools()
            .await
            .into_iter()
            .find(|t| t.id == id)?;
        Some(ryu_tool_registry::describe_from_parts(
            &tool.id,
            &tool.name,
            tool.description.as_deref().unwrap_or_default(),
            kind_for(&tool),
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
            classify_kind("sandbox__run", super::super::sandbox::SERVER_NAME),
            ToolKind::Builtin
        );
        assert_eq!(classify_kind("foo__bar", "foo"), ToolKind::Mcp);
        assert_eq!(
            classify_kind("composio__slack", "composio"),
            ToolKind::Composio
        );
        // `shadow`/`advisor` are now declarative `app`-registered plugin tools
        // (server "app"), not built-in servers — they classify as App like exa.
        assert_eq!(classify_kind("app__thing", "app"), ToolKind::App);
        assert_eq!(
            classify_kind("skills__load", super::super::skills_tool::SERVER_NAME),
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
    async fn command_tagged_tool_classifies_and_searches_as_command() {
        let reg = McpRegistry::empty();
        // A command-tagged app tool …
        reg.register_app_tool_tagged(
            "app__exa_search".into(),
            "exa_search".into(),
            Some("Search the web".into()),
            Some(AppToolBackendTag::Command),
        );
        // … and an http-tagged one (which must stay classified as App).
        reg.register_app_tool_tagged(
            "app__other".into(),
            "other".into(),
            None,
            Some(AppToolBackendTag::Http),
        );

        // descriptor_from → Command, and search(kind=Command) selects it.
        let results = reg.search("exa_search", Some(ToolKind::Command), 25).await;
        assert!(
            results
                .iter()
                .any(|d| d.id == "app__exa_search" && d.kind == ToolKind::Command),
            "command tool must be surfaced + selected by kind=command"
        );
        // The http app tool is NOT a command (asymmetry) — absent from kind=Command.
        assert!(
            results.iter().all(|d| d.id != "app__other"),
            "http app tool must not appear under kind=command"
        );

        // describe honors the tag on both sites.
        let described = reg.describe("app__exa_search").await.expect("described");
        assert_eq!(described.kind, ToolKind::Command);
        let http_desc = reg.describe("app__other").await.expect("described");
        assert_eq!(http_desc.kind, ToolKind::App);
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
