//! Password-manager credential routes under `/api/vault/password-managers`:
//! 1Password (Connect or a service account) and Bitwarden Secrets Manager
//! accounts, the explicit read API, approvals, and grants.
//!
//! Every route is human-only under the node bearer and authorizes against
//! `sys/password-managers/<account>`: `admin` adds, tests, reconnects, or
//! removes an account, approves or rejects its credential-use requests, and
//! revokes its grants; `read` lets a human read a reference through
//! `POST …/read` (which itself needs an approval for that human); any
//! capability makes the account, its requests, and its grants visible.
//! Configuration managers and the unbound local operator hold every
//! capability by baseline. No response carries an account token; only the
//! approved `read` carries a value. See [`crate::vault::password_managers`].

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    ctx, invalid_request, respond, rfc3339_fields, try_response, vault_error, Ctx,
};
use super::{json_error, no_store_response, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::vault::broker::proposals::{Proposal, ProposalStatus};
use crate::vault::password_managers::providers::{FailureKind, ProviderFailure};
use crate::vault::password_managers::{
    account_key, read_subject, AccountInput, Consumer, GrantMode, PmOutcome, PmRef,
};
use crate::vault::policy::Capability;

/// Password-manager routes, merged into the authenticated vault router.
pub fn routes() -> Router<ServerState> {
    let body = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route(
            "/api/vault/password-managers/accounts",
            get(account_list).post(account_create).layer(body()),
        )
        .route(
            "/api/vault/password-managers/accounts/:id",
            delete(account_delete),
        )
        .route(
            "/api/vault/password-managers/accounts/:id/test",
            post(account_test),
        )
        .route(
            "/api/vault/password-managers/accounts/:id/token",
            post(account_token).layer(body()),
        )
        .route(
            "/api/vault/password-managers/read",
            post(read_reference).layer(body()),
        )
        .route("/api/vault/password-managers/grants", get(grant_list))
        .route(
            "/api/vault/password-managers/grants/:id",
            delete(grant_revoke),
        )
        .route("/api/vault/password-managers/approvals", get(approval_list))
        .route(
            "/api/vault/password-managers/approvals/:id/:decision",
            post(approval_decide).layer(body()),
        )
}

/// The principal a human caller acts as (`user:<id>` or `operator`).
fn principal(ctx: &Ctx) -> String {
    match &ctx.caller {
        Some(caller) => format!("user:{}", caller.user_id),
        None => "operator".to_owned(),
    }
}

fn parse<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, Response> {
    serde_json::from_value(body).map_err(|error| invalid_request(&error.to_string()))
}

/// Map a resolution error: provider failures are sanitized and typed.
fn pm_error(error: anyhow::Error) -> Response {
    let Some(failure) = error.downcast_ref::<ProviderFailure>() else {
        return vault_error(error);
    };
    let (status, code) = match failure.kind {
        FailureKind::Auth => (StatusCode::BAD_GATEWAY, "vault_pm_reconnect_required"),
        FailureKind::NotFound => (StatusCode::NOT_FOUND, "vault_not_found"),
        FailureKind::Unavailable => (StatusCode::BAD_GATEWAY, "vault_pm_unavailable"),
    };
    json_error(status, format!("{code}: {}", failure.message))
}

/// Whether the caller holds any capability on the account (shared with the
/// broker proposal listing).
pub(super) fn visible(ctx: &Ctx, account: &str) -> bool {
    !ctx.sys_caps(&account_key(account)).is_empty()
}

async fn require_account(ctx: &Ctx, id: &str, capability: Capability) -> Result<String, Response> {
    let account = ctx.store.pm_account(id).await.map_err(vault_error)?;
    ctx.require_sys(&account_key(&account.name), capability)?;
    Ok(account.name)
}

// ── Accounts ──────────────────────────────────────────────────────────────

/// GET /api/vault/password-managers/accounts.
#[utoipa::path(get, path = "/api/vault/password-managers/accounts", tag = "Vault",
    summary = "List password-manager accounts (never tokens)",
    responses((status = 200, description = "Accounts", body = serde_json::Value)))]
pub async fn account_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_accounts(&ctx).await
}

