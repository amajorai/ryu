//! Static-role routes: `/api/vault/static/roles[/:name]`,
//! `POST /api/vault/static/rotate/:name`, `GET /api/vault/static/creds/:name`.
//!
//! Split out of [`super`]; the handlers are re-exported there so their
//! public paths (and OpenAPI `__path_*` items) stay stable.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ok_or;
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::{SecretCoords, SecretScope};
use crate::server::vault_api::{
    ctx, invalid_request, parse_body, respond, try_response, vault_error, Ctx,
};
use crate::server::ServerState;
use crate::vault::dynamic::static_roles::StaticRoleInput;
use crate::vault::policy::Capability;

// ── Static roles ──────────────────────────────────────────────────────────

fn static_key(name: &str) -> String {
    format!("sys/static/{name}")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticTargetBody {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRoleBody {
    #[serde(flatten)]
    role: StaticRoleInput,
    target: StaticTargetBody,
    /// Rotate immediately after saving (default true).
    #[serde(default)]
    rotate_now: Option<bool>,
}

fn static_target(ctx: &Ctx, target: StaticTargetBody) -> Result<SecretCoords, Response> {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: ctx.node_id.clone(),
        environment: target
            .environment
            .unwrap_or_else(|| crate::vault::DEFAULT_ENVIRONMENT.to_owned()),
        path: target
            .path
            .unwrap_or_else(|| crate::vault::ROOT_PATH.to_owned()),
        binding: None,
        name: target.name,
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

/// Rotations write a server-generated value into `target` with no change
/// request, so in a protected environment they are reserved to callers with
/// `admin` on the target (like every other unapproved write path), and a
/// target whose `write` carries parameter constraints cannot be managed: the
/// generated value cannot be checked against them.
async fn require_unapproved_rotation(ctx: &Ctx, target: &SecretCoords) -> Result<(), Response> {
    if crate::server::vault_api::protected_environment(ctx, &target.environment)
        .await?
        .is_some()
        && !ctx.caps(target).contains(&Capability::Admin)
    {
        return Err(crate::server::vault_api::protected_denied(
            &target.environment,
        ));
    }
    if ctx.write_parameters_constrained(target) {
        return Err(crate::server::json_error(
            axum::http::StatusCode::FORBIDDEN,
            format!(
                "vault_denied: parameter constraints apply to `{}`, which a static role's generated value cannot satisfy",
                target.policy_key()
            ),
        ));
    }
    Ok(())
}

/// GET /api/vault/static/roles lists the roles the caller administers.
#[utoipa::path(get, path = "/api/vault/static/roles", tag = "Vault",
    summary = "List static roles (no credentials)",
    responses((status = 200, description = "Static roles", body = serde_json::Value)))]
pub async fn static_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    match ctx.store.static_list_roles().await {
        Ok(roles) => {
            let visible: Vec<_> = roles
                .into_iter()
                .filter(|role| !ctx.sys_caps(&static_key(&role.name)).is_empty())
                .collect();
            respond(json!({ "roles": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/static/roles/{name}.
#[utoipa::path(get, path = "/api/vault/static/roles/{name}", tag = "Vault",
    summary = "Describe a static role (no credentials)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Static role", body = serde_json::Value)))]
pub async fn static_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::List));
    ok_or(ctx.store.static_role(&name).await, "role")
}

/// PUT /api/vault/static/roles/{name}.
#[utoipa::path(put, path = "/api/vault/static/roles/{name}", tag = "Vault",
    summary = "Create or replace a static role (admin; write on the target value)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Static role", body = serde_json::Value)))]
pub async fn static_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::Admin));
    let body: StaticRoleBody = try_response!(parse_body(body));
    let target = try_response!(static_target(&ctx, body.target));
    try_response!(ctx.require(&target, Capability::Write));
    // Checked before the role is saved: once saved, the scheduler rotates it.
    try_response!(require_unapproved_rotation(&ctx, &target).await);
    let actor = ctx.actor();
    // A delegated admin's role may only target public hosts (screened at
    // every rotation); a configuration manager's keeps the host's network.
    let writer = crate::vault::dynamic::target_guard::RoleWriter::from_manager(ctx.manager);
    let role = match ctx
        .store
        .static_put_role_as(&name, &body.role, target, writer, &actor)
        .await
    {
        Ok(role) => role,
        Err(error) => return vault_error(error),
    };
    if !body.rotate_now.unwrap_or(true) {
        return respond(json!({ "role": role }));
    }
    // A failed first rotation keeps the role (it retries on schedule) and is
    // reported alongside it.
    match ctx.store.static_rotate(&name, &actor).await {
        Ok(role) => respond(json!({ "role": role, "rotated": true })),
        Err(error) => respond(json!({
            "role": ctx.store.static_role(&name).await.ok(),
            "rotated": false,
            "rotationError": error.to_string(),
        })),
    }
}

/// DELETE /api/vault/static/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/static/roles/{name}", tag = "Vault",
    summary = "Stop managing a static role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn static_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::Admin));
    ok_or(
        ctx.store
            .static_delete_role(&name, &ctx.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/static/rotate/{name}.
#[utoipa::path(post, path = "/api/vault/static/rotate/{name}", tag = "Vault",
    summary = "Rotate a static role's credential now (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Static role", body = serde_json::Value)))]
pub async fn static_rotate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::Admin));
    // The target's environment may have become protected (or the caller's
    // write constrained) since the role was saved.
    let role = match ctx.store.static_role(&name).await {
        Ok(role) => role,
        Err(error) => return vault_error(error),
    };
    try_response!(require_unapproved_rotation(&ctx, &role.target).await);
    ok_or(ctx.store.static_rotate(&name, &ctx.actor()).await, "role")
}

