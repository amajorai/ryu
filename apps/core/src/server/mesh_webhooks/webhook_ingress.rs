//! Mesh status, the webhook ingress seam and sandbox enable/disable: `webhook_ingress_set_backend` through `sandbox_status`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/webhook-ingress/backend` — select the active ingress backend,
/// persisted to the `webhook.ingress.backend` pref. The change takes effect on
/// the next Core start (the ingress is built once at startup). Rejects an unknown
/// backend with 400.
///
/// ## Two selections that used to succeed and then do nothing
///
/// Both are the same defect: the pref was written, `ok: true` came back, and the
/// node behaved as if nothing had been asked for.
///
/// 1. **`own-relay` with no public URL.** Nothing here read
///    `webhook.ingress.url`, so the backend could be selected with nothing to
///    publish. `OwnRelaySource` does not complain until Core next starts, and the
///    GET keeps reporting `own-relay` in the meantime. See
///    [`crate::webhook_ingress::own_relay_rejection`].
/// 2. **Any kind while `RYU_WEBHOOK_INGRESS_URL` is set.**
///    `ryu_webhook_ingress::configured_kind` resolves that variable to
///    `OwnRelay` *before* consulting the pref, so a Cloudflared selection was
///    persisted, acknowledged, and then permanently overridden. See
///    [`crate::webhook_ingress::env_pinned_kind`].
///
/// Both gates run only on this POST. No already-persisted value is re-validated
/// and no read path was changed, so a node that is running today keeps running.
#[utoipa::path(
    post,
    path = "/api/webhook-ingress/backend",
    tag = "Nodes",
    summary = "Set the active webhook ingress backend",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Unknown backend, an `own-relay` selection with no usable public URL, or a `ryu-relay` selection with no known Ryu server"),
        (status = 409, description = "The environment pins the backend to `own-relay`; the requested kind could not take effect"),
    )
)]
pub(in crate::server) async fn webhook_ingress_set_backend(
    State(state): State<ServerState>,
    Json(body): Json<SetIngressBackendBody>,
) -> axum::response::Response {
    let kind: crate::webhook_ingress::IngressKind = match body.backend.parse() {
        Ok(k) => k,
        Err(e) => {
            return json_error(StatusCode::BAD_REQUEST, e.to_string());
        }
    };

    let env_url = crate::webhook_ingress::own_relay_url_env();

    // Gate 1 — the environment pins the kind. 409 (not 400): the request is
    // well-formed and would be valid on this node tomorrow; it conflicts with the
    // node's current state. The message names the variable, because unsetting it
    // is the only way to make the requested kind reachable.
    if let Some(pinned) = crate::webhook_ingress::env_pinned_kind(env_url.as_deref()) {
        if pinned != kind {
            return json_error(
                StatusCode::CONFLICT,
                format!(
                    "the {env} environment variable pins this node's webhook ingress to \
                     '{pinned}', so selecting '{want}' would be recorded but never take \
                     effect. Unset {env} to choose a backend from here.",
                    env = crate::webhook_ingress::OWN_RELAY_URL_ENV,
                    pinned = pinned.as_str(),
                    want = kind.as_str(),
                ),
            );
        }
    }

    // Gate 2 — own-relay needs somewhere to publish. Read through the same
    // env→pref precedence `OwnRelaySource::new` uses, so this cannot disagree with
    // what the backend will actually resolve at start.
    if kind == crate::webhook_ingress::IngressKind::OwnRelay {
        // A pref-store read failure is treated as "no URL configured" — the same
        // direction `from_prefs` already fails in (`prefs.get(..).ok().flatten()`),
        // and the safe one: refusing tells the operator to check the setting,
        // whereas accepting would persist the selection this gate exists to stop.
        let url_pref = state
            .preferences
            .get(crate::webhook_ingress::INGRESS_URL_PREF)
            .await
            .ok()
            .flatten();
        let base =
            crate::webhook_ingress::resolve_own_relay_base(env_url.as_deref(), url_pref.as_deref());
        if let Some(why) = crate::webhook_ingress::own_relay_rejection(base.as_deref()) {
            return json_error(StatusCode::BAD_REQUEST, why);
        }
    }

    // Gate 3: the managed relay registers with the Ryu server this node signed
    // in to (or `RYU_BACKEND_URL`). With none known it could never start, and a
    // success here would leave Composio and workflow webhooks undelivered.
    if kind == crate::webhook_ingress::IngressKind::RyuRelay
        && crate::webhook_ingress::relay_server_base().is_none()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "the Ryu relay needs a Ryu account: sign in first, or choose another ingress backend"
                .to_owned(),
        );
    }

    match state
        .preferences
        .set(crate::webhook_ingress::INGRESS_BACKEND_PREF, kind.as_str())
        .await
    {
        Ok(()) => {
            // The ingress itself changes on the next start, but a Funnel that is no
            // longer the selected ingress must stop publishing now, not at the next
            // daemon restart. Best-effort: a daemon that is not running has no Funnel.
            if kind != crate::webhook_ingress::IngressKind::TailscaleFunnel
                && crate::sidecar::tailscale::daemon_active()
            {
                if let Err(error) = crate::sidecar::tailscale::teardown_funnel().await {
                    tracing::debug!(
                        "webhook-ingress: Funnel teardown after backend switch: {error}"
                    );
                }
            }
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "backend": kind.as_str() })),
            )
                .into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ── Sandbox enable/disable (M6 / issue #190) ─────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/mcp/sandbox/enable",
    tag = "MCP",
    summary = "Enable MCP tool sandboxing",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sandbox_enable() -> Json<serde_json::Value> {
    crate::sidecar::mcp::sandbox::set_enabled(true);
    Json(json!({ "ok": true, "enabled": true }))
}

#[utoipa::path(
    post,
    path = "/api/mcp/sandbox/disable",
    tag = "MCP",
    summary = "Disable MCP tool sandboxing",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sandbox_disable() -> Json<serde_json::Value> {
    crate::sidecar::mcp::sandbox::set_enabled(false);
    Json(json!({ "ok": true, "enabled": false }))
}

#[utoipa::path(
    get,
    path = "/api/mcp/sandbox/status",
    tag = "MCP",
    summary = "MCP sandbox availability + state",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sandbox_status() -> Json<serde_json::Value> {
    use crate::sidecar::sandbox::docker::{detect, DetectResult};

    let enabled = crate::sidecar::mcp::sandbox::is_enabled();
    let available = cfg!(feature = "sandbox-wasmtime");

    // Probe Docker daemon availability (detect-only; never installs Docker).
    let docker_detect = detect().await;
    let docker_available = matches!(docker_detect, DetectResult::Available);
    let docker_reason = match &docker_detect {
        DetectResult::Available => None,
        DetectResult::Unavailable(r) => Some(r.as_str()),
    };

    Json(json!({
        "enabled": enabled,
        "available": available,
        "docker": {
            "available": docker_available,
            "reason": docker_reason,
        }
    }))
}
