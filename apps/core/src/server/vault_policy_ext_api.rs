//! Policy-extension routes (HashiCorp Vault / OpenBao parity).
//!
//! * `GET  /api/vault/capabilities-self?paths=a,b`: the caller's capabilities
//!   on each policy key (`sys/...` or `ENV/folder/NAME`), with identity
//!   templates expanded, and whether a control group gates `read` there.
//!   Scope baselines for individual values are on the secret list wire.
//! * `GET  /api/vault/control-groups`: requests the caller opened or may
//!   approve (`admin` on `sys/control-groups` sees all).
//! * `GET  /api/vault/control-groups/{id}`: one request (requester, approver,
//!   or admin).
//! * `POST /api/vault/control-groups/{id}/authorize`: approve as a named
//!   approver; requesters can never approve their own request.
//! * `POST /api/vault/control-groups/{id}/redeem`: the requester exchanges the
//!   one-time token for the value once every factor is satisfied.
//!
//! A reveal of a value gated by a control group (see
//! [`crate::vault::policy_ext`]) answers `202` with the pending request and its
//! token instead of the value; [`open_control_group`] does that.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    ctx, invalid_request, respond, rfc3339_fields, vault_error, Ctx, MAX_REQUEST_BODY_BYTES,
};
use super::{json_error, no_store_response, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::SecretCoords;
use crate::vault::audit::AuditEntry;
use crate::vault::policy::Capability;
use crate::vault::policy_ext::{self, ControlGroupRequest, ControlGroupSpec};
use crate::vault::VaultError;

/// Maximum paths per capabilities-self query.
pub const MAX_CAPABILITY_PATHS: usize = 64;
const ADMIN_KEY: &str = "sys/control-groups";

/// Policy-extension routes (node bearer).
pub fn routes() -> Router<ServerState> {
    let body = || DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route("/api/vault/capabilities-self", get(capabilities_self))
        .route("/api/vault/control-groups", get(list_control_groups))
        .route("/api/vault/control-groups/:id", get(get_control_group))
        .route(
            "/api/vault/control-groups/:id/authorize",
            post(authorize_control_group).layer(body()),
        )
        .route(
            "/api/vault/control-groups/:id/redeem",
            post(redeem_control_group).layer(body()),
        )
}

/// The requester/approver identity of a verified caller.
fn principal(ctx: &Ctx) -> Result<String, Response> {
    ctx.caller
        .as_ref()
        .map(|caller| format!("user:{}", caller.user_id))
        .ok_or_else(|| {
            json_error(
                StatusCode::UNAUTHORIZED,
                "vault_user_required: control groups need a signed-in user".to_owned(),
            )
        })
}

fn is_admin(ctx: &Ctx) -> bool {
    ctx.sys_caps(ADMIN_KEY).contains(&Capability::Admin)
}

fn not_found() -> Response {
    json_error(
        StatusCode::NOT_FOUND,
        "vault_not_found: control-group request not found".to_owned(),
    )
}

/// Open a control-group request for a gated reveal of `coords` (`202`).
pub(super) async fn open_control_group(
    ctx: &Ctx,
    coords: &SecretCoords,
    version: Option<i64>,
    spec: &ControlGroupSpec,
) -> Response {
    let requester = match principal(ctx) {
        Ok(requester) => requester,
        Err(response) => return response,
    };
    let key = coords.policy_key();
    // Pin the version current now, so approval releases the value that was
    // requested rather than whatever is current at redemption.
    let version = match version {
        Some(version) => version,
        None => match ctx.store.secret_info(coords).await {
            Ok(Some(info)) if info.deleted_at.is_none() => info.version,
            Ok(_) => {
                return json_error(StatusCode::NOT_FOUND, "vault_not_found: secret".to_owned())
            }
            Err(error) => return vault_error(error),
        },
    };
    let target = json!({ "coords": coords, "version": version });
    let now = crate::vault::now_millis();
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = policy_ext::prune(&conn, now) {
        tracing::warn!("pruning control-group requests failed: {error:#}");
    }
    let (request, token) =
        match policy_ext::create_request(&conn, &requester, &key, &target, spec, now) {
            Ok(created) => created,
            Err(error) => return vault_error(error),
        };
    ctx.store.audit_locked(
        &conn,
        &AuditEntry::new(&ctx.actor(), "control_group.open", "pending")
            .details(json!({ "id": request.id, "key": key })),
    );
    drop(conn);
    no_store_response(
        (
            StatusCode::ACCEPTED,
            Json(rfc3339_fields(json!({
                "ok": true,
                "controlGroup": request,
                "token": token,
            }))),
        )
            .into_response(),
    )
}

#[derive(Debug, Deserialize)]
pub struct CapabilitiesQuery {
    /// Comma-separated policy keys.
    paths: String,
}

/// GET /api/vault/capabilities-self.
#[utoipa::path(get, path = "/api/vault/capabilities-self", tag = "Vault",
    summary = "The caller's capabilities on policy keys (templates expanded)",
    params(("paths" = String, Query, description = "Comma-separated policy keys")),
    responses((status = 200, description = "Capabilities per key", body = serde_json::Value)))]
