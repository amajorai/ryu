//! Gateway config write, status and control-plane proxies: `redact_gateway_config` through `gateway_get_config`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Remove credential values from the generic persisted Gateway config while
/// retaining non-secret policy/configuration fields used by status surfaces.
/// This stays Core-local instead of depending on Gateway's typed config view:
/// Core owns the persisted file path and must protect unknown future Gateway
/// fields as well as today's provider/auth shapes.
pub(in crate::server) fn redact_gateway_config(value: &mut toml::Value) {
    match value {
        // A sealed leaf is a credential whatever its key is called.
        toml::Value::String(text) if ryu_crypto::looks_sealed(text) => {
            *value = toml::Value::String(REDACTED_GATEWAY_CONFIG_VALUE.to_owned());
        }
        toml::Value::Table(table) => {
            for (key, value) in table.iter_mut() {
                if is_gateway_secret_key(key) {
                    redact_gateway_secret_value(value);
                } else {
                    redact_gateway_config(value);
                }
            }
        }
        toml::Value::Array(values) => {
            for value in values {
                redact_gateway_config(value);
            }
        }
        _ => {}
    }
}

pub(in crate::server) fn redact_gateway_secret_value(value: &mut toml::Value) {
    match value {
        // Preserve adapter names and auth-key metadata, but redact every scalar
        // held by a secret container such as providers.genai.keys.
        toml::Value::Table(table) => {
            for (_, value) in table.iter_mut() {
                redact_gateway_secret_value(value);
            }
        }
        // Auth api_keys is an array of metadata tables, while provider api_keys
        // is an array of scalar credentials. Keep the former's safe metadata.
        toml::Value::Array(values) => {
            for value in values {
                if matches!(value, toml::Value::Table(_)) {
                    redact_gateway_config(value);
                } else {
                    *value = toml::Value::String(REDACTED_GATEWAY_CONFIG_VALUE.to_owned());
                }
            }
        }
        _ => {
            *value = toml::Value::String(REDACTED_GATEWAY_CONFIG_VALUE.to_owned());
        }
    }
}

/// `GET /api/gateway/status` — a read-only observability proxy that fetches the
/// local gateway's `/health` and `/metrics` and returns a combined snapshot.
/// Also includes the persisted effective config from `gateway.toml` so the
/// desktop surfaces can reflect the current firewall/routing/budget settings
/// even when the gateway is unreachable. Credential values in that config are
/// replaced with `***` before the response is serialized.
///
/// Always responds `200`. When the gateway is unreachable it returns
/// `{ "reachable": false, ... }` rather than an error status, so the desktop
/// status spine can distinguish "gateway down (Core up)" from "Core down" — the
/// typed client treats any non-2xx as Core being unreachable.
///
/// Forwards the gateway bearer token (`RYU_GATEWAY_TOKEN`) when configured, in
/// case the gateway runs with auth enabled.
#[utoipa::path(
    get,
    path = "/api/gateway/status",
    tag = "Gateway",
    summary = "Gateway status (proxied)",
    description = "Returns Gateway health, metrics, and a persisted effective configuration with credential values redacted before serialization. Always responds 200, including when the Gateway is unreachable.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();

    // Read the effective config from disk so the status endpoint always reflects
    // the persisted config even when the gateway is temporarily down.
    let effective_config: Option<serde_json::Value> = gateway_config_path().and_then(|p| {
        let raw = std::fs::read_to_string(&p).ok()?;
        let mut v: toml::Value = toml::from_str(&raw).ok()?;
        redact_gateway_config(&mut v);
        serde_json::to_value(v).ok()
    });

    // Short timeout: the indicator polls frequently and a down gateway must fail
    // fast rather than stall the UI.
    let fetch_json = |path: &str| {
        let url = format!("{base}{path}");
        let req = state
            .client
            .get(&url)
            .timeout(std::time::Duration::from_millis(1500));
        let req = match token.as_deref() {
            Some(t) => req.bearer_auth(t),
            None => req,
        };
        async move {
            let resp = req.send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.json::<serde_json::Value>().await.ok()
        }
    };

    let (health, metrics) = tokio::join!(fetch_json("/health"), fetch_json("/metrics"));

    // Reachability is gated on /health: if the gateway didn't answer a healthy
    // /health, treat it as down even if a stale /metrics happened to respond.
    let Some(health) = health else {
        return Json(json!({
            "reachable": false,
            "url": base,
            "health": null,
            "metrics": null,
            "effective_config": effective_config,
        }));
    };

    Json(json!({
        "reachable": true,
        "url": base,
        "health": health,
        "metrics": metrics,
        "effective_config": effective_config,
    }))
}

// ── Gateway config proxy (control plane, Unit U017) ─────────────────────────
//
// These two handlers forward to the gateway's `/v1/config` endpoint, carrying
// the bearer token server-side so the desktop never handles the master key. The
// proxy relays the gateway's exact status code; when the gateway is unreachable
// a structured 502 is returned, consistent with AC #3.

