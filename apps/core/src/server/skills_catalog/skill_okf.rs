//! The knowledge catalog, the skills catalog and skill packs: `okf_export` through `all_skill_catalog_cards`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/okf/export { target_dir, scope?, bundle_id? }` — emit Ryu's own
/// indexed knowledge as an OKF bundle on disk.
///
/// The concrete path is scope `"bundle"`: reconstruct the concepts previously
/// ingested under `bundle_id` from the retrieval index (via
/// [`RetrievalStore::reconstruct_okf_concepts`]), map each to an [`crate::okf::Concept`],
/// generate `index.md` + `log.md`, and write the bundle to `target_dir`. Broader
/// memory export is a follow-up.
#[utoipa::path(
    post,
    path = "/api/okf/export",
    tag = "Knowledge",
    summary = "Export indexed knowledge as an OKF bundle directory",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn okf_export(
    State(state): State<ServerState>,
    Json(body): Json<OkfExportBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let target_dir = body.target_dir.trim().to_string();
    if target_dir.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`target_dir` is required" })),
        );
    }

    let scope = body.scope.as_deref().map(str::trim).unwrap_or("bundle");
    if scope != "bundle" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": format!("unsupported scope '{scope}'; only 'bundle' is implemented (broader memory export is a follow-up)"),
            })),
        );
    }

    let Some(bundle_id) = body
        .bundle_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "success": false, "error": "`bundle_id` is required for scope 'bundle'" }),
            ),
        );
    };

    let concepts = match state.retrieval.reconstruct_okf_concepts(bundle_id).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };
    if concepts.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "success": false,
                "error": format!("no indexed knowledge found for bundle '{bundle_id}'"),
            })),
        );
    }

    let bundle = build_okf_export_bundle(bundle_id, concepts);
    let files: Vec<String> = bundle
        .concepts
        .iter()
        .map(|c| c.file_path.clone())
        .collect();
    let concept_count = bundle.concepts.len();

    let dir = std::path::PathBuf::from(&target_dir);
    let write = {
        let bundle = bundle.clone();
        tokio::task::spawn_blocking(move || bundle.write(&dir)).await
    };
    match write {
        Ok(Ok(())) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "target_dir": target_dir,
                "bundle_id": bundle_id,
                "concepts": concept_count,
                "files": files,
                "index": crate::okf::RESERVED_INDEX,
                "log": crate::okf::RESERVED_LOG,
            })),
        ),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": format!("export task panicked: {e}") })),
        ),
    }
}

// ── Skills catalog (browse + install from every registered source) ──────────
//
// The desktop/mobile/extension are pure GUI layers over these endpoints. The
// source adapters live behind `catalog_source`; the route also exposes an
// Hermes-style live "all marketplaces" view that fans out to each registered
// source and stamps every card with its originating marketplace.

/// The per-request selector that means "build one catalog from every Skill
/// source". It is a view, not a persisted source, so it never appears in
/// `/api/catalog/sources` and cannot become the node-global active preference.
pub(in crate::server) const SKILL_ALL_SOURCES_ID: &str = "all";

/// A wedged marketplace must not hold the whole Skills page hostage. The all
/// view is best-effort: a source that fails or times out contributes no cards,
/// while the other registries still render.
pub(in crate::server) const SKILL_ALL_SOURCE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(8);

/// Resolve which Skill catalog source a request addresses.
///
/// An explicit, registered `?source=` wins over the node-global preference;
/// `?source=all` addresses the live federated view. Unknown/stale ids degrade
/// to the persisted active source for compatibility with older clients.
pub(in crate::server) async fn resolve_skill_source_id(
    state: &ServerState,
    requested: Option<&str>,
) -> String {
    if let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) {
        if id == SKILL_ALL_SOURCES_ID
            || state
                .catalog_sources
                .source_by_id(crate::catalog_source::CatalogKind::Skill, id)
                .is_some()
        {
            return id.to_string();
        }
    }
    state
        .catalog_sources
        .active_id(
            crate::catalog_source::CatalogKind::Skill,
            &state.preferences,
        )
        .await
        .unwrap_or_else(|| "skills-sh".to_string())
}

/// The sources visited by the live all-marketplaces view, in picker order.
pub(in crate::server) fn all_skill_view_sources(
    state: &ServerState,
) -> Vec<crate::catalog_source::SourceMeta> {
    state
        .catalog_sources
        .sources_for(crate::catalog_source::CatalogKind::Skill)
}

