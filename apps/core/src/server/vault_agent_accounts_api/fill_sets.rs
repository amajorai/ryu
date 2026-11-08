//! `/api/vault/fill-sets`: attach the user's vault items to one agent's
//! browser session (see [`crate::vault::agent_accounts::fill_sets`]).
//!
//! * `POST` attaches up to 32 items to an agent. The caller needs `use` and
//!   `read` (not gated by a control group) on every item, since a fill hands
//!   the value to the agent's browser on the site the caller picks; the agent
//!   must be allowed the user's accounts, and the agent may hold only one
//!   active set. The answer is metadata only.
//! * `GET ?agent_id=` lists the active sets whose every item the caller may
//!   `use`.
//! * `DELETE /{id}` revokes a set, under the same `use` check.
//!
//! There is no update: a set is immutable once attached. Creation and
//! revocation are audited (`fill_set.create`, `fill_set.revoke`) with item
//! coordinates, sites, login URLs and the Box opt-in, never a value.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::vault_api::{ctx, invalid_request, respond, vault_error, Ctx};
use super::super::ServerState;
use super::{account_policy, agent_actor, denied, FillBody};
use crate::agent_access::AgentAccountPolicy;
use crate::identity_verify::VerifiedCaller;
use crate::vault::agent_accounts::fill_sets::{self, CreateInput, FillSet, Registry};
use crate::vault::audit::AuditEntry;
use crate::vault::items::ItemCoords;
use crate::vault::now_millis;
use crate::vault::policy::Capability;

/// The revoke route. Core is on axum 0.7, whose path parameters are `:id`;
/// `{id}` would be a literal segment and every revoke would 404.
pub(super) const REVOKE_PATH: &str = "/api/vault/fill-sets/:id";

/// The fill-set routes, merged into the agent account router.
pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/vault/fill-sets",
            get(set_list)
                .post(set_create)
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024)),
        )
        .route(REVOKE_PATH, delete(set_revoke))
}

/// `?agent_id=`.
#[derive(Debug, Default, Deserialize)]
pub struct SetQuery {
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// Whether the caller may `use` every item of a set.
fn may_use_all(ctx: &Ctx, set: &FillSet) -> Result<(), Response> {
    for item in &set.items {
        let coords = item.coords().map_err(vault_error)?;
        ctx.require_sys(&coords.policy_key(), Capability::Use)?;
    }
    Ok(())
}

/// Whether the caller may attach an item. A fill releases the plaintext to
/// the agent's browser on a site the caller chooses, so attaching needs what
/// a reveal needs: `read`, not gated by a control group, as well as `use`.
fn may_attach(ctx: &Ctx, coords: &ItemCoords) -> Result<(), Response> {
    let key = coords.policy_key();
    ctx.require_sys(&key, Capability::Use)?;
    ctx.require_sys(&key, Capability::Read)?;
    ctx.require_ungated_read(&key)
}

async fn audit(ctx: &Ctx, action: &str, set: &FillSet) -> Result<(), Response> {
    let items: Vec<Value> = set
        .items
        .iter()
        .map(|item| {
            json!({
                "environment": item.environment,
                "path": item.path,
                "key": item.key,
                "host": item.host,
                "submitUrls": item.submit_urls,
                "boxUnbound": item.box_unbound,
            })
        })
        .collect();
    let entry = AuditEntry::new(&ctx.actor(), action, "ok").details(json!({
        "fillSet": set.id,
        "agentId": set.agent_id,
        "items": items,
    }));
    if ctx.store.audit(&entry).await {
        Ok(())
    } else {
        Err(vault_error(
            crate::vault::VaultError::AuditUnavailable.into(),
        ))
    }
}

/// POST /api/vault/fill-sets.
#[utoipa::path(post, path = "/api/vault/fill-sets", tag = "Vault",
    summary = "Attach vault items to one agent's browser session (immutable)",
    request_body = serde_json::Value,
    responses((status = 201, description = "Attached (no value is returned)", body = serde_json::Value)))]
pub async fn set_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let agent_id = body["agent_id"].as_str().map(str::to_owned);
    let policy = match account_policy(&state, agent_id.as_deref()).await {
        Ok(policy) => policy,
        Err(response) => return response,
    };
    create(&ctx, fill_sets::registry(), body, policy.as_ref()).await
}

