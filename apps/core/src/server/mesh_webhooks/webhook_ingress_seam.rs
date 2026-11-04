//! Webhook ingress seam (#479, P6a).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Webhook ingress seam (#479, P6a) ──────────────────────────────────────────

/// `GET /api/webhook-ingress/status` — the active ingress backend, its public URL
/// (if resolved), and whether ingress is up. Consumed by P7's desktop status
/// surface (the `webhook_ingress_mode` line). `up` is true once a public URL has
/// been resolved (the tunnel/relay can receive Composio webhooks).
#[utoipa::path(
    get,
    path = "/api/webhook-ingress/status",
    tag = "Nodes",
    summary = "Webhook ingress backend + public URL",
    responses((status = 200, description = "Ingress status", body = serde_json::Value))
)]
pub(in crate::server) async fn webhook_ingress_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    // Shared with the `webhooks.ingressStatus` kernel capability and bridge method.
    Json(app_webhooks::ingress_status(&state).await)
}

/// `GET /api/webhooks` — the unified webhook endpoint registry (webhook-unify #3).
///
/// One list/inspect surface over every inbound webhook receiver on this node —
/// the composio webhook and every workflow that declares a `Webhook` trigger —
/// each carrying its **resolved public URL** (the fix for the desktop showing a
/// `localhost` URL), whether a secret is configured, and its last-delivery time.
///
/// The per-endpoint `public_url` is `public_base_url + <path>`. It is `null` when
/// ingress is not up yet (no base resolved). For the tunnel backends the base is
/// a real origin that forwards every path to Core, so the URL is directly
/// reachable; for the managed RyuRelay per-path routing additionally depends on
/// the relay server emitting the generic inbound frame (see the server handoff).
#[utoipa::path(
    get,
    path = "/api/webhooks",
    tag = "Nodes",
    summary = "List all inbound webhook endpoints (registry) with resolved public URLs",
    responses((status = 200, description = "Webhook registry", body = serde_json::Value))
)]
pub(in crate::server) async fn webhooks_list(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    // Shared with the `webhooks.list` kernel capability and app host-bridge method.
    Json(app_webhooks::registry(&state).await)
}

#[derive(serde::Deserialize)]
pub(crate) struct WebhookSecretBody {
    /// When omitted or blank, Core mints a fresh high-entropy secret. A supplied
    /// value is trimmed at the edges and kept verbatim otherwise.
    #[serde(default)]
    pub(crate) secret: Option<String>,
}

pub(in crate::server) const MIN_WEBHOOK_SECRET_LEN: usize = 16;
pub(in crate::server) const MAX_WEBHOOK_SECRET_LEN: usize = 512;

pub(in crate::server) fn mint_webhook_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub(in crate::server) fn normalize_webhook_secret(input: Option<String>) -> Result<String, String> {
    let secret = input.unwrap_or_default().trim().to_owned();
    if secret.is_empty() {
        return Ok(mint_webhook_secret());
    }
    if secret.chars().count() < MIN_WEBHOOK_SECRET_LEN {
        return Err(format!(
            "webhook secret must be at least {MIN_WEBHOOK_SECRET_LEN} characters"
        ));
    }
    if secret.chars().count() > MAX_WEBHOOK_SECRET_LEN {
        return Err(format!(
            "webhook secret must be at most {MAX_WEBHOOK_SECRET_LEN} characters"
        ));
    }
    Ok(secret)
}

pub(in crate::server) fn workflow_webhook_secret(id: &str) -> Result<Option<String>, String> {
    let workflow = crate::workflow::store::load_workflow(id)
        .map_err(|_| format!("workflow '{id}' not found"))?;
    Ok(workflow.triggers.iter().find_map(|trigger| match trigger {
        crate::workflow::WorkflowTrigger::Webhook { secret } => secret
            .as_ref()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        _ => None,
    }))
}

/// `GET /api/webhooks/:id/secret` — return one endpoint's secret only on an
/// explicit protected request. The registry itself remains metadata-only, so a
/// normal list refresh cannot leak signing material.
#[utoipa::path(
    get,
    path = "/api/webhooks/{id}/secret",
    tag = "Nodes",
    summary = "Get one webhook signing secret",
    params(("id" = String, Path, description = "`composio` or a workflow id")),
    responses((status = 200, description = "The signing secret", body = serde_json::Value))
)]
pub(in crate::server) async fn webhook_secret_get(
    Path(id): Path<String>,
) -> axum::response::Response {
    let secret = if id == "composio" {
        crate::composio_triggers::webhook_secret()
    } else {
        match workflow_webhook_secret(&id) {
            Ok(secret) => secret,
            Err(error) => return json_error(StatusCode::NOT_FOUND, error),
        }
    };

    match secret {
        Some(secret) => Json(json!({ "secret": secret })).into_response(),
        None => json_error(
            StatusCode::NOT_FOUND,
            "webhook endpoint has no configured secret".to_owned(),
        ),
    }
}

