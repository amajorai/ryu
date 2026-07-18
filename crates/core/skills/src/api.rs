//! HTTP API for the Skills authoring surface (`/api/skills` + `/api/skills/:id/*`):
//! list installed skills, read/create/update a SKILL.md from the desktop editor,
//! toggle a skill active (the injection gate), and a bounded, undoable version
//! history.
//!
//! **Routing shape (why this differs from `ryu_quests`).** The `/api/skills`
//! prefix is *shared*: this crate owns the CRUD/version/activate leaves, while the
//! `catalog`/`updates`/`install-from-source` leaves stay in Core (they are wired to
//! Core-only machinery — the download center, `catalog_source`, and marketplace
//! buyer tokens — which is out of this crate's scope). Because the two halves
//! interleave under one prefix, Core cannot `nest_service` just this half. So
//! [`routes`] returns a **generic, state-agnostic** `Router<S>` whose handlers are
//! State-free named fns reading the process-global [`crate::SkillRegistry`]
//! (published by Core at startup via [`crate::set_global_registry`], and shared —
//! it is `Arc`-backed — with the chat-turn injection's own `ServerState.skills`
//! handle). Core `.merge`s that router alongside its catalog routes and applies the
//! single Skills-App `route_layer`, so the mounted route set + gate is byte-identical
//! to the pre-extraction inline router. The OpenAPI annotations keep the full
//! external paths and are merged into Core's spec via [`openapi`].

use axum::{
    extract::Path,
    http::StatusCode,
    routing::{get, post, put},
    Json, Router,
};
use serde_json::json;

use crate::{store, SkillRegistry, SkillSummary};

/// Router state for the skills HTTP surface. The registry is `Arc`-backed and is
/// published to the process-global handle when [`routes`] is built, so the moved
/// handlers reach it without a per-request `State` extractor (which would pin the
/// router to a concrete state type and stop it merging into Core's `ServerState`
/// router alongside the catalog routes).
#[derive(Clone)]
pub struct SkillsCtx {
    pub registry: SkillRegistry,
}

impl SkillsCtx {
    pub fn new(registry: SkillRegistry) -> Self {
        Self { registry }
    }
}

/// The live registry the handlers act on. Prod always publishes it (Core, at
/// startup); when unset (a handler exercised before publication) fall back to an
/// empty registry so a read is a graceful no-op rather than a panic.
fn registry() -> &'static SkillRegistry {
    static EMPTY: std::sync::OnceLock<SkillRegistry> = std::sync::OnceLock::new();
    crate::global_registry().unwrap_or_else(|| EMPTY.get_or_init(SkillRegistry::empty))
}

/// Build the `/api/skills` CRUD/version/activate router, publishing `ctx`'s
/// registry as the process-global handle the handlers read. Returns a generic,
/// state-agnostic `Router<S>` so Core can `.merge` it into its `ServerState`
/// router beside the (Core-owned) `catalog`/`updates`/`install-from-source` routes
/// and gate the whole `/api/skills` surface with one `route_layer`. Static literal
/// segments are registered before the `:id` param routes so matchit resolves them
/// first — byte-identical to the pre-extraction inline order.
pub fn routes<S>(ctx: SkillsCtx) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    crate::set_global_registry(ctx.registry);
    Router::new()
        .route("/api/skills/activate", post(skills_activate))
        .route("/api/skills", get(list_skills).post(create_skill_handler))
        .route("/api/skills/:id/source", get(get_skill_source))
        .route("/api/skills/:id", put(update_skill_handler))
        .route(
            "/api/skills/:id/versions",
            get(list_skill_versions_handler).post(create_skill_version_handler),
        )
        .route(
            "/api/skills/:id/versions/:version_id",
            get(get_skill_version_handler),
        )
        .route(
            "/api/skills/:id/versions/:version_id/restore",
            post(restore_skill_version_handler),
        )
}

