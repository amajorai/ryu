//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `composio_trigger_subscribe` through `composio_webhook`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/composio/triggers/subscribe` — register a Composio trigger instance
/// and bind it to an agent, on one of the user's connected accounts or (with
/// `own_account`) one connected to the agent's own identity.
#[utoipa::path(
    post,
    path = "/api/composio/triggers/subscribe",
    tag = "Composio",
    summary = "Subscribe an agent to a Composio event trigger",
    request_body = serde_json::Value,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_trigger_subscribe(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ComposioSubscribeBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.own_account {
        return composio_own_account_trigger_subscribe(&state, &caller, body).await;
    }
    // The trigger runs on one of the user's connected accounts, so the agent's
    // account policy must allow that account (shared with `bind_target`).
    if let Some(refusal) = connect_events::agent_trigger_account_refusal(
        &state,
        &body.agent_id,
        &body.connected_account_id,
    )
    .await
    {
        return refusal;
    }
    if ryu_composio::service::is_configured() {
        return connect_events::subscribe(&state, &caller, body).await;
    }
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        &body.agent_id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "agent execution is not permitted" })),
        );
    }
    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    let config = if body.config.is_null() {
        json!({})
    } else {
        body.config
    };
    // The account must be one of the calling user's own, never an account
    // connected to an agent's own identity passed off as the user's.
    if let Some(refusal) = connect_events::user_trigger_account_ownership_refusal(
        &state,
        &caller,
        &body.connected_account_id,
    )
    .await
    {
        return refusal;
    }
    if let Err(error) = crate::webhook_ingress::reconcile_composio_subscription(store).await {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error.to_string() })),
        );
    }
    match store
        .subscribe(
            &body.agent_id,
            &body.toolkit,
            &body.trigger_slug,
            &body.connected_account_id,
            config,
        )
        .await
    {
        Ok(sub) => (StatusCode::CREATED, Json(json!({ "subscription": sub }))),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// The `own_account` branch of [`composio_trigger_subscribe`]: the account is
/// connected to the agent's own Composio entity, which the policy and an
/// ownership listing must both confirm before anything is registered.
pub(in crate::server) async fn composio_own_account_trigger_subscribe(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    body: ComposioSubscribeBody,
) -> (StatusCode, Json<serde_json::Value>) {
    let entity = match connect_events::own_account_trigger_refusal(
        state,
        caller,
        &body.agent_id,
        &body.connected_account_id,
    )
    .await
    {
        Ok(entity) => entity,
        Err(refusal) => return refusal,
    };
    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    let config = if body.config.is_null() {
        json!({})
    } else {
        body.config
    };
    if let Err(error) = crate::webhook_ingress::reconcile_composio_subscription(store).await {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error.to_string() })),
        );
    }
    match store
        .subscribe_own_account(
            &body.agent_id,
            &entity,
            &body.toolkit,
            &body.trigger_slug,
            &body.connected_account_id,
            config,
        )
        .await
    {
        Ok(sub) => (StatusCode::CREATED, Json(json!({ "subscription": sub }))),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/composio/trigger-subscriptions` — list agent↔trigger subscriptions.
#[utoipa::path(
    get,
    path = "/api/composio/trigger-subscriptions",
    tag = "Composio",
    summary = "List Composio trigger subscriptions",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_trigger_list(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::composio_triggers::global() else {
        return (StatusCode::OK, Json(json!({ "subscriptions": [] })));
    };
    let subscriptions = if ryu_composio::service::is_configured() {
        match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
            Ok(owner) => store.list_connect_targets(&owner).await,
            Err(_) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"verified user required"})),
                );
            }
        }
    } else {
        store.list().await
    };
    match subscriptions {
        Ok(subs) => (StatusCode::OK, Json(json!({ "subscriptions": subs }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/composio/trigger-subscriptions/:id` — remove a subscription.
#[utoipa::path(
    delete,
    path = "/api/composio/trigger-subscriptions/{id}",
    tag = "Composio",
    summary = "Delete a Composio trigger subscription",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_trigger_delete(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    let removed = if ryu_composio::service::is_configured() {
        match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
            Ok(owner) => store.remove_connect_target(&owner, &id).await,
            Err(_) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"verified user required"})),
                );
            }
        }
    } else {
        store.delete(&id).await
    };
    match removed {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "subscription not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/composio/webhook` — inbound Composio trigger event. Maps the event
/// to subscribed agents/workflows and fires each. Requires Core to be reachable
/// at a public URL (or via a relay) for the webhook to arrive (#456).
///
/// This route is **public** (it sits outside `require_auth`) because an external
/// Composio delivery cannot send Core's bearer token. It is instead authenticated
/// **fail-closed** with Composio's HMAC-SHA256 signature over
/// `{webhook-id}.{webhook-timestamp}.{rawBody}` (see
/// [`crate::composio_triggers::verify_webhook_signature`]). The project secret
/// is hydrated from the encrypted store, all signed headers are mandatory, and
/// a stale timestamp or mismatch returns 401 before anything fires.
#[utoipa::path(
    post,
    path = "/api/composio/webhook",
    tag = "Composio",
    summary = "Composio trigger webhook receiver (HMAC-authenticated)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 401, description = "Missing/invalid signature or secret unset"),
        (status = 410, description = "Connect owns ingress; deliver to the configured Connect service")
    )
)]
pub(in crate::server) async fn composio_webhook(
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    if ryu_composio::service::is_configured() {
        return (
            StatusCode::GONE,
            Json(
                json!({"code":"connect_owns_ingress","error":"Deliver Composio webhooks to the configured Connect service"}),
            ),
        );
    }
    // Authenticate the raw bytes BEFORE parsing — verify over exactly what was
    // received, never a re-serialized value. Composio's current signature covers
    // the id, timestamp, and raw body and enforces the replay window itself.
    let webhook_id = headers
        .get("webhook-id")
        .and_then(|value| value.to_str().ok());
    let webhook_timestamp = headers
        .get("webhook-timestamp")
        .and_then(|value| value.to_str().ok());
    let signature = headers
        .get("webhook-signature")
        .and_then(|value| value.to_str().ok());
    if !crate::composio_triggers::verify_webhook_signature(
        &body,
        webhook_id,
        webhook_timestamp,
        signature,
    ) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid or missing webhook signature" })),
        );
    }

    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid JSON body: {e}") })),
            );
        }
    };

    let Some(store) = crate::composio_triggers::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "composio triggers store unavailable" })),
        );
    };
    // Reserve only a request that is authenticated, parseable, and dispatchable.
    // Duplicate retries return success because the first delivery already ran.
    // The verified signature guarantees a non-empty `webhook-id`.
    let delivery_id = webhook_delivery_id(&headers);
    if let Err(error) = crate::sidecar::gateway::record_composio_trigger_delivery(
        &reqwest::Client::new(),
        &delivery_id,
    )
    .await
    {
        tracing::warn!(error = %error, "Composio trigger accounting unavailable");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code":"credit_accounting_unavailable"})),
        );
    }
    // Durable claim (shared with the relay path): Composio retries the same id
    // for about a day, so an in-memory set would re-fire every run after a Core
    // restart. The claim is never released: the fan-out below runs detached.
    match crate::webhook_ingress::reserve_composio_delivery(&delivery_id) {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::OK,
                Json(json!({ "ok": true, "duplicate": true })),
            );
        }
        Err(error) => {
            tracing::warn!(%error, "Composio delivery reservation unavailable");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "code": "delivery_reservation_unavailable" })),
            );
        }
    }
    // Detached from this request: when the sender times out before a long agent
    // run finishes, axum drops this handler, and an inline fan-out would be
    // cancelled mid-run while its retries are already acknowledged as duplicates.
    let fan_out = tokio::spawn(async move { store.handle_webhook(&payload).await });
    let fired = match fan_out.await {
        Ok(fired) => fired,
        Err(error) => {
            tracing::error!(%error, "Composio webhook fan-out did not complete");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "composio webhook fan-out failed" })),
            );
        }
    };
    // Record the delivery for the webhook registry (GET /api/webhooks).
    crate::webhook_ingress::record_delivery(crate::webhook_ingress::WEBHOOK_PATH);
    (StatusCode::OK, Json(json!({ "ok": true, "fired": fired })))
}
