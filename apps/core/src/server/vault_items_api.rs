//! Typed credential item routes under `/api/vault/items`.
//!
//! Every route is human-only under the node bearer and authorizes against the
//! reserved policy key `sys/items/<environment>/<folder>/<key>`:
//! `list` to see an item and its event timeline, `use` or `read` to receive
//! its non-sensitive values, `read` to reveal any field, `write` to create or
//! patch, and `delete` to remove. Configuration managers and the unbound local
//! operator hold every capability by baseline. Responses never carry a
//! sensitive value except the audited reveal, and `PUT` compares supplied
//! values only against ones the caller could read. Writes and deletes in a
//! protected environment need `admin`: items have no change-request flow.
//! The timeline shows the current item only; earlier items at the same key
//! need `read`. See [`crate::vault::items`].
//!
//! Payment cards (`kind: "card"`, see [`crate::vault::items::cards`]) add a
//! merchant-locked `fill` (`use` and `read`, plus an allowlisted HTTPS
//! origin: the fill hands the number and security code to the caller, so a
//! `use`-only caller pays through the broker instead) and spend
//! approvals under `/api/vault/cards/approvals` (`list` on the card to see a
//! request, `write` to approve, reject, or revoke it). Every card use (fill,
//! broker substitution, or a reveal of the number or security code) needs an
//! approval: the first use answers `202` with the pending request.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{ctx, invalid_request, respond, try_response, vault_error, Ctx};
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::vault::items::cards::{
    self, ApprovalStatus, ApproveInput, CardApproval, CardChannel, CardUseOutcome, CardUseRequest,
};
use crate::vault::items::{EventScope, ItemCoords, ItemPatch, ItemPut, PutAccess, PutOutcome};
use crate::vault::policy::Capability;

/// Item routes, merged into the authenticated vault router.
pub fn routes() -> Router<ServerState> {
    use axum::extract::DefaultBodyLimit;
    let body = || DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route("/api/vault/items", get(item_list))
        .route(
            "/api/vault/items/:key",
            put(item_put)
                .get(item_get)
                .patch(item_patch)
                .delete(item_delete)
                .layer(body()),
        )
        .route(
            "/api/vault/items/:key/reveal",
            post(item_reveal).layer(body()),
        )
        .route("/api/vault/items/:key/events", get(item_events))
        .route("/api/vault/items/:key/fill", post(item_fill).layer(body()))
        .route("/api/vault/cards/approvals", get(card_approval_list))
        .route("/api/vault/cards/approvals/:id", get(card_approval_get))
        .route(
            "/api/vault/cards/approvals/:id/approve",
            post(card_approval_approve).layer(body()),
        )
        .route(
            "/api/vault/cards/approvals/:id/reject",
            post(card_approval_reject).layer(body()),
        )
        .route(
            "/api/vault/cards/approvals/:id/revoke",
            post(card_approval_revoke).layer(body()),
        )
}

/// Item bodies are parsed without the `…At` timestamp rewriting the other
/// vault routes apply, so a field named like a timestamp keeps its string.
fn parse_item_body<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, Response> {
    serde_json::from_value(body).map_err(|error| invalid_request(&error.to_string()))
}

/// `?environment=&path=` selecting one item's folder.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationQuery {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

fn coords(query: &LocationQuery, key: &str) -> Result<ItemCoords, Response> {
    ItemCoords::new(query.environment.as_deref(), query.path.as_deref(), key).map_err(vault_error)
}

fn require(ctx: &Ctx, coords: &ItemCoords, capability: Capability) -> Result<(), Response> {
    ctx.require_sys(&coords.policy_key(), capability)
}

/// Items have no change-request flow, so a write or delete in a protected
/// environment needs `admin` there instead of bypassing its approvals.
pub(super) async fn require_unprotected_or_admin(
    ctx: &Ctx,
    coords: &ItemCoords,
) -> Result<(), Response> {
    let protected = match ctx.store.environment(&coords.environment).await {
        Ok(environment) => environment.is_some_and(|environment| environment.protected),
        Err(error) => return Err(vault_error(error)),
    };
    if protected
        && !ctx
            .sys_caps(&coords.policy_key())
            .contains(&Capability::Admin)
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            format!(
                "vault_denied: `{}` is a protected environment; changing typed items there \
                 needs the `admin` capability",
                coords.environment
            ),
        ));
    }
    Ok(())
}