/// The OpenAPI sub-document for the Skills authoring surface, merged into Core's
/// spec (the `catalog`/`updates` handlers keep their annotations Core-side).
pub fn openapi() -> utoipa::openapi::OpenApi {
    <SkillsApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    list_skills,
    get_skill_source,
    update_skill_handler,
    list_skill_versions_handler,
    get_skill_version_handler,
    restore_skill_version_handler,
    skills_activate,
))]
struct SkillsApiDoc;

/// `GET /api/skills` — list all installed skills with their enabled state.
///
/// Skills live in the universal `~/.claude/skills/<id>/SKILL.md`. This endpoint lets agents and
/// UIs discover available skills (AC1). Each entry carries a `kind = "skill"`
/// field so the listing is heterogeneous-runnable compatible.
#[utoipa::path(
    get,
    path = "/api/skills",
    tag = "Skills",
    summary = "List installed skills",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_skills() -> Json<serde_json::Value> {
    let summaries: Vec<SkillSummary> = registry().list_all().iter().map(SkillSummary::from).collect();
    Json(json!({ "skills": summaries }))
}

/// `GET /api/skills/:id/source` — the full editable SKILL.md for the editor.
///
/// Returns both the decomposed form fields (name/description/allowed_tools/
/// always_on/body) and the raw `source` string (the diff baseline for version
/// history).
#[utoipa::path(
    get,
    path = "/api/skills/{id}/source",
    tag = "Skills",
    summary = "Read a skill's SKILL.md source",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_skill_source(Path(id): Path<String>) -> (StatusCode, Json<serde_json::Value>) {
    match store::read_skill_source(&id) {
        Ok(Some(source)) => {
            let rec = crate::parse_skill_md(&id, &source).ok();
            let (name, description, allowed_tools, always_on, body) = match rec {
                Some(r) => (
                    r.name,
                    r.description,
                    r.allowed_tools,
                    r.always_on,
                    r.instructions,
                ),
                // Unparseable on-disk file: still let the editor open the raw body.
                None => (id.clone(), None, Vec::new(), false, source.clone()),
            };
            (
                StatusCode::OK,
                Json(json!({
                    "id": id,
                    "name": name,
                    "description": description,
                    "allowed_tools": allowed_tools,
                    "always_on": always_on,
                    "body": body,
                    "source": source,
                })),
            )
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "skill not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Map a [`store::CreateError`] to an HTTP response.
fn skill_write_error(e: store::CreateError) -> (StatusCode, Json<serde_json::Value>) {
    use store::CreateError;
    match e {
        CreateError::Conflict(slug) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("a skill named '{slug}' already exists") })),
        ),
        CreateError::Invalid(m) => (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))),
        CreateError::Io(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        ),
    }
}

/// `POST /api/skills` — create a new user-authored skill from the editor.
pub async fn create_skill_handler(
    Json(draft): Json<store::SkillDraft>,
) -> (StatusCode, Json<serde_json::Value>) {
    match store::create_skill(&draft) {
        Ok(res) => {
            // A skill the user authored is active by default (injects on the
            // default route), matching the catalog-install paths.
            crate::set_active(&res.id, true);
            registry().reload();
            (
                StatusCode::OK,
                Json(json!({
                    "id": res.id,
                    "path": res.path.to_string_lossy(),
                    "source": res.source,
                })),
            )
        }
        Err(e) => skill_write_error(e),
    }
}

/// `PUT /api/skills/:id` — update an existing skill's SKILL.md (autosaved from the
/// editor). Front-matter keys the editor does not manage are preserved.
#[utoipa::path(
    put,
    path = "/api/skills/{id}",
    tag = "Skills",
    summary = "Update a skill's source",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_skill_handler(
    Path(id): Path<String>,
    Json(draft): Json<store::SkillDraft>,
) -> (StatusCode, Json<serde_json::Value>) {
    match store::update_skill(&id, &draft) {
        Ok(res) => {
            registry().reload();
            (
                StatusCode::OK,
                Json(json!({
                    "id": res.id,
                    "path": res.path.to_string_lossy(),
                    "source": res.source,
                })),
            )
        }
        Err(e) => skill_write_error(e),
    }
}

