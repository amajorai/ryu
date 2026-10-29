//! External secret store routes: OpenBao, HashiCorp Vault, and Infisical
//! connections, folder sources (live or sync), and push destinations.
//!
//! Every route is human-only under the node bearer and authorizes `admin` on
//! `sys/external/<store>`: configuration managers and the unbound local
//! operator hold it by baseline; anyone else needs a policy. Binding a node
//! folder also needs folder-wide capabilities on that folder: `read` and
//! `list` to push it (its plaintext leaves the node), `write` and `delete` to
//! source it (the store replaces its values), plus `admin` in a protected
//! environment, since a source bypasses change requests. A control group on the
//! caller's `read` refuses a push binding, and pushes (including unattended
//! ones) skip any value a control group gates for anyone. A folder whose
//! `write` carries parameter constraints cannot be sourced: synced values are
//! written unattended and cannot be checked against them. Responses never
//! carry store credentials or secret values. See [`crate::vault::external`].

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::{Extension, Json};
use serde_json::{json, Value};

use super::vault_api::{ctx, invalid_request, parse_body, respond, try_response, vault_error, Ctx};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::kv::ListFilter;
use crate::plugin_secrets::{SecretCoords, SecretScope};
use crate::vault::external::{DestinationInput, SourceInput, StoreInput};
use crate::vault::policy::Capability;

/// Names probed for a folder-wide grant. They are not valid secret names and
/// share no character or length, so a rule matches both only when its last
/// segment is all wildcards (`prod/db/*`, `prod/**`); `prod/db/?`,
/// `prod/db/API_*`, or a literal name cannot hand out a whole folder.
const FOLDER_PROBES: [&str; 2] = ["~", "^^"];

fn sys_key(store_name: &str) -> String {
    format!("sys/external/{store_name}")
}

/// Require `admin` on the store `store_id` names; returns its name.
async fn require_store(ctx: &Ctx, store_id: &str) -> Result<String, Response> {
    let store = ctx
        .store
        .external_store(store_id)
        .await
        .map_err(vault_error)?;
    ctx.require_sys(&sys_key(&store.name), Capability::Admin)?;
    Ok(store.name)
}

/// Require `capabilities` on node folder `(environment, path)` at this node,
/// for every value it holds now or later: on the whole folder (see
/// [`FOLDER_PROBES`]) and on each name already in it, so a name-specific deny
/// still wins. Non-recursive, like sources and destinations themselves.
async fn require_folder(
    ctx: &Ctx,
    environment: &str,
    path: &str,
    capabilities: &[Capability],
) -> Result<(), Response> {
    if !crate::vault::is_valid_environment(environment) {
        return Err(invalid_request("invalid environment"));
    }
    let Some(path) = crate::vault::normalize_path(path) else {
        return Err(invalid_request("invalid folder path"));
    };
    let existing = ctx
        .store
        .list_vault_secrets_filtered(&ListFilter {
            environment: Some(environment.to_owned()),
            path: Some(path.clone()),
            recursive: false,
            include_deleted: true,
        })
        .await
        .map_err(vault_error)?;
    let names = FOLDER_PROBES.iter().map(|probe| (*probe).to_owned()).chain(
        existing
            .into_iter()
            .filter(|info| {
                info.scope == SecretScope::Node
                    && info.scope_id == ctx.node_id
                    && info.binding.is_none()
                    && info.path == path
            })
            .map(|info| info.name),
    );
    for name in names {
        let coords = SecretCoords {
            scope: SecretScope::Node,
            scope_id: ctx.node_id.clone(),
            environment: environment.to_owned(),
            path: path.clone(),
            binding: None,
            name,
        };
        for capability in capabilities {
            ctx.require(&coords, *capability)?;
        }
        // A push copies plaintext out without approval: a control group on
        // the caller's read refuses it (unattended pushes also skip any value
        // a control group gates; see `push_inner`).
        if capabilities.contains(&Capability::Read) {
            ctx.require_ungated_read(&coords.policy_key())?;
        }
        // A sync writes whatever the store holds, later and unattended, so
        // it cannot be checked against the caller's parameter constraints;
        // a constrained folder cannot be sourced.
        if capabilities.contains(&Capability::Write) && ctx.write_parameters_constrained(&coords) {
            return Err(super::json_error(
                axum::http::StatusCode::FORBIDDEN,
                format!(
                    "vault_denied: parameter constraints apply to `{}`, which an external source cannot satisfy",
                    coords.policy_key()
                ),
            ));
        }
    }
    Ok(())
}

