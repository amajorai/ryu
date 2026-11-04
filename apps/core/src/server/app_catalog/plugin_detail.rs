//! App catalog browse, install-from-URL and hot reload: `plugin_catalog_detail` through `local_detail_trust_signals`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/plugins/catalog/detail?id=<entry-id>` — detail for the selected
/// entry from the active Plugin catalog source (integrations.sh descriptors, etc.).
#[utoipa::path(
    get,
    path = "/api/plugins/catalog/detail",
    tag = "Plugins",
    summary = "Plugin catalog entry detail",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    // Mirror the browse route's per-request selectors, so opening a listing's
    // detail resolves against the SAME source the list was browsed from — without
    // flipping the node-global active-source preference. `?origin=community` keeps
    // its dedicated shortcut; `?source=<id>` covers every other view.
    //
    // The unified first-party view is the one case with no single backing source: a
    // listing in it may have come from the git catalog OR the hosted commerce
    // server, so it gets an ordered candidate list rather than one source.
    let candidates: Vec<crate::catalog_source::Source> = if params.get("origin").map(String::as_str)
        == Some(crate::catalog_source::COMMUNITY_ORIGIN)
    {
        community_plugin_source(&state).await.into_iter().collect()
    } else {
        let source_id = resolve_plugin_source_id(&state, &params).await;
        if source_id == PLUGIN_ALL_SOURCES_ID {
            // The all-marketplaces view browses N sources, so a listing opened from
            // it may belong to any of them — and the client sends back the view's
            // id, not the row's. Resolving `all` to a single source would therefore
            // hand every card in the DEFAULT view an empty preview; it resolves to
            // the same ordered candidate list the browse used instead, and the walk
            // below returns the first source that can answer for this id.
            let mut list = Vec::new();
            for meta in all_plugin_view_sources(&state) {
                if is_merged_plugin_view(&meta.id) {
                    for id in PLUGIN_MERGED_SOURCE_IDS {
                        if let Some(source) = plugin_source_by_id(&state, id).await {
                            list.push(source);
                        }
                    }
                } else if let Some(source) = plugin_source_by_id(&state, &meta.id).await {
                    list.push(source);
                }
            }
            list
        } else if is_merged_plugin_view(&source_id) {
            let mut list = Vec::new();
            // Hosted bridge first: it is authoritative for GitHub-backed listings,
            // offers, publisher metadata, and signed downloads. The legacy index follows
            // only as a read-only compatibility source.
            for id in PLUGIN_MERGED_SOURCE_IDS {
                if let Some(source) = plugin_source_by_id(&state, id).await {
                    list.push(source);
                }
            }
            list
        } else {
            plugin_source_by_id(&state, &source_id)
                .await
                .into_iter()
                .collect()
        }
    };
    // A locally loaded plugin (built-in or installed) answers from its own
    // manifest — no source round-trip, and no dependence on whether the active
    // remote source happens to carry it. This is what gives a first-party app the
    // same README / API-reference / dependency tabs a community listing gets.
    if let Some(mut local) = local_plugin_detail(id) {
        // A plugin installed from the Ryu Marketplace answers from its manifest, so
        // its Versions tab would offer every GitHub release. Carry the
        // Marketplace's approval list so only installable versions offer install.
        if let Some(approved) = marketplace_approved_versions(&state, id).await {
            if let Some(obj) = local.as_object_mut() {
                obj.insert("approvedVersions".to_owned(), approved);
            }
        }
        return (
            StatusCode::OK,
            Json(enrich_plugin_detail(&state, local).await),
        );
    }

    if candidates.is_empty() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "no active plugin catalog source" })),
        );
    }
    // Walk the candidates, keeping the FIRST error to report if none can answer:
    // "not found in the git catalog" names the primary source the user was
    // browsing, which is the more useful message than the last fallback's.
    let mut first_error: Option<String> = None;
    for source in candidates {
        match source.detail(&state.client, id).await {
            Ok(value) => {
                return (
                    StatusCode::OK,
                    Json(enrich_plugin_detail(&state, value).await),
                );
            }
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e.to_string());
                }
            }
        }
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(
            json!({ "error": first_error.unwrap_or_else(|| "plugin detail unavailable".to_string()) }),
        ),
    )
}