/// GET /api/vault/items.
#[utoipa::path(get, path = "/api/vault/items", tag = "Vault",
    summary = "List typed credential items (no values)",
    params(
        ("environment" = Option<String>, Query, description = "Environment slug"),
        ("path" = Option<String>, Query, description = "Folder path"),
    ),
    responses((status = 200, description = "Items", body = serde_json::Value)))]
pub async fn item_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<LocationQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_items(&ctx, &query).await
}

async fn list_items(ctx: &Ctx, query: &LocationQuery) -> Response {
    let items = try_response!(ctx
        .store
        .item_list(query.environment.as_deref(), query.path.as_deref())
        .await
        .map_err(vault_error));
    let visible: Vec<_> = items
        .into_iter()
        .filter(|item| {
            let key = crate::vault::items::policy_key(&item.environment, &item.path, &item.key);
            ctx.sys_caps(&key).contains(&Capability::List)
        })
        .collect();
    respond(json!({ "items": visible }))
}

/// PUT /api/vault/items/{key}.
#[utoipa::path(put, path = "/api/vault/items/{key}", tag = "Vault",
    summary = "Create a typed item, or confirm an identical one (201 created, 200 unchanged, 409 conflict)",
    params(("key" = String, Path, description = "Item key")),
    request_body = serde_json::Value,
    responses(
        (status = 201, description = "Created", body = serde_json::Value),
        (status = 200, description = "Unchanged", body = serde_json::Value),
        (status = 409, description = "Exists with a different schema or value"),
    ))]
pub async fn item_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    put_item(&ctx, &key, body).await
}

async fn put_item(ctx: &Ctx, key: &str, body: Value) -> Response {
    let input: ItemPut = try_response!(parse_item_body(body));
    let location =
        try_response!(
            ItemCoords::new(input.environment.as_deref(), input.path.as_deref(), key)
                .map_err(vault_error)
        );
    try_response!(require(ctx, &location, Capability::Write));
    try_response!(require_unprotected_or_admin(ctx, &location).await);
    let caps = ctx.sys_caps(&location.policy_key());
    let access = PutAccess {
        plain: caps.contains(&Capability::Use),
        sensitive: caps.contains(&Capability::Read),
    };
    match ctx.store.item_put(key, input, &ctx.actor(), access).await {
        Ok((outcome, item)) => {
            let mut response = respond(json!({ "item": item }));
            if outcome == PutOutcome::Created {
                *response.status_mut() = StatusCode::CREATED;
            }
            response
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/items/{key}.
#[utoipa::path(get, path = "/api/vault/items/{key}", tag = "Vault",
    summary = "Read a typed item: field schema, hasValue, and non-sensitive values",
    params(
        ("key" = String, Path, description = "Item key"),
        ("environment" = Option<String>, Query, description = "Environment slug"),
        ("path" = Option<String>, Query, description = "Folder path"),
    ),
    responses((status = 200, description = "Item", body = serde_json::Value)))]
pub async fn item_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<LocationQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    get_item(&ctx, &key, &query).await
}

async fn get_item(ctx: &Ctx, key: &str, query: &LocationQuery) -> Response {
    let coords = try_response!(coords(query, key));
    let caps = ctx.sys_caps(&coords.policy_key());
    if !caps.contains(&Capability::List) {
        return super::vault_api::denied(Capability::List, &coords.policy_key());
    }
    let include_values = caps.contains(&Capability::Use) || caps.contains(&Capability::Read);
    match ctx.store.item_get(&coords, include_values).await {
        Ok(item) => respond(json!({ "item": item })),
        Err(error) => vault_error(error),
    }
}

/// PATCH /api/vault/items/{key}.
#[utoipa::path(patch, path = "/api/vault/items/{key}", tag = "Vault",
    summary = "Change item values or description (requires expectedVersion and expectedId; null clears)",
    params(("key" = String, Path, description = "Item key")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Updated", body = serde_json::Value),
        (status = 409, description = "Version or id mismatch"),
    ))]
pub async fn item_patch(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    patch_item(&ctx, &key, body).await
}

async fn patch_item(ctx: &Ctx, key: &str, body: Value) -> Response {
    let patch: ItemPatch = try_response!(parse_item_body(body));
    let location =
        try_response!(
            ItemCoords::new(patch.environment.as_deref(), patch.path.as_deref(), key)
                .map_err(vault_error)
        );
    try_response!(require(ctx, &location, Capability::Write));
    try_response!(require_unprotected_or_admin(ctx, &location).await);
    match ctx.store.item_patch(key, patch, &ctx.actor()).await {
        Ok(item) => respond(json!({ "item": item })),
        Err(error) => vault_error(error),
    }
}

