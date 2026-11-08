//! `PUT /api/vault/agent-accounts/login-urls`: set or replace the login URLs
//! (`submit_urls`) of one existing agent account.
//!
//! In a session Box the egress sidecar substitutes an account's password only
//! in a `POST` to one of its login URLs, so these URLs govern where a fill's
//! value can go. The route is narrow on purpose: it changes nothing else on
//! the account, validates the URLs with the create rules
//! ([`crate::vault::agent_accounts::fill_target`]), needs the same
//! authorization as account create (`write` on the agent's folder, an
//! unprotected folder or an admin, and an agent allowed accounts of its own),
//! and writes an `agent_account.login_urls` audit row with the URLs before and
//! after. The account is addressed in the body, so an agent's declarative tool
//! can call the route with Core's `agent_id` query parameter; an account in
//! another agent's folder is not found.

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::put;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::vault_api::{ctx, invalid_request, respond, vault_error, Ctx};
use super::super::vault_items_api::require_unprotected_or_admin;
use super::super::ServerState;
use super::{account_policy, folder_key, require_own_accounts, AccountQuery};
use crate::agent_access::AgentAccountPolicy;
use crate::identity_verify::VerifiedCaller;
use crate::vault::agent_accounts::fill_target::{self, LoginUrlChange};
use crate::vault::audit::AuditEntry;
use crate::vault::policy::Capability;

/// The route path.
pub(super) const LOGIN_URLS_PATH: &str = "/api/vault/agent-accounts/login-urls";
/// The audit action of a change.
pub(super) const AUDIT_ACTION: &str = "agent_account.login_urls";

/// The login URL route, merged into the agent account router.
pub fn routes() -> Router<ServerState> {
    Router::new().route(
        LOGIN_URLS_PATH,
        put(login_urls_set).layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
    )
}

/// Body of a change: the account and its complete new list of login URLs
/// (at most four; empty clears them).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginUrlsBody {
    pub account: String,
    pub submit_urls: Vec<String>,
}

/// PUT /api/vault/agent-accounts/login-urls.
#[utoipa::path(put, path = "/api/vault/agent-accounts/login-urls", tag = "Vault",
    summary = "Set or replace the login URLs of an agent's website account",
    description = "Login URLs decide where a session Box fill may submit the account's password. \
        Validated like account create: https, the account's host, its www. variant or a \
        subdomain, no user name, port, query or fragment, at most four. Audited with the URLs \
        before and after.",
    params(("agent_id" = Option<String>, Query, description = "Agent that owns the account (set by Core)")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The account (metadata only)", body = serde_json::Value),
        (status = 400, description = "A login URL breaks a rule"),
        (status = 404, description = "No such account for this agent"),
        (status = 409, description = "The account predates login URLs"),
    ))]
pub async fn login_urls_set(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<AccountQuery>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let policy = match account_policy(&state, query.agent_id.as_deref()).await {
        Ok(policy) => policy,
        Err(response) => return response,
    };
    set(&ctx, &query, body, policy.as_ref()).await
}

pub(super) async fn set(
    ctx: &Ctx,
    query: &AccountQuery,
    body: Value,
    policy: Option<&AgentAccountPolicy>,
) -> Response {
    if let Err(response) = require_own_accounts(policy) {
        return response;
    }
    let agent_id = query.agent_id.as_deref();
    let input: LoginUrlsBody = match serde_json::from_value(body) {
        Ok(input) => input,
        Err(error) => return invalid_request(&error.to_string()),
    };
    let folder = match folder_key(agent_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&folder.policy_key(), Capability::Write) {
        return response;
    }
    if let Err(response) = require_unprotected_or_admin(ctx, &folder).await {
        return response;
    }
    let actor = ctx.actor();
    let change = match fill_target::set_submit_urls(
        ctx.store,
        agent_id,
        &input.account,
        &input.submit_urls,
        &actor,
    )
    .await
    {
        Ok(change) => change,
        Err(error) => return vault_error(error),
    };
    if !audit(ctx, agent_id, &change).await {
        // A change nobody can see must not stand: put the old URLs back.
        let restored = fill_target::set_submit_urls(
            ctx.store,
            agent_id,
            &input.account,
            &change.before,
            &actor,
        )
        .await;
        if let Err(error) = restored {
            tracing::error!("could not restore login URLs after an audit failure: {error:#}");
        }
        return vault_error(crate::vault::VaultError::AuditUnavailable.into());
    }
    respond(json!({ "account": change.account }))
}

async fn audit(ctx: &Ctx, agent_id: Option<&str>, change: &LoginUrlChange) -> bool {
    let entry = AuditEntry::new(&ctx.actor(), AUDIT_ACTION, "ok").details(json!({
        "agentId": agent_id,
        "account": change.account.id,
        "host": change.account.host,
        "before": change.before,
        "after": change.account.submit_urls,
    }));
    ctx.store.audit(&entry).await
}

#[cfg(test)]
#[path = "login_urls_tests.rs"]
mod tests;
