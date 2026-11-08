//! Agent account routes under `/api/vault/agent-accounts`, and the two kernel
//! capabilities a filling sidecar uses (see [`crate::vault::agent_accounts`]).
//!
//! * `GET` lists the calling agent's accounts and `POST` creates one with a
//!   vault-generated password. Both answer with metadata only. The agent is
//!   the Core-owned `agent_id` query parameter that a declarative tool's
//!   `caller_agent_query` appends; authorization is `list`/`write` on the
//!   agent's folder key `sys/items/agents/<folder>` under the node bearer, as
//!   for every typed item.
//! * `vault.credentialFill` releases one field (or the current TOTP code) to a
//!   sidecar that types it into a page, and `vault.totpEnroll` stores a 2FA
//!   seed the sidecar read off a setup page. Both are gated by the reviewed
//!   `vault:fill` grant in the capability broker and bound to the page origin
//!   the sidecar reports. Neither is reachable with the node bearer, so a tool
//!   call can never receive a secret.
//! * The agent's identity mode gates these accounts (see
//!   [`crate::agent_access`]): a `managed` agent the user limited gets none, so
//!   creating one is refused, and filling or enrolling an account needs the
//!   agent's allowlist to name it when the agent has one. A legacy (unlimited
//!   `managed`) agent keeps the accounts it could already create. An account an
//!   agent with an allowlist creates is added to that allowlist, so it can be
//!   used at once. Listing is the user's management view and is not filtered:
//!   it returns metadata only, and the editor needs every account to offer it.
//! * `/api/vault/fill-sets` ([`fill_sets`]) attaches the user's own items to
//!   one agent browser session. The listing reports them under `attached`, and
//!   `vault.credentialFill` fills one by its `attached:<n>` handle for the
//!   browser session that claimed the set.
//! * `PUT /api/vault/agent-accounts/login-urls` ([`login_urls`]) sets an
//!   account's login URLs, which govern where a Box fill's value can go.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{ctx, respond, vault_error, Ctx};
use super::vault_items_api::require_unprotected_or_admin;
use super::ServerState;
use crate::agent_access::AgentAccountPolicy;
use crate::identity_verify::VerifiedCaller;
use crate::vault::agent_accounts::fill_sets::{self as vault_fill_sets, HANDLE_PREFIX};
use crate::vault::agent_accounts::{self, CreateInput, FillField};
use crate::vault::audit::AuditActor;
use crate::vault::items::ItemCoords;
use crate::vault::policy::Capability;

/// Reviewed grant for the fill and enrollment capabilities.
pub(crate) const GRANT_VAULT_FILL: &str = "vault:fill";

/// Agent account routes, merged into the authenticated vault router.
pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/vault/agent-accounts",
            get(account_list)
                .post(account_create)
                .layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
        )
        .merge(fill_sets::routes())
        .merge(login_urls::routes())
}

/// `?agent_id=&site=`.
#[derive(Debug, Default, Deserialize)]
pub struct AccountQuery {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub site: Option<String>,
}

fn agent_actor(agent_id: Option<&str>) -> AuditActor {
    AuditActor::new("agent", agent_id)
}

/// The policy key of an agent's folder, checked like an item key.
fn folder_key(agent_id: Option<&str>) -> Result<ItemCoords, Response> {
    // The key segment is a placeholder: policies on `sys/items/agents/<folder>/*`
    // and on the folder itself both match through the item grammar.
    ItemCoords::new(
        Some(agent_accounts::ENVIRONMENT),
        Some(&agent_accounts::agent_folder(agent_id)),
        "account",
    )
    .map_err(vault_error)
}

/// The account policy of the agent named by a request, read from its record.
/// `None` without an agent id or a record (the unassigned folder and legacy
/// callers keep today's behaviour). A store error refuses rather than reading
/// as unrestricted.
async fn account_policy(
    state: &ServerState,
    agent_id: Option<&str>,
) -> Result<Option<AgentAccountPolicy>, Response> {
    box_fill::policy_for(&state.agent_store, agent_id)
        .await
        .map_err(|error| {
            tracing::warn!("agent account policy lookup failed: {error:#}");
            super::json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent lookup unavailable".to_owned(),
            )
        })
}

fn denied(message: &str) -> Response {
    vault_error(crate::vault::VaultError::Denied(message.to_owned()).into())
}

/// An agent that acts as the user has no accounts of its own.
fn require_own_accounts(policy: Option<&AgentAccountPolicy>) -> Result<(), Response> {
    match policy {
        Some(policy) if !policy.allows_own_accounts() => Err(denied(
            "this agent acts as you and has no accounts of its own; change its identity in the agent's settings",
        )),
        _ => Ok(()),
    }
}