async fn list_accounts(ctx: &Ctx) -> Response {
    match ctx.store.pm_account_list().await {
        Ok(accounts) => {
            let visible: Vec<_> = accounts
                .into_iter()
                .filter(|account| visible(ctx, &account.name))
                .collect();
            respond(json!({ "accounts": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/password-managers/accounts.
#[utoipa::path(post, path = "/api/vault/password-managers/accounts", tag = "Vault",
    summary = "Add a 1Password or Bitwarden Secrets Manager account (admin); the token is sealed",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created (no token)", body = serde_json::Value)))]
pub async fn account_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    create_account(&ctx, body).await
}

async fn create_account(ctx: &Ctx, body: Value) -> Response {
    let input: AccountInput = try_response!(parse(body));
    try_response!(ctx.require_sys(&account_key(&input.name), Capability::Admin));
    match ctx.store.pm_account_create(input, &ctx.actor()).await {
        Ok(account) => respond(json!({ "account": account })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/password-managers/accounts/{id}.
#[utoipa::path(delete, path = "/api/vault/password-managers/accounts/{id}", tag = "Vault",
    summary = "Remove a password-manager account, its grants, and its pending approvals (admin)",
    params(("id" = String, Path, description = "Account id")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn account_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_account(&ctx, &id, Capability::Admin).await);
    match ctx.store.pm_account_delete(&id, &ctx.actor()).await {
        Ok(()) => respond(json!({ "deleted": true })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/password-managers/accounts/{id}/test.
#[utoipa::path(post, path = "/api/vault/password-managers/accounts/{id}/test", tag = "Vault",
    summary = "Check a password-manager account's connectivity and token (admin; never reads a value)",
    params(("id" = String, Path, description = "Account id")),
    responses((status = 200, description = "Result and account state", body = serde_json::Value)))]
pub async fn account_test(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_account(&ctx, &id, Capability::Admin).await);
    match ctx.store.pm_account_test(&id, &ctx.actor()).await {
        Ok(account) => respond(json!({ "ok": true, "account": account })),
        Err(error) if error.downcast_ref::<ProviderFailure>().is_some() => {
            let account = ctx.store.pm_account(&id).await.ok();
            respond(json!({ "ok": false, "error": format!("{error:#}"), "account": account }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Deserialize)]
struct TokenBody {
    token: String,
}

/// POST /api/vault/password-managers/accounts/{id}/token.
#[utoipa::path(post, path = "/api/vault/password-managers/accounts/{id}/token", tag = "Vault",
    summary = "Replace a password-manager account's token (admin); marks it connected",
    params(("id" = String, Path, description = "Account id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Account (no token)", body = serde_json::Value)))]
pub async fn account_token(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(require_account(&ctx, &id, Capability::Admin).await);
    let body: TokenBody = try_response!(parse(body));
    match ctx
        .store
        .pm_account_set_token(&id, body.token, &ctx.actor())
        .await
    {
        Ok(account) => respond(json!({ "account": account })),
        Err(error) => vault_error(error),
    }
}

// ── Explicit read ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ReadBody {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    environment: Option<String>,
}

/// POST /api/vault/password-managers/read.
#[utoipa::path(post, path = "/api/vault/password-managers/read", tag = "Vault",
    summary = "Read an op:// or bws:// reference as the calling human (read on the account, plus an approval)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Value", body = serde_json::Value),
        (status = 202, description = "Approval pending; the provider was not contacted", body = serde_json::Value),
    ))]
pub async fn read_reference(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    read_inner(&ctx, body).await
}

async fn read_inner(ctx: &Ctx, body: Value) -> Response {
    let body: ReadBody = try_response!(parse(body));
    let Some(parsed) = PmRef::parse(&body.reference) else {
        return invalid_request("`ref` is not a valid op:// or bws:// reference");
    };
    let account = try_response!(ctx
        .store
        .pm_account_for_ref(&parsed)
        .await
        .map_err(vault_error));
    try_response!(ctx.require_sys(&account_key(&account.name), Capability::Read));
    let subject = read_subject(&principal(ctx));
    let consumer = Consumer {
        subject: subject.clone(),
        requested_by: subject,
        environment: body
            .environment
            .filter(|environment| crate::vault::is_valid_environment(environment))
            .unwrap_or_else(crate::vault::active_environment),
        machine_policies: None,
        // `read` on the account was checked against the caller above.
        policy_subjects: Vec::new(),
    };
    match ctx
        .store
        .pm_resolve(&body.reference, &consumer, &ctx.actor())
        .await
    {
        Ok(PmOutcome::Value(value)) => {
            let Some(value) = value.into_string() else {
                return json_error(
                    StatusCode::BAD_GATEWAY,
                    "vault_pm_unavailable: the value is not valid UTF-8".to_owned(),
                );
            };
            respond(json!({
                "value": value,
                "ref": parsed.qualified(&account.name),
                "account": account.name,
                "provider": account.provider,
            }))
        }
        Ok(PmOutcome::Pending(proposal)) => pending(&proposal),
        Err(error) => pm_error(error),
    }
}

/// `202` with the pending approval request.
fn pending(proposal: &Proposal) -> Response {
    no_store_response(
        (
            StatusCode::ACCEPTED,
            Json(rfc3339_fields(json!({
                "pending": true,
                "approval": proposal,
            }))),
        )
            .into_response(),
    )
}

// ── Grants ────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantQuery {
    /// Include revoked, used, and expired grants.
    #[serde(default)]
    all: bool,
}

/// GET /api/vault/password-managers/grants.
#[utoipa::path(get, path = "/api/vault/password-managers/grants", tag = "Vault",
    summary = "List password-manager grants on visible accounts",
    params(("all" = Option<bool>, Query, description = "Include revoked, used, and expired grants")),
    responses((status = 200, description = "Grants", body = serde_json::Value)))]