pub(in crate::server) fn with_forwarded_gateway_actor(
    mut request: reqwest::RequestBuilder,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> reqwest::RequestBuilder {
    if let Some(caller) = caller {
        request = request.header("x-ryu-control-actor-id", &caller.user_id);
        if let Some(email) = caller.email.as_deref() {
            request = request.header("x-ryu-control-actor-name", email);
        }
    }
    request
}

/// Best-effort local gateway activity row for Core-owned mutations that do not
/// pass through `PUT /v1/config` (provider-key writes and process restarts).
/// The gateway admin boundary remains authoritative; a failed audit write is
/// warned about without turning an already-completed local mutation into an API
/// failure.
pub(in crate::server) async fn record_gateway_control(
    state: &ServerState,
    action: &str,
    target: &str,
    summary: Option<&str>,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) {
    record_gateway_control_attributed(state, action, target, summary, caller, None).await;
}

/// Same best-effort control sink with an optional stable agent correlation.
/// Agent-management routes use this so the organization audit and the agent
/// passport point to the same row.
pub(in crate::server) async fn record_gateway_control_attributed(
    state: &ServerState,
    action: &str,
    target: &str,
    summary: Option<&str>,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent_id: Option<&str>,
) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let mut request = state
        .client
        .post(format!("{}/v1/audit/control", base.trim_end_matches('/')))
        .timeout(std::time::Duration::from_millis(1500))
        .json(&json!({
            "action": action,
            "target": target,
            "summary": summary,
            "actor_id": caller.as_ref().map(|value| value.user_id.as_str()),
            "actor_name": caller
                .as_ref()
                .and_then(|value| value.email.as_deref()),
            "agent_id": agent_id,
        }));
    if let Some(token) = gateway_admin_key() {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => tracing::warn!(
            action,
            target,
            status = %response.status(),
            "gateway control audit write returned a non-success status"
        ),
        Err(error) => tracing::warn!(
            action,
            target,
            error = %error,
            "gateway control audit write failed"
        ),
    }
}

/// `GET /api/engine/concurrency` — local-engine admission-queue depth for the
/// desktop "N/M slots busy · K queued" surface (Layer 2 of the batching work).
///
/// Merges two sources, both best-effort (a missing one is simply omitted):
///   - the **gateway** admission snapshot (`/v1/concurrency`) — in-flight vs
///     queued, with the interactive/background split — the priority queue Core's
///     fan-out traffic flows through; and
///   - the resident **llama.cpp** engine's own `/slots` — how many slots the
///     engine reports busy (covers the direct, ungated LocalEngine path too).
///
/// Always returns 200 with whatever is reachable, so the panel degrades to
/// "unknown" instead of erroring when the gateway or engine is down.
#[utoipa::path(
    get,
    path = "/api/engine/concurrency",
    tag = "Gateway",
    summary = "Local-engine admission-queue + slot depth",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn engine_concurrency(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::sidecar::active_engine::{local_engine_base_url, ActiveEngineStore};
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    // 1. Gateway admission snapshot.
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut req = state
        .client
        .get(format!("{base}/v1/concurrency"))
        .timeout(std::time::Duration::from_millis(2000));
    if let Some(t) = gateway_admin_key().as_deref() {
        req = req.bearer_auth(t);
    }
    let admission = match req.send().await {
        Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
        Err(_) => None,
    };

    // 2. Resident engine's own slot view (best-effort; only meaningful for the
    //    llama.cpp server, which exposes `/slots`).
    let active = ActiveEngineStore::load().active;
    let mut engine_busy: Option<u64> = None;
    let mut engine_total: Option<u64> = None;
    if active.as_deref() == Some("llamacpp") {
        if let Some(engine_base) = active.as_deref().and_then(local_engine_base_url) {
            if let Ok(resp) = state
                .client
                .get(format!("{engine_base}/slots"))
                .timeout(std::time::Duration::from_millis(1500))
                .send()
                .await
            {
                if let Ok(slots) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = slots.as_array() {
                        engine_total = Some(arr.len() as u64);
                        // llama-server slots report `is_processing` (newer) or a
                        // non-`-1` `state` (older). Count either signal as busy.
                        let busy = arr
                            .iter()
                            .filter(|s| {
                                s.get("is_processing").and_then(serde_json::Value::as_bool)
                                    == Some(true)
                                    || s.get("state")
                                        .and_then(serde_json::Value::as_i64)
                                        .is_some_and(|st| st > 0)
                            })
                            .count() as u64;
                        engine_busy = Some(busy);
                    }
                }
            }
        }
    }

    Json(json!({
        "active_engine": active,
        "admission": admission,
        "engine_busy_slots": engine_busy,
        "engine_total_slots": engine_total,
    }))
}

#[utoipa::path(
    get,
    path = "/api/gateway/config",
    tag = "Gateway",
    summary = "Get the gateway config (proxied)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_get_config(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();

    let mut req = state
        .client
        .get(format!("{base}/v1/config"))
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            if status.is_success() {
                crate::acp_runtime::observe_gateway_config(&mut body);
            }
            (status, Json(body))
        }
    }
}
