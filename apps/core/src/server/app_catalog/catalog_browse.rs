//! App catalog browse, install-from-URL and hot reload: `plugin_catalog_browse` through `plugin_catalog_channels`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/plugins/catalog/browse?query=&limit=&cursor=` — browse the active
/// Plugin catalog source. When the active source is `ryu-marketplace`, returns
/// the merged built-in + marketplace + legacy list (client-side filter on
/// `query`). For federated sources (e.g. integrations.sh), searches the source
/// with server-side pagination.
#[utoipa::path(
    get,
    path = "/api/plugins/catalog/browse",
    tag = "Plugins",
    summary = "Browse the active plugin catalog source",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_catalog_browse(
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

    // `?origin=community` browses the GitHub-topic feed WITHOUT changing the
    // active-source preference, so the Community store section coexists with
    // Apps/Plugins instead of replacing them. Unreviewed listings are reachable
    // only through this explicit opt-in — never in the default merged view.
    if params.get("origin").map(String::as_str) == Some(crate::catalog_source::COMMUNITY_ORIGIN) {
        let q = crate::catalog_source::CatalogQuery {
            query: query.to_string(),
            limit,
            cursor: cursor.map(str::to_string),
            ..Default::default()
        };
        let Some(source) = community_plugin_source(&state).await else {
            return (
                StatusCode::OK,
                Json(json!({ "entries": [], "next_cursor": serde_json::Value::Null })),
            );
        };
        // The source never errors on search (it degrades to empty-with-note or a
        // stale cache), so a rate-limited or offline GitHub renders an explained
        // empty section rather than a failed page.
        return match source.search(&state.client, &q).await {
            Ok(val) => {
                let entries: Vec<serde_json::Value> = val
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|it| plugin_marketplace_item_to_entry(it, source.id()))
                            .collect()
                    })
                    .unwrap_or_default();
                (
                    StatusCode::OK,
                    Json(json!({
                        "entries": entries,
                        "next_cursor": val.get("next_cursor").cloned().unwrap_or(serde_json::Value::Null),
                        "note": val.get("note").cloned().unwrap_or(serde_json::Value::Null),
                    })),
                )
            }
            Err(e) => (
                StatusCode::OK,
                Json(
                    json!({ "entries": [], "next_cursor": serde_json::Value::Null, "note": e.to_string() }),
                ),
            ),
        };
    }

    let active_id = resolve_plugin_source_id(&state, &params).await;

    // Every marketplace at once — the store's default view.
    if active_id == PLUGIN_ALL_SOURCES_ID {
        return (
            StatusCode::OK,
            Json(json!({
                "entries": all_plugin_catalog_entries(&state, query, limit).await,
                // No cursor: the page is a concatenation of N independently
                // paginated feeds, and one opaque cursor cannot address a position
                // in all of them. Each source contributes at most `limit` rows and
                // the client renders them under a heading per marketplace — see
                // `all_plugin_catalog_entries`.
                "next_cursor": serde_json::Value::Null,
            })),
        );
    }

    // The unified first-party view: the merged offline-safe catalog. Reached by
    // EITHER first-party id (see `PLUGIN_MERGED_SOURCE_IDS`) so the hosted bridge
    // and its read-only compatibility fallback render as one marketplace instead
    // of whichever source preference happened to name.
    if is_merged_plugin_view(&active_id) {
        let needle = query.trim().to_ascii_lowercase();
        let entries: Vec<serde_json::Value> = merged_plugin_catalog_entries(&state)
            .await
            .into_iter()
            .filter(|e| plugin_entry_matches_query(e, &needle))
            .collect();
        return (
            StatusCode::OK,
            Json(json!({
                "entries": entries,
                "next_cursor": serde_json::Value::Null
            })),
        );
    }

    let mut q = crate::catalog_source::CatalogQuery {
        query: query.to_string(),
        limit,
        cursor: cursor.map(str::to_string),
        ..Default::default()
    };
    q.extra.clear();

    match plugin_source_by_id(&state, &active_id).await {
        Some(source) => match source.search(&state.client, &q).await {
            Ok(val) => {
                let entries: Vec<serde_json::Value> = val
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|it| plugin_marketplace_item_to_entry(it, source.id()))
                            .collect()
                    })
                    .unwrap_or_default();
                (
                    StatusCode::OK,
                    Json(json!({
                    "entries": entries,
                        "next_cursor": val.get("next_cursor").cloned().unwrap_or(serde_json::Value::Null),
                        "note": val.get("note").cloned().unwrap_or(serde_json::Value::Null),
                    })),
                )
            }
            Err(e) => (
                catalog_search_error_status(&e),
                Json(json!({ "error": e.to_string(), "entries": [] })),
            ),
        },
        None => (
            StatusCode::OK,
            Json(json!({ "entries": [], "next_cursor": serde_json::Value::Null })),
        ),
    }
}

