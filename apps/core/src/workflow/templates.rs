//! Workflow **template catalog** — curated, installable workflow blueprints.
//!
//! Each template is one *primary* [`Workflow`] plus zero or more *body*
//! workflows (a durable `While` loop needs its body as a separate workflow, so
//! the loop's `body_workflow_id` points at one). Installing a template mints
//! fresh `wf_<uuid>` ids for every body, patches each `While` node's
//! `body_workflow_id` (and any `SubWorkflow.workflow_id`) to the minted id, mints
//! a fresh id for the primary, and persists them all through the shared
//! [`super::persist_workflow`] path (so triggers reconcile identically to a
//! hand-authored save). Returns the primary id.
//!
//! Per the Core-vs-Gateway rule this is **Core**: a template decides *what runs*
//! (which nodes, in what order). Every model call a node makes stays
//! Gateway-governed. Nothing is hardcoded beyond the blueprint shapes — the
//! catalog is data, and installing produces ordinary editable workflows.
//!
//! The blueprints themselves are **data files**, one JSON document per template
//! in `templates/`, and [`catalog()`] is derived from them — the same
//! file-based-definitions move that `registry.json` made (generated from the
//! manifests by `tools/generate-registry.mjs`). They are `include_str!`d, exactly
//! like the plugin manifest fixtures (`plugin_manifest::BUILTIN_MANIFESTS`), so
//! the catalog ships **inside** the Core binary and has no filesystem dependency
//! at runtime: adding or editing a template is a JSON edit plus one line in
//! [`TEMPLATE_FILES`], not a Rust rewrite.
//!
//! The 12 blueprints cover the common agentic patterns (Anthropic's
//! "Building effective agents" set) plus Ryu's autoresearch git-ledger loop.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{NodeKind, Workflow};

/// Public listing shape for one template (`GET /api/workflows/catalog`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTemplateMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    /// One of `research`, `orchestration`, `quality`, `automation`.
    pub category: String,
    /// The agentic pattern, e.g. `evaluator-optimizer`, `routing`.
    pub pattern: String,
    /// A lucide icon name the desktop/web card renders.
    pub icon: String,
    /// Node count of the primary workflow (the card's complexity hint).
    pub node_count: usize,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// A full template: metadata + the primary workflow + body workflows keyed by a
/// stable **placeholder** id that install-time minting patches into `While`
/// nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTemplate {
    pub meta: WorkflowTemplateMeta,
    pub primary: Workflow,
    /// `(placeholder_id, body_workflow)` pairs. The placeholder appears as a
    /// `While.body_workflow_id` (or `SubWorkflow.workflow_id`) in `primary` (or
    /// another body) and is rewritten to a minted `wf_<uuid>` on install.
    pub bodies: Vec<(String, Workflow)>,
}

// ── the catalog ──────────────────────────────────────────────────────────────

/// The curated blueprints, embedded at compile time from `templates/*.json`.
/// Order = display order (the desktop store section renders them in sequence).
/// Adding a template = drop a JSON file next to these and add one line here.
///
/// The file shape is exactly the serde image of [`WorkflowTemplate`]:
/// `{ "meta": {…}, "primary": <Workflow>, "bodies": [["<placeholder>", <Workflow>]] }`.
/// A `Workflow`'s `triggers` / `created_at` / `updated_at` are `#[serde(default)]`,
/// so a template file omits them (a template is never a persisted workflow — the
/// install path mints ids and persists through `persist_workflow`).
const TEMPLATE_FILES: &[&str] = &[
    include_str!("templates/autoresearch.json"),
    include_str!("templates/prompt-chaining.json"),
    include_str!("templates/routing.json"),
    include_str!("templates/parallelization.json"),
    include_str!("templates/orchestrator-workers.json"),
    include_str!("templates/evaluator-optimizer.json"),
    include_str!("templates/autonomous-agent.json"),
    include_str!("templates/fan-out-synthesize.json"),
    include_str!("templates/classify-and-act.json"),
    include_str!("templates/adversarial-verification.json"),
    include_str!("templates/tournament.json"),
    include_str!("templates/generate-and-filter.json"),
];