/// GET /api/vault/static/creds/{name} returns the current credential.
#[utoipa::path(get, path = "/api/vault/static/creds/{name}", tag = "Vault",
    summary = "Read a static role's current credential (read on its target value)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Credential", body = serde_json::Value)))]
pub async fn static_creds(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    static_creds_for(&ctx, &name).await
}

async fn static_creds_for(ctx: &Ctx, name: &str) -> Response {
    try_response!(ctx.require_sys(&static_key(name), Capability::Read));
    let role = match ctx.store.static_role(name).await {
        Ok(role) => role,
        Err(error) => return vault_error(error),
    };
    try_response!(ctx.require(&role.target, Capability::Read));
    // The credential is the target's plaintext: a control group on the target
    // gates it here too (open one through the target's /reveal).
    try_response!(ctx.require_ungated_read(&role.target.policy_key()));
    match ctx.store.static_read(name, &ctx.actor()).await {
        Ok((role, value)) => respond(json!({
            "role": role.name,
            "username": role.summary.get("username").or_else(|| role.summary.get("userName")),
            "value": value,
            "lastRotatedAt": role.last_rotated_at,
            "nextRotationAt": role.next_rotation_at,
        })),
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_role_bodies_flatten_the_role_input() {
        let body: StaticRoleBody = serde_json::from_value(json!({
            "provider": { "kind": "redis", "connectionUrl": "redis://h", "username": "app" },
            "rotationPeriodSecs": 3600,
            "target": { "name": "CACHE_PASSWORD" },
            "rotateNow": false,
        }))
        .unwrap();
        assert_eq!(body.role.provider.kind(), "redis");
        assert_eq!(body.target.name, "CACHE_PASSWORD");
        assert_eq!(body.rotate_now, Some(false));
    }

    #[tokio::test]
    async fn static_creds_honor_control_groups_on_the_target() {
        use crate::plugin_secrets::{PluginSecretStore, SecretCoords, SecretScope};
        use crate::vault::audit::AuditActor;
        use crate::vault::policy::{Policy, PolicyRule};
        use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
        use axum::http::StatusCode;

        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let (url, _log) = crate::vault::dynamic::redis::tests::fake_server(false).await;
        let input = serde_json::from_value(json!({
            "provider": { "kind": "valkey", "connectionUrl": url, "username": "app" },
            "rotationPeriodSecs": 3600,
        }))
        .unwrap();
        let target = SecretCoords::root(SecretScope::Node, "node-1", None, "CACHE_PASSWORD");
        let actor = AuditActor::system();
        store
            .static_put_role("cache", &input, target, &actor)
            .await
            .unwrap();
        store.static_rotate("cache", &actor).await.unwrap();
        let (_, password) = store.static_read("cache", &actor).await.unwrap();

        let ctx = |gated: bool| {
            Ctx::test_member(
                store,
                "user-1",
                vec![Policy {
                    name: "reader".into(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: "**".into(),
                        capabilities: vec![Capability::Read],
                        deny: false,
                        control_group: gated.then(|| ControlGroupSpec {
                            ttl_secs: None,
                            factors: vec![ControlGroupFactor {
                                name: "security".into(),
                                approvers: vec!["user:bob".into()],
                                approvals: 1,
                            }],
                        }),
                        ..Default::default()
                    }],
                }],
            )
        };
        let read = |response: Response| async move {
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            (status, String::from_utf8_lossy(&bytes).into_owned())
        };

        let (status, text) = read(static_creds_for(&ctx(true), "cache").await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
        assert!(text.contains("vault_control_group_required"), "{text}");
        assert!(!text.contains(&password));

        let (status, text) = read(static_creds_for(&ctx(false), "cache").await).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert!(text.contains(&password));
    }

    #[tokio::test]
    async fn static_roles_cannot_bypass_protected_environments_or_constraints() {
        use crate::plugin_secrets::kv::Environment;
        use crate::plugin_secrets::PluginSecretStore;
        use crate::vault::audit::AuditActor;
        use crate::vault::policy::{Policy, PolicyRule};
        use axum::http::StatusCode;

        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let ctx = |capabilities: Vec<Capability>, constrained: bool| {
            Ctx::test_member(
                store,
                "user-1",
                vec![Policy {
                    name: "writer".into(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: "prod/**".into(),
                        capabilities,
                        deny: false,
                        required_parameters: if constrained {
                            vec!["value".into()]
                        } else {
                            Vec::new()
                        },
                        ..Default::default()
                    }],
                }],
            )
        };
        let target = SecretCoords {
            scope: SecretScope::Node,
            scope_id: "node-1".to_owned(),
            environment: "prod".to_owned(),
            path: "/".to_owned(),
            binding: None,
            name: "DB_PASSWORD".to_owned(),
        };
        let status = |result: Result<(), Response>| match result {
            Ok(()) => StatusCode::OK,
            Err(response) => response.status(),
        };
        let writer = ctx(vec![Capability::Write], false);
        assert_eq!(
            status(require_unapproved_rotation(&writer, &target).await),
            StatusCode::OK
        );
        assert_eq!(
            status(require_unapproved_rotation(&ctx(vec![Capability::Write], true), &target).await),
            StatusCode::FORBIDDEN
        );

        store
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
            status(require_unapproved_rotation(&writer, &target).await),
            StatusCode::FORBIDDEN
        );
        let admin = ctx(vec![Capability::Write, Capability::Admin], false);
        assert_eq!(
            status(require_unapproved_rotation(&admin, &target).await),
            StatusCode::OK
        );
    }
}
