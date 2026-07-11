//! Unified tool catalog over the [`super::McpRegistry`] (#474, P1).
//!
//! One searchable catalog across **MCP servers + built-ins + Composio + plugin
//! tools** — no parallel registry. `search()` ranks descriptors with a
//! **swappable [`ToolRanker`]** (BM25 default, semantic rerank as a second impl
//! seam, selectable via a pref key mirroring `catalog.active_source.{kind}`).
//! `describe()` returns a tool's argument schema.
//!
//! Contract 1 (spec Appendix A, verbatim): [`ToolKind`] / [`ToolDescriptor`] /
//! [`DescribedTool`] / [`DescribedArg`]. `RegistryTool.description:
//! Option<String>` is mapped to `String` ("" when `None`) at this boundary.
//!
//! Placement (CLAUDE.md §1): discovering *what tools exist* and ranking them is
//! orchestration → Core. The allowlist verdict / budget / audit is Gateway.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{McpRegistry, RegistryTool};

/// Source plane of a tool. Serializes lowercase: `mcp|builtin|composio|app`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Mcp,
    Builtin,
    Composio,
    App,
}

impl ToolKind {
    /// Parse the `?kind=` / `tool_search.kind` value. `any` → `None` (no filter);
    /// an unknown value also yields `None` so callers can treat it as "any".
    pub fn parse_filter(s: &str) -> Option<ToolKind> {
        match s.trim().to_ascii_lowercase().as_str() {
            "mcp" => Some(ToolKind::Mcp),
            "builtin" => Some(ToolKind::Builtin),
            "composio" => Some(ToolKind::Composio),
            "app" => Some(ToolKind::App),
            _ => None, // "any" or unknown
        }
    }
}

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
/// anything else → Mcp.
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

/// A ranked tool descriptor (Contract 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDescriptor {
    /// `<server>__<tool>` | `composio__<slug>`.
    pub id: String,
    pub name: String,
    /// Never null — `""` when absent.
    #[serde(default)]
    pub description: String,
    pub kind: ToolKind,
    #[serde(default)]
    pub arg_names: Vec<String>,
    #[serde(default)]
    pub arg_descriptions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
    /// The tool's `_meta`, verbatim (widget keys), when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// Whether a widget originating from this tool may `callTool` (companion).
    #[serde(default)]
    pub widget_accessible: bool,
    /// The `ui://widget/<slug>.html` template uri when this tool renders a widget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_template: Option<String>,
}

impl ToolDescriptor {
    /// Whether this descriptor is reachable under an agent's tool `allowlist`,
    /// matching the *execution* gate ([`super::tool_allowed`]) so a `?agent=`
    /// search view does not under-report tools the agent can actually call:
    /// for MCP/built-in/app tools an entry may be the fully-qualified id, the
    /// bare tool name, **or** the server segment; for Composio it is matched on
    /// the fully-qualified id only (Composio ids have no name/server grant form,
    /// and id-only is the cross-plane-bypass guard on the call path).
    pub fn matches_allowlist(&self, allowlist: &[String]) -> bool {
        if self.kind == ToolKind::Composio {
            return allowlist.iter().any(|e| e == &self.id);
        }
        let (server, name) = self
            .id
            .split_once("__")
            .map_or((self.id.as_str(), self.name.as_str()), |(s, t)| (s, t));
        allowlist
            .iter()
            .any(|e| e == &self.id || e == name || e == server)
    }
}

/// A fully-described tool with its argument schema (Contract 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DescribedTool {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub kind: ToolKind,
    pub args: Vec<DescribedArg>,
    /// True when the schema could not be fully resolved (e.g. a Composio action
    /// whose only known argument is the freeform `arguments` object).
    #[serde(default)]
    pub shallow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
}

/// One argument of a [`DescribedTool`] (Contract 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DescribedArg {
    pub name: String,
    pub r#type: String,
    #[serde(default)]
    pub description: String,
    pub required: bool,
}