/// `GET /api/plugins/catalog/version-detail?repo=<owner/repo>&tag=<tag>` — the
/// listing as it stood at ONE published version.
///
/// Reads the repo at that tag, so the README and the declared
/// licence/description/engines/surfaces/permissions are genuinely historical. It
/// deliberately does NOT include repository health — stars, open issues, archived,
/// last-updated are current-state facts GitHub reports as of now and cannot be
/// reconstructed for a past tag. Returning them next to historical fields would
/// produce a card that looks like "the state at that version" while half of it
/// silently describes today.
///
/// 404 when the tag has no readable manifest, which is normal for tags predating
/// the listing being packaged — a client should render "not available for this
/// version", not an error.
#[utoipa::path(
    get,
    path = "/api/plugins/catalog/version-detail",
    tag = "Plugins",
    summary = "Listing detail at one published version",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_catalog_version_detail(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(repo) = params.get("repo").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `repo` query parameter" })),
        );
    };
    // `?channel=` resolves the tag instead of naming it — the per-listing
    // equivalent of Core's own channel selection. Same rule: read the channel off
    // each tag, take the semver maximum within it, and NEVER fall back to another
    // channel, so asking for `beta` on a listing with no betas answers "nothing
    // published yet" rather than quietly handing back stable.
    let resolved_tag: Option<String> = match params.get("channel").filter(|s| !s.is_empty()) {
        Some(channel) => {
            let channels = crate::catalog_source::github_listing_channels(repo, None).await;
            match channels.iter().find(|(name, _)| name == channel) {
                Some((_, tag)) => Some(tag.clone()),
                None => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": "no build published on that channel",
                            "channels": channels.iter().map(|(c, _)| c).collect::<Vec<_>>(),
                        })),
                    );
                }
            }
        }
        None => None,
    };
    let Some(tag) = resolved_tag
        .as_deref()
        .or_else(|| params.get("tag").map(String::as_str))
        .filter(|s| !s.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `tag` or `channel` query parameter" })),
        );
    };
    match crate::catalog_source::github_version_detail(repo, tag).await {
        Some(detail) => (StatusCode::OK, Json(detail)),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no readable manifest at that tag" })),
        ),
    }
}

/// `GET /api/plugins/catalog/channels?repo=<owner/repo>` / `?id=<listing-id>` — the
/// release channels a listing publishes, each with the version that channel
/// currently resolves to.
///
/// Drives a per-listing channel picker. Only channels with an actual build are
/// returned, so nobody selects one and is then told there is nothing there.
///
/// Two lookups, because a listing is published one of two ways:
///
///   - `repo=` reads the repository's own releases and derives each channel from
///     the tag ([`crate::update::channel_of`]) — the community path, where the git
///     tags ARE the publication.
///   - `id=` asks the marketplace control plane, which keys a listing by
///     `(kind, id, channel)` and knows the trains it holds.
///
/// `installable` distinguishes them, and it matters: a repo-derived channel is a
/// browsing fact (it describes what the author tagged), while only a marketplace
/// channel can be handed to `POST /api/plugins/catalog/install`. Presenting them
/// identically would produce a picker whose selection silently does nothing.
///
/// An EMPTY list means "no channels known" — including the case where the upstream
/// read failed — and never "stable is the only option". A client renders no picker
/// rather than a picker with one entry it invented.
#[utoipa::path(
    get,
    path = "/api/plugins/catalog/channels",
    tag = "Plugins",
    summary = "Release channels a listing publishes",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_catalog_channels(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let repo = params.get("repo").filter(|s| !s.is_empty());
    let listing_id = params.get("id").filter(|s| !s.is_empty());
    if repo.is_none() && listing_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `repo` or `id` query parameter" })),
        );
    }

    // Marketplace-published channels first: they are the installable ones, so when a
    // listing is on the marketplace AND names a repo, the marketplace answer is the
    // one a picker must drive installs from.
    if let Some(id) = listing_id {
        let source = crate::catalog_source::RyuMarketplaceSource::builtin(
            crate::catalog_source::CatalogKind::Plugin,
        );
        let channels = source.fetch_channels(&state.client, id).await;
        if !channels.is_empty() {
            return (
                StatusCode::OK,
                Json(json!({
                    "channels": channels
                        .into_iter()
                        .map(|(channel, version)| json!({
                            "channel": channel,
                            "version": version,
                            "installable": true,
                        }))
                        .collect::<Vec<_>>(),
                })),
            );
        }
    }

    let Some(repo) = repo else {
        return (StatusCode::OK, Json(json!({ "channels": [] })));
    };
    let channels = crate::catalog_source::github_listing_channels(repo, None).await;
    (
        StatusCode::OK,
        Json(json!({
            "channels": channels
                .into_iter()
                .map(|(channel, tag)| json!({
                    "channel": channel,
                    "tag": tag,
                    "version": tag,
                    "installable": false,
                }))
                .collect::<Vec<_>>(),
        })),
    )
}
