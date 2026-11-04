//! Knowledge catalog (browse + install OKF bundles).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Knowledge catalog (browse + install OKF bundles) ─────────────────────────
//
// Source-aware like the model/skill/mcp catalogs: the active Knowledge source
// (the Ryu Marketplace federated source by default, or a custom OKF git bundle)
// owns search/detail. Install is the privileged path: clone/parse the bundle via
// the `okf` module, then index it through the retrieval layer
// (`ingest_okf_bundle`). The seam returns descriptors only; the download/ingest
// happens here in Core.

/// The active Knowledge catalog [`Source`] (defaults to the built-in primary).
pub(in crate::server) async fn active_knowledge_source(
    state: &ServerState,
) -> Option<crate::catalog_source::Source> {
    state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Knowledge,
            &state.preferences,
        )
        .await
}

/// Load an OKF bundle from a descriptor's `source_url`: a local directory via
/// [`crate::okf::Bundle::from_dir`] (off-thread, sync), else a git clone via
/// [`crate::okf::Bundle::from_git`]. Mirrors `OkfBundleSource::load_bundle` for
/// the install path, which works off the resolved descriptor rather than the
/// source struct (a marketplace source carries the same `{ source_url, ref? }`).
pub(in crate::server) async fn load_okf_bundle(
    source_url: &str,
    git_ref: Option<&str>,
) -> anyhow::Result<crate::okf::Bundle> {
    let url = source_url.trim().to_string();
    let path = std::path::Path::new(&url);
    if path.is_dir() {
        let p = path.to_path_buf();
        tokio::task::spawn_blocking(move || crate::okf::Bundle::from_dir(p))
            .await
            .map_err(|e| anyhow::anyhow!("loading OKF bundle task panicked: {e}"))?
    } else {
        crate::okf::Bundle::from_git(&url, git_ref).await
    }
}

/// `GET /api/knowledge/catalog?query=&limit=&cursor=` — browse the active
/// Knowledge source's concepts. Mirrors the model/skill/mcp list handlers.
#[utoipa::path(
    get,
    path = "/api/knowledge/catalog",
    tag = "Knowledge",
    summary = "Browse the knowledge (OKF) catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn knowledge_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let cursor = params
        .get("cursor")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let q = crate::catalog_source::CatalogQuery {
        query: query.to_string(),
        limit,
        cursor: cursor.map(str::to_string),
        ..Default::default()
    };
    match active_knowledge_source(&state).await {
        Some(source) => match source.search(&state.client, &q).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                catalog_search_error_status(&e),
                Json(json!({ "error": e.to_string(), "concepts": [] })),
            ),
        },
        None => (
            StatusCode::OK,
            Json(json!({ "concepts": [], "next_cursor": serde_json::Value::Null })),
        ),
    }
}

/// `GET /api/knowledge/catalog/detail?id=<concept-path>` — one concept's parsed
/// frontmatter + body, so a client can preview it before installing the bundle.
#[utoipa::path(
    get,
    path = "/api/knowledge/catalog/detail",
    tag = "Knowledge",
    summary = "Knowledge concept detail",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn knowledge_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    match active_knowledge_source(&state).await {
        Some(source) => match source.detail(&state.client, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            ),
        },
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "no active knowledge source" })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct KnowledgeCatalogInstallBody {
    /// The bundle/source id to install. Optional for a single-bundle OKF source
    /// (it installs its configured bundle); a marketplace source uses it to pick
    /// the catalog item.
    #[serde(default)]
    pub(in crate::server) id: String,
    /// How concept bodies are cut into chunks (the Spaces chunking strategy
    /// object). Absent keeps the historical OKF splitter.
    #[serde(default)]
    pub(in crate::server) chunking: Option<retrieval::ChunkingStrategy>,
}