/// Every curated template. Order = display order.
///
/// A malformed embedded file is skipped with a warning rather than panicking —
/// the same fail-soft idiom as `PluginManifestLoader::load`, so one bad template
/// degrades the catalog instead of taking the process down. `all_template_files_parse`
/// makes that a CI failure, so the skip path can only ever fire on a bug that
/// already failed the test suite.
pub fn catalog() -> Vec<WorkflowTemplate> {
    TEMPLATE_FILES
        .iter()
        .filter_map(|raw| match serde_json::from_str::<WorkflowTemplate>(raw) {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::warn!("built-in workflow template skipped: {e}");
                None
            }
        })
        .collect()
}

/// The listing (`GET /api/workflows/catalog`): metadata only.
pub fn catalog_meta() -> Vec<WorkflowTemplateMeta> {
    catalog().into_iter().map(|t| t.meta).collect()
}

/// Find one template by id.
pub fn find(template_id: &str) -> Option<WorkflowTemplate> {
    catalog().into_iter().find(|t| t.meta.id == template_id)
}

// ── install ──────────────────────────────────────────────────────────────────

/// Rewrite every `While.body_workflow_id` / `SubWorkflow.workflow_id` that names
/// a placeholder in `id_map` to its minted id.
fn patch_bodies(workflow: &mut Workflow, id_map: &HashMap<String, String>) {
    for n in &mut workflow.nodes {
        match &mut n.kind {
            NodeKind::While {
                body_workflow_id: Some(bid),
                ..
            } => {
                if let Some(minted) = id_map.get(bid) {
                    *bid = minted.clone();
                }
            }
            NodeKind::SubWorkflow { workflow_id } => {
                if let Some(minted) = id_map.get(workflow_id) {
                    *workflow_id = minted.clone();
                }
            }
            _ => {}
        }
    }
}

fn mint_id() -> String {
    format!("wf_{}", uuid::Uuid::new_v4().simple())
}

