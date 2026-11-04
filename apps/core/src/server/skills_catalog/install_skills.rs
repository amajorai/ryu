//! The knowledge catalog, the skills catalog and skill packs: `skills_catalog_install` through `skills_install_from_source`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/skills/catalog/install { id, source?, promptForTargets?, targetIds?,
/// rememberTargetIds? }` — installs into the canonical skills directory and
/// reloads the live registry so the Skill is usable immediately. Prompt-aware
/// callers can distribute the installed package to agent-native global skill
/// directories; older callers keep canonical-only behavior until defaults exist.
///
/// Source-aware (#463): skills.sh installs via the `owner/repo/slug` download
/// path; a custom Claude marketplace source resolves the chosen item to its
/// repo+subdir and installs through Unit #462's from-source fetcher. Either way
/// the registry hot-reloads.
#[utoipa::path(
    post,
    path = "/api/skills/catalog/install",
    tag = "Skills",
    summary = "Install a skill from the catalog",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Canonical install and optional target distribution completed", body = serde_json::Value),
        (status = 400, description = "Invalid source or target", body = serde_json::Value),
        (status = 403, description = "Install permission required", body = serde_json::Value),
        (status = 409, description = "Prompt-aware install requires a target selection", body = serde_json::Value),
        (status = 500, description = "Install, preferences, or distribution failed", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn skills_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SkillInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(app_lifecycle_denied_value(
                crate::identity_verify::permissions::APP_INSTALL,
                crate::sidecar::control_plane::registered_node().as_ref(),
                "node_scope_or_acl_denied",
            )),
        );
    }

    let source_id = resolve_skill_source_id(&state, body.source.as_deref()).await;
    if source_id == SKILL_ALL_SOURCES_ID {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": "install requires the card's concrete source when browsing all marketplaces",
            })),
        );
    }
    // The id is granted together with the source that installs it; an
    // unregistered id falls back to the skills.sh install below.
    let grant_origin = match state
        .catalog_sources
        .sources_for(crate::catalog_source::CatalogKind::Skill)
        .into_iter()
        .find(|meta| meta.id == source_id)
    {
        Some(meta) if meta.builtin => {
            crate::sidecar::control_plane::SkillCatalogOrigin::Builtin(&source_id)
        }
        Some(_) => crate::sidecar::control_plane::SkillCatalogOrigin::Custom,
        None => crate::sidecar::control_plane::SkillCatalogOrigin::Builtin("skills-sh"),
    };
    if !crate::sidecar::control_plane::skill_catalog_install_granted(grant_origin, &body.id) {
        return skill_not_granted_refusal();
    }
    let (distribution_context, targets) = match skill_target_context_and_targets().await {
        Ok(result) => result,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": error.to_string() })),
            );
        }
    };
    let parsed_preferences = match skill_target_preferences(&state, &targets).await {
        Ok(parsed) => parsed,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": error.to_string() })),
            );
        }
    };
    let selection_input = crate::skills_catalog::distribution::SkillTargetSelectionInput {
        prompt_for_targets: body.prompt_for_targets,
        target_ids: body.target_ids.clone(),
        remember_target_ids: body.remember_target_ids,
    };
    let selected_target_ids = match crate::skills_catalog::distribution::resolve_target_selection(
        &parsed_preferences.preferences,
        &selection_input,
    ) {
        Ok(target_ids) => target_ids,
        Err(_) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": "skill_targets_required",
                    "code": "skill_targets_required",
                })),
            );
        }
    };
    if let Err(error) =
        crate::skills_catalog::distribution::validate_target_ids(&selected_target_ids, &targets)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error.to_string() })),
        );
    }
    let distribute_after_install =
        should_distribute_after_install(&parsed_preferences.preferences, &selection_input);
    if body.dry_run {
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "dryRun": true,
                "action": "install",
                "id": body.id,
                "source": source_id,
                "targetIds": selected_target_ids,
                "distributeAfterInstall": distribute_after_install,
                "writes": ["canonical skill registry", "optional agent skill targets"],
            })),
        );
    }
    // Forward the caller's bearer to the marketplace install handoff (#491) so a
    // PAID Ryu-Marketplace skill is denied unless the buyer org holds a license.
    let buyer_token = buyer_bearer_from_headers(&headers);
    // Skills install fetches a JSON envelope of inline files (no single
    // streaming URL→dest), so it tracks as an INDETERMINATE task in the global
    // download center (#456): it shows in the overlay as active→done/failed and
    // is cancelable, without byte progress.
    let id = body.id.clone();
    let label = format!("Skill: {id} ({source_id})");
    let installed = state
        .downloads
        .register_indeterminate(
            format!("skill:{source_id}:{id}"),
            crate::downloads::DownloadKind::Skill,
            label,
            crate::catalog_source::with_buyer_token(buyer_token, async {
                // Dispatch through the active source's skill-install path. A
                // non-skill source returns Ok(None), so fall back to the
                // skills.sh helper for the built-in source.
                let installed = match state
                    .catalog_sources
                    .source_by_id(crate::catalog_source::CatalogKind::Skill, &source_id)
                {
                    Some(source) => source.install_skill(&state.client, &id).await,
                    None => crate::skills_catalog::install_skill(&state.client, &id)
                        .await
                        .map(Some),
                };
                match installed {
                    Ok(Some(result)) => Ok(result),
                    Ok(None) => crate::skills_catalog::install_skill(&state.client, &id).await,
                    Err(e) => Err(e),
                }
            }),
        )
        .await;
    match installed {
        Ok(result) => {
            crate::stats_beacon::record_marketplace_event("skill", &id, true);
            let result_value = serde_json::to_value(&result).unwrap_or_default();
            let remember_target_ids =
                selection_input.remember_target_ids && selection_input.target_ids.is_some();
            let remembered_target_ids = selected_target_ids.clone();
            if let Err(error) = reload_before_optional_preference_write(
                || state.skills.reload(),
                remember_target_ids,
                async {
                    save_skill_target_preferences(&state, remembered_target_ids).await?;
                    Ok(())
                },
            )
            .await
            {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "success": false,
                        "canonicalInstalled": true,
                        "result": result_value,
                        "error": error.to_string(),
                    })),
                );
            }
            if !distribute_after_install {
                return (
                    StatusCode::OK,
                    Json(json!({ "success": true, "result": result_value })),
                );
            }
            let skill_id = result.slug.clone();
            let source_skill_md = std::path::PathBuf::from(&result.path);
            let distributed = tokio::task::spawn_blocking(move || {
                crate::skills_catalog::distribution::distribute_skill(
                    &distribution_context,
                    &skill_id,
                    &source_skill_md,
                    &selected_target_ids,
                )
            })
            .await;
            match distributed {
                Ok(Ok(distribution)) => (
                    StatusCode::OK,
                    Json(json!({
                        "success": true,
                        "result": result_value,
                        "distribution": distribution,
                    })),
                ),
                Ok(Err(error)) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "success": false,
                        "canonicalInstalled": true,
                        "result": result_value,
                        "error": error.to_string(),
                    })),
                ),
                Err(error) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "success": false,
                        "canonicalInstalled": true,
                        "result": result_value,
                        "error": format!("distribution task failed: {error}"),
                    })),
                ),
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SkillInstallFromSourceBody {
    /// One of the six supported source forms: `owner/repo`, a github/gitlab URL,
    /// a github `/tree/<ref>/<subdir>` URL, a `git@` SSH url, or a local path.
    pub(in crate::server) source: String,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// `POST /api/skills/install-from-source { source }` — resolve a source reference
/// (issue #462), fetch it (tarball first, `git clone --depth 1` fallback), copy the
/// **entire** skill directory into `~/.claude/skills/<name>/`, mark it active, and
/// hot-reload the registry so it's usable immediately.
#[utoipa::path(
    post,
    path = "/api/skills/install-from-source",
    tag = "Skills",
    summary = "Install a skill directly from a source spec",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_install_from_source(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SkillInstallFromSourceBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(app_lifecycle_denied_value(
                crate::identity_verify::permissions::APP_INSTALL,
                crate::sidecar::control_plane::registered_node().as_ref(),
                "node_scope_or_acl_denied",
            )),
        );
    }

    if body.source.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`source` must not be empty" })),
        );
    }
    if let Some(refusal) = skill_grant_refusal(&[body.source.as_str()]) {
        return refusal;
    }
    if body.dry_run {
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "dryRun": true,
                "action": "install",
                "source": body.source,
                "writes": ["canonical skill registry"],
            })),
        );
    }
    match crate::skills_catalog::from_source::install_from_source(&state.client, &body.source).await
    {
        Ok(result) => {
            state.skills.reload();
            (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "id": result.slug,
                    "result": serde_json::to_value(result).unwrap_or_default(),
                })),
            )
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}
