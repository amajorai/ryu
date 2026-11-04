//! The knowledge catalog, the skills catalog and skill packs: `skills_target_preferences_put` through `skill_not_granted_refusal`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `PUT /api/skills/targets/preferences` — validate and remember the default
/// agent targets used by future catalog installs.
#[utoipa::path(
    put,
    path = "/api/skills/targets/preferences",
    tag = "Skills",
    summary = "Set default agent skill targets",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Preferences saved", body = serde_json::Value),
        (status = 400, description = "Invalid target id", body = serde_json::Value),
        (status = 403, description = "Install permission required", body = serde_json::Value),
        (status = 500, description = "Target registry or preferences unavailable", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn skills_target_preferences_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SkillTargetPreferencesBody>,
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
    let (_, targets) = match skill_target_context_and_targets().await {
        Ok(result) => result,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    let target_ids = deduplicate_target_ids(body.target_ids);
    if let Err(error) =
        crate::skills_catalog::distribution::validate_target_ids(&target_ids, &targets)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error.to_string() })),
        );
    }
    let preferences = match save_skill_target_preferences(&state, target_ids).await {
        Ok(preferences) => preferences,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": error.to_string() })),
            );
        }
    };
    let parsed = crate::skills_catalog::distribution::ParsedPreferences {
        preferences,
        dropped_target_ids: Vec::new(),
        warning: None,
    };
    (StatusCode::OK, Json(skill_target_envelope(targets, parsed)))
}

/// `DELETE /api/skills/targets/preferences` — clear the default so the next
/// prompt-aware install asks again. Existing distributed files are untouched.
#[utoipa::path(
    delete,
    path = "/api/skills/targets/preferences",
    tag = "Skills",
    summary = "Clear default agent skill targets",
    responses(
        (status = 200, description = "Preferences cleared", body = serde_json::Value),
        (status = 403, description = "Install permission required", body = serde_json::Value),
        (status = 500, description = "Target registry or preferences unavailable", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn skills_target_preferences_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
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
    let (_, targets) = match skill_target_context_and_targets().await {
        Ok(result) => result,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    if let Err(error) = state
        .preferences
        .delete(crate::skills_catalog::distribution::INSTALL_TARGETS_PREF)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": error.to_string() })),
        );
    }
    let parsed = crate::skills_catalog::distribution::ParsedPreferences {
        preferences: Default::default(),
        dropped_target_ids: Vec::new(),
        warning: None,
    };
    (StatusCode::OK, Json(skill_target_envelope(targets, parsed)))
}

/// `POST /api/skills/:id/distribute` — project an already-installed canonical
/// skill package into the selected agent-native global directories.
#[utoipa::path(
    post,
    path = "/api/skills/{id}/distribute",
    tag = "Skills",
    summary = "Distribute an installed skill to agent targets",
    params(("id" = String, Path, description = "Canonical skill id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Per-target distribution result", body = serde_json::Value),
        (status = 400, description = "Invalid target or canonical package", body = serde_json::Value),
        (status = 403, description = "Install permission required", body = serde_json::Value),
        (status = 404, description = "Canonical skill not found", body = serde_json::Value),
        (status = 500, description = "Distribution task or preferences failed", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn skills_distribute(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<SkillDistributeBody>,
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
    let target_ids = body.target_ids;
    let id_for_validation = id.clone();
    let target_ids_for_validation = target_ids.clone();
    let validated = tokio::task::spawn_blocking(move || {
        let context = crate::skills_catalog::distribution::DistributionContext::current()?;
        let targets = crate::skills_catalog::distribution::list_agent_targets(
            &context.home_dir,
            &context.environment,
        )?;
        crate::skills_catalog::distribution::validate_target_ids(
            &target_ids_for_validation,
            &targets,
        )?;
        Ok::<_, anyhow::Error>((context, ryu_skills::resolve_skill_md(&id_for_validation)))
    })
    .await;
    let (context, source_skill_md) = match validated {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error.to_string() })),
            );
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("target validation task failed: {error}") }),
                ),
            );
        }
    };
    let Some(source_skill_md) = source_skill_md else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "canonical skill not found" })),
        );
    };
    if body.remember_target_ids {
        if let Err(error) = save_skill_target_preferences(&state, target_ids.clone()).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": error.to_string() })),
            );
        }
    }
    let id_for_distribution = id.clone();
    let distributed = tokio::task::spawn_blocking(move || {
        crate::skills_catalog::distribution::distribute_skill(
            &context,
            &id_for_distribution,
            &source_skill_md,
            &target_ids,
        )
    })
    .await;
    match distributed {
        Ok(Ok(distribution)) => (
            StatusCode::OK,
            Json(json!({ "success": true, "distribution": distribution })),
        ),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error.to_string() })),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({ "success": false, "error": format!("distribution task failed: {error}") }),
            ),
        ),
    }
}

/// `GET /api/skills/updates` — installed (through-Ryu) skills whose local
/// SKILL.md differs from the current upstream package. Content-diff detection;
/// see `skills_catalog::check_updates`.
#[utoipa::path(
    get,
    path = "/api/skills/updates",
    tag = "Skills",
    summary = "Installed skills with a newer upstream SKILL.md",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_updates(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let updates = crate::skills_catalog::check_updates(&state.client).await;
    Json(json!({ "updates": updates }))
}

/// Refusal for a skill install the control plane has not granted (see
/// `control_plane::skill_install_granted`). `None` lets the install proceed.
pub(in crate::server) fn skill_grant_refusal(
    identifiers: &[&str],
) -> Option<(StatusCode, Json<serde_json::Value>)> {
    (!crate::sidecar::control_plane::skill_install_granted(identifiers))
        .then(skill_not_granted_refusal)
}

pub(in crate::server) fn skill_not_granted_refusal() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "success": false,
            "error": "this skill is not granted to this node by your organization",
            "code": "skill_not_granted",
        })),
    )
}