pub async fn capabilities_self(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<CapabilitiesQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let paths: Vec<&str> = query
        .paths
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect();
    if paths.is_empty() || paths.len() > MAX_CAPABILITY_PATHS {
        return invalid_request(&format!(
            "paths must list between 1 and {MAX_CAPABILITY_PATHS} keys"
        ));
    }
    let templates = ctx.template_context();
    let gated = ctx.caller.is_some();
    let mut out = serde_json::Map::new();
    for path in paths {
        let control_group = gated
            && policy_ext::control_group_for(&ctx.policies, path, Capability::Read, &templates)
                .is_some();
        out.insert(
            path.to_owned(),
            json!({
                "capabilities": ctx.sys_caps(path),
                "controlGroup": control_group,
            }),
        );
    }
    respond(json!({ "paths": out }))
}

/// GET /api/vault/control-groups.
#[utoipa::path(get, path = "/api/vault/control-groups", tag = "Vault",
    summary = "Control-group requests the caller opened or may approve",
    responses((status = 200, description = "Requests (never tokens or values)", body = serde_json::Value)))]
pub async fn list_control_groups(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let subjects = ctx.subjects();
    let all = is_admin(&ctx);
    let now = crate::vault::now_millis();
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = policy_ext::prune(&conn, now) {
        tracing::warn!("pruning control-group requests failed: {error:#}");
    }
    match policy_ext::list_requests(&conn, &subjects, all, now) {
        Ok(requests) => respond(json!({ "controlGroups": requests })),
        Err(error) => vault_error(error),
    }
}

fn visible(ctx: &Ctx, request: &ControlGroupRequest) -> bool {
    let subjects = ctx.subjects();
    subjects.contains(&request.requester) || request.is_approver(&subjects) || is_admin(ctx)
}

/// GET /api/vault/control-groups/{id}.
#[utoipa::path(get, path = "/api/vault/control-groups/{id}", tag = "Vault",
    summary = "One control-group request",
    params(("id" = String, Path, description = "Request id")),
    responses((status = 200, description = "Request", body = serde_json::Value)))]
pub async fn get_control_group(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let conn = ctx.store.conn.lock().await;
    match policy_ext::get_request(&conn, &id, crate::vault::now_millis()) {
        Ok(Some(request)) if visible(&ctx, &request) => respond(json!({ "controlGroup": request })),
        Ok(_) => not_found(),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/control-groups/{id}/authorize.
#[utoipa::path(post, path = "/api/vault/control-groups/{id}/authorize", tag = "Vault",
    summary = "Approve a control-group request as a named approver",
    params(("id" = String, Path, description = "Request id")),
    responses((status = 200, description = "Updated request", body = serde_json::Value)))]
pub async fn authorize_control_group(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    authorize_request(&ctx, &id).await
}

