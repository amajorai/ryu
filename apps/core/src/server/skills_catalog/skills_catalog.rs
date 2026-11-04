//! The knowledge catalog, the skills catalog and skill packs: `all_skill_catalog_detail` through `skills_targets`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Resolve detail for a card in the all view when an older client did not send
/// the card's source stamp. New clients send the stamp and take the fast path;
/// this fallback keeps direct API callers and deep links useful.
pub(in crate::server) async fn all_skill_catalog_detail(
    state: &ServerState,
    id: &str,
) -> anyhow::Result<serde_json::Value> {
    for meta in all_skill_view_sources(state) {
        let Some(source) = state
            .catalog_sources
            .source_by_id(crate::catalog_source::CatalogKind::Skill, &meta.id)
        else {
            continue;
        };
        match tokio::time::timeout(SKILL_ALL_SOURCE_TIMEOUT, source.detail(&state.client, id)).await
        {
            Ok(Ok(value)) => return Ok(normalize_skill_detail(&source, id, value)),
            Ok(Err(error)) => {
                tracing::debug!(source = %meta.id, error = %error, "skill detail source did not claim id")
            }
            Err(_) => {
                tracing::debug!(source = %meta.id, "skill detail source timed out")
            }
        }
    }
    Err(anyhow::anyhow!(
        "skill `{id}` was not found in any registered source"
    ))
}

/// `GET /api/skills/catalog?query=&limit=&installed_only=&source=`
///
/// An explicit `source` is request-local. `source=all` builds one merged view
/// from skills.sh, GitHub taps, browse.sh, ClawHub, LobeHub, Ryu Marketplace,
/// and any user-added Claude marketplaces.
#[utoipa::path(
    get,
    path = "/api/skills/catalog",
    tag = "Skills",
    summary = "Browse the federated skills catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let installed_only = params
        .get("installed_only")
        .map(|s| s == "true" || s == "1")
        .unwrap_or(false);
    let source_id = resolve_skill_source_id(&state, params.get("source").map(String::as_str)).await;

    if source_id == SKILL_ALL_SOURCES_ID {
        return (
            StatusCode::OK,
            Json(json!({
                "skills": all_skill_catalog_cards(&state, query, limit, installed_only).await,
            })),
        );
    }

    let Some(source) = state
        .catalog_sources
        .source_by_id(crate::catalog_source::CatalogKind::Skill, &source_id)
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "skill catalog source unavailable", "skills": [] })),
        );
    };
    let mut request = crate::catalog_source::CatalogQuery {
        query: query.to_string(),
        limit,
        cursor: params.get("cursor").filter(|s| !s.is_empty()).cloned(),
        ..Default::default()
    };
    request.extra.insert(
        "installed_only".to_string(),
        serde_json::Value::String(installed_only.to_string()),
    );
    match source.search(&state.client, &request).await {
        Ok(mut value) => {
            if installed_only {
                if let Some(cards) = value
                    .get_mut("skills")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    cards.retain(|card| {
                        card.get("installed").and_then(serde_json::Value::as_bool) == Some(true)
                    });
                }
            }
            (StatusCode::OK, Json(value))
        }
        Err(error) => (
            catalog_search_error_status(&error),
            Json(json!({ "error": error.to_string(), "skills": [] })),
        ),
    }
}

