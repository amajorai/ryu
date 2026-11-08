//! Routes, shared-template copies, the task binding read and the OpenAPI document.

use super::box_flag::require_box_backend_feature;
use super::handlers::{import, import_names, put, read, Import};
use super::launch::launch;
use super::store_update::update;
use super::*;

pub fn routes() -> Router<ServerState> {
    Router::new()
        .merge(github::routes())
        .route(
            "/api/cloud-environments/task-binding/:conversation_id",
            get(task_binding),
        )
        .route("/api/cloud-environments/shared", get(shared))
        .route(
            "/api/cloud-environments/shared/:id/import",
            axum::routing::post(import_shared),
        )
        .route("/api/cloud-environments", get(read).put(put))
        .route(
            "/api/cloud-environments/import",
            get(import_names).post(import),
        )
        .route(
            "/api/cloud-environments/:id/launch",
            axum::routing::post(launch),
        )
        .layer(axum::extract::DefaultBodyLimit::max(1_048_576))
}
#[utoipa::path(get,path="/api/cloud-environments/task-binding/{conversation_id}",operation_id="get_cloud_task_binding",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose cloud binding is being hydrated")),description="Read the caller's server-owned cloud conversation binding before reopening a chat. Requires current personal identity and GatewayRoute; execution permission is not required to inspect or stop a task. Returns cloudEnvironmentId, state, backend (docker, opensandbox, vpn or box) and executor (ryu, claude-code, codex, opencode or cursor) as nullable strings. A marker belonging to a different owner is denied. Interrupted or stopped bindings remain cloud bindings and must never reopen as local execution.",responses((status=200,body=Value),(status=403,description="Caller or task owner denied"),(status=503,description="Lifecycle store unavailable")))]
pub(super) async fn task_binding(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    crate::server::cloud_tasks::binding_metadata(&auth, &conversation_id)
        .await
        .map(Json)
}

pub(super) fn shareable(mut environment: Environment) -> Environment {
    environment.vault_keys.clear();
    environment.tailscale_vault_key = None;
    environment
}
#[utoipa::path(get, path="/api/cloud-environments/shared", tag="Cloud environments", security(("bearerAuth"=[])), description="List at most 100 published shared templates owned by other users on this node. Personal vault bindings and VPN key references are removed; values never leave the owner vault.", responses((status=200,body=Value),(status=403,description="Personal user identity required"),(status=503,description="Store unavailable")))]
pub(super) async fn shared(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Value>, ApiError> {
    let identity = owner(&auth)?;
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    let environments: Vec<_> = load()?
        .owners
        .into_iter()
        .filter(|(id, _)| id != &identity)
        .flat_map(|(_, state)| state.environments)
        .filter(|e| e.published && e.privacy == "shared")
        .map(shareable)
        .take(100)
        .collect();
    Ok(Json(json!({"environments":environments})))
}
#[derive(Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentSharedImport)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportShared {
    revision: u64,
}
#[utoipa::path(post, path="/api/cloud-environments/shared/{id}/import", tag="Cloud environments", security(("bearerAuth"=[])),params(("id"=String,Path,description="Published shared source template ID")),request_body=ImportShared, description="Copy a currently published shared template into this user's personal collection with a fresh ID, private visibility and unpublished draft state. Secret/VPN bindings are removed. Requires matching personal revision; source templates cannot be edited by recipients.", responses((status=200,body=Snapshot),(status=400,description="Collection limits reached"),(status=403,description="Personal identity denied; cloud_environment_feature_unavailable: the copy uses the box backend and the signed-in account lacks the Fresh cloud box rollout"),(status=404,description="Shared template unavailable"),(status=409,description="Revision conflict"),(status=503,description="Store or vault unavailable")))]
pub(super) async fn import_shared(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(id): Path<String>,
    Json(request): Json<ImportShared>,
) -> Result<Json<Snapshot>, ApiError> {
    let identity = owner(&auth)?;
    let (mut state, mut environment) = {
        let _lock = STORE_LOCK.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_environment_store_unavailable",
                "The environment store is unavailable.",
            )
        })?;
        let store = load()?;
        let environment = store
            .owners
            .iter()
            .filter(|(owner, _)| *owner != &identity)
            .flat_map(|(_, s)| &s.environments)
            .find(|e| e.id == id && e.published && e.privacy == "shared")
            .cloned()
            .ok_or_else(|| {
                error(
                    StatusCode::NOT_FOUND,
                    "cloud_environment_not_found",
                    "The shared template is unavailable.",
                )
            })?;
        (
            store.owners.get(&identity).cloned().unwrap_or_default(),
            shareable(environment),
        )
    };
    environment.id = uuid::Uuid::new_v4().to_string();
    environment.privacy = "private".into();
    environment.published = false;
    state.revision = request.revision;
    for entry in &mut state.vault {
        entry.value = None;
    }
    state.environments.push(environment);
    let box_allowed = require_box_backend_feature(&auth).await.is_ok();
    Ok(Json(update(&identity, state, box_allowed)?))
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(super::handlers::read,super::handlers::put,super::handlers::import_names,super::handlers::import,shared,import_shared,super::launch::launch,task_binding), components(schemas(Snapshot,Environment,Internet,Runtime,VaultEntry,Import,ImportShared)), tags((name="Cloud environments",description="Node-owned setup templates, private sealed variables and shared template copies.")))]
pub(super) struct CloudEnvironmentApiDoc;
pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
    use utoipa::OpenApi;
    let mut doc = CloudEnvironmentApiDoc::openapi();
    doc.merge(crate::server::cloud_tasks::openapi());
    doc.merge(github::openapi());
    doc.components
        .get_or_insert_with(Default::default)
        .add_security_scheme(
            "bearerAuth",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).build()),
        );
    doc
}