pub(in crate::server) async fn enforce_webhook_secret_access(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    id: &str,
    permission: &str,
) -> Result<(), axum::response::Response> {
    let result = if id == "composio" {
        enforce_permission(state, caller, permission).await
    } else {
        enforce_permission_on(state, caller, permission, crate::acl::KIND_WORKFLOW, id).await
    };
    if result.is_err() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            format!("insufficient permissions: {permission}"),
        ));
    }
    Ok(())
}

/// Shared with the `webhooks.secretGet` app host-bridge method
/// (`app_webhooks::WebhookSecretOp`), which passes the bridge's verified caller.
pub(crate) async fn webhook_secret_get_authorized(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let permission = if id == "composio" {
        crate::identity_verify::permissions::GATEWAY_CONFIGURE
    } else {
        // The signing secret authenticates an external caller and can start the
        // workflow. Reading it is secret-management authority, not ordinary
        // workflow viewing; keep it aligned with the write/rotation surface.
        crate::identity_verify::permissions::WORKFLOW_EDIT
    };
    if let Err(response) = enforce_webhook_secret_access(&state, &caller, &id, permission).await {
        return response;
    }
    webhook_secret_get(Path(id)).await
}

/// Shared with the `webhooks.secretSet` app host-bridge method
/// (`app_webhooks::WebhookSecretOp`), which passes the bridge's verified caller.
pub(crate) async fn webhook_secret_set_authorized(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<WebhookSecretBody>,
) -> axum::response::Response {
    let permission = if id == "composio" {
        crate::identity_verify::permissions::GATEWAY_CONFIGURE
    } else {
        crate::identity_verify::permissions::WORKFLOW_EDIT
    };
    if let Err(response) = enforce_webhook_secret_access(&state, &caller, &id, permission).await {
        return response;
    }
    webhook_secret_set(Path(id), Json(body)).await
}

/// `POST /api/webhooks/:id/secret` — set or mint a workflow webhook secret.
/// Composio owns its project-subscription secret, so manual Composio writes are
/// rejected. Trigger reconciliation stores that provider value automatically.
#[utoipa::path(
    post,
    path = "/api/webhooks/{id}/secret",
    tag = "Nodes",
    summary = "Set or generate one webhook signing secret",
    params(("id" = String, Path, description = "`composio` or a workflow id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The configured signing secret", body = serde_json::Value),
        (status = 400, description = "Invalid secret"),
        (status = 404, description = "Webhook endpoint not found"),
        (status = 409, description = "Composio secret is managed by its project subscription"),
        (status = 503, description = "Encrypted secret store unavailable")
    )
)]
pub(in crate::server) async fn webhook_secret_set(
    Path(id): Path<String>,
    Json(body): Json<WebhookSecretBody>,
) -> axum::response::Response {
    if id == "composio" {
        return json_error(
            StatusCode::CONFLICT,
            "Composio manages the project webhook secret; save a Composio trigger to sync it"
                .to_owned(),
        );
    }

    let secret = match normalize_webhook_secret(body.secret) {
        Ok(secret) => secret,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };

    let mut workflow = match crate::workflow::store::load_workflow(&id) {
        Ok(workflow) => workflow,
        Err(_) => return json_error(StatusCode::NOT_FOUND, format!("workflow '{id}' not found")),
    };
    let mut found = false;
    for trigger in &mut workflow.triggers {
        if let crate::workflow::WorkflowTrigger::Webhook { secret: current } = trigger {
            *current = Some(secret.clone());
            found = true;
        }
    }
    if !found {
        return json_error(
            StatusCode::NOT_FOUND,
            "workflow has no webhook trigger".to_owned(),
        );
    }

    if let Err(error) = crate::workflow::persist_workflow(workflow).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    Json(json!({ "secret": secret })).into_response()
}

/// `GET /api/webhook-ingress/backend` — the configured backend selector + the
/// full list of available backends (for a picker). The configured kind resolves
/// from the env override → the `webhook.ingress.backend` pref → the default.
#[utoipa::path(
    get,
    path = "/api/webhook-ingress/backend",
    tag = "Nodes",
    summary = "Get the configured webhook ingress backend",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn webhook_ingress_get_backend(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let kind = crate::webhook_ingress::configured_kind(&state.preferences).await;
    let available: Vec<&str> = crate::webhook_ingress::IngressKind::ALL
        .iter()
        .map(|k| k.as_str())
        .collect();
    Json(json!({
        "backend": kind.as_str(),
        "default": crate::webhook_ingress::IngressKind::DEFAULT.as_str(),
        "available": available,
    }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetIngressBackendBody {
    pub(in crate::server) backend: String,
}
