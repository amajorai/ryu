//! Operator backup API. `nodes.manage` is the policy gate because destinations
//! and whole-node snapshots include data belonging to every user of this node.

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Extension, Json, Router,
};
use ryu_backup::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use super::{enforce_permission, ServerState};
use crate::{
    backups::{global, RestoreBackup},
    identity_verify::{permissions::NODES_MANAGE, VerifiedCaller},
};

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackupOverview {
    destinations: Vec<BackupDestination>,
    policies: Vec<BackupPolicy>,
    operations: Vec<BackupOperation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    space_id: Option<String>,
    scope: Option<String>,
}

impl ListQuery {
    fn resolved_scope(self) -> anyhow::Result<Option<BackupScope>> {
        match (self.space_id, self.scope.as_deref()) {
            (Some(space_id), None) => Ok(Some(BackupScope::Space { space_id })),
            (None, Some("node")) => Ok(Some(BackupScope::Node)),
            (None, None) => Ok(None),
            _ => anyhow::bail!("Use scope=node or spaceId, not both"),
        }
    }
}

async fn authorize(state: &ServerState, caller: &Option<VerifiedCaller>) -> Result<(), Response> {
    enforce_permission(state, caller, NODES_MANAGE).await.map_err(|_| (
        StatusCode::FORBIDDEN, Json(json!({ "code": "backup_permission_denied", "error": "Node management permission is required for backups" }))
    ).into_response())
}

fn failure(error: anyhow::Error) -> Response {
    // Never return provider error chains, signed request URLs or secret values.
    let message: String = error.to_string().chars().take(320).collect();
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "code": "backup_request_failed", "error": message })),
    )
        .into_response()
}

pub fn router() -> Router<ServerState> {
    Router::new()
        .route("/api/backups", get(overview))
        .route("/api/backups/recovery-key", post(recovery_key))
        .route("/api/backups/destinations", post(create_destination))
        .route(
            "/api/backups/destinations/:id",
            put(update_destination).delete(remove_destination),
        )
        .route("/api/backups/destinations/:id/test", post(test_destination))
        .route("/api/backups/destinations/:id/backups", get(list_backups))
        .route("/api/backups/policies", post(save_policy))
        .route("/api/backups/policies/:id", delete(remove_policy))
        .route("/api/backups/runs", post(create_backup))
        .route("/api/backups/restore", post(restore_backup))
        .route("/api/backups/operations/:id", get(operation))
        .layer(DefaultBodyLimit::max(32 * 1024))
}