/// The detail keys a listing needs before the store's README / Versions / Health
/// tabs can render. A payload missing all of them collapses to a single Overview
/// tab — which is exactly what the first-party catalogs used to produce.
pub(in crate::server) const PLUGIN_DETAIL_ENRICHABLE_KEYS: [&str; 2] = ["readme", "versions"];

/// Keys the repo enrichment may contribute. Restricted deliberately: enrichment is
/// a display supplement, so it must never be able to overwrite identity, trust, or
/// install-relevant fields (`id`, `origin`, `reviewed`, `license`, `url`, …) that
/// the manifest or the source already decided.
pub(in crate::server) const PLUGIN_ENRICHMENT_KEYS: [&str; 8] = [
    "readme",
    "readmeUrl",
    "versions",
    "downloads",
    "stars",
    "openIssues",
    "createdAt",
    "pushedAt",
];

/// Fill a plugin detail payload's missing README / version history from its GitHub
/// repository, so a first-party listing gets the same tab set as a Community one.
///
/// Three properties make this safe to run on every detail open:
/// - **Opt-out by presence.** A payload that already carries a README or version
///   list is returned untouched, so a source that knows better always wins.
/// - **Additive only.** Only [`PLUGIN_ENRICHMENT_KEYS`] are copied, and only into
///   absent/null slots — enrichment can add a tab, never rewrite a claim.
/// - **Best-effort.** A rate-limited or offline GitHub yields fewer tabs, not an
///   error (see [`crate::catalog_source::enrich_github_repo`], which also caches).
pub(in crate::server) async fn enrich_plugin_detail(
    state: &ServerState,
    detail: serde_json::Value,
) -> serde_json::Value {
    mark_unapproved_versions(enrich_plugin_detail_from_repo(state, detail).await)
}

/// How long a detail open waits for the Marketplace's approval list before it
/// renders without one (an offline node must not stall the panel).
pub(in crate::server) const MARKETPLACE_APPROVED_VERSIONS_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(3);

/// For a plugin installed from the Ryu Marketplace, the versions the Marketplace
/// will serve for it (`approvedVersions`). `None` for any other install, when the
/// Marketplace cannot be reached in time, or when it does not report the list.
pub(in crate::server) async fn marketplace_approved_versions(
    state: &ServerState,
    id: &str,
) -> Option<serde_json::Value> {
    use crate::catalog_source::CatalogSource as _;
    let record = state.app_store.get_record(id).await.ok().flatten()?;
    let from_marketplace = record
        .provenance
        .as_ref()
        .and_then(|provenance| provenance.source_id.as_deref())
        == Some(crate::plugins::isolation::OFFICIAL_MARKETPLACE_SOURCE_ID);
    if !from_marketplace {
        return None;
    }
    let source = crate::catalog_source::RyuMarketplaceSource::builtin(
        crate::catalog_source::CatalogKind::Plugin,
    );
    let detail = tokio::time::timeout(
        MARKETPLACE_APPROVED_VERSIONS_TIMEOUT,
        source.detail(&state.client, id),
    )
    .await
    .ok()?
    .ok()?;
    detail
        .get("approvedVersions")
        .filter(|value| value.is_array())
        .cloned()
}

/// The Marketplace names the exact versions it will serve (`approvedVersions`): the
/// current builds plus every release its review approved. A Versions-tab row outside
/// that list (a tag that was never submitted, a rejected or still-pending release)
/// cannot be installed, so it is marked `installable: false` and the store offers
/// no install for it. A detail without the list — another source, or an older
/// control plane — is left exactly as it was.
pub(in crate::server) fn mark_unapproved_versions(
    mut detail: serde_json::Value,
) -> serde_json::Value {
    fn bare(version: &str) -> String {
        let trimmed = version.trim();
        trimmed
            .strip_prefix(['v', 'V'])
            .unwrap_or(trimmed)
            .to_owned()
    }
    let Some(obj) = detail.as_object_mut() else {
        return detail;
    };
    let Some(approved) = obj.get("approvedVersions").and_then(|v| v.as_array()) else {
        return detail;
    };
    let approved: std::collections::HashSet<String> = approved
        .iter()
        .filter_map(|v| v.as_str())
        .map(bare)
        .collect();
    if let Some(rows) = obj.get_mut("versions").and_then(|v| v.as_array_mut()) {
        for row in rows.iter_mut().filter_map(|row| row.as_object_mut()) {
            let reviewed = row
                .get("version")
                .and_then(|v| v.as_str())
                .is_some_and(|version| approved.contains(&bare(version)));
            if !reviewed {
                row.insert("installable".to_owned(), serde_json::Value::Bool(false));
            }
        }
    }
    detail
}

