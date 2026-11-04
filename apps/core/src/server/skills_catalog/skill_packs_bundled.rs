//! Skill packs + bundled system skills.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// `POST /api/skills/activate` moved to `ryu_skills::api::skills_activate` (merged in
// `skills_routes`); its request body + handler + `#[utoipa::path]` live in the crate.

// ── Skill packs + bundled system skills ───────────────────────────────────────
//
// Packs are a named collection of skills (a repo whose `SKILL.md` dirs are the
// members, or a user-defined manifest of skills.sh ids + repo URLs). The
// system-skills sync reconciles the bundled catalog on demand. Both are the
// Core-side logic over one HTTP API, exactly like the rest of the skills
// surface.

/// `GET /api/skills/packs` — every pack (built-in catalog + user packs) with its
/// member count. Member resolution is network-backed (a repo tree walk), so the
/// count is resolved here rather than stored.
#[utoipa::path(
    get,
    path = "/api/skills/packs",
    tag = "Skills",
    summary = "List skill packs (built-in + user-defined)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_packs_list(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let packs = crate::skills_catalog::packs::list_packs();
    let mut out = Vec::with_capacity(packs.len());
    for pack in packs {
        let members =
            crate::skills_catalog::packs::resolve_member_ids(&state.client, &pack.source).await;
        out.push(json!({
            "id": pack.id,
            "name": pack.name,
            "description": pack.description,
            "source": serde_json::to_value(&pack.source).unwrap_or_default(),
            "builtin": pack.builtin,
            "member_count": members.map(|m| m.len()).unwrap_or(0),
        }));
    }
    Json(json!({ "packs": out }))
}