/// Releasing or changing one account's secrets needs the agent to be allowed
/// that account.
fn require_account_allowed(
    policy: Option<&AgentAccountPolicy>,
    account: &str,
) -> Result<(), Response> {
    match box_fill::own_account_refusal(policy, account) {
        Some(refusal) => Err(denied(refusal)),
        None => Ok(()),
    }
}

/// GET /api/vault/agent-accounts.
#[utoipa::path(get, path = "/api/vault/agent-accounts", tag = "Vault",
    summary = "List the calling agent's website accounts (metadata only)",
    params(
        ("agent_id" = Option<String>, Query, description = "Calling agent (set by Core)"),
        ("site" = Option<String>, Query, description = "Only accounts for this URL or host"),
    ),
    responses((status = 200, description = "Accounts", body = serde_json::Value)))]
pub async fn account_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<AccountQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_accounts(&ctx, &query).await
}

async fn list_accounts(ctx: &Ctx, query: &AccountQuery) -> Response {
    let agent_id = query.agent_id.as_deref();
    let folder = match folder_key(agent_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&folder.policy_key(), Capability::List) {
        return response;
    }
    match agent_accounts::list(ctx.store, agent_id, query.site.as_deref()).await {
        Ok(accounts) => respond(json!({
            "accounts": accounts,
            "attached": attached_items(vault_fill_sets::registry(), agent_id),
        })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/agent-accounts.
#[utoipa::path(post, path = "/api/vault/agent-accounts", tag = "Vault",
    summary = "Create a website account for the calling agent with a vault-generated password",
    params(("agent_id" = Option<String>, Query, description = "Calling agent (set by Core)")),
    request_body = serde_json::Value,
    responses((status = 201, description = "Created (no secret is returned)", body = serde_json::Value)))]
pub async fn account_create(
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
    let response = create_account(&ctx, &query, body, policy.as_ref()).await;
    if response.status() != StatusCode::CREATED {
        return response;
    }
    let Some(agent_id) = query.agent_id.as_deref() else {
        return response;
    };
    // An agent with an allowlist could not use the account it just created,
    // so add it to the allowlist; the account is the agent's own.
    let (parts, bytes) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(bytes, 64 * 1024).await else {
        return super::json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "account created but its response could not be read".to_owned(),
        );
    };
    if let Some(account_id) = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|created| created["account"]["id"].as_str().map(str::to_owned))
    {
        allow_created_account(&state, agent_id, &account_id).await;
    }
    Response::from_parts(parts, axum::body::Body::from(bytes))
}

/// Add `agent:<account_id>` to the agent's allowlist when it has one. An
/// unlimited agent may already use it. A failure leaves the account created
/// but not yet allowed; the user can allow it in the agent's account access.
pub(super) async fn allow_created_account(state: &ServerState, agent_id: &str, account_id: &str) {
    allow_agent_owned_key(state, agent_id, format!("agent:{account_id}")).await;
}

/// Add one key for an account the agent owns (its vault accounts, its own
/// Composio accounts) to the agent's allowlist when it has one. An unlimited
/// agent may already use the account, so its record is left alone.
pub(super) async fn allow_agent_owned_key(state: &ServerState, agent_id: &str, key: String) {
    edit_agent_owned_key(state, agent_id, |access| {
        if access.contains(&key) {
            false
        } else {
            access.push(key);
            true
        }
    })
    .await;
}

/// Remove one key for an account the agent no longer owns from its allowlist.
pub(super) async fn revoke_agent_owned_key(state: &ServerState, agent_id: &str, key: &str) {
    edit_agent_owned_key(state, agent_id, |access| {
        let before = access.len();
        access.retain(|existing| existing != key);
        access.len() != before
    })
    .await;
}

async fn edit_agent_owned_key(
    state: &ServerState,
    agent_id: &str,
    edit: impl FnOnce(&mut Vec<String>) -> bool,
) {
    let record = match state.agent_store.get(agent_id).await {
        Ok(Some(record)) => record,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!("could not read agent to update its own accounts: {error:#}");
            return;
        }
    };
    let Some(mut access) = record.account_access else {
        return;
    };
    if !edit(&mut access) {
        return;
    }
    let patch = crate::agents::UpdateAgent {
        account_access: Some(Some(access)),
        ..Default::default()
    };
    if let Err(error) = state.agent_store.update(agent_id, patch).await {
        tracing::warn!("could not update the agent's own accounts: {error:#}");
    }
}

