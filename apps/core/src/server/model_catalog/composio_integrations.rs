//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `integrations_list` through `ComposioConnectBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/integrations?q=&cursor=&limit=` — the merged Integrations Store
/// directory (integrations.sh + the user's Composio toolkits + Ryu's and
/// Treg's tool catalog platforms),
/// deduped by brand slug, sorted by popularity then name, offset-cursor paginated.
#[utoipa::path(
    get,
    path = "/api/integrations",
    tag = "Composio",
    summary = "Browse the merged Integrations directory (directory + Composio + Treg)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn integrations_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut merged = build_merged_integrations(&state).await;

    let needle = params
        .get("q")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !needle.is_empty() {
        merged.retain(|brand| {
            brand.name.to_ascii_lowercase().contains(&needle)
                || brand.id.contains(&needle)
                || brand
                    .categories
                    .iter()
                    .any(|c| c.to_ascii_lowercase().contains(&needle))
                || brand
                    .domain
                    .as_deref()
                    .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
        });
    }

    // Stable sort by popularity desc then name asc so pagination is deterministic.
    merged.sort_by(|a, b| {
        b.popularity
            .unwrap_or(0)
            .cmp(&a.popularity.unwrap_or(0))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });

    let total = merged.len();
    let offset = params
        .get("cursor")
        .and_then(|c| c.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(60);
    let next_cursor = (offset + limit < total).then(|| (offset + limit).to_string());
    let slice: Vec<_> = merged.into_iter().skip(offset).take(limit).collect();

    (
        StatusCode::OK,
        Json(json!({
            "integrations": slice,
            "next_cursor": next_cursor,
            "total": total,
        })),
    )
}

/// `GET /api/integrations/:id` — one merged Integrations brand by slug.
#[utoipa::path(
    get,
    path = "/api/integrations/{id}",
    tag = "Composio",
    summary = "Get one merged Integrations brand by slug",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn integrations_get(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let merged = build_merged_integrations(&state).await;
    match merged.into_iter().find(|brand| brand.id == id) {
        Some(mut brand) => {
            // Expand each catalog lane's platform row into its endpoint rows,
            // then merge Ryu's and Treg's under the precedence switch. A lane
            // that cannot be read keeps its platform row.
            let precedence = crate::treg_catalog::precedence();
            let mut expanded = Vec::new();
            let mut catalog_rows = Vec::new();
            let wanted: Vec<_> = crate::treg_catalog::active_lanes(precedence)
                .into_iter()
                .filter_map(|lane| {
                    let slug = match lane {
                        crate::treg_catalog::CatalogLane::Treg => brand.treg_slug.clone(),
                        crate::treg_catalog::CatalogLane::Ryu => brand.ryu_slug.clone(),
                    };
                    slug.map(|slug| (lane, slug))
                })
                .collect();
            let fetched = futures_util::future::join_all(
                wanted
                    .iter()
                    .map(|(lane, slug)| crate::treg_catalog::platform_options(*lane, slug)),
            )
            .await;
            for ((lane, _), rows) in wanted.iter().zip(fetched) {
                if let Ok(rows) = rows {
                    expanded.push(lane.source());
                    catalog_rows.extend(rows);
                }
            }
            if !expanded.is_empty() {
                let others = std::mem::take(&mut brand.options)
                    .into_iter()
                    .filter(|option| !expanded.contains(&option.source.as_str()))
                    .collect();
                brand.options =
                    crate::treg_catalog::merge_catalog_options(others, catalog_rows, precedence);
            }
            crate::catalog_source::mark_cheapest_options(&mut brand.options);
            let pins = integration_provider_pins(&state).await;
            let pin = pins.get(&brand.id).cloned();
            crate::catalog_source::rank_managed_providers(&mut brand, pin.as_deref());
            (StatusCode::OK, Json(json!(brand)))
        }
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
    }
}

/// `GET /api/composio/actions?toolkit=&q=&limit=` — list a toolkit's actions.
#[utoipa::path(
    get,
    path = "/api/composio/actions",
    tag = "Composio",
    summary = "List Composio actions for a toolkit",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_actions(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::RawQuery(raw_query): axum::extract::RawQuery,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let toolkit = params.get("toolkit").map(String::as_str).unwrap_or("");
    let query = params.get("q").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50);
    let tag_values: Vec<String> =
        url::form_urlencoded::parse(raw_query.as_deref().unwrap_or("").as_bytes())
            .filter_map(|(key, value)| (key == "tags").then(|| value.into_owned()))
            .collect();
    let tags: Vec<&str> = tag_values.iter().map(String::as_str).collect();
    if let Some(result) = ryu_composio::service::actions(
        toolkit,
        query,
        limit,
        &tags,
        caller.as_ref().map(|caller| caller.user_id.as_str()),
    )
    .await
    {
        return match result {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":error.to_string(),"data":[]})),
            ),
        };
    }
    match crate::composio_catalog::list_actions_with_tags(
        &state.client,
        toolkit,
        query,
        limit,
        &tags,
    )
    .await
    {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// `GET /api/composio/triggers?toolkit=` — list a toolkit's trigger types.
#[utoipa::path(
    get,
    path = "/api/composio/triggers",
    tag = "Composio",
    summary = "List Composio trigger types for a toolkit",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_triggers(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let toolkit = params.get("toolkit").map(String::as_str).unwrap_or("");
    if ryu_composio::service::is_configured() {
        if crate::mcp_oauth::owner_for_caller(caller.as_ref()).is_err() {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"verified user required","data":[]})),
            );
        }
        if let Some(result) = ryu_composio::service::trigger_types(
            toolkit,
            caller.as_ref().map(|caller| caller.user_id.as_str()),
        )
        .await
        {
            return match result {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(error) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error":error.to_string(),"data":[]})),
                ),
            };
        }
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Connect unavailable","data":[]})),
        );
    }
    match crate::composio_catalog::list_triggers(&state.client, toolkit).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// `GET /api/composio/connections?toolkit=` — list the user's connected accounts,
/// optionally filtered to one toolkit (for the Connections tab's connected state).
#[utoipa::path(
    get,
    path = "/api/composio/connections",
    tag = "Composio",
    summary = "List the user's Composio connected accounts",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_connections(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let owner = match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": error.to_string(), "data": [] })),
            );
        }
    };
    // No Composio key is the default state, not a failure: report it as an empty,
    // unconfigured list (200) so callers show a "connect an integration" empty
    // state rather than a load error. 502 stays reserved for real upstream faults.
    if !ryu_composio::service::is_configured() && !crate::composio_auth::is_configured() {
        return (
            StatusCode::OK,
            Json(json!({ "data": [], "configured": false })),
        );
    }
    let toolkit = params.get("toolkit").map(String::as_str).unwrap_or("");
    let composio_entity = caller.as_ref().map(|caller| caller.user_id.as_str());
    match crate::composio_connect::list_connections(&state.client, toolkit, composio_entity).await {
        Ok(mut value) => {
            if let Err(error) = decorate_composio_access_levels(&owner, &mut value).await {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": error.to_string(), "data": [] })),
                );
            }
            (StatusCode::OK, Json(value))
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "data": [] })),
        ),
    }
}

/// Body for `POST /api/composio/connections/initiate`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ComposioConnectBody {
    #[serde(default)]
    pub(in crate::server) access_level: crate::identity::ConnectionAccessLevel,
    pub(in crate::server) toolkit: String,
}
