//! Read, save and import routes for the personal collection.

use super::box_flag::require_box_backend_feature;
use super::store_update::update;
use super::validation::{import_authorized, importable_key};
use super::*;

#[utoipa::path(get, path="/api/cloud-environments", tag="Cloud environments", security(("bearerAuth"=[])), description="Read the verified user's node-local environment templates and redacted personal vault. Values are never returned. Maximum 100 environments and 100 vault entries. Shared templates are listed separately.", responses((status=200, body=Snapshot),(status=403, description="Personal user identity required"),(status=503, description="Store unavailable or unsupported schema")))]
pub(super) async fn read(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Snapshot>, ApiError> {
    let owner = owner(&auth)?;
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    Ok(Json(projection(
        load()?.owners.remove(&owner).unwrap_or_default(),
    )))
}
#[utoipa::path(put, path="/api/cloud-environments", tag="Cloud environments", security(("bearerAuth"=[])), request_body=Snapshot, description="Atomically replace this user's templates and vault metadata. schemaVersion must be 1; revision must equal the current revision. Omitted value preserves the sealed value for the same id/key/kind; removing an entry deletes its value. Values are write-only and sealed at rest. Maximum request 1 MiB, 100 templates/entries, 20 repositories per template, 64 KiB script/instructions/value. GatewayRoute and verified personal identity required; request retries must reload revision after 409. Optional runtime selects backend auto or box (a fresh disposable Ryu Box per conversation), executor ryu, claude-code, codex, opencode or cursor, and lifetimeMinutes 5-240 (honored only for box); omitted runtime reads as auto/ryu/30. Managed executors require the box backend and internet access; box rejects a Tailscale key, its egress proxy substitutes bound network secrets only for DNS domains a restricted allowlist allows, and a restricted box allowlist must include archive.ubuntu.com, security.ubuntu.com and the agent's provider hosts (422 cloud_environment_policy_unavailable). This route does not start scripts or test VPN credentials.", responses((status=200,body=Snapshot),(status=400,description="Invalid schema, limits, keys, domains or references"),(status=403,description="Identity denied; cloud_environment_feature_unavailable: the save newly selects the box backend for a signed-in account without the Fresh cloud box rollout"),(status=409,description="Revision or stable ID conflict"),(status=422,description="Runtime rules not satisfied"),(status=503,description="Store or encrypted vault unavailable")))]
pub(super) async fn put(
    Extension(auth): Extension<ResolvedAuthorization>,
    Json(state): Json<Snapshot>,
) -> Result<Json<Snapshot>, ApiError> {
    let owner = owner(&auth)?;
    let box_allowed = require_box_backend_feature(&auth).await.is_ok();
    Ok(Json(update(&owner, state, box_allowed)?))
}
#[utoipa::path(get, path="/api/cloud-environments/import", tag="Cloud environments", security(("bearerAuth"=[])), description="Node-owner only. Enumerate at most 1000 eligible names from the selected Core node shell, never values. Platform and infrastructure variables are excluded. This is not the client computer environment.", responses((status=200,body=Value),(status=403,description="Node owner required")))]
pub(super) async fn import_names(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Value>, ApiError> {
    import_authorized(&auth)?;
    let names: BTreeSet<_> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| importable_key(key))
        .take(1000)
        .collect();
    Ok(Json(json!({"names":names})))
}
#[derive(Deserialize, utoipa::ToSchema)]
#[schema(as = CloudEnvironmentImport)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Import {
    keys: Vec<String>,
    kind: String,
    environment_ids: Vec<String>,
    domains: Vec<String>,
    revision: u64,
}
#[utoipa::path(post, operation_id="import_cloud_environment_variables", path="/api/cloud-environments/import", tag="Cloud environments", security(("bearerAuth"=[])), request_body=Import, description="Node-owner only. Import 1–100 explicitly selected eligible shell variables into the owner's sealed personal vault. revision conflict fails atomically; no values returned. Each selected key must be present and non-reserved. Existing keys are updated. Optional environmentIds bind to owned templates and domains bind network secrets.", responses((status=200,body=Snapshot),(status=400,description="Invalid selection or missing variable"),(status=403,description="Node owner required"),(status=409,description="Revision conflict"),(status=503,description="Store or vault unavailable")))]
pub(super) async fn import(
    Extension(auth): Extension<ResolvedAuthorization>,
    Json(request): Json<Import>,
) -> Result<Json<Snapshot>, ApiError> {
    import_authorized(&auth)?;
    let identity = owner(&auth)?;
    if request.keys.is_empty()
        || request.keys.len() > 100
        || request.keys.iter().any(|k| !importable_key(k))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "cloud_environment_invalid",
            "Select between 1 and 100 non-reserved variables.",
        ));
    }
    let mut state = {
        let _lock = STORE_LOCK.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_environment_store_unavailable",
                "The environment store is unavailable.",
            )
        })?;
        load()?.owners.remove(&identity).unwrap_or_default()
    };
    state.revision = request.revision;
    for entry in &mut state.vault {
        entry.value = None;
    }
    for key in request.keys {
        let value = std::env::var(&key).map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "cloud_environment_import_unavailable",
                "A selected variable is unavailable.",
            )
        })?;
        if let Some(entry) = state.vault.iter_mut().find(|e| e.key == key) {
            entry.value = Some(value);
            entry.kind = request.kind.clone();
            entry.environment_ids = request.environment_ids.clone();
            entry.domains = request.domains.clone();
        } else {
            state.vault.push(VaultEntry {
                id: uuid::Uuid::new_v4().to_string(),
                key,
                value: Some(value),
                kind: request.kind.clone(),
                environment_ids: request.environment_ids.clone(),
                domains: request.domains.clone(),
                has_value: true,
            });
        }
    }
    let box_allowed = require_box_backend_feature(&auth).await.is_ok();
    Ok(Json(update(&identity, state, box_allowed)?))
}