async fn create_account(
    ctx: &Ctx,
    query: &AccountQuery,
    body: Value,
    policy: Option<&AgentAccountPolicy>,
) -> Response {
    if let Err(response) = require_own_accounts(policy) {
        return response;
    }
    let agent_id = query.agent_id.as_deref();
    let input: CreateInput = match serde_json::from_value(body) {
        Ok(input) => input,
        Err(error) => return super::vault_api::invalid_request(&error.to_string()),
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
    match agent_accounts::create(ctx.store, agent_id, input, &agent_actor(agent_id)).await {
        Ok(account) => {
            let mut response = respond(json!({ "account": account }));
            *response.status_mut() = StatusCode::CREATED;
            response
        }
        Err(error) => vault_error(error),
    }
}

// ── Kernel capabilities (sidecar → Core) ─────────────────────────────────────

/// Body of `vault.credentialFill`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillBody {
    #[serde(default)]
    pub agent_id: Option<String>,
    pub account: String,
    pub field: FillField,
    /// The URL of the page the value will be typed into.
    pub page_url: String,
    /// The filling sidecar's own id for the agent's browser session. Needed
    /// to fill an attached item (`attached:<n>`), whose set it pins.
    #[serde(default)]
    pub browser_session: Option<String>,
}

/// Body of `vault.totpEnroll`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollBody {
    #[serde(default)]
    pub agent_id: Option<String>,
    pub account: String,
    /// An `otpauth://totp/` URI or a Base32 seed.
    pub secret: String,
    /// The URL of the setup page the secret was read from.
    pub page_url: String,
}

async fn authorize(state: &ServerState, headers: &HeaderMap) -> Result<String, Response> {
    crate::sidecar::ext_proxy::authenticate_sidecar(state, headers)
        .await
        .map(|(plugin_id, _)| plugin_id)
        .map_err(|(status, message)| (status, Json(json!({ "error": message }))).into_response())
}

fn sidecar_store() -> Result<&'static crate::plugin_secrets::PluginSecretStore, Response> {
    super::vault_api::store()
}

/// `POST /api/host/capability/vault.credentialFill`: one account field for the
/// page at `page_url`. The grant is checked by the broker before dispatch.
pub(crate) async fn host_credential_fill(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FillBody>,
) -> Response {
    let plugin_id = match authorize(&state, &headers).await {
        Ok(plugin_id) => plugin_id,
        Err(response) => return response,
    };
    let store = match sidecar_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let agent_id = body.agent_id.as_deref();
    let policy = match account_policy(&state, agent_id).await {
        Ok(policy) => policy,
        Err(response) => return response,
    };
    let released = if body.account.starts_with(HANDLE_PREFIX) {
        release_attached(store, vault_fill_sets::registry(), &body, policy.as_ref()).await
    } else {
        if let Err(response) = require_account_allowed(policy.as_ref(), &body.account) {
            return response;
        }
        agent_accounts::release_for_fill(
            store,
            agent_id,
            &body.account,
            body.field,
            &body.page_url,
            &agent_actor(agent_id),
        )
        .await
        .map_err(vault_error)
    };
    match released {
        Ok(value) => {
            tracing::info!(
                plugin_id,
                account = body.account,
                field = body.field.as_str(),
                "agent account field released for fill"
            );
            respond(json!({
                "account": body.account,
                "field": body.field,
                "value": value,
            }))
        }
        Err(response) => response,
    }
}

/// `POST /api/host/capability/vault.totpEnroll`: store a 2FA seed read off the
/// setup page at `page_url`.
pub(crate) async fn host_totp_enroll(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<EnrollBody>,
) -> Response {
    if let Err(response) = authorize(&state, &headers).await {
        return response;
    }
    let store = match sidecar_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let agent_id = body.agent_id.as_deref();
    let policy = match account_policy(&state, agent_id).await {
        Ok(policy) => policy,
        Err(response) => return response,
    };
    if let Err(response) = require_account_allowed(policy.as_ref(), &body.account) {
        return response;
    }
    match agent_accounts::enroll_totp(
        store,
        agent_id,
        &body.account,
        &body.secret,
        &body.page_url,
        &agent_actor(agent_id),
    )
    .await
    {
        Ok(account) => respond(json!({ "account": account })),
        Err(error) => vault_error(error),
    }
}

pub(crate) mod box_fill;
pub(super) mod fill_sets;
pub(super) mod login_urls;
use fill_sets::{attached_items, release_attached};

#[cfg(test)]
mod tests;