/// Install a template: persist all body workflows with minted ids (patched so
/// inter-body references resolve), then persist the primary (its `While` nodes
/// patched to the minted body ids). Returns the primary workflow id.
pub async fn install(template_id: &str) -> Result<String, String> {
    let tmpl = find(template_id).ok_or_else(|| format!("unknown template '{template_id}'"))?;

    // Mint a fresh id for every body placeholder up front so references resolve.
    let mut id_map: HashMap<String, String> = HashMap::new();
    for (placeholder, _) in &tmpl.bodies {
        id_map.insert(placeholder.clone(), mint_id());
    }

    // Persist each body with its minted id (patching any inter-body references).
    for (placeholder, mut body) in tmpl.bodies {
        body.id = id_map.get(&placeholder).cloned().unwrap_or_else(mint_id);
        patch_bodies(&mut body, &id_map);
        super::persist_workflow(body).await?;
    }

    // Persist the primary: fresh id (let persist mint it) + patched while nodes.
    let mut primary = tmpl.primary;
    primary.id = String::new();
    patch_bodies(&mut primary, &id_map);
    let saved = super::persist_workflow(primary).await?;
    Ok(saved.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::WorkflowGraph;

    /// Every embedded file must PARSE. `catalog()` skips a malformed template with
    /// a warning (fail-soft at runtime), so without this assertion a broken JSON
    /// edit would silently shrink the catalog instead of failing CI.
    #[test]
    fn all_template_files_parse() {
        for (i, raw) in TEMPLATE_FILES.iter().enumerate() {
            serde_json::from_str::<WorkflowTemplate>(raw)
                .unwrap_or_else(|e| panic!("TEMPLATE_FILES[{i}] does not parse: {e}"));
        }
        assert_eq!(
            catalog().len(),
            TEMPLATE_FILES.len(),
            "catalog() dropped a template file"
        );
    }

    /// Autoresearch is published in both the built-in catalog and the portable
    /// marketplace. They are one workflow contract, not two independently edited
    /// examples. Comparing parsed JSON keeps formatting irrelevant while making a
    /// stale marketplace loop fail at the source.
    #[test]
    fn marketplace_autoresearch_matches_the_builtin_template() {
        let builtin: serde_json::Value =
            serde_json::from_str(include_str!("templates/autoresearch.json"))
                .expect("built-in autoresearch parses");
        let marketplace: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../generated/ryu-runtime/marketplace-store/workflows/autoresearch/workflow.json"
        ))
        .expect("marketplace autoresearch parses");
        assert_eq!(marketplace, builtin);
    }

    /// The catalog is ordered — the store section renders it in sequence — so the
    /// file order in `TEMPLATE_FILES` is load-bearing, not incidental.
    #[test]
    fn catalog_order_is_the_declared_display_order() {
        let ids: Vec<String> = catalog().into_iter().map(|t| t.meta.id).collect();
        assert_eq!(
            ids,
            vec![
                "autoresearch",
                "prompt-chaining",
                "routing",
                "parallelization",
                "orchestrator-workers",
                "evaluator-optimizer",
                "autonomous-agent",
                "fan-out-synthesize",
                "classify-and-act",
                "adversarial-verification",
                "tournament",
                "generate-and-filter",
            ]
        );
    }

    /// Each template's data file is named after its own `meta.id`, so `find()`
    /// (which keys off `meta.id`) and the `include_str!` list cannot drift apart.
    #[test]
    fn template_file_names_match_their_meta_ids() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/workflow/templates");
        for t in catalog() {
            let path = dir.join(format!("{}.json", t.meta.id));
            assert!(path.exists(), "no data file at {}", path.display());
            assert!(
                find(&t.meta.id).is_some(),
                "find() cannot resolve '{}'",
                t.meta.id
            );
        }
    }

    #[test]
    fn catalog_has_twelve_templates_with_unique_ids() {
        let all = catalog();
        assert_eq!(all.len(), 12);
        let mut ids: Vec<String> = all.iter().map(|t| t.meta.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 12, "template ids must be unique");
    }

    #[test]
    fn every_primary_and_body_is_a_valid_dag() {
        for t in catalog() {
            WorkflowGraph::build(&t.primary)
                .unwrap_or_else(|e| panic!("template '{}' primary invalid: {e}", t.meta.id));
            for (ph, body) in &t.bodies {
                WorkflowGraph::build(body).unwrap_or_else(|e| {
                    panic!("template '{}' body '{ph}' invalid: {e}", t.meta.id)
                });
            }
        }
    }

    #[test]
    fn node_count_matches_primary() {
        for t in catalog() {
            assert_eq!(
                t.meta.node_count,
                t.primary.nodes.len(),
                "template '{}' node_count mismatch",
                t.meta.id
            );
        }
    }

    #[test]
    fn every_category_and_pattern_is_known() {
        let cats = ["research", "orchestration", "quality", "automation"];
        for t in catalog() {
            assert!(
                cats.contains(&t.meta.category.as_str()),
                "bad category {}",
                t.meta.category
            );
            assert!(!t.meta.pattern.is_empty());
        }
    }

    #[test]
    fn while_nodes_reference_a_declared_body_placeholder() {
        for t in catalog() {
            let placeholders: Vec<&str> = t.bodies.iter().map(|(p, _)| p.as_str()).collect();
            for n in &t.primary.nodes {
                if let NodeKind::While {
                    body_workflow_id: Some(bid),
                    ..
                } = &n.kind
                {
                    assert!(
                        placeholders.contains(&bid.as_str()),
                        "template '{}' while node references undeclared body '{bid}'",
                        t.meta.id
                    );
                }
            }
        }
    }

    #[test]
    fn patch_bodies_rewrites_while_and_subworkflow_ids() {
        let mut map = HashMap::new();
        map.insert("ph".to_owned(), "wf_minted".to_owned());
        // Built the same way a template file is: JSON in, `Workflow` out.
        let mut w: Workflow = serde_json::from_str(
            r#"{
                "id": "x",
                "name": "x",
                "description": "",
                "nodes": [
                    { "id": "l", "type": "while", "expr": "nonempty",
                      "body_workflow_id": "ph", "max_iterations": 3 },
                    { "id": "s", "type": "sub_workflow", "workflow_id": "ph" }
                ],
                "edges": []
            }"#,
        )
        .expect("fixture workflow parses");
        patch_bodies(&mut w, &map);
        match &w.nodes[0].kind {
            NodeKind::While {
                body_workflow_id: Some(b),
                ..
            } => assert_eq!(b, "wf_minted"),
            _ => panic!("expected while"),
        }
        match &w.nodes[1].kind {
            NodeKind::SubWorkflow { workflow_id } => assert_eq!(workflow_id, "wf_minted"),
            _ => panic!("expected sub_workflow"),
        }
    }
}