/// Approve request `id` as the calling user.
pub(super) async fn authorize_request(ctx: &Ctx, id: &str) -> Response {
    let approver = match principal(ctx) {
        Ok(approver) => approver,
        Err(response) => return response,
    };
    let subjects = ctx.subjects();
    let conn = ctx.store.conn.lock().await;
    let now = crate::vault::now_millis();
    // Hide requests the caller has no relation to.
    match policy_ext::get_request(&conn, id, now) {
        Ok(Some(request)) if visible(ctx, &request) => {}
        Ok(_) => return not_found(),
        Err(error) => return vault_error(error),
    }
    let result = policy_ext::authorize(&conn, id, &approver, &subjects, now);
    let outcome = if result.is_ok() { "ok" } else { "denied" };
    ctx.store.audit_locked(
        &conn,
        &AuditEntry::new(&ctx.actor(), "control_group.authorize", outcome)
            .details(json!({ "id": id })),
    );
    match result {
        Ok(request) => respond(json!({ "ok": true, "controlGroup": request })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
pub struct RedeemBody {
    token: String,
}

/// POST /api/vault/control-groups/{id}/redeem.
#[utoipa::path(post, path = "/api/vault/control-groups/{id}/redeem", tag = "Vault",
    summary = "Redeem an approved control-group token for the value (single use)",
    params(("id" = String, Path, description = "Request id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Value", body = serde_json::Value)))]
pub async fn redeem_control_group(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<RedeemBody>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    redeem_request(&ctx, &id, &body.token).await
}

fn target_coords(request: &ControlGroupRequest) -> Option<(SecretCoords, Option<i64>)> {
    let coords = serde_json::from_value(request.target.get("coords")?.clone()).ok()?;
    Some((
        coords,
        request.target.get("version").and_then(Value::as_i64),
    ))
}

/// Redeem `token` for request `id` as the calling user. `read` and the current
/// control group are rechecked before the single-use token is spent, and a
/// failed reveal gives the token
/// back, so only a released value consumes an approval.
pub(super) async fn redeem_request(ctx: &Ctx, id: &str, token: &str) -> Response {
    let requester = match principal(ctx) {
        Ok(requester) => requester,
        Err(response) => return response,
    };
    // The id in the path must be the one the token names.
    if !token
        .strip_prefix("vcg_")
        .and_then(|rest| rest.split_once('.'))
        .is_some_and(|(token_id, _)| token_id == id)
    {
        return not_found();
    }
    let audit = |conn: &rusqlite::Connection, outcome: &str| {
        ctx.store.audit_locked(
            conn,
            &AuditEntry::new(&ctx.actor(), "control_group.redeem", outcome)
                .details(json!({ "id": id })),
        );
    };
    let now = crate::vault::now_millis();
    let (request, coords, version) = {
        let conn = ctx.store.conn.lock().await;
        let pending = match policy_ext::verify_token(&conn, token, &requester) {
            Ok((request, _)) => request,
            Err(error) => {
                audit(&conn, "denied");
                return vault_error(error);
            }
        };
        let Some((coords, version)) = target_coords(&pending) else {
            audit(&conn, "denied");
            return invalid_request("control-group target is not a value");
        };
        // Approval does not outlive a policy change that removed `read`.
        if let Err(response) = ctx.require(&coords, Capability::Read) {
            audit(&conn, "denied");
            return response;
        }
        // Nor does it outlive a change to the control group itself: approvals
        // count only against the group that gates the key now. An ungated key
        // (`None`) is readable directly, so releasing it is harmless.
        if let Some(current) = ctx.read_control_group(&coords) {
            if !pending.matches_spec(&current) {
                audit(&conn, "denied");
                return vault_error(
                    VaultError::Conflict(
                        "control-group policy changed; open a new request".to_owned(),
                    )
                    .into(),
                );
            }
        }
        let result = policy_ext::redeem(&conn, token, &requester, now);
        audit(&conn, if result.is_ok() { "ok" } else { "denied" });
        match result {
            Ok(request) => (request, coords, version),
            Err(error) => return vault_error(error),
        }
    };
    match ctx.store.reveal(&coords, version, &ctx.actor()).await {
        Ok(value) => respond(json!({ "value": value, "controlGroup": request })),
        Err(error) => {
            let conn = ctx.store.conn.lock().await;
            if let Err(undo) = policy_ext::unredeem(&conn, &request.id) {
                tracing::warn!("restoring control-group request failed: {undo:#}");
            }
            vault_error(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::{OrgRole, VerifiedCaller};
    use crate::plugin_secrets::{PluginSecretStore, SecretScope};
    use crate::vault::policy::{Policy, PolicyRule};
    use crate::vault::policy_ext::ControlGroupFactor;

    fn user(id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn gate(read: bool) -> Policy {
        Policy {
            name: "gate".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "**".into(),
                capabilities: vec![Capability::Read],
                deny: !read,
                control_group: read.then(|| ControlGroupSpec {
                    ttl_secs: None,
                    factors: vec![ControlGroupFactor {
                        name: "security".into(),
                        approvers: vec!["user:bob".into()],
                        approvals: 1,
                    }],
                }),
                ..Default::default()
            }],
        }
    }

    fn ctx_for(store: &'static PluginSecretStore, id: &str, policy: Policy) -> Ctx {
        Ctx {
            store,
            node: None,
            node_id: "node-1".to_owned(),
            caller: Some(user(id)),
            manager: true,
            policies: vec![policy],
            jwt: None,
        }
    }

    async fn body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn gated_reveal_needs_an_approver_and_redeems_once() {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        store
            .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v1")
            .await
            .unwrap();
        let alice = ctx_for(store, "alice", gate(true));
        let bob = ctx_for(store, "bob", gate(true));
        let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
        assert!(!alice.can_read_directly(&coords), "exports must skip it");
        let spec = alice.read_control_group(&coords).expect("gated");

        let response = open_control_group(&alice, &coords, None, &spec).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let opened = body_json(response).await;
        assert!(opened.get("value").is_none());
        let id = opened["controlGroup"]["id"].as_str().unwrap().to_owned();
        let token = opened["token"].as_str().unwrap().to_owned();
        assert_eq!(opened["controlGroup"]["target"]["version"], 1);

        // Redeeming before approval fails and does not spend anything.
        let early = redeem_request(&alice, &id, &token).await;
        assert_eq!(early.status(), StatusCode::CONFLICT);
        // The requester can never approve their own request.
        let own = authorize_request(&alice, &id).await;
        assert_eq!(own.status(), StatusCode::FORBIDDEN);
        let approved = authorize_request(&bob, &id).await;
        assert_eq!(approved.status(), StatusCode::OK);
        assert_eq!(
            body_json(approved).await["controlGroup"]["status"],
            "approved"
        );

        // The value changes after the request: the pinned version is released.
        store
            .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v2")
            .await
            .unwrap();

        // Losing `read` blocks redemption without spending the token.
        let revoked = ctx_for(store, "alice", gate(false));
        let denied = redeem_request(&revoked, &id, &token).await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        // Only the requester can redeem.
        let stolen = redeem_request(&bob, &id, &token).await;
        assert_eq!(stolen.status(), StatusCode::NOT_FOUND);

        let redeemed = redeem_request(&alice, &id, &token).await;
        assert_eq!(redeemed.status(), StatusCode::OK);
        assert_eq!(body_json(redeemed).await["value"], "v1");
        let again = redeem_request(&alice, &id, &token).await;
        assert_eq!(again.status(), StatusCode::CONFLICT);
    }

    fn gate_with(factors: &[(&str, &[&str], u8)]) -> Policy {
        let mut policy = gate(true);
        policy.rules[0].control_group = Some(ControlGroupSpec {
            ttl_secs: None,
            factors: factors
                .iter()
                .map(|(name, approvers, approvals)| ControlGroupFactor {
                    name: (*name).into(),
                    approvers: approvers.iter().map(|s| (*s).to_owned()).collect(),
                    approvals: *approvals,
                })
                .collect(),
        });
        policy
    }

    #[tokio::test]
    async fn redeem_rechecks_the_current_control_group() {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        store
            .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v1")
            .await
            .unwrap();
        let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
        let alice = ctx_for(store, "alice", gate(true));
        let bob = ctx_for(store, "bob", gate(true));
        let spec = alice.read_control_group(&coords).unwrap();
        let opened = body_json(open_control_group(&alice, &coords, None, &spec).await).await;
        let id = opened["controlGroup"]["id"].as_str().unwrap().to_owned();
        let token = opened["token"].as_str().unwrap().to_owned();
        assert_eq!(authorize_request(&bob, &id).await.status(), StatusCode::OK);

        // Narrowed approvers and a raised count: bob's approval no longer counts.
        let narrowed = ctx_for(
            store,
            "alice",
            gate_with(&[("security", &["user:carol", "user:dave"], 2)]),
        );
        let denied = redeem_request(&narrowed, &id, &token).await;
        assert_eq!(denied.status(), StatusCode::CONFLICT);
        assert!(body_json(denied).await["error"]
            .as_str()
            .unwrap_or_default()
            .contains("control-group policy changed"));
        // An added factor is refused too.
        let added = ctx_for(
            store,
            "alice",
            gate_with(&[("security", &["user:bob"], 1), ("legal", &["user:erin"], 1)]),
        );
        let denied = redeem_request(&added, &id, &token).await;
        assert_eq!(denied.status(), StatusCode::CONFLICT);

        // The refusals spent nothing: under the unchanged group (approver
        // order aside) the requester still redeems once.
        let unchanged = ctx_for(store, "alice", gate_with(&[("security", &["user:bob"], 1)]));
        let redeemed = redeem_request(&unchanged, &id, &token).await;
        assert_eq!(redeemed.status(), StatusCode::OK);
        assert_eq!(body_json(redeemed).await["value"], "v1");
    }

    #[test]
    fn matches_spec_ignores_order_but_not_content() {
        let factor = |name: &str, approvers: &[&str], approvals: u8| ControlGroupFactor {
            name: name.into(),
            approvers: approvers.iter().map(|s| (*s).to_owned()).collect(),
            approvals,
        };
        let request = ControlGroupRequest {
            id: "id".into(),
            requester: "user:alice".into(),
            policy_key: "k".into(),
            target: Value::Null,
            factors: vec![
                factor("p/0/a", &["user:bob", "team:ops"], 1),
                factor("p/0/b", &["user:carol"], 1),
            ],
            approvals: Vec::new(),
            status: policy_ext::ControlGroupStatus::Approved,
            created_at: 0,
            expires_at: 1,
            redeemed_at: None,
        };
        let spec = |factors| ControlGroupSpec {
            ttl_secs: None,
            factors,
        };
        assert!(request.matches_spec(&spec(vec![
            factor("p/0/b", &["user:carol"], 1),
            factor("p/0/a", &["team:ops", "user:bob"], 1),
        ])));
        assert!(!request.matches_spec(&spec(vec![
            factor("p/0/a", &["user:bob", "team:ops"], 2),
            factor("p/0/b", &["user:carol"], 1),
        ])));
        assert!(!request.matches_spec(&spec(vec![
            factor("p/0/a", &["user:bob"], 1),
            factor("p/0/b", &["user:carol"], 1),
        ])));
        assert!(!request.matches_spec(&spec(vec![factor(
            "p/0/a",
            &["user:bob", "team:ops"],
            1
        )])));
    }

    #[tokio::test]
    async fn open_requests_are_capped_per_requester() {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        store
            .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v1")
            .await
            .unwrap();
        let alice = ctx_for(store, "alice", gate(true));
        let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
        let spec = alice.read_control_group(&coords).unwrap();
        for _ in 0..policy_ext::MAX_OPEN_REQUESTS_PER_REQUESTER {
            let response = open_control_group(&alice, &coords, None, &spec).await;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
        }
        let flooded = open_control_group(&alice, &coords, None, &spec).await;
        assert_eq!(flooded.status(), StatusCode::CONFLICT);
        // Another requester is unaffected.
        let carol = ctx_for(store, "carol", gate(true));
        let response = open_control_group(&carol, &coords, None, &spec).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }
}