/// `POST /api/knowledge/catalog/install { id, chunking? }` — the privileged install path:
/// resolve the active source's descriptor (`{ source_url, ref?, bundle_id }`),
/// clone/parse the OKF bundle via the `okf` module, and index it into the
/// retrieval layer via [`RetrievalStore::ingest_okf_bundle`]. Returns the ingest
/// summary (concepts + chunks). Source returns a descriptor only; Core downloads.
#[utoipa::path(
    post,
    path = "/api/knowledge/catalog/install",
    tag = "Knowledge",
    summary = "Install (clone + ingest) a knowledge bundle from the catalog",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn knowledge_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<KnowledgeCatalogInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }
    let chunking = body.chunking.unwrap_or_default();
    if let Err(e) = chunking.validate() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": format!("invalid chunking: {e}") })),
        );
    }
    let id = body.id.trim().to_string();
    // Forward the caller's bearer to the marketplace install handoff (#491) so a
    // PAID Ryu-Marketplace bundle is denied unless the buyer org holds a license.
    let buyer_token = buyer_bearer_from_headers(&headers);

    let Some(source) = active_knowledge_source(&state).await else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "success": false, "error": "no active knowledge source" })),
        );
    };

    // Resolve the descriptor (never downloads). The raw payload carries the OKF
    // bundle git source the install path needs.
    let descriptor = match crate::catalog_source::with_buyer_token(
        buyer_token,
        source.install_descriptor(&state.client, &id),
    )
    .await
    {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };

    // Extract the bundle source from the descriptor's opaque `raw` payload.
    let raw = &descriptor.raw;
    let source_url = raw
        .get("source_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        // Fall back to the descriptor repo_id (OkfBundleSource sets it to the URL).
        .unwrap_or(descriptor.repo_id.as_str())
        .to_string();
    if source_url.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": "knowledge descriptor has no `source_url` to ingest",
            })),
        );
    }
    let git_ref = raw
        .get("ref")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    // The bundle id the concepts are indexed under (idempotent re-ingest key):
    // the descriptor's `bundle_id` when present, else the source id, else the URL.
    let bundle_id = raw
        .get("bundle_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if descriptor.source_id.trim().is_empty() {
                source_url.clone()
            } else {
                descriptor.source_id.clone()
            }
        });

    // Clone + parse the bundle (the download), then index it.
    let bundle = match load_okf_bundle(&source_url, git_ref.as_deref()).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };
    let warnings = bundle.warnings.clone();
    // Stamp the node's registered org as the explicit shared-visibility owner so
    // `space_tenancy_allows`'s fail-closed default (bound node, unowned chunk =
    // hidden) does not swallow this genuinely node-shared content.
    let node_org = node_org_id();
    match state
        .retrieval
        .ingest_okf_bundle_with_chunking(&bundle_id, &bundle, node_org.as_deref(), &chunking)
        .await
    {
        Ok(summary) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "bundle_id": summary.bundle_id,
                "concepts": summary.concepts,
                "chunks": summary.chunks,
                "warnings": warnings,
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct OkfExportBody {
    /// Filesystem directory the bundle is written to (created if absent).
    pub(in crate::server) target_dir: String,
    /// What to export. Only `"bundle"` (the default) is implemented today;
    /// `"memory"` is reserved for a future broader memory export.
    #[serde(default)]
    pub(in crate::server) scope: Option<String>,
    /// For scope `"bundle"`: the ingested bundle id to re-emit.
    #[serde(default)]
    pub(in crate::server) bundle_id: Option<String>,
}

/// Assemble an exportable [`crate::okf::Bundle`] from reconstructed concepts,
/// generating a progressive-disclosure `index.md` and a dated `log.md`.
pub(in crate::server) fn build_okf_export_bundle(
    bundle_id: &str,
    concepts: Vec<crate::okf::Concept>,
) -> crate::okf::Bundle {
    use crate::okf::{Bundle, IndexDoc, LogDoc, LogEntry, OKF_VERSION};

    // index.md: one bullet per concept, bundle-absolute link + type + description.
    let mut index_body = String::from("# Concepts\n\n");
    for c in &concepts {
        let title = c.title.clone().unwrap_or_else(|| c.file_path.clone());
        let desc = c
            .description
            .as_deref()
            .map(|d| format!(" — {d}"))
            .unwrap_or_default();
        index_body.push_str(&format!(
            "- [{title}](/{path}) `{kind}`{desc}\n",
            path = c.file_path,
            kind = c.type_,
        ));
    }
    let index = IndexDoc {
        okf_version: Some(OKF_VERSION.to_owned()),
        title: Some(format!("{bundle_id} (exported)")),
        description: Some(format!(
            "OKF bundle exported from Ryu Core, reconstructed from the retrieval index for bundle `{bundle_id}`."
        )),
        extra: std::collections::BTreeMap::new(),
        body: index_body,
    };

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let entry = format!(
        "Exported {n} concept(s) from Ryu Core (bundle `{bundle_id}`).",
        n = concepts.len(),
    );
    let log = LogDoc {
        entries: vec![LogEntry {
            date: today.clone(),
            content: entry.clone(),
        }],
        body: format!("# Changelog\n\n## {today}\n\n{entry}\n"),
    };

    Bundle {
        root: std::path::PathBuf::new(),
        concepts,
        index: Some(index),
        log: Some(log),
        okf_version: Some(OKF_VERSION.to_owned()),
        warnings: Vec::new(),
    }
}