/// `?environment=&path=&expectedVersion=` for deletes.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteQuery {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

/// DELETE /api/vault/items/{key}.
#[utoipa::path(delete, path = "/api/vault/items/{key}", tag = "Vault",
    summary = "Delete a typed item and its values (the event timeline is kept)",
    params(
        ("key" = String, Path, description = "Item key"),
        ("environment" = Option<String>, Query, description = "Environment slug"),
        ("path" = Option<String>, Query, description = "Folder path"),
        ("expectedVersion" = Option<i64>, Query, description = "Fail with 409 unless the item is at this version"),
    ),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn item_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    delete_item(&ctx, &key, &query).await
}

async fn delete_item(ctx: &Ctx, key: &str, query: &DeleteQuery) -> Response {
    let coords =
        try_response!(
            ItemCoords::new(query.environment.as_deref(), query.path.as_deref(), key)
                .map_err(vault_error)
        );
    try_response!(require(ctx, &coords, Capability::Delete));
    try_response!(require_unprotected_or_admin(ctx, &coords).await);
    match ctx
        .store
        .item_delete(&coords, query.expected_version, &ctx.actor())
        .await
    {
        Ok(deleted) => respond(json!({ "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

/// Body of a reveal.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevealBody {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub field: String,
}

/// POST /api/vault/items/{key}/reveal.
#[utoipa::path(post, path = "/api/vault/items/{key}/reveal", tag = "Vault",
    summary = "Reveal one field's value (read; audited)",
    params(("key" = String, Path, description = "Item key")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Value", body = serde_json::Value)))]
pub async fn item_reveal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    reveal_item(&ctx, &key, body).await
}

async fn reveal_item(ctx: &Ctx, key: &str, body: Value) -> Response {
    let body: RevealBody = try_response!(parse_item_body(body));
    let coords =
        try_response!(
            ItemCoords::new(body.environment.as_deref(), body.path.as_deref(), key)
                .map_err(vault_error)
        );
    try_response!(require(ctx, &coords, Capability::Read));
    // Items cannot open a control-group request, so a gated read is refused
    // rather than released without approval.
    try_response!(ctx.require_ungated_read(&coords.policy_key()));
    if cards::is_restricted_field(&body.field) {
        let is_card = try_response!(ctx.store.item_is_card(&coords).await.map_err(vault_error));
        if is_card {
            return reveal_card_field(ctx, coords, &body.field).await;
        }
    }
    match ctx
        .store
        .item_reveal(&coords, &body.field, &ctx.actor())
        .await
    {
        Ok(value) => respond(json!({ "field": body.field, "value": value })),
        Err(error) => vault_error(error),
    }
}

/// `?environment=&path=&after=&limit=&wait=` for the timeline.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub wait: Option<u64>,
}

/// GET /api/vault/items/{key}/events.
#[utoipa::path(get, path = "/api/vault/items/{key}/events", tag = "Vault",
    summary = "Item event timeline after a cursor, with an optional long-poll wait (0-60 s)",
    params(
        ("key" = String, Path, description = "Item key"),
        ("environment" = Option<String>, Query, description = "Environment slug"),
        ("path" = Option<String>, Query, description = "Folder path"),
        ("after" = Option<i64>, Query, description = "Return events with seq greater than this"),
        ("limit" = Option<usize>, Query, description = "Page size (1-500, default 100)"),
        ("wait" = Option<u64>, Query, description = "Seconds to wait for a new event (0-60)"),
    ),
    responses((status = 200, description = "Events", body = serde_json::Value)))]
pub async fn item_events(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    item_events_for(ctx, &key, &query).await
}

async fn item_events_for(ctx: Ctx, key: &str, query: &EventsQuery) -> Response {
    let coords =
        try_response!(
            ItemCoords::new(query.environment.as_deref(), query.path.as_deref(), key)
                .map_err(vault_error)
        );
    try_response!(require(&ctx, &coords, Capability::List));
    // Earlier items at the same key are a different credential's history.
    let scope = if ctx
        .sys_caps(&coords.policy_key())
        .contains(&Capability::Read)
    {
        EventScope::History
    } else {
        EventScope::CurrentItem
    };
    let wait = query.wait.unwrap_or(0);
    if wait > crate::vault::items::MAX_EVENT_WAIT_SECS {
        return invalid_request("wait is 0 to 60 seconds");
    }
    let after = query.after.unwrap_or(0);
    // Release the request context before a possibly long wait.
    let store = ctx.store;
    drop(ctx);
    match store
        .item_events(&coords, after, query.limit.unwrap_or(100), wait, scope)
        .await
    {
        Ok(events) => {
            let next = events.last().map_or(after, |event| event.seq);
            respond(json!({ "events": events, "next": next }))
        }
        Err(error) => vault_error(error),
    }
}

// ── Payment cards ─────────────────────────────────────────────────────────

/// The approval subject of a human caller: `user:<id>` or `operator`.
fn card_subject(ctx: &Ctx) -> String {
    match &ctx.caller {
        Some(caller) => format!("user:{}", caller.user_id),
        None => "operator".to_owned(),
    }
}

/// `202 Accepted` with the pending approval request.
fn approval_pending(approval: &CardApproval) -> Response {
    let mut response = respond(json!({
        "ok": true,
        "status": "approval_required",
        "approval": approval,
        "approvePath": approval.approve_path(),
    }));
    *response.status_mut() = StatusCode::ACCEPTED;
    response
}

/// Reveal a card's number or security code: a human with `read` whose
/// reveal a human approved (`once`).
async fn reveal_card_field(ctx: &Ctx, coords: ItemCoords, field: &str) -> Response {
    let subject = card_subject(ctx);
    let request = CardUseRequest {
        coords,
        channel: CardChannel::Reveal,
        merchant_host: String::new(),
        requester: subject.clone(),
        agent: subject,
        actor: ctx.actor(),
    };
    match ctx.store.card_use(&request, Some(field)).await {
        Ok(CardUseOutcome::Granted { values, .. }) => match values.get(field) {
            Some(value) => respond(json!({ "field": field, "value": value })),
            None => vault_error(
                crate::vault::VaultError::NotFound(format!("field `{field}` has no value")).into(),
            ),
        },
        Ok(CardUseOutcome::Pending(approval)) => approval_pending(&approval),
        Ok(CardUseOutcome::Blocked(reason)) => {
            json_error(StatusCode::FORBIDDEN, format!("vault_denied: {reason}"))
        }
        Err(error) => vault_error(error),
    }
}

/// Body of a card fill.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FillBody {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// The HTTPS origin (or page URL) being filled, e.g.
    /// `https://checkout.example.com`.
    pub origin: String,
}