/// Does a normalized Skill card match the query? Source adapters are allowed to
/// filter upstream, but this second check keeps the merged view honest for bulk
/// indexes and custom marketplaces that return an unfiltered page.
pub(in crate::server) fn skill_card_matches_query(card: &serde_json::Value, needle: &str) -> bool {
    let needle = needle.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return true;
    }
    ["id", "name", "slug", "source", "description"]
        .into_iter()
        .filter_map(|key| card.get(key).and_then(serde_json::Value::as_str))
        .any(|value| value.to_ascii_lowercase().contains(&needle))
}

/// Pull the `skills` array from one source's normalized response.
pub(in crate::server) fn skill_cards_from_value(
    value: serde_json::Value,
) -> Vec<serde_json::Value> {
    value
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Ryu Marketplace's cross-kind detail endpoint returns its native commerce
/// envelope, while the Skills UI consumes the shared `{ card, readme, files }`
/// detail contract. Normalize that one source here so a Ryu skill behaves like
/// every other registry without teaching the desktop about commerce payloads.
pub(in crate::server) fn normalize_skill_detail(
    source: &crate::catalog_source::Source,
    id: &str,
    value: serde_json::Value,
) -> serde_json::Value {
    if !matches!(source, crate::catalog_source::Source::RyuMarketplace(_)) {
        return value;
    }
    let name = value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| id.rsplit('/').next().unwrap_or(id));
    let description = value
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let url = value
        .get("installSource")
        .or_else(|| value.get("install_source"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(id)
        .to_string();
    json!({
        "card": {
            "id": id,
            "source": source.display_name(),
            "slug": id.rsplit('/').next().unwrap_or(id),
            "name": name,
            "description": description,
            "installs": 0,
            "downloads": 0,
            "installed": false,
            "trust_level": "builtin",
        },
        "description": description,
        "readme": description,
        "metadata": {
            "installs": null,
            "github_stars": null,
            "first_seen": null,
            "github_created_at": null,
            "github_updated_at": null,
            "github_pushed_at": null,
            "security_audits": [],
            "repository_url": null,
        },
        "files": [],
        "url": url,
    })
}

/// Build a live, de-duplicated catalog from every registered Skill source.
///
/// This is intentionally a runtime builder rather than a generated checked-in
/// index: each adapter already owns its upstream shape, detail URL, trust label,
/// and install semantics. The fan-out mirrors Hermes' `build_skills_index.py`,
/// but keeps the result fresh and lets custom marketplaces participate without a
/// Ryu release. The response is bounded per source and a failed source is
/// skipped rather than blanking the whole store.
pub(in crate::server) async fn all_skill_catalog_cards(
    state: &ServerState,
    query: &str,
    limit: usize,
    installed_only: bool,
) -> Vec<serde_json::Value> {
    let source_pairs: Vec<_> = all_skill_view_sources(state)
        .into_iter()
        .filter_map(|meta| {
            state
                .catalog_sources
                .source_by_id(crate::catalog_source::CatalogKind::Skill, &meta.id)
                .map(|source| (meta, source))
        })
        .collect();
    let needle = query.trim().to_ascii_lowercase();
    let futures = source_pairs.into_iter().map(|(meta, source)| {
        let request = crate::catalog_source::CatalogQuery {
            query: query.to_string(),
            limit,
            extra: {
                let mut extra = serde_json::Map::new();
                extra.insert(
                    "installed_only".to_string(),
                    serde_json::Value::String(installed_only.to_string()),
                );
                extra
            },
            ..Default::default()
        };
        async move {
            let result = tokio::time::timeout(
                SKILL_ALL_SOURCE_TIMEOUT,
                source.search(&state.client, &request),
            )
            .await;
            (meta, result)
        }
    });
    let results = futures_util::future::join_all(futures).await;

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (meta, result) in results {
        let value = match result {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                tracing::warn!(
                    source = %meta.id,
                    error = %error,
                    "skill source failed in the all-marketplaces view; skipping it"
                );
                continue;
            }
            Err(_) => {
                tracing::warn!(
                    source = %meta.id,
                    timeout_secs = SKILL_ALL_SOURCE_TIMEOUT.as_secs(),
                    "skill source timed out in the all-marketplaces view; skipping it"
                );
                continue;
            }
        };
        for mut card in skill_cards_from_value(value) {
            if !skill_card_matches_query(&card, &needle)
                || (installed_only
                    && card.get("installed").and_then(serde_json::Value::as_bool) != Some(true))
            {
                continue;
            }
            let Some(id) = card
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            if let Some(object) = card.as_object_mut() {
                object.insert("catalog_source_id".to_string(), json!(meta.id));
                object.insert("catalog_source_name".to_string(), json!(meta.display_name));
            }
            out.push(card);
        }
    }
    out
}