/// Build a descriptor from a registry tool (`Option<String>` → `String`).
fn descriptor_from(tool: &RegistryTool) -> ToolDescriptor {
    let (arg_names, arg_descriptions) = arg_summary(tool.input_schema.as_ref());
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

/// Extract `(arg_names, arg_descriptions)` from a JSON-schema `input_schema`.
fn arg_summary(schema: Option<&Value>) -> (Vec<String>, Vec<String>) {
    let mut names = Vec::new();
    let mut descs = Vec::new();
    if let Some(props) = schema
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object)
    {
        for (name, def) in props {
            names.push(name.clone());
            descs.push(
                def.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
        }
    }
    (names, descs)
}

/// Extract the full `DescribedArg` list from an `input_schema`.
fn described_args(schema: Option<&Value>) -> Vec<DescribedArg> {
    let Some(schema) = schema else {
        return Vec::new();
    };
    let required: Vec<String> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    props
        .iter()
        .map(|(name, def)| DescribedArg {
            name: name.clone(),
            r#type: def
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("string")
                .to_string(),
            description: def
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            required: required.iter().any(|r| r == name),
        })
        .collect()
}

// ── Ranker (swappable; nothing hardcoded) ────────────────────────────────────

/// Pref key selecting the active ranker, mirroring `catalog.active_source.{kind}`.
pub const RANKER_PREF_KEY: &str = "tools.active_ranker";

/// A swappable tool ranking strategy. BM25 is the default; `Semantic` is a real
/// embedder-backed second strategy (enum-dispatch in [`ToolRanker::rank`]), not a
/// placeholder — it embeds the query + candidates and ranks by cosine similarity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRanker {
    /// Classic BM25 lexical ranking over name + description + arg names.
    Bm25,
    /// Embedding-based semantic ranking via the registry [`Embedder`]
    /// (cosine over `doc_text`). Falls back to BM25 ordering when the embedder is
    /// unreachable (documented graceful fallback, not a stub error).
    Semantic,
}

impl ToolRanker {
    /// Resolve the ranker from a pref string; defaults to BM25.
    pub fn from_pref(s: Option<&str>) -> ToolRanker {
        match s.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("semantic") => ToolRanker::Semantic,
            _ => ToolRanker::Bm25,
        }
    }

    /// Rank descriptors against a query, mutating `score` and sorting descending.
    /// Returns the top `limit`.
    ///
    /// `Semantic` embeds the query + each candidate's [`doc_text`] via the
    /// registry's [`Embedder`](crate::server::retrieval::Embedder) and ranks by
    /// cosine similarity; it falls back to BM25 ordering when the embedder is
    /// unreachable (or the query is empty), so it degrades gracefully rather than
    /// erroring. `Bm25` is the pure lexical path.
    async fn rank(
        self,
        query: &str,
        mut items: Vec<ToolDescriptor>,
        limit: usize,
    ) -> Vec<ToolDescriptor> {
        let scored = match self {
            ToolRanker::Semantic => semantic_score(query, &mut items).await,
            ToolRanker::Bm25 => false,
        };
        if !scored {
            // BM25 path (also the Semantic fallback when no embedder is reachable).
            bm25_score(query, &mut items);
        }
        items.sort_by(|a, b| {
            b.score
                .unwrap_or(0.0)
                .partial_cmp(&a.score.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        items.truncate(limit);
        items
    }
}

/// Cosine similarity of two equal-length vectors; `0.0` on length mismatch.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom > f32::EPSILON {
        dot / denom
    } else {
        0.0
    }
}

/// Score `items` in place by embedding cosine similarity. Returns `true` when the
/// semantic path ran (every item scored), `false` to signal the caller to fall
/// back to BM25 (empty query, or the query embedding failed → embedder
/// unreachable). A single per-item embedding failure scores that item `0.0`.
async fn semantic_score(query: &str, items: &mut [ToolDescriptor]) -> bool {
    if query.trim().is_empty() || items.is_empty() {
        return false;
    }
    let embedder =
        crate::server::retrieval::Embedder::from_registry(&crate::registry::ModelRegistry::load());
    let Ok(q_vec) = embedder.embed(query).await else {
        // Embedder unreachable → documented BM25 fallback.
        return false;
    };
    for d in items.iter_mut() {
        let score = match embedder.embed(&doc_text(d)).await {
            Ok(doc_vec) => cosine(&q_vec, &doc_vec),
            Err(_) => 0.0,
        };
        d.score = Some(score);
    }
    true
}