/// `GET /api/skills/catalog/detail?id=owner%2Frepo%2Fslug&source=`
#[utoipa::path(
    get,
    path = "/api/skills/catalog/detail",
    tag = "Skills",
    summary = "Skill detail: SKILL.md + file list",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    let source_id = resolve_skill_source_id(&state, params.get("source").map(String::as_str)).await;
    if source_id == SKILL_ALL_SOURCES_ID {
        return match all_skill_catalog_detail(&state, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": error.to_string() })),
            ),
        };
    }
    let Some(source) = state
        .catalog_sources
        .source_by_id(crate::catalog_source::CatalogKind::Skill, &source_id)
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "skill catalog source unavailable" })),
        );
    };
    match source.detail(&state.client, id).await {
        Ok(value) => (
            StatusCode::OK,
            Json(normalize_skill_detail(&source, id, value)),
        ),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct SkillInstallBody {
    pub(in crate::server) id: String,
    #[serde(default)]
    pub(in crate::server) source: Option<String>,
    #[serde(default)]
    pub(in crate::server) prompt_for_targets: bool,
    pub(in crate::server) target_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(in crate::server) remember_target_ids: bool,
    #[serde(default)]
    pub(in crate::server) dry_run: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct SkillTargetPreferencesBody {
    pub(in crate::server) target_ids: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct SkillDistributeBody {
    pub(in crate::server) target_ids: Vec<String>,
    #[serde(default)]
    pub(in crate::server) remember_target_ids: bool,
}

pub(in crate::server) async fn skill_target_context_and_targets() -> anyhow::Result<(
    crate::skills_catalog::distribution::DistributionContext,
    Vec<crate::skills_catalog::distribution::SkillAgentTargetView>,
)> {
    tokio::task::spawn_blocking(|| {
        let context = crate::skills_catalog::distribution::DistributionContext::current()?;
        let targets = crate::skills_catalog::distribution::list_agent_targets(
            &context.home_dir,
            &context.environment,
        )?;
        Ok((context, targets))
    })
    .await
    .map_err(|error| anyhow::anyhow!("agent target discovery task failed: {error}"))?
}

pub(in crate::server) async fn skill_target_preferences(
    state: &ServerState,
    targets: &[crate::skills_catalog::distribution::SkillAgentTargetView],
) -> anyhow::Result<crate::skills_catalog::distribution::ParsedPreferences> {
    let raw = state
        .preferences
        .get(crate::skills_catalog::distribution::INSTALL_TARGETS_PREF)
        .await?;
    Ok(crate::skills_catalog::distribution::parse_preferences(
        raw.as_deref(),
        targets,
    ))
}

pub(in crate::server) fn skill_target_envelope(
    targets: Vec<crate::skills_catalog::distribution::SkillAgentTargetView>,
    parsed: crate::skills_catalog::distribution::ParsedPreferences,
) -> serde_json::Value {
    json!({
        "targets": targets,
        "preferences": parsed.preferences,
        "droppedTargetIds": parsed.dropped_target_ids,
        "warning": parsed.warning,
    })
}

pub(in crate::server) fn deduplicate_target_ids(target_ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    target_ids
        .into_iter()
        .filter(|target_id| seen.insert(target_id.clone()))
        .collect()
}

pub(in crate::server) fn should_distribute_after_install(
    preferences: &crate::skills_catalog::distribution::SkillInstallPreferencesV1,
    input: &crate::skills_catalog::distribution::SkillTargetSelectionInput,
) -> bool {
    input.target_ids.is_some() || preferences.configured
}

pub(in crate::server) async fn reload_before_optional_preference_write<Reload, PreferenceWrite>(
    reload: Reload,
    remember_target_ids: bool,
    preference_write: PreferenceWrite,
) -> anyhow::Result<()>
where
    Reload: FnOnce(),
    PreferenceWrite: std::future::Future<Output = anyhow::Result<()>>,
{
    reload();
    if remember_target_ids {
        preference_write.await?;
    }
    Ok(())
}

pub(in crate::server) async fn save_skill_target_preferences(
    state: &ServerState,
    target_ids: Vec<String>,
) -> anyhow::Result<crate::skills_catalog::distribution::SkillInstallPreferencesV1> {
    let preferences = crate::skills_catalog::distribution::SkillInstallPreferencesV1 {
        version: 1,
        configured: true,
        target_ids,
    };
    let encoded = serde_json::to_string(&preferences)?;
    state
        .preferences
        .set(
            crate::skills_catalog::distribution::INSTALL_TARGETS_PREF,
            &encoded,
        )
        .await?;
    Ok(preferences)
}

/// `GET /api/skills/targets` — list known global agent targets and the resolved
/// install defaults. Reading the target registry is available to every caller
/// that can reach the Skills App; it does not require install permission.
#[utoipa::path(
    get,
    path = "/api/skills/targets",
    tag = "Skills",
    summary = "List agent skill targets and install defaults",
    responses(
        (status = 200, description = "Targets and preferences", body = serde_json::Value),
        (status = 500, description = "Target registry or preferences unavailable", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn skills_targets(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    let (_, targets) = match skill_target_context_and_targets().await {
        Ok(result) => result,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    match skill_target_preferences(&state, &targets).await {
        Ok(parsed) => (StatusCode::OK, Json(skill_target_envelope(targets, parsed))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}