/// The lowercase host of an `https://` origin without credentials.
fn https_origin_host(origin: &str) -> Result<String, Response> {
    let parsed = url::Url::parse(origin.trim())
        .map_err(|_| invalid_request("origin must be an https:// URL"))?;
    if parsed.scheme() != "https" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "vault_denied: cards fill only on https origins".to_owned(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid_request("origin must not carry credentials"));
    }
    parsed
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .ok_or_else(|| invalid_request("origin must name a host"))
}

/// POST /api/vault/items/{key}/fill.
#[utoipa::path(post, path = "/api/vault/items/{key}/fill", tag = "Vault",
    summary = "Fill a payment card into an allowlisted HTTPS origin (use and read; spend approval; audited)",
    params(("key" = String, Path, description = "Card item key")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Card values for this origin", body = serde_json::Value),
        (status = 202, description = "A spend approval is pending", body = serde_json::Value),
        (status = 403, description = "The origin is not https or not on the card's merchant allowlist"),
    ))]
pub async fn item_fill(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    fill_item(&ctx, &key, body).await
}

async fn fill_item(ctx: &Ctx, key: &str, body: Value) -> Response {
    let body: FillBody = try_response!(parse_item_body(body));
    let coords =
        try_response!(
            ItemCoords::new(body.environment.as_deref(), body.path.as_deref(), key)
                .map_err(vault_error)
        );
    try_response!(require(ctx, &coords, Capability::Use));
    // The fill releases the full number and security code to the caller, and
    // the origin is only the caller's claim: Core never sees the page being
    // filled. So it is a reveal in all but name and needs `read` too. A
    // `use`-only caller pays through the broker, which substitutes the values
    // on an allowlisted HTTPS request without exposing them.
    try_response!(require(ctx, &coords, Capability::Read));
    let host = try_response!(https_origin_host(&body.origin));
    let subject = card_subject(ctx);
    let request = CardUseRequest {
        coords,
        channel: CardChannel::Fill,
        merchant_host: host.clone(),
        requester: subject.clone(),
        agent: subject,
        actor: ctx.actor(),
    };
    match ctx.store.card_use(&request, None).await {
        Ok(CardUseOutcome::Granted {
            values,
            approval_id,
            brand,
            last4,
        }) => respond(json!({
            "origin": format!("https://{host}"),
            "fields": values,
            "card": { "brand": brand, "last4": last4 },
            "approvalId": approval_id,
        })),
        Ok(CardUseOutcome::Pending(approval)) => approval_pending(&approval),
        Ok(CardUseOutcome::Blocked(_)) => json_error(
            StatusCode::FORBIDDEN,
            format!("vault_denied: `{host}` is not on this card's merchant allowlist"),
        ),
        Err(error) => vault_error(error),
    }
}