/// Require what sourcing node folder `(environment, path)` needs: `write`
/// and `delete` on the whole folder and, in a protected environment, `admin`
/// too. A source (live or synced) replaces the folder's values with no change
/// request, so like every other unapproved write path it is reserved to
/// admins there rather than bypassing the configured approvals.
async fn require_source_folder(ctx: &Ctx, environment: &str, path: &str) -> Result<(), Response> {
    require_folder(
        ctx,
        environment,
        path,
        &[Capability::Write, Capability::Delete],
    )
    .await?;
    if super::vault_api::protected_environment(ctx, environment)
        .await?
        .is_some()
    {
        require_folder(ctx, environment, path, &[Capability::Admin])
            .await
            .map_err(|response| {
                if response.status() == axum::http::StatusCode::FORBIDDEN {
                    super::vault_api::protected_denied(environment)
                } else {
                    response
                }
            })?;
    }
    Ok(())
}

fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

/// Store ids the caller may see (any capability on `sys/external/<name>`).
async fn visible_store_ids(ctx: &Ctx) -> Result<Vec<String>, Response> {
    let stores = ctx.store.external_store_list().await.map_err(vault_error)?;
    Ok(stores
        .into_iter()
        .filter(|store| !ctx.sys_caps(&sys_key(&store.name)).is_empty())
        .map(|store| store.id)
        .collect())
}

// ── Stores ────────────────────────────────────────────────────────────────

/// GET /api/vault/external/stores.
#[utoipa::path(get, path = "/api/vault/external/stores", tag = "Vault",
    summary = "List external secret stores (no credentials)",
    responses((status = 200, description = "Stores", body = serde_json::Value)))]
pub async fn store_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let stores = try_response!(ctx.store.external_store_list().await.map_err(vault_error));
    let visible: Vec<_> = stores
        .into_iter()
        .filter(|store| !ctx.sys_caps(&sys_key(&store.name)).is_empty())
        .collect();
    respond(json!({ "stores": visible }))
}

/// POST /api/vault/external/stores.
#[utoipa::path(post, path = "/api/vault/external/stores", tag = "Vault",
    summary = "Connect an OpenBao, HashiCorp Vault, or Infisical store (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn store_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let input: StoreInput = try_response!(parse_body(body));
    try_response!(ctx.require_sys(&sys_key(&input.name), Capability::Admin));
    ok_or(
        ctx.store.external_store_create(input, &ctx.actor()).await,
        "store",
    )
}

/// DELETE /api/vault/external/stores/{id}.
#[utoipa::path(delete, path = "/api/vault/external/stores/{id}", tag = "Vault",
    summary = "Delete an unused external store (admin)",
    params(("id" = String, Path, description = "Store id")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn store_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_store(&ctx, &id).await);
    ok_or(
        ctx.store
            .external_store_delete(&id, &ctx.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/external/stores/{id}/test.
#[utoipa::path(post, path = "/api/vault/external/stores/{id}/test", tag = "Vault",
    summary = "Check an external store's connectivity and credentials (admin)",
    params(("id" = String, Path, description = "Store id")),
    responses((status = 200, description = "Reachable", body = serde_json::Value)))]
pub async fn store_test(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_store(&ctx, &id).await);
    match ctx.store.external_store_test(&id, &ctx.actor()).await {
        Ok(()) => respond(json!({ "ok": true })),
        Err(error) => match error.downcast_ref::<crate::vault::VaultError>() {
            Some(_) => vault_error(error),
            None => respond(json!({ "ok": false, "error": format!("{error:#}") })),
        },
    }
}

// ── Sources ───────────────────────────────────────────────────────────────

/// GET /api/vault/external/sources.
#[utoipa::path(get, path = "/api/vault/external/sources", tag = "Vault",
    summary = "List folders sourced from external stores, with sync status",
    responses((status = 200, description = "Sources", body = serde_json::Value)))]
pub async fn source_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let visible = try_response!(visible_store_ids(&ctx).await);
    let sources = try_response!(ctx.store.external_source_list().await.map_err(vault_error));
    let sources: Vec<_> = sources
        .into_iter()
        .filter(|source| visible.contains(&source.store_id))
        .collect();
    respond(json!({ "sources": sources }))
}

/// POST /api/vault/external/sources.
#[utoipa::path(post, path = "/api/vault/external/sources", tag = "Vault",
    summary = "Source a node folder from an external store, live or synced (admin; write and delete on the folder)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn source_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let input: SourceInput = try_response!(parse_body(body));
    try_response!(require_store(&ctx, &input.store_id).await);
    try_response!(require_source_folder(&ctx, &input.environment, &input.path).await);
    ok_or(
        ctx.store
            .external_source_create(input, &ctx.node_id, &ctx.actor())
            .await,
        "source",
    )
}