pub(in crate::server) async fn enrich_plugin_detail_from_repo(
    state: &ServerState,
    mut detail: serde_json::Value,
) -> serde_json::Value {
    let Some(obj) = detail.as_object() else {
        return detail;
    };
    let already_rich = PLUGIN_DETAIL_ENRICHABLE_KEYS
        .iter()
        .any(|k| obj.get(*k).is_some_and(|v| !v.is_null()));
    if already_rich {
        return detail;
    }
    // The repo to enrich from, in descending order of authority: an explicit
    // repository/repo url, the homepage/website, then the install source (a git
    // marketplace's `url` is the repo path the plugin was read from).
    let reference = ["repositoryUrl", "repo_url", "website", "url"]
        .iter()
        .filter_map(|k| obj.get(*k).and_then(|v| v.as_str()))
        .find(|s| crate::catalog_source::split_github_repo(s).is_some())
        .map(str::to_string);
    let Some(reference) = reference else {
        return detail;
    };
    let cache_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(reference.as_str())
        .to_string();
    let token = state
        .preferences
        .get(crate::catalog_source::GITHUB_TOKEN_PREF)
        .await
        .ok()
        .flatten();
    let enrichment =
        crate::catalog_source::enrich_github_repo(&cache_id, &reference, token.as_deref()).await;
    let Some(fields) = enrichment.as_object() else {
        return detail;
    };
    if let Some(target) = detail.as_object_mut() {
        for key in PLUGIN_ENRICHMENT_KEYS {
            let Some(value) = fields.get(key).filter(|v| !v.is_null()) else {
                continue;
            };
            let absent = target.get(key).is_none_or(serde_json::Value::is_null);
            if absent {
                target.insert(key.to_owned(), value.clone());
            }
        }
    }
    detail
}

/// README file names tried inside an installed plugin's directory, in order.
pub(in crate::server) const PLUGIN_README_NAMES: [&str; 4] =
    ["README.md", "readme.md", "README.markdown", "README"];

/// Cap on a README read off disk. Matches the community-listing cap so both paths
/// hand the renderer the same worst case.
pub(in crate::server) const MAX_PLUGIN_README_BYTES: usize = 256 * 1024;

/// Read an installed plugin's README from its plugin directory. Built-ins have no
/// directory, so this is simply absent for them — not an error.
pub(in crate::server) fn local_plugin_readme(id: &str) -> Option<String> {
    let dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(id));
    for name in PLUGIN_README_NAMES {
        let Ok(text) = std::fs::read_to_string(dir.join(name)) else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() <= MAX_PLUGIN_README_BYTES {
            return Some(trimmed.to_string());
        }
        let mut end = MAX_PLUGIN_README_BYTES;
        while end > 0 && !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        return Some(format!("{}\n\n…", &trimmed[..end]));
    }
    None
}

/// Detail payload for a locally loaded plugin, assembled from its manifest alone.
///
/// Returns `None` when no loaded manifest claims `id`, so the caller falls through
/// to the remote catalog source. The payload follows the same camelCase detail
/// contract remote sources emit (see `PluginCatalogDetail` in `@ryu/marketplace`),
/// so one renderer serves both.
/// The `(source, origin, reviewed)` trust signals for a locally loaded manifest,
/// decided purely by whether its bytes ship inside the binary.
///
/// Pure so both branches are unit-testable: exercising the disk branch through
/// [`local_plugin_detail`] itself would mean pointing the process-global
/// `RYU_PLUGINS_DIR` at a fixture, which races every other test that loads a
/// manifest.
pub(in crate::server) fn local_detail_trust_signals(
    compiled_in: bool,
) -> (&'static str, &'static str, bool) {
    if compiled_in {
        ("built-in", "first_party", true)
    } else {
        ("installed", "community", false)
    }
}