#[utoipa::path(get, path = "/api/backups", tag = "Backups", summary = "List backup destinations, schedules and recent operations (nodes.manage)", responses((status = 200, body = BackupOverview), (status = 403, description = "Node management permission required"), (status = 400, description = "Backup state unavailable")))]
pub async fn overview(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match global().await {
        Ok(service) => Json(BackupOverview {
            destinations: service.destinations().await,
            policies: service.policies().await,
            operations: service.operations().await,
        })
        .into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(post, path = "/api/backups/recovery-key", tag = "Backups", summary = "Generate a new backup recovery key (nodes.manage); save it outside the node", responses((status = 200, body = serde_json::Value), (status = 403, description = "Node management permission required")))]
pub async fn recovery_key(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    Json(json!({ "recoveryKey": encryption::new_key() })).into_response()
}

#[utoipa::path(post, path = "/api/backups/destinations", tag = "Backups", summary = "Validate and save an S3 destination (nodes.manage); write-only sealed credentials", request_body = SaveBackupDestination, responses((status = 200, body = BackupDestination), (status = 400, description = "Invalid destination, duplicate bucket/prefix, or connection test failed"), (status = 403, description = "Permission denied")))]
pub async fn create_destination(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<SaveBackupDestination>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match async { global().await?.save_destination(None, body).await }.await {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(put, path = "/api/backups/destinations/{id}", tag = "Backups", summary = "Update an S3 destination and rotate its access credentials (nodes.manage)", params(("id" = String, Path)), request_body = SaveBackupDestination, responses((status = 200, body = BackupDestination), (status = 400, description = "Invalid update or connection test failed"), (status = 403, description = "Permission denied")))]
pub async fn update_destination(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<SaveBackupDestination>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match async { global().await?.save_destination(Some(id), body).await }.await {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(delete, path = "/api/backups/destinations/{id}", tag = "Backups", summary = "Remove destination configuration; S3 objects remain (nodes.manage)", params(("id" = String, Path)), responses((status = 204, description = "Removed"), (status = 400, description = "Active operation or schedules still use destination"), (status = 403, description = "Permission denied")))]
pub async fn remove_destination(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match async { global().await?.delete_destination(&id).await }.await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(post, path = "/api/backups/destinations/{id}/test", tag = "Backups", summary = "Test S3 write, read, list and delete permissions (nodes.manage)", params(("id" = String, Path)), responses((status = 200, body = serde_json::Value), (status = 400, description = "Connection validation failed"), (status = 403, description = "Permission denied")))]
pub async fn test_destination(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    let result = async { let (_, s3) = global().await?.destination(&id).await?; s3.test().await.map_err(|_| anyhow::anyhow!("S3 connection test failed. Check endpoint, region and read/write/list/delete permissions.")) }.await;
    match result {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(get, path = "/api/backups/destinations/{id}/backups", tag = "Backups", summary = "Discover authenticated backups from S3, including on replacement nodes (nodes.manage)", params(("id" = String, Path), ("spaceId" = Option<String>, Query), ("scope" = Option<String>, Query, description = "Use node for an isolated node catalog; omit scope and spaceId to browse all scopes")), responses((status = 200, body = Vec<BackupRecord>), (status = 400, description = "Catalog unavailable, damaged or over 2000 matching records; narrow the scope or destination prefix"), (status = 403, description = "Permission denied")))]
pub async fn list_backups(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    let result = async {
        let scope = query.resolved_scope()?;
        let (_, s3) = global().await?.destination(&id).await?;
        s3.list(scope.as_ref()).await.map_err(|_| anyhow::anyhow!("Could not read the S3 backup catalog. Check connectivity, permissions and the recovery key."))
    }.await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(error),
    }
}

#[cfg(test)]
mod listing_scope_tests {
    use super::*;

    #[test]
    fn explicit_node_and_space_catalogs_are_isolated_while_unspecified_api_lists_all() {
        let query: ListQuery = serde_json::from_value(json!({ "scope": "node" })).unwrap();
        assert_eq!(query.resolved_scope().unwrap(), Some(BackupScope::Node));
        let query: ListQuery = serde_json::from_value(json!({ "spaceId": "space-a" })).unwrap();
        assert_eq!(
            query.resolved_scope().unwrap(),
            Some(BackupScope::Space {
                space_id: "space-a".into()
            })
        );
        let query: ListQuery = serde_json::from_value(json!({})).unwrap();
        assert_eq!(query.resolved_scope().unwrap(), None);
        for value in [
            json!({ "scope": "node", "spaceId": "space-a" }),
            json!({ "scope": "app" }),
        ] {
            let query: ListQuery = serde_json::from_value(value).unwrap();
            assert!(query.resolved_scope().is_err());
        }
    }
}

#[utoipa::path(post, path = "/api/backups/policies", tag = "Backups", summary = "Upsert a UTC cron schedule and retention for a destination/scope (nodes.manage)", request_body = SaveBackupPolicy, responses((status = 200, body = BackupPolicy), (status = 400, description = "Invalid cron, retention or scope"), (status = 403, description = "Permission denied")))]
pub async fn save_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<SaveBackupPolicy>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match async { global().await?.save_policy(body).await }.await {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(delete, path = "/api/backups/policies/{id}", tag = "Backups", summary = "Remove a backup schedule (nodes.manage)", params(("id" = String, Path)), responses((status = 204, description = "Removed"), (status = 403, description = "Permission denied")))]
pub async fn remove_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match async { global().await?.delete_policy(&id).await }.await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(post, path = "/api/backups/runs", tag = "Backups", summary = "Queue a node or Space backup (nodes.manage); idempotencyKey prevents duplicate jobs", request_body = CreateBackup, responses((status = 202, body = BackupOperation), (status = 400, description = "Invalid scope, idempotency conflict, or queue full"), (status = 403, description = "Permission denied")))]
pub async fn create_backup(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<CreateBackup>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    let result = async { global().await?.create(state, body, None).await }.await;
    match result {
        Ok(value) => (StatusCode::ACCEPTED, Json(value)).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(post, path = "/api/backups/restore", tag = "Backups", summary = "Restore a new private Space or stage a node recovery directory, or preview the recovery plan; originals remain (nodes.manage)", request_body = RestoreBackup, responses((status = 202, body = BackupOperation), (status = 200, description = "Dry-run recovery plan", body = BackupOperation), (status = 400, description = "Invalid backup or idempotency conflict"), (status = 403, description = "Permission denied")))]
pub async fn restore_backup(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<RestoreBackup>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    let owner = super::spaces::owner_of(&super::caller_tenancy(&caller));
    let result = async { global().await?.restore(state, body, owner, None).await }.await;
    match result {
        Ok(value) => (StatusCode::ACCEPTED, Json(value)).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(get, path = "/api/backups/operations/{id}", tag = "Backups", summary = "Read a persisted backup/restore operation (nodes.manage)", params(("id" = String, Path)), responses((status = 200, body = BackupOperation), (status = 404, description = "Operation not found"), (status = 403, description = "Permission denied")))]
pub async fn operation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&state, &caller).await {
        return response;
    }
    match global().await {
        Ok(service) => match service.operation(&id).await {
            Some(value) => Json(value).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        Err(error) => failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failure_response_limits_and_redacts_provider_details() {
        let response = failure(
            anyhow::anyhow!(
                "credential=private-token and signed-url=https://s3.example/?sig=secret"
            )
            .context("S3 connection validation failed"),
        );
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "backup_request_failed");
        assert_eq!(body["error"], "S3 connection validation failed");
        let rendered = body.to_string();
        assert!(!rendered.contains("private-token"));
        assert!(!rendered.contains("sig=secret"));

        let long_error = failure(anyhow::anyhow!("x".repeat(400)));
        let body = axum::body::to_bytes(long_error.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"].as_str().unwrap().chars().count(), 320);
    }

    #[test]
    fn backup_list_query_uses_camel_case_and_rejects_unknown_fields() {
        let query: ListQuery = serde_json::from_value(json!({ "spaceId": "space-1" })).unwrap();
        assert_eq!(query.space_id.as_deref(), Some("space-1"));

        assert!(serde_json::from_value::<ListQuery>(json!({ "space_id": "space-1" })).is_err());
        assert!(serde_json::from_value::<ListQuery>(json!({ "unknown": true })).is_err());
    }
}

#[cfg(test)]
#[path = "backups_routes_test.rs"]
mod routes_test;