/// Tokenize on non-alphanumeric boundaries, lowercased.
fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_lowercase())
        .collect()
}

/// The searchable text of a descriptor (id + name + description + arg names).
fn doc_text(d: &ToolDescriptor) -> String {
    let mut s = format!("{} {} {}", d.id, d.name, d.description);
    for a in &d.arg_names {
        s.push(' ');
        s.push_str(a);
    }
    s
}

/// Score `items` in place with BM25; an exact id/name match gets a strong boost
/// so it ranks first (acceptance: BM25 ranks exact match first).
fn bm25_score(query: &str, items: &mut [ToolDescriptor]) {
    const K1: f32 = 1.5;
    const B: f32 = 0.75;
    let q_terms = tokenize(query);
    if q_terms.is_empty() {
        for d in items.iter_mut() {
            d.score = Some(0.0);
        }
        return;
    }

    let docs: Vec<Vec<String>> = items.iter().map(|d| tokenize(&doc_text(d))).collect();
    let n = docs.len().max(1) as f32;
    let avg_dl = docs.iter().map(|d| d.len() as f32).sum::<f32>() / n;
    let avg_dl = if avg_dl == 0.0 { 1.0 } else { avg_dl };

    let q_lower = query.trim().to_ascii_lowercase();

    for (i, d) in items.iter_mut().enumerate() {
        let doc = &docs[i];
        let dl = doc.len() as f32;
        let mut score = 0.0_f32;
        for term in &q_terms {
            let tf = doc.iter().filter(|w| *w == term).count() as f32;
            if tf == 0.0 {
                continue;
            }
            // Document frequency across the candidate set.
            let df = docs.iter().filter(|dd| dd.contains(term)).count() as f32;
            let idf = (((n - df + 0.5) / (df + 0.5)) + 1.0).ln();
            let denom = tf + K1 * (1.0 - B + B * dl / avg_dl);
            score += idf * (tf * (K1 + 1.0)) / denom;
        }
        // Exact id / name match boost so it sorts first.
        if d.id.eq_ignore_ascii_case(&q_lower) || d.name.eq_ignore_ascii_case(&q_lower) {
            score += 1000.0;
        }
        d.score = Some(score);
    }
}

impl McpRegistry {
    /// Search the unified tool catalog. `kind` filters by source plane (`None` =
    /// any). Composio is pulled in **live** (capped at 50) only when a key is
    /// configured and `kind` includes Composio; it is never in `list_all_tools`.
    ///
    /// Ranking uses the pref-selected [`ToolRanker`] (BM25 default).
    pub async fn search(
        &self,
        query: &str,
        kind: Option<ToolKind>,
        limit: usize,
    ) -> Vec<ToolDescriptor> {
        let mut candidates: Vec<ToolDescriptor> = self
            .list_all_tools()
            .await
            .iter()
            .map(descriptor_from)
            .filter(|d| kind.is_none() || kind == Some(d.kind))
            .collect();

        // Composio: searchable-not-listed. Pull live, capped, key-gated.
        let want_composio = matches!(kind, None | Some(ToolKind::Composio));
        if want_composio && super::composio::is_configured() {
            candidates.extend(composio_candidates(&self.http, query).await);
        }

        let ranker = self.resolve_ranker().await;
        ranker.rank(query, candidates, limit).await
    }