/// `?status=&environment=` for card approvals.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalQuery {
    #[serde(default)]
    pub status: Option<ApprovalStatus>,
    #[serde(default)]
    pub environment: Option<String>,
}

fn approval_key(approval: &CardApproval) -> String {
    crate::vault::items::policy_key(&approval.environment, &approval.path, &approval.key)
}

/// GET /api/vault/cards/approvals.
#[utoipa::path(get, path = "/api/vault/cards/approvals", tag = "Vault",
    summary = "List card spend approval requests and grants (list on the card)",
    params(
        ("status" = Option<String>, Query, description = "pending, approved, rejected, expired, consumed, revoked"),
        ("environment" = Option<String>, Query, description = "Environment slug"),
    ),
    responses((status = 200, description = "Approvals", body = serde_json::Value)))]
pub async fn card_approval_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ApprovalQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_card_approvals(&ctx, &query).await
}

async fn list_card_approvals(ctx: &Ctx, query: &ApprovalQuery) -> Response {
    let approvals = try_response!(ctx
        .store
        .card_approvals(query.status, query.environment.as_deref())
        .await
        .map_err(vault_error));
    let visible: Vec<_> = approvals
        .into_iter()
        .filter(|approval| {
            ctx.sys_caps(&approval_key(approval))
                .contains(&Capability::List)
        })
        .collect();
    respond(json!({ "approvals": visible }))
}

/// A card approval the caller may see with `capability` on its card.
async fn load_approval(
    ctx: &Ctx,
    id: &str,
    capability: Capability,
) -> Result<CardApproval, Response> {
    let approval = ctx.store.card_approval(id).await.map_err(vault_error)?;
    let not_found = || {
        json_error(
            StatusCode::NOT_FOUND,
            format!("vault_not_found: card approval `{id}`"),
        )
    };
    let approval = approval.ok_or_else(not_found)?;
    let caps = ctx.sys_caps(&approval_key(&approval));
    if !caps.contains(&Capability::List) {
        return Err(not_found());
    }
    if !caps.contains(&capability) {
        return Err(super::vault_api::denied(
            capability,
            &approval_key(&approval),
        ));
    }
    Ok(approval)
}

/// GET /api/vault/cards/approvals/{id}.
#[utoipa::path(get, path = "/api/vault/cards/approvals/{id}", tag = "Vault",
    summary = "Read one card spend approval (list on the card)",
    params(("id" = String, Path, description = "Approval id")),
    responses((status = 200, description = "Approval", body = serde_json::Value)))]
pub async fn card_approval_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    match load_approval(&ctx, &id, Capability::List).await {
        Ok(approval) => respond(json!({ "approval": approval })),
        Err(response) => response,
    }
}

/// POST /api/vault/cards/approvals/{id}/approve.
#[utoipa::path(post, path = "/api/vault/cards/approvals/{id}/approve", tag = "Vault",
    summary = "Approve a card use once, or as a grant for the session or agent at that merchant (write on the card)",
    params(("id" = String, Path, description = "Approval id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Approved", body = serde_json::Value),
        (status = 409, description = "Not pending"),
    ))]
pub async fn card_approval_approve(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    approve_card(&ctx, &id, body.map(|Json(body)| body)).await
}

async fn approve_card(ctx: &Ctx, id: &str, body: Option<Value>) -> Response {
    let input: ApproveInput = match body {
        Some(body) => try_response!(parse_item_body(body)),
        None => ApproveInput::default(),
    };
    try_response!(load_approval(ctx, id, Capability::Write).await);
    match ctx
        .store
        .card_approve(id, &input, &ctx.actor(), &card_subject(ctx))
        .await
    {
        Ok(approval) => respond(json!({ "approval": approval })),
        Err(error) => vault_error(error),
    }
}

/// Body of a reject or revoke.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclineBody {
    #[serde(default)]
    pub note: Option<String>,
}