pub(super) async fn create(
    ctx: &Ctx,
    registry: &Registry,
    body: Value,
    policy: Option<&AgentAccountPolicy>,
) -> Response {
    let input: CreateInput = match serde_json::from_value(body) {
        Ok(input) => input,
        Err(error) => return invalid_request(&error.to_string()),
    };
    if let Some(policy) = policy {
        if !policy.allows_user_accounts() {
            return denied(
                "this agent may not use your accounts; change its identity in the agent's settings",
            );
        }
    }
    // Check access before loading, so a denied caller learns nothing of the
    // items, then again on the loaded coordinates.
    for item in &input.items {
        let coords =
            match ItemCoords::new(item.environment.as_deref(), item.path.as_deref(), &item.key) {
                Ok(coords) => coords,
                Err(error) => return vault_error(error),
            };
        if let Err(response) = may_attach(ctx, &coords) {
            return response;
        }
    }
    let now = now_millis();
    let set = match fill_sets::build(ctx.store, &input, now).await {
        Ok(set) => set,
        Err(error) => return vault_error(error),
    };
    for item in &set.items {
        let checked = item
            .coords()
            .map_err(vault_error)
            .and_then(|coords| may_attach(ctx, &coords));
        if let Err(response) = checked {
            return response;
        }
    }
    let set = match registry.insert(set, now) {
        Ok(set) => set,
        Err(error) => return vault_error(error),
    };
    if let Err(response) = audit(ctx, "fill_set.create", &set).await {
        registry.revoke(&set.id, now);
        return response;
    }
    let mut response = respond(json!({ "fillSet": set }));
    *response.status_mut() = StatusCode::CREATED;
    response
}

/// GET /api/vault/fill-sets.
#[utoipa::path(get, path = "/api/vault/fill-sets", tag = "Vault",
    summary = "List active vault sets attached to agent browser sessions",
    params(("agent_id" = Option<String>, Query, description = "Only this agent's set")),
    responses((status = 200, description = "Sets", body = serde_json::Value)))]
pub async fn set_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<SetQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list(&ctx, fill_sets::registry(), query.agent_id.as_deref())
}

pub(super) fn list(ctx: &Ctx, registry: &Registry, agent_id: Option<&str>) -> Response {
    let sets: Vec<FillSet> = registry
        .list(agent_id, now_millis())
        .into_iter()
        .filter(|set| may_use_all(ctx, set).is_ok())
        .collect();
    respond(json!({ "fillSets": sets }))
}

/// DELETE /api/vault/fill-sets/{id}.
#[utoipa::path(delete, path = "/api/vault/fill-sets/{id}", tag = "Vault",
    summary = "Revoke a vault set attached to an agent browser session",
    params(("id" = String, Path, description = "Fill set id")),
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn set_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    revoke(&ctx, fill_sets::registry(), &id).await
}

pub(super) async fn revoke(ctx: &Ctx, registry: &Registry, id: &str) -> Response {
    let now = now_millis();
    let Some(set) = registry.get(id, now) else {
        return vault_error(
            crate::vault::VaultError::NotFound(format!("no fill set `{id}`")).into(),
        );
    };
    if let Err(response) = may_use_all(ctx, &set) {
        return response;
    }
    registry.revoke(id, now);
    // Live session Box fills of the set are cancelled before the answer,
    // within two seconds; one left pending expires on the Box within 60 s.
    let fills = crate::sidecar::mcp::box_desktop::revoke_set(id).await;
    // Revocation stands even when the audit row cannot be written: keeping
    // the set would fail open.
    let audited = audit(ctx, "fill_set.revoke", &set).await.is_ok();
    respond(json!({
        "revoked": true,
        "audited": audited,
        "box_fills_cancelled": fills.cancelled,
        "box_fills_pending": fills.pending,
    }))
}

/// The user's items attached to the agent's browser session, filled by their
/// `attached:<n>` handle. Metadata only.
pub(super) fn attached_items(
    registry: &Registry,
    agent_id: Option<&str>,
) -> Vec<fill_sets::AttachedItem> {
    let Some(agent_id) = agent_id else {
        return Vec::new();
    };
    registry
        .list(Some(agent_id), crate::vault::now_millis())
        .into_iter()
        .flat_map(|set| set.items)
        .collect()
}

/// Release one field of an item the user attached to this agent's browser
/// session. The agent must still be allowed the user's accounts.
pub(super) async fn release_attached(
    store: &crate::plugin_secrets::PluginSecretStore,
    registry: &Registry,
    body: &FillBody,
    policy: Option<&AgentAccountPolicy>,
) -> Result<String, Response> {
    let Some(agent_id) = body.agent_id.as_deref() else {
        return Err(denied(
            "attached items fill only in an agent's browser session",
        ));
    };
    if policy.is_some_and(|policy| !policy.allows_user_accounts()) {
        return Err(denied("this agent may not use your accounts"));
    }
    let item = registry
        .claim(
            agent_id,
            body.browser_session.as_deref(),
            &body.account,
            crate::vault::now_millis(),
        )
        .map_err(vault_error)?;
    fill_sets::release(
        store,
        &item,
        body.field,
        &body.page_url,
        &agent_actor(Some(agent_id)),
    )
    .await
    .map_err(vault_error)
}