    /// Describe a single tool by its fully-qualified id. Returns `None` when the
    /// id is not found. A `composio__*` id is `shallow:true` with a single
    /// freeform `arguments` row (the action's full schema is not listed).
    pub async fn describe(&self, id: &str) -> Option<DescribedTool> {
        // Composio: not in list_all_tools — describe shallowly.
        if id.starts_with("composio__") {
            let slug = id.strip_prefix("composio__").unwrap_or(id);
            return Some(DescribedTool {
                id: id.to_string(),
                name: slug.to_string(),
                description: String::new(),
                kind: ToolKind::Composio,
                args: vec![DescribedArg {
                    name: "arguments".to_string(),
                    r#type: "object".to_string(),
                    description: "Action-specific parameters for this Composio action.".to_string(),
                    required: false,
                }],
                shallow: true,
                parameters: None,
            });
        }

        let tool = self
            .list_all_tools()
            .await
            .into_iter()
            .find(|t| t.id == id)?;
        Some(DescribedTool {
            id: tool.id.clone(),
            name: tool.name.clone(),
            description: tool.description.clone().unwrap_or_default(),
            kind: classify_kind(&tool.id, &tool.server),
            args: described_args(tool.input_schema.as_ref()),
            shallow: tool.input_schema.is_none(),
            parameters: tool.input_schema.clone(),
        })
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
/// (empty toolkit → catalog drops the empty filter), capped at 50/search.
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

    fn desc(id: &str, name: &str, description: &str, kind: ToolKind) -> ToolDescriptor {
        ToolDescriptor {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            kind,
            arg_names: Vec::new(),
            arg_descriptions: Vec::new(),
            score: None,
            meta: None,
            widget_accessible: false,
            output_template: None,
        }
    }

    #[test]
    fn kind_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&ToolKind::Mcp).unwrap(), "\"mcp\"");
        assert_eq!(
            serde_json::to_string(&ToolKind::Builtin).unwrap(),
            "\"builtin\""
        );
        assert_eq!(
            serde_json::to_string(&ToolKind::Composio).unwrap(),
            "\"composio\""
        );
        assert_eq!(serde_json::to_string(&ToolKind::App).unwrap(), "\"app\"");
    }

    #[test]
    fn parse_filter_maps_any_to_none() {
        assert_eq!(ToolKind::parse_filter("any"), None);
        assert_eq!(ToolKind::parse_filter("nonsense"), None);
        assert_eq!(ToolKind::parse_filter("mcp"), Some(ToolKind::Mcp));
        assert_eq!(ToolKind::parse_filter("COMPOSIO"), Some(ToolKind::Composio));
    }

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
    async fn bm25_ranks_exact_match_first() {
        let items = vec![
            desc("foo__search", "search", "search the web", ToolKind::Mcp),
            desc(
                "foo__send",
                "send_message",
                "send a search-related message",
                ToolKind::Mcp,
            ),
            desc("foo__noise", "noise", "totally unrelated", ToolKind::Mcp),
        ];
        let ranked = ToolRanker::Bm25.rank("search", items, 8).await;
        assert_eq!(ranked[0].name, "search", "exact name match ranks first");
        assert!(ranked.iter().all(|d| d.score.is_some()));
        // The unrelated tool should rank last (zero score).
        assert_eq!(ranked.last().unwrap().name, "noise");
    }

    #[tokio::test]
    async fn ranker_selectable_from_pref() {
        assert_eq!(ToolRanker::from_pref(None), ToolRanker::Bm25);
        assert_eq!(ToolRanker::from_pref(Some("bm25")), ToolRanker::Bm25);
        assert_eq!(
            ToolRanker::from_pref(Some("semantic")),
            ToolRanker::Semantic
        );
        // BM25 path produces a deterministic exact-match-first ordering. (The
        // Semantic path needs a reachable embedder, which is not asserted here.)
        let items = vec![
            desc("foo__search", "search", "find things", ToolKind::Mcp),
            desc("foo__x", "x", "nothing", ToolKind::Mcp),
        ];
        let ranked = ToolRanker::Bm25.rank("search", items, 8).await;
        assert_eq!(ranked[0].name, "search");
    }

    #[test]
    fn described_args_extracts_required_flag() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "page url" },
                "depth": { "type": "integer" }
            },
            "required": ["url"]
        });
        let mut args = described_args(Some(&schema));
        args.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(args.len(), 2);
        let url = args.iter().find(|a| a.name == "url").unwrap();
        assert_eq!(url.r#type, "string");
        assert_eq!(url.description, "page url");
        assert!(url.required);
        let depth = args.iter().find(|a| a.name == "depth").unwrap();
        assert_eq!(depth.r#type, "integer");
        assert!(!depth.required);
    }

    #[tokio::test]
    async fn describe_composio_id_is_shallow() {
        let reg = McpRegistry::empty();
        let d = reg.describe("composio__GITHUB_CREATE_ISSUE").await.unwrap();
        assert!(d.shallow);
        assert_eq!(d.kind, ToolKind::Composio);
        assert_eq!(d.args.len(), 1);
        assert_eq!(d.args[0].name, "arguments");
        assert_eq!(d.args[0].r#type, "object");
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