async fn decline_card(ctx: &Ctx, id: &str, body: Option<Value>, revoke: bool) -> Response {
    let body: DeclineBody = match body {
        Some(body) => try_response!(parse_item_body(body)),
        None => DeclineBody::default(),
    };
    try_response!(load_approval(ctx, id, Capability::Write).await);
    match ctx
        .store
        .card_decline(
            id,
            revoke,
            body.note.as_deref(),
            &ctx.actor(),
            &card_subject(ctx),
        )
        .await
    {
        Ok(approval) => respond(json!({ "approval": approval })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/cards/approvals/{id}/reject.
#[utoipa::path(post, path = "/api/vault/cards/approvals/{id}/reject", tag = "Vault",
    summary = "Reject a pending card spend approval (write on the card)",
    params(("id" = String, Path, description = "Approval id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Rejected", body = serde_json::Value)))]
pub async fn card_approval_reject(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    decline_card(&ctx, &id, body.map(|Json(body)| body), false).await
}

/// POST /api/vault/cards/approvals/{id}/revoke.
#[utoipa::path(post, path = "/api/vault/cards/approvals/{id}/revoke", tag = "Vault",
    summary = "Revoke an active card grant (write on the card)",
    params(("id" = String, Path, description = "Approval id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn card_approval_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    decline_card(&ctx, &id, body.map(|Json(body)| body), true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::kv::Environment;
    use crate::plugin_secrets::PluginSecretStore;
    use crate::vault::policy::{Policy, PolicyRule};

    fn member_ctx(store: &'static PluginSecretStore, rules: &[(&str, Vec<Capability>)]) -> Ctx {
        let policy = Policy {
            name: "items".into(),
            description: String::new(),
            rules: rules
                .iter()
                .map(|(path, capabilities)| PolicyRule {
                    path: (*path).to_owned(),
                    capabilities: capabilities.clone(),
                    deny: false,
                    ..Default::default()
                })
                .collect(),
        };
        Ctx::test_member(store, "user-1", vec![policy])
    }

    /// `ctx` acting as another verified user.
    fn as_user(mut ctx: Ctx, user_id: &str) -> Ctx {
        if let Some(caller) = ctx.caller.as_mut() {
            caller.user_id = user_id.to_owned();
        }
        ctx
    }

    fn store() -> &'static PluginSecretStore {
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
    }

    async fn body(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn login(environment: &str, password: &str) -> Value {
        json!({
            "environment": environment,
            "kind": "login",
            "fields": [
                { "name": "username", "type": "text" },
                { "name": "password", "type": "password" }
            ],
            "values": { "username": "alice", "password": password }
        })
    }

    const ALL: &[Capability] = &[
        Capability::List,
        Capability::Use,
        Capability::Read,
        Capability::Write,
        Capability::Delete,
    ];

    #[tokio::test]
    async fn put_maps_created_and_unchanged_and_hides_values_from_write_only() {
        let store = store();
        let owner = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        let (status, _) = body(put_item(&owner, "github", login("default", "hunter2")).await).await;
        assert_eq!(status, StatusCode::CREATED);
        let (status, _) = body(put_item(&owner, "github", login("default", "hunter2")).await).await;
        assert_eq!(status, StatusCode::OK);

        let writer = member_ctx(store, &[("sys/items/default/*", vec![Capability::Write])]);
        let right = body(put_item(&writer, "github", login("default", "hunter2")).await).await;
        let wrong = body(put_item(&writer, "github", login("default", "nope")).await).await;
        assert_eq!(right.0, StatusCode::CONFLICT);
        assert_eq!(right, wrong, "a right and a wrong guess look the same");
    }

    #[tokio::test]
    async fn reads_reveals_and_lists_follow_capabilities() {
        let store = store();
        let owner = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        put_item(&owner, "github", login("default", "hunter2")).await;
        put_item(&owner, "hidden", login("default", "x")).await;

        let lister = member_ctx(
            store,
            &[("sys/items/default/github", vec![Capability::List])],
        );
        let (status, view) =
            body(get_item(&lister, "github", &LocationQuery::default()).await).await;
        assert_eq!(status, StatusCode::OK);
        let text = view.to_string();
        assert!(
            !text.contains("alice") && !text.contains("hunter2"),
            "{text}"
        );

        let user = member_ctx(
            store,
            &[(
                "sys/items/default/github",
                vec![Capability::List, Capability::Use],
            )],
        );
        let (_, view) = body(get_item(&user, "github", &LocationQuery::default()).await).await;
        let text = view.to_string();
        assert!(
            text.contains("alice") && !text.contains("hunter2"),
            "{text}"
        );

        let reveal = || json!({ "field": "password" });
        let (status, _) = body(reveal_item(&user, "github", reveal()).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, revealed) = body(reveal_item(&owner, "github", reveal()).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revealed["value"], "hunter2");

        let (_, listed) = body(list_items(&lister, &LocationQuery::default()).await).await;
        let keys: Vec<_> = listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["key"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(keys, vec!["github"]);
    }

    #[tokio::test]
    async fn events_reject_long_waits_and_scope_history_to_read() {
        let store = store();
        let owner = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        put_item(&owner, "github", login("default", "hunter2")).await;
        let query = |wait: Option<u64>| EventsQuery {
            wait,
            ..EventsQuery::default()
        };
        let lister = || member_ctx(store, &[("sys/items/default/*", vec![Capability::List])]);
        let (status, _) = body(item_events_for(lister(), "github", &query(Some(61))).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        delete_item(&owner, "github", &DeleteQuery::default()).await;
        put_item(&owner, "github", login("default", "other")).await;
        let (_, scoped) = body(item_events_for(lister(), "github", &query(None)).await).await;
        assert_eq!(scoped["events"].as_array().unwrap().len(), 1);
        let (_, history) = body(item_events_for(owner, "github", &query(None)).await).await;
        assert_eq!(history["events"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn protected_environments_need_admin_for_item_changes() {
        let store = store();
        store
            .put_environment(
                &Environment {
                    slug: "prod".into(),
                    name: "Production".into(),
                    protected: true,
                    required_approvals: 1,
                    position: 0,
                    cas_required: false,
                },
                &crate::vault::audit::AuditActor::new("operator", None),
            )
            .await
            .unwrap();
        let writer = member_ctx(store, &[("sys/items/prod/*", ALL.to_vec())]);
        let (status, _) = body(put_item(&writer, "db", login("prod", "pw")).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let mut admin_caps = ALL.to_vec();
        admin_caps.push(Capability::Admin);
        let admin = member_ctx(store, &[("sys/items/prod/*", admin_caps)]);
        let (status, _) = body(put_item(&admin, "db", login("prod", "pw")).await).await;
        assert_eq!(status, StatusCode::CREATED);
        let query = DeleteQuery {
            environment: Some("prod".into()),
            ..DeleteQuery::default()
        };
        let (status, _) = body(delete_item(&writer, "db", &query).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn control_group_gated_item_reveals_are_refused() {
        use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
        let store = store();
        let owner = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        put_item(&owner, "github", login("default", "hunter2")).await;
        let mut gated = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        gated.policies[0].rules[0].control_group = Some(ControlGroupSpec {
            ttl_secs: None,
            factors: vec![ControlGroupFactor {
                name: "security".into(),
                approvers: vec!["user:bob".into()],
                approvals: 1,
            }],
        });
        let (status, view) =
            body(reveal_item(&gated, "github", json!({ "field": "password" })).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!view.to_string().contains("hunter2"), "{view}");
        assert!(
            view.to_string().contains("vault_control_group_required"),
            "{view}"
        );
    }

    fn card(merchants: &[&str]) -> Value {
        use chrono::Datelike as _;
        json!({
            "kind": "card",
            "values": {
                "cardholder": "Ada Lovelace",
                "number": "4242 4242 4242 4242",
                "expMonth": "12",
                "expYear": (chrono::Utc::now().year() + 2).to_string(),
                "cvc": "8317",
            },
            "merchants": merchants,
        })
    }

    #[tokio::test]
    async fn card_fill_needs_an_allowlisted_https_origin_and_an_approval() {
        let store = store();
        let owner = as_user(
            member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]),
            "user-2",
        );
        let (status, created) =
            body(put_item(&owner, "visa", card(&["shop.example.com"])).await).await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(
            !created.to_string().contains("4242424242424242"),
            "{created}"
        );
        assert_eq!(created["item"]["card"]["last4"], "4242");

        let user = member_ctx(
            store,
            &[(
                "sys/items/default/visa",
                vec![Capability::List, Capability::Use, Capability::Read],
            )],
        );
        let fill = |origin: &str| json!({ "origin": origin });
        // A fill hands the number and security code to the caller, so `use`
        // alone (the broker's capability) is not enough.
        let use_only = member_ctx(
            store,
            &[(
                "sys/items/default/visa",
                vec![Capability::List, Capability::Use],
            )],
        );
        let (status, refused) =
            body(fill_item(&use_only, "visa", fill("https://shop.example.com")).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert!(!refused.to_string().contains("4242424242424242"));
        let (status, _) =
            body(fill_item(&user, "visa", fill("http://shop.example.com")).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = body(fill_item(&user, "visa", fill("https://evil.example")).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let lister = member_ctx(store, &[("sys/items/default/visa", vec![Capability::List])]);
        let (status, _) =
            body(fill_item(&lister, "visa", fill("https://shop.example.com")).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "fill needs use");
        let read_only = member_ctx(
            store,
            &[(
                "sys/items/default/visa",
                vec![Capability::List, Capability::Read],
            )],
        );
        let (status, _) =
            body(fill_item(&read_only, "visa", fill("https://shop.example.com")).await).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "fill needs use as well as read"
        );

        let (status, pending) =
            body(fill_item(&user, "visa", fill("https://shop.example.com/checkout")).await).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
        let id = pending["approval"]["id"].as_str().unwrap().to_owned();
        assert_eq!(pending["approval"]["merchantHost"], "shop.example.com");
        assert!(!pending.to_string().contains("4242424242424242"));

        // Listing needs `list`; deciding needs `write`.
        let (_, listed) = body(list_card_approvals(&lister, &ApprovalQuery::default()).await).await;
        assert_eq!(listed["approvals"].as_array().unwrap().len(), 1);
        let stranger = member_ctx(store, &[("sys/items/default/other", ALL.to_vec())]);
        let (_, hidden) =
            body(list_card_approvals(&stranger, &ApprovalQuery::default()).await).await;
        assert!(hidden["approvals"].as_array().unwrap().is_empty());
        let (status, _) = body(approve_card(&user, &id, None).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Holding `write` does not let the requester approve their own fill.
        let self_approver = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        let (status, refused) = body(approve_card(&self_approver, &id, None).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        let (status, approved) = body(
            approve_card(
                &owner,
                &id,
                Some(
                    json!({ "mode": "grant", "subject": "session", "ttlSecs": 600, "maxUses": 1 }),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{approved}");
        assert_eq!(approved["approval"]["status"], "approved");

        let (status, filled) =
            body(fill_item(&user, "visa", fill("https://shop.example.com")).await).await;
        assert_eq!(status, StatusCode::OK, "{filled}");
        assert_eq!(filled["fields"]["number"], "4242424242424242");
        assert_eq!(filled["fields"]["cvc"], "8317");
        assert_eq!(filled["card"]["brand"], "visa");
        let (status, _) =
            body(fill_item(&user, "visa", fill("https://shop.example.com")).await).await;
        assert_eq!(status, StatusCode::ACCEPTED, "the one-use grant is spent");
    }

    #[tokio::test]
    async fn card_number_reveals_need_a_reveal_approval() {
        let store = store();
        let owner = member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]);
        let approver = as_user(
            member_ctx(store, &[("sys/items/default/*", ALL.to_vec())]),
            "user-2",
        );
        put_item(&owner, "visa", card(&["shop.example.com"])).await;
        // A re-PUT never confirms a stored number or security code (it would
        // test guesses around the reveal approval), even when they match.
        let (status, conflict) =
            body(put_item(&owner, "visa", card(&["shop.example.com"])).await).await;
        assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
        let reveal = || json!({ "field": "number" });
        let (status, pending) = body(reveal_item(&owner, "visa", reveal()).await).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
        assert_eq!(pending["approval"]["channel"], "reveal");
        assert_eq!(pending["approval"]["field"], "number");
        let id = pending["approval"]["id"].as_str().unwrap().to_owned();
        let (status, rejected) = body(decline_card(&approver, &id, None, false).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(rejected["approval"]["status"], "rejected");
        let (_, pending) = body(reveal_item(&owner, "visa", reveal()).await).await;
        let id = pending["approval"]["id"].as_str().unwrap().to_owned();
        let (status, _) = body(approve_card(&owner, &id, None).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "no self-approval");
        let (status, _) = body(approve_card(&approver, &id, None).await).await;
        assert_eq!(status, StatusCode::OK);
        // The approval covers the number only.
        let (status, _) = body(reveal_item(&owner, "visa", json!({ "field": "cvc" })).await).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (status, revealed) = body(reveal_item(&owner, "visa", reveal()).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revealed["value"], "4242424242424242");
        // Non-restricted card fields reveal as usual.
        let (status, holder) =
            body(reveal_item(&owner, "visa", json!({ "field": "cardholder" })).await).await;
        assert_eq!(
            (status, holder["value"].clone()),
            (StatusCode::OK, json!("Ada Lovelace"))
        );
    }
}