async fn require_source(ctx: &Ctx, id: &str) -> Result<(), Response> {
    let source = ctx.store.external_source(id).await.map_err(vault_error)?;
    require_store(ctx, &source.store_id).await.map(|_| ())
}

/// DELETE /api/vault/external/sources/{id}.
#[utoipa::path(delete, path = "/api/vault/external/sources/{id}", tag = "Vault",
    summary = "Stop sourcing a folder (synced values stay as local values) (admin)",
    params(("id" = String, Path, description = "Source id")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn source_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_source(&ctx, &id).await);
    ok_or(
        ctx.store
            .external_source_delete(&id, &ctx.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/external/sources/{id}/sync.
#[utoipa::path(post, path = "/api/vault/external/sources/{id}/sync", tag = "Vault",
    summary = "Sync a source now (live sources refresh their cache) (admin)",
    params(("id" = String, Path, description = "Source id")),
    responses((status = 200, description = "Sync report", body = serde_json::Value)))]
pub async fn source_sync(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_source(&ctx, &id).await);
    match ctx.store.external_sync_source(&id, &ctx.actor()).await {
        Ok(report) => respond(json!({ "report": report })),
        Err(error) if error.downcast_ref::<crate::vault::VaultError>().is_some() => {
            vault_error(error)
        }
        Err(error) => super::json_error(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("vault_external_unavailable: {error:#}"),
        ),
    }
}

// ── Destinations ──────────────────────────────────────────────────────────

/// GET /api/vault/external/destinations.
#[utoipa::path(get, path = "/api/vault/external/destinations", tag = "Vault",
    summary = "List push destinations, with push status",
    responses((status = 200, description = "Destinations", body = serde_json::Value)))]
pub async fn destination_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let visible = try_response!(visible_store_ids(&ctx).await);
    let destinations = try_response!(ctx
        .store
        .external_destination_list()
        .await
        .map_err(vault_error));
    let destinations: Vec<_> = destinations
        .into_iter()
        .filter(|destination| visible.contains(&destination.store_id))
        .collect();
    respond(json!({ "destinations": destinations }))
}

/// POST /api/vault/external/destinations.
#[utoipa::path(post, path = "/api/vault/external/destinations", tag = "Vault",
    summary = "Push a node folder one-way to an external store (admin; read on the folder). KV paths are replaced; Infisical keys are upserted only",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn destination_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let input: DestinationInput = try_response!(parse_body(body));
    try_response!(require_store(&ctx, &input.store_id).await);
    try_response!(
        require_folder(
            &ctx,
            &input.environment,
            &input.path,
            &[Capability::Read, Capability::List],
        )
        .await
    );
    ok_or(
        ctx.store
            .external_destination_create(input, &ctx.node_id, &ctx.actor())
            .await,
        "destination",
    )
}

async fn require_destination(ctx: &Ctx, id: &str) -> Result<(), Response> {
    let destinations = ctx
        .store
        .external_destination_list()
        .await
        .map_err(vault_error)?;
    let Some(destination) = destinations.into_iter().find(|d| d.id == id) else {
        return Err(vault_error(
            crate::vault::VaultError::NotFound(format!("external destination `{id}`")).into(),
        ));
    };
    require_store(ctx, &destination.store_id).await.map(|_| ())
}

/// DELETE /api/vault/external/destinations/{id}.
#[utoipa::path(delete, path = "/api/vault/external/destinations/{id}", tag = "Vault",
    summary = "Stop pushing a folder (remote values stay) (admin)",
    params(("id" = String, Path, description = "Destination id")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn destination_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_destination(&ctx, &id).await);
    ok_or(
        ctx.store
            .external_destination_delete(&id, &ctx.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/external/destinations/{id}/push.
#[utoipa::path(post, path = "/api/vault/external/destinations/{id}/push", tag = "Vault",
    summary = "Push a destination now (admin)",
    params(("id" = String, Path, description = "Destination id")),
    responses((status = 200, description = "Pushed key count", body = serde_json::Value)))]
pub async fn destination_push(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_destination(&ctx, &id).await);
    match ctx.store.external_push(&id, &ctx.actor()).await {
        Ok(count) => respond(json!({ "pushed": count })),
        Err(error) if error.downcast_ref::<crate::vault::VaultError>().is_some() => {
            vault_error(error)
        }
        Err(error) => super::json_error(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("vault_external_unavailable: {error:#}"),
        ),
    }
}