pub async fn grant_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<GrantQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    match ctx.store.pm_grant_list(query.all).await {
        Ok(grants) => {
            let visible: Vec<_> = grants
                .into_iter()
                .filter(|grant| visible(&ctx, &grant.account))
                .collect();
            respond(json!({ "grants": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/password-managers/grants/{id}.
#[utoipa::path(delete, path = "/api/vault/password-managers/grants/{id}", tag = "Vault",
    summary = "Revoke a password-manager grant (admin on its account)",
    params(("id" = String, Path, description = "Grant id")),
    responses((status = 200, description = "Revoked grant", body = serde_json::Value)))]
pub async fn grant_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let grant = try_response!(ctx.store.pm_grant(&id).await.map_err(vault_error));
    try_response!(ctx.require_sys(&account_key(&grant.account), Capability::Admin));
    match ctx.store.pm_grant_revoke(&id, &ctx.actor()).await {
        Ok(grant) => respond(json!({ "revoked": true, "grant": grant })),
        Err(error) => vault_error(error),
    }
}

// ── Approvals ─────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct ApprovalQuery {
    #[serde(default)]
    status: Option<ProposalStatus>,
}

/// GET /api/vault/password-managers/approvals.
#[utoipa::path(get, path = "/api/vault/password-managers/approvals", tag = "Vault",
    summary = "List password-manager credential-use requests on visible accounts",
    params(("status" = Option<String>, Query, description = "pending (default), approved, rejected, expired")),
    responses((status = 200, description = "Requests (never values)", body = serde_json::Value)))]