/// `GET /api/skills/packs/detail?id=` — one pack with its resolved members.
#[utoipa::path(
    get,
    path = "/api/skills/packs/detail",
    tag = "Skills",
    summary = "Resolve a skill pack's members",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_packs_detail(
    State(state): State<ServerState>,
    Query(query): Query<PackQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(pack) = crate::skills_catalog::packs::list_packs()
        .into_iter()
        .find(|p| p.id == query.id)
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "unknown pack" })),
        );
    };
    match crate::skills_catalog::packs::resolve_members(&state.client, &pack.source).await {
        Ok(members) => (
            StatusCode::OK,
            Json(json!({
                "id": pack.id,
                "name": pack.name,
                "description": pack.description,
                "source": serde_json::to_value(&pack.source).unwrap_or_default(),
                "builtin": pack.builtin,
                "members": members,
            })),
        ),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct PackQuery {
    pub(in crate::server) id: String,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct PackInstallBody {
    pub(in crate::server) id: String,
}

/// `POST /api/skills/packs/install { id }` — install every member of a pack.
/// Best-effort per member; returns the slugs that landed on disk and hot-reloads
/// the registry.
#[utoipa::path(
    post,
    path = "/api/skills/packs/install",
    tag = "Skills",
    summary = "Install all members of a skill pack",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_packs_install(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PackInstallBody>,
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
    let Some(pack) = crate::skills_catalog::packs::list_packs()
        .into_iter()
        .find(|p| p.id == body.id)
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "unknown pack" })),
        );
    };
    // A repo pack is granted as a whole (its id or repo); a custom pack only
    // when every one of its entries is granted on its own.
    let pack_refusal = match &pack.source {
        crate::skills_catalog::packs::PackSource::Repo { repo } => {
            skill_grant_refusal(&[pack.id.as_str(), repo.as_str()])
        }
        crate::skills_catalog::packs::PackSource::Custom { entries } => entries
            .iter()
            .find_map(|entry| skill_grant_refusal(&[entry.as_str()])),
    };
    if let Some(refusal) = pack_refusal {
        return refusal;
    }
    match crate::skills_catalog::packs::install_pack(&state.client, &pack.source).await {
        Ok(installed) => {
            state.skills.reload();
            (
                StatusCode::OK,
                Json(json!({ "success": true, "installed": installed })),
            )
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct PackAddBody {
    /// Kebab-case id for the pack (`my-pack`).
    pub(in crate::server) id: String,
    pub(in crate::server) name: String,
    pub(in crate::server) description: String,
    /// The pack source: `owner/repo`, a github/skills.sh URL, or a custom
    /// manifest `{"entries": [...]}` (skills.sh ids + repo URLs).
    pub(in crate::server) source: String,
}

/// `POST /api/skills/packs` — add a user-defined pack and persist it.
#[utoipa::path(
    post,
    path = "/api/skills/packs",
    tag = "Skills",
    summary = "Add a custom skill pack",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_packs_add(
    State(_state): State<ServerState>,
    Json(body): Json<PackAddBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::skills_catalog::packs::{parse_pack_source, SkillPack};
    let id = body.id.trim().to_string();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "invalid pack id" })),
        );
    }
    let source = match parse_pack_source(&body.source) {
        Ok(source) => source,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };
    let pack = SkillPack {
        id,
        name: body.name.trim().to_string(),
        description: body.description.trim().to_string(),
        source,
        builtin: false,
    };
    match crate::skills_catalog::packs::save_user_pack(pack) {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `POST /api/skills/packs/remove { id }` — remove a user-defined pack (built-ins
/// cannot be removed).
#[utoipa::path(
    post,
    path = "/api/skills/packs/remove",
    tag = "Skills",
    summary = "Remove a user-defined skill pack",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_packs_remove(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PackInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UNINSTALL,
    )
    .await
    {
        return response;
    }
    match crate::skills_catalog::packs::remove_user_pack(&body.id) {
        Ok(true) => (StatusCode::OK, Json(json!({ "success": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "pack not found or built-in" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `GET /api/skills/system` — the bundled system-skills catalog state: which
/// bundled skills are installed, which are missing, and which `System`-owned
/// skills a catalog change would drop.
#[utoipa::path(
    get,
    path = "/api/skills/system",
    tag = "Skills",
    summary = "Bundled system-skills catalog state",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_system_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::skills_catalog::system_skills::{
        effective_selected_pack_ids, origin_of, read_selection, SkillOrigin, SYNC_ENABLED_PREF,
    };
    let installed = crate::skills_catalog::installed_slugs();
    let version = crate::skills_catalog::system_skills::bundle_version();
    let selection = read_selection(&state.preferences).await;
    let mut bundled: Vec<serde_json::Value> = Vec::new();
    for slug in crate::skills_catalog::system_skills::DEFAULT_SKILLS {
        bundled.push(json!({
            "slug": slug,
            "installed": installed.contains(*slug),
            "origin": origin_of(slug),
        }));
    }
    for repo in crate::skills_catalog::system_skills::bundled_repos() {
        let members = crate::skills_catalog::packs::resolve_member_ids(
            &state.client,
            &crate::skills_catalog::packs::PackSource::Repo { repo: repo.clone() },
        )
        .await
        .unwrap_or_default();
        for id in members {
            let slug = crate::skills_catalog::slug_of(&id);
            if bundled.iter().any(|b| b["slug"] == slug) {
                continue;
            }
            let origin = origin_of(&slug);
            if origin == SkillOrigin::System && !installed.contains(&slug) {
                bundled.push(json!({
                    "slug": slug,
                    "installed": false,
                    "origin": origin,
                }));
            }
        }
    }
    let enabled = state
        .preferences
        .get(SYNC_ENABLED_PREF)
        .await
        .ok()
        .flatten()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "on" | "yes"
            )
        })
        .unwrap_or(true);
    Json(json!({
        "version": version,
        "repos": crate::skills_catalog::system_skills::bundled_repos(),
        "defaults": crate::skills_catalog::system_skills::DEFAULT_SKILLS,
        "bundled": bundled,
        "options": crate::skills_catalog::system_skills::bundled_skill_pack_options(),
        "selectionConfigured": selection.configured,
        "selectedPackIds": effective_selected_pack_ids(&selection),
        "enabled": enabled,
    }))
}

/// `POST /api/skills/system/sync` — run the bundled-catalog reconcile now
/// (idempotent). Installs missing bundled skills, removes `System`-owned skills
/// dropped from the catalog, and never touches `User`-owned skills.
#[utoipa::path(
    post,
    path = "/api/skills/system/sync",
    tag = "Skills",
    summary = "Reconcile the bundled system-skills catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn skills_system_sync(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::skills_catalog::system_skills::{
        read_selection, selection_bundle_version, sync_selected_bundled_with_preferences,
        SYNCED_VERSION_PREF, SYNC_ENABLED_PREF,
    };
    let selection = read_selection(&state.preferences).await;
    if !selection.configured {
        return Json(json!({
            "success": false,
            "skipped": "onboarding_skill_selection_required",
            "selectionConfigured": false,
            "selectedPackIds": selection.pack_ids,
        }));
    }
    let enabled = state
        .preferences
        .get(SYNC_ENABLED_PREF)
        .await
        .ok()
        .flatten()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "on" | "yes"
            )
        })
        .unwrap_or(true);
    let synced_version = state
        .preferences
        .get(SYNCED_VERSION_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let report = sync_selected_bundled_with_preferences(
        &state.client,
        &state.preferences,
        enabled,
        &synced_version,
        &selection.pack_ids,
    )
    .await;
    if report.complete {
        let version = selection_bundle_version(&selection.pack_ids);
        let _ = state.preferences.set(SYNCED_VERSION_PREF, &version).await;
    }
    state.skills.reload();
    Json(json!({
        "success": report.complete,
        "selectionConfigured": true,
        "selectedPackIds": selection.pack_ids,
        "report": serde_json::to_value(&report).unwrap_or_default(),
    }))
}