/// `GET /api/skills/:id/versions` — list a skill's saved versions (newest first).
#[utoipa::path(
    get,
    path = "/api/skills/{id}/versions",
    tag = "Skills",
    summary = "List a skill's version history",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_skill_versions_handler(
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match store::list_skill_versions(&id) {
        Ok(versions) => (StatusCode::OK, Json(json!({ "versions": versions }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize, Default)]
pub struct CreateSkillVersionBody {
    label: Option<String>,
}

/// `POST /api/skills/:id/versions` — snapshot the skill's current SKILL.md.
pub async fn create_skill_version_handler(
    Path(id): Path<String>,
    body: Option<Json<CreateSkillVersionBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let label = body
        .and_then(|Json(b)| b.label)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match store::snapshot_skill(&id, label.as_deref()) {
        Ok(Some(meta)) => (StatusCode::OK, Json(json!({ "version": meta }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "skill not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/skills/:id/versions/:version_id` — fetch one version in full
/// (including its captured SKILL.md source, used for the diff view).
#[utoipa::path(
    get,
    path = "/api/skills/{id}/versions/{version_id}",
    tag = "Skills",
    summary = "Get one version of a skill",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_skill_version_handler(
    Path((id, version_id)): Path<(String, String)>,
) -> (StatusCode, Json<serde_json::Value>) {
    match store::load_skill_version(&id, &version_id) {
        Ok(Some(version)) => (StatusCode::OK, Json(json!({ "version": version }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "version not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/skills/:id/versions/:version_id/restore` — restore a version as the
/// skill's current SKILL.md. The current definition is snapshotted first (as
/// `"Before restore"`) so the restore is itself undoable.
#[utoipa::path(
    post,
    path = "/api/skills/{id}/versions/{version_id}/restore",
    tag = "Skills",
    summary = "Restore a skill to an earlier version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn restore_skill_version_handler(
    Path((id, version_id)): Path<(String, String)>,
) -> (StatusCode, Json<serde_json::Value>) {
    match store::restore_skill_version(&id, &version_id) {
        Ok(Some(source)) => {
            registry().reload();
            (
                StatusCode::OK,
                Json(json!({ "success": true, "source": source })),
            )
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "version not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub struct SkillActivateBody {
    /// Skill id (the directory name / slug).
    id: String,
    /// `true` to inject this skill on the default chat route, `false` to stop.
    active: bool,
}

/// `POST /api/skills/activate { id, active }` — toggle whether a skill's
/// instructions inject on the openai_compat default route. Installed-but-inactive
/// is the default for skills discovered in the shared dir (so dozens of them don't
/// flood a local model's context); this lets the user opt one in or out. Reloads
/// the registry so the change takes effect immediately.
#[utoipa::path(
    post,
    path = "/api/skills/activate",
    tag = "Skills",
    summary = "Toggle a skill active (injection gate)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn skills_activate(
    Json(body): Json<SkillActivateBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    crate::set_active(&body.id, body.active);
    registry().reload();
    (
        StatusCode::OK,
        Json(json!({ "success": true, "id": body.id, "active": body.active })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openapi_lists_the_moved_paths() {
        let doc = openapi();
        // The seven moved handlers are present; the Core-owned catalog paths are not.
        assert!(doc.paths.paths.contains_key("/api/skills"));
        assert!(doc.paths.paths.contains_key("/api/skills/activate"));
        assert!(doc.paths.paths.contains_key("/api/skills/{id}/source"));
        assert!(doc
            .paths
            .paths
            .contains_key("/api/skills/{id}/versions/{version_id}/restore"));
        assert!(!doc.paths.paths.contains_key("/api/skills/catalog"));
    }

    #[test]
    fn routes_builds_over_an_arbitrary_state() {
        // Compiles + builds for a unit state, proving the generic `Router<S>` merges
        // into Core's `ServerState` router (the whole reason handlers are State-free).
        let _: Router<()> = routes(SkillsCtx::new(SkillRegistry::empty()));
    }
}