pub async fn approval_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ApprovalQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let status = query.status.unwrap_or(ProposalStatus::Pending);
    match ctx.store.pm_approvals(Some(status)).await {
        Ok(approvals) => {
            let visible: Vec<_> = approvals
                .into_iter()
                .filter(|proposal| {
                    proposal
                        .credential_use
                        .as_ref()
                        .is_some_and(|credential_use| visible(&ctx, &credential_use.account))
                })
                .collect();
            respond(json!({ "approvals": visible }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct DecisionBody {
    /// Approve only: `once`, `1h`, `24h`, or `30d` (the default).
    #[serde(default)]
    grant: Option<GrantMode>,
    #[serde(default)]
    note: String,
}

/// POST /api/vault/password-managers/approvals/{id}/{decision}.
#[utoipa::path(post, path = "/api/vault/password-managers/approvals/{id}/{decision}", tag = "Vault",
    summary = "Approve (once, 1h, 24h, or 30d) or reject a credential-use request (admin on its account)",
    params(
        ("id" = String, Path, description = "Approval id"),
        ("decision" = String, Path, description = "approve or reject"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Decision (and the grant on approval)", body = serde_json::Value)))]
pub async fn approval_decide(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((id, decision)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let body: DecisionBody = match body {
        Some(Json(body)) => try_response!(parse(body)),
        None => DecisionBody::default(),
    };
    match decision.as_str() {
        "approve" => {
            approve_credential_use(&ctx, &id, body.grant.unwrap_or_default(), &body.note).await
        }
        "reject" => reject_credential_use(&ctx, &id, &body.note).await,
        _ => invalid_request("decision must be approve or reject"),
    }
}

/// Require `admin` on the account a credential-use request names.
async fn require_approver(ctx: &Ctx, id: &str) -> Result<(), Response> {
    let proposal = ctx.store.pm_approval(id).await.map_err(vault_error)?;
    let account = proposal
        .credential_use
        .map(|credential_use| credential_use.account)
        .unwrap_or_default();
    ctx.require_sys(&account_key(&account), Capability::Admin)
}

/// Approve credential-use request `id` with `mode` (shared with the broker
/// proposal route).
pub(super) async fn approve_credential_use(
    ctx: &Ctx,
    id: &str,
    mode: GrantMode,
    note: &str,
) -> Response {
    try_response!(require_approver(ctx, id).await);
    match ctx
        .store
        .pm_approve(id, mode, note, &principal(ctx), &ctx.actor())
        .await
    {
        Ok(grant) => respond(json!({ "approved": true, "proposal": id, "grant": grant })),
        Err(error) => vault_error(error),
    }
}

/// Reject credential-use request `id` (shared with the broker proposal
/// route).
pub(super) async fn reject_credential_use(ctx: &Ctx, id: &str, note: &str) -> Response {
    try_response!(require_approver(ctx, id).await);
    match ctx
        .store
        .pm_reject(id, note, &principal(ctx), &ctx.actor())
        .await
    {
        Ok(()) => respond(json!({ "rejected": true })),
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::PluginSecretStore;
    use crate::vault::policy::{Policy, PolicyRule};

    async fn body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn operator(store: &'static PluginSecretStore) -> Ctx {
        Ctx {
            store,
            node: None,
            node_id: "node-1".to_owned(),
            caller: None,
            manager: true,
            policies: Vec::new(),
            jwt: None,
        }
    }

    fn member(store: &'static PluginSecretStore, rules: &[(&str, Capability)]) -> Ctx {
        Ctx::test_member(
            store,
            "u1",
            vec![Policy {
                name: "p".to_owned(),
                description: String::new(),
                rules: rules
                    .iter()
                    .map(|(path, capability)| PolicyRule {
                        path: (*path).to_owned(),
                        capabilities: vec![*capability],
                        ..Default::default()
                    })
                    .collect(),
            }],
        )
    }

    async fn store_with_connect_account() -> &'static PluginSecretStore {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let created = create_account(
            &operator(store),
            json!({
                "name": "work",
                "provider": "1password-connect",
                "address": "http://127.0.0.1:9",
                "token": "connect-token-SEALED",
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let text = body_json(created).await.to_string();
        assert!(!text.contains("connect-token-SEALED"));
        store
    }

    #[tokio::test]
    async fn accounts_never_return_their_token() {
        let store = store_with_connect_account().await;
        let listed = body_json(list_accounts(&operator(store)).await).await;
        assert_eq!(listed["accounts"][0]["name"], "work");
        assert_eq!(listed["accounts"][0]["state"], "connected");
        assert!(!listed.to_string().contains("connect-token-SEALED"));
        // A member with no grant on the account does not see it.
        let hidden = body_json(list_accounts(&member(store, &[])).await).await;
        assert_eq!(hidden["accounts"], json!([]));
        // Request input cannot name a CLI binary.
        let refused = create_account(
            &operator(store),
            json!({
                "name": "cli", "provider": "bitwarden-sm",
                "binary": "/bin/sh", "token": "t",
            }),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn read_answers_202_pending_without_read_it_is_denied() {
        let store = store_with_connect_account().await;
        let denied = read_inner(
            &member(store, &[("sys/password-managers/work", Capability::List)]),
            json!({ "ref": "op://dev/GitHub/token" }),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let reader = member(store, &[("sys/password-managers/work", Capability::Read)]);
        let first = read_inner(&reader, json!({ "ref": "op://dev/GitHub/token" })).await;
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let first = body_json(first).await;
        assert_eq!(first["pending"], true);
        assert_eq!(
            first["approval"]["credentialUse"]["subject"],
            "read:user:u1"
        );
        assert_eq!(
            first["approval"]["credentialUse"]["ref"],
            "op://work@dev/GitHub/token"
        );
        // A retry returns the same request rather than queueing another.
        let again =
            body_json(read_inner(&reader, json!({ "ref": "op://dev/GitHub/token" })).await).await;
        assert_eq!(again["approval"]["id"], first["approval"]["id"]);
        // The reader cannot approve their own request without admin.
        let id = first["approval"]["id"].as_str().unwrap().to_owned();
        let refused = approve_credential_use(&reader, &id, GrantMode::Once, "").await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let approved = approve_credential_use(&operator(store), &id, GrantMode::Hour, "ok").await;
        assert_eq!(approved.status(), StatusCode::OK);
        let approved = body_json(approved).await;
        assert_eq!(approved["grant"]["mode"], "1h");
        assert_eq!(approved["grant"]["subject"], "read:user:u1");
    }

    #[test]
    fn password_manager_routes_need_vault_write_except_listings() {
        use crate::authorization::{Capability as Cap, RoutePolicy};
        use axum::http::Method;
        let write = RoutePolicy::requires([Cap::VaultWrite]);
        for (method, path) in [
            (Method::POST, "/api/vault/password-managers/read"),
            (Method::POST, "/api/vault/password-managers/accounts"),
            (
                Method::POST,
                "/api/vault/password-managers/accounts/pma_1/token",
            ),
            (
                Method::POST,
                "/api/vault/password-managers/approvals/bpr_1/approve",
            ),
            (Method::DELETE, "/api/vault/password-managers/grants/pmg_1"),
        ] {
            assert_eq!(
                super::super::route_policy(&method, path),
                write,
                "{method} {path}"
            );
        }
        assert_eq!(
            super::super::route_policy(&Method::GET, "/api/vault/password-managers/accounts"),
            RoutePolicy::requires([Cap::GatewayRoute])
        );
    }
}