/// Protected routes (node bearer), merged into the vault router.
pub fn routes() -> axum::Router<ServerState> {
    use axum::routing::{delete, get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route(
            "/api/vault/external/stores",
            get(store_list).post(store_create),
        )
        .route("/api/vault/external/stores/:id", delete(store_delete))
        .route("/api/vault/external/stores/:id/test", post(store_test))
        .route(
            "/api/vault/external/sources",
            get(source_list).post(source_create),
        )
        .route("/api/vault/external/sources/:id", delete(source_delete))
        .route("/api/vault/external/sources/:id/sync", post(source_sync))
        .route(
            "/api/vault/external/destinations",
            get(destination_list).post(destination_create),
        )
        .route(
            "/api/vault/external/destinations/:id",
            delete(destination_delete),
        )
        .route(
            "/api/vault/external/destinations/:id/push",
            post(destination_push),
        )
        .layer(limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::OrgRole;
    use crate::plugin_secrets::{
        PluginSecretStore, SecretMetadataPatch, VersionSource, WriteRequest,
    };
    use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};
    use crate::vault::audit::AuditActor;
    use crate::vault::policy::{Policy, PolicyRule};
    use axum::http::StatusCode;

    fn registered_node() -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: "org-1".to_owned(),
                name: "Acme".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        }
    }

    fn member() -> VerifiedCaller {
        VerifiedCaller {
            user_id: "user-1".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn policy(rules: &[(&str, &[Capability], bool)]) -> Policy {
        Policy {
            name: "p".to_owned(),
            description: String::new(),
            rules: rules
                .iter()
                .map(|(path, capabilities, deny)| PolicyRule {
                    path: (*path).to_owned(),
                    capabilities: capabilities.to_vec(),
                    deny: *deny,
                    ..Default::default()
                })
                .collect(),
        }
    }

    /// A registered node with a member caller (not a manager) holding `rules`,
    /// or the unbound local operator when `rules` is `None`.
    async fn make_ctx(rules: Option<&[(&str, &[Capability], bool)]>) -> Ctx {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        store
            .write_secret(WriteRequest {
                coords: SecretCoords {
                    scope: SecretScope::Node,
                    scope_id: "node-1".to_owned(),
                    environment: "prod".to_owned(),
                    path: "/db".to_owned(),
                    binding: None,
                    name: "ROOT_PASSWORD".to_owned(),
                },
                value: Some("v"),
                patch: SecretMetadataPatch::default(),
                actor: &AuditActor::system(),
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
        let (node, caller, manager, policies) = match rules {
            Some(rules) => (
                Some(registered_node()),
                Some(member()),
                false,
                vec![policy(rules)],
            ),
            None => (None, None, true, Vec::new()),
        };
        Ctx {
            store,
            node,
            node_id: "node-1".to_owned(),
            caller,
            manager,
            policies,
            jwt: None,
        }
    }

    const STORE_ONLY: &[(&str, &[Capability], bool)] =
        &[("sys/external/mine", &[Capability::Admin], false)];
    const PUSH: &[Capability] = &[Capability::Read, Capability::List];
    const SOURCE: &[Capability] = &[Capability::Write, Capability::Delete];

    fn status(result: Result<(), Response>) -> StatusCode {
        match result {
            Ok(()) => StatusCode::OK,
            Err(response) => response.status(),
        }
    }

    #[tokio::test]
    async fn a_store_policy_alone_cannot_push_or_source_a_folder() {
        let ctx = make_ctx(Some(STORE_ONLY)).await;
        assert!(ctx.require_sys(&sys_key("mine"), Capability::Admin).is_ok());
        assert!(ctx
            .require_sys(&sys_key("other"), Capability::Admin)
            .is_err());
        assert_eq!(
            status(require_folder(&ctx, "prod", "/db", PUSH).await),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(require_folder(&ctx, "prod", "/db", SOURCE).await),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn folder_grants_must_cover_the_whole_folder() {
        let whole: &[(&str, &[Capability], bool)] = &[
            ("sys/external/mine", &[Capability::Admin], false),
            (
                "prod/db/*",
                &[Capability::Read, Capability::Write, Capability::Delete],
                false,
            ),
        ];
        let ctx = make_ctx(Some(whole)).await;
        assert!(require_folder(&ctx, "prod", "/db", PUSH).await.is_ok());
        assert!(require_folder(&ctx, "prod", "/db", SOURCE).await.is_ok());
        // Non-recursive: a grant on `prod/db/*` does not cover `prod/db/x`.
        assert!(require_folder(&ctx, "prod", "/db/x", PUSH).await.is_err());

        // Name-shaped grants cannot hand out the folder.
        for pattern in [
            "prod/db/ROOT_*",
            "prod/db/?",
            "prod/db/??",
            "prod/db/ROOT_PASSWORD",
        ] {
            let rules: &[(&str, &[Capability], bool)] = &[(pattern, &[Capability::Read], false)];
            let ctx = make_ctx(Some(rules)).await;
            assert!(
                require_folder(&ctx, "prod", "/db", PUSH).await.is_err(),
                "{pattern}"
            );
        }

        // A deny on one existing name wins over a folder-wide grant.
        let denied: &[(&str, &[Capability], bool)] = &[
            ("prod/**", &[Capability::Read], false),
            ("prod/db/ROOT_PASSWORD", &[Capability::Read], true),
        ];
        let ctx = make_ctx(Some(denied)).await;
        assert!(require_folder(&ctx, "prod", "/db", PUSH).await.is_err());
        assert!(require_folder(&ctx, "prod", "/other", PUSH).await.is_ok());
    }

    #[tokio::test]
    async fn the_unbound_operator_may_bind_any_folder_and_bad_folders_are_400() {
        let ctx = make_ctx(None).await;
        assert!(require_folder(&ctx, "prod", "/db", PUSH).await.is_ok());
        assert!(require_folder(&ctx, "prod", "/db", SOURCE).await.is_ok());
        assert!(ctx.require_sys(&sys_key("any"), Capability::Admin).is_ok());
        assert_eq!(
            status(require_folder(&ctx, "Bad Env", "/db", PUSH).await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(require_folder(&ctx, "prod", "/../x", PUSH).await),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn sourcing_a_protected_environment_needs_folder_admin() {
        use crate::plugin_secrets::kv::Environment;
        let writer: &[(&str, &[Capability], bool)] = &[
            ("sys/external/mine", &[Capability::Admin], false),
            (
                "prod/db/*",
                &[Capability::Read, Capability::Write, Capability::Delete],
                false,
            ),
        ];
        let ctx = make_ctx(Some(writer)).await;
        assert!(require_source_folder(&ctx, "prod", "/db").await.is_ok());
        ctx.store
            .put_environment(
                &Environment {
                    slug: "prod".into(),
                    name: "Production".into(),
                    protected: true,
                    required_approvals: 2,
                    position: 0,
                    cas_required: false,
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        assert_eq!(
            status(require_source_folder(&ctx, "prod", "/db").await),
            StatusCode::FORBIDDEN
        );
        // Pushing only reads the folder; protection does not change it.
        assert!(require_folder(&ctx, "prod", "/db", PUSH).await.is_ok());

        let admin: &[(&str, &[Capability], bool)] = &[
            ("sys/external/mine", &[Capability::Admin], false),
            (
                "prod/db/*",
                &[Capability::Write, Capability::Delete, Capability::Admin],
                false,
            ),
        ];
        let mut ctx_admin = make_ctx(Some(admin)).await;
        ctx_admin.store = ctx.store;
        assert!(require_source_folder(&ctx_admin, "prod", "/db")
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn gated_reads_cannot_push_and_constrained_writes_cannot_source() {
        use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
        let whole: &[(&str, &[Capability], bool)] = &[
            ("sys/external/mine", &[Capability::Admin], false),
            (
                "prod/db/*",
                &[Capability::Read, Capability::Write, Capability::Delete],
                false,
            ),
        ];
        let mut gated = make_ctx(Some(whole)).await;
        gated.policies[0].rules[1].control_group = Some(ControlGroupSpec {
            ttl_secs: None,
            factors: vec![ControlGroupFactor {
                name: "security".into(),
                approvers: vec!["user:bob".into()],
                approvals: 1,
            }],
        });
        assert_eq!(
            status(require_folder(&gated, "prod", "/db", PUSH).await),
            StatusCode::FORBIDDEN
        );
        assert!(require_folder(&gated, "prod", "/db", SOURCE).await.is_ok());

        let mut constrained = make_ctx(Some(whole)).await;
        constrained.policies[0].rules[1].required_parameters = vec!["value".into()];
        assert!(require_folder(&constrained, "prod", "/db", PUSH)
            .await
            .is_ok());
        assert_eq!(
            status(require_folder(&constrained, "prod", "/db", SOURCE).await),
            StatusCode::FORBIDDEN
        );
    }
}
