//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `collect_recent_redacted_spans` through `set_active_engine`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Gather a bounded window of recent redacted trace spans for the support bundle.
/// Spans are content-free by construction (`args_hash`, never raw args); this
/// merely caps the count. Best-effort — a read failure yields an empty list.
pub(in crate::server) async fn collect_recent_redacted_spans(
    state: &ServerState,
) -> Vec<crate::support_access::RedactedSpan> {
    let mut out = Vec::new();
    // Pull recent conversation ids, then their spans, newest-conversation first.
    let conv_ids = match state.conversations.list_conversations().await {
        Ok(convs) => convs.into_iter().map(|c| c.id).collect::<Vec<_>>(),
        Err(_) => return out,
    };
    for cid in conv_ids {
        if out.len() >= SUPPORT_RECENT_SPANS_LIMIT {
            break;
        }
        let Ok(spans) = state.traces.get_spans(&cid).await else {
            continue;
        };
        for s in spans {
            if out.len() >= SUPPORT_RECENT_SPANS_LIMIT {
                break;
            }
            out.push(crate::support_access::RedactedSpan {
                conversation_id: s.conversation_id,
                kind: s.kind,
                name: s.name,
                args_hash: s.args_hash,
                started_at: s.started_at,
                ended_at: s.ended_at,
                error: s.error,
            });
        }
    }
    out
}

/// `POST /api/diagnostics/otlp/test-span` — send one `ryu.test` span to the
/// configured OTLP destination and flush it, so the user can verify the endpoint
/// and auth. Refuses (409) unless diagnostics export consent is on and an
/// endpoint is active; a failed flush is a 502. Nothing egresses on refusal.
#[utoipa::path(
    post,
    path = "/api/diagnostics/otlp/test-span",
    tag = "Support",
    summary = "Send a test span to the OTLP destination",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn diagnostics_otlp_test_span() -> (StatusCode, Json<serde_json::Value>)
{
    // The flush blocks on the exporter thread; keep it off the async workers.
    let outcome = tokio::task::spawn_blocking(crate::telemetry::send_test_span).await;
    match outcome {
        Ok(Ok(endpoint)) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "span": "ryu.test", "endpoint": endpoint })),
        ),
        Ok(Err(error)) => {
            let status = match error {
                crate::telemetry::TestSpanError::ExportFailed(_) => StatusCode::BAD_GATEWAY,
                _ => StatusCode::CONFLICT,
            };
            (
                status,
                Json(json!({ "ok": false, "error": error.to_string() })),
            )
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": format!("test span task failed: {error}") })),
        ),
    }
}

/// `GET /api/support-access/audit` — the local, user-readable, append-only audit
/// log of every support-access event (#546, P5). Not gated on the grant: the
/// user can always read their own record of what support saw, even after the
/// grant lapses (that's the point — they hold the record).
#[utoipa::path(
    get,
    path = "/api/support-access/audit",
    tag = "Support",
    summary = "Read the support-access audit log",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn support_access_audit(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.support_audit.list().await {
        Ok(entries) => (StatusCode::OK, Json(json!({ "entries": entries }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `GET /api/system/status` — the merged system-status spine in ONE call.
///
/// Composes the active-engine, sidecar, gateway, and mesh probes Core already
/// exposes individually, applying the degrade rules in one place so every client
/// (desktop, CLI, extension, island, mobile) renders the same reachable/down view
/// instead of each firing 4+ requests and re-deriving the merge. If this endpoint
/// answers at all, Core is reachable; the client adds only the device-local
/// Shadow probe (Shadow is a sensor and is never routed through Core).
#[utoipa::path(
    get,
    path = "/api/system/status",
    tag = "Nodes",
    summary = "Merged system status (engine + sidecars + gateway + mesh)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn system_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    // Reuse each existing handler verbatim, concurrently — no probe logic is
    // duplicated here; only the merge shape lives in Core.
    let (engine, sidecars, gateway, mesh) = tokio::join!(
        get_active_engine(State(state.clone())),
        sidecar_status(State(state.clone())),
        gateway_status(State(state.clone())),
        mesh_status(State(state.clone())),
    );
    let gateway_reachable = gateway
        .0
        .get("reachable")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Json(json!({
        "core": { "reachable": true },
        "engine": engine.0,
        "sidecars": sidecars
            .0
            .get("sidecars")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "gateway": { "reachable": gateway_reachable },
        "mesh": mesh.0,
    }))
}

#[utoipa::path(
    post,
    path = "/api/sidecar/start-all",
    tag = "Sidecars",
    summary = "Start all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sidecar_start_all(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    match state.manager.start_all().await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/sidecar/stop-all",
    tag = "Sidecars",
    summary = "Stop all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sidecar_stop_all(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    state.manager.stop_all().await;
    Json(json!({ "success": true }))
}

#[utoipa::path(
    post,
    path = "/api/sidecar/{name}/start",
    tag = "Sidecars",
    summary = "Start a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sidecar_start(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.manager.start_sidecar(&name).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/sidecar/{name}/stop",
    tag = "Sidecars",
    summary = "Stop a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sidecar_stop(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.manager.stop_sidecar(&name).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/sidecar/{name}/restart",
    tag = "Sidecars",
    summary = "Restart a sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sidecar_restart(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.manager.restart_sidecar(&name).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

/// Report the currently selected local engine, whether it is running, and which
/// local engines are installed and available to swap to. Only one local engine
/// is ever resident at a time.
#[utoipa::path(
    get,
    path = "/api/engine/active",
    tag = "Engines",
    summary = "Get the active resident engine",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_active_engine(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let active = state.manager.active_local_engine().await;
    let available = state.manager.available_local_engines().await;
    let running = active
        .as_ref()
        .map(|name| {
            state
                .manager
                .statuses()
                .into_iter()
                .any(|s| &s.name == name && s.running)
        })
        .unwrap_or(false);
    Json(json!({
        "active": active,
        "running": running,
        "available": available,
        // Which llama.cpp build is installed, so a picker can render
        // "LlamaCpp — CPU only" without a second round trip. `null` until the
        // engine has been installed once.
        "llamacpp_variant": crate::sidecar::providers::llamacpp::variant::installed_variant()
            .map(|v| v.as_str()),
    }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetActiveEngineBody {
    pub(in crate::server) name: String,
}

/// Engine names that are really "llama.cpp with a pinned build": selecting one
/// sets the acceleration preference and then makes plain `llamacpp` resident.
///
/// These are aliases rather than entries in `LOCAL_ENGINES` on purpose. A second
/// engine name would mean a second manager, a second port and a second row in
/// every "which engine serves GGUF" decision — while resolving, on GPU-less
/// hardware, to byte-identical bits on the same port. The user gets the
/// swap-to-CPU action they asked for; Core keeps one resident engine.
pub(in crate::server) fn llamacpp_variant_alias(name: &str) -> Option<&'static str> {
    use crate::sidecar::providers::llamacpp::variant::AUTO;
    match name.trim().to_ascii_lowercase().as_str() {
        "llamacpp-cpu" => Some("cpu"),
        "llamacpp-metal" => Some("metal"),
        "llamacpp-cuda" => Some("cuda"),
        "llamacpp-vulkan" => Some("vulkan"),
        "llamacpp-auto" | "llamacpp-gpu" => Some(AUTO),
        _ => None,
    }
}

/// Swap the resident local engine to `name`: stop whatever local engine is
/// currently resident and start the requested one (mutually exclusive). The
/// selection persists across Core restarts.
#[utoipa::path(
    post,
    path = "/api/engine/active",
    tag = "Engines",
    summary = "Swap the active resident engine",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_active_engine(
    State(state): State<ServerState>,
    Json(body): Json<SetActiveEngineBody>,
) -> Json<serde_json::Value> {
    // "Switch to CPU llama.cpp" arrives here as an engine name. Resolve it to
    // the acceleration preference it really is, install that build, then fall
    // through to the ordinary `llamacpp` swap below.
    let mut name = body.name.clone();
    if let Some(requested) = llamacpp_variant_alias(&body.name) {
        if let Err(e) = apply_llamacpp_variant(&state, requested).await {
            return Json(json!({ "success": false, "error": e.to_string() }));
        }
        name = "llamacpp".to_string();
    }
    match state.manager.set_active_local_engine(&name).await {
        Ok(swap) => {
            // Re-point the gateway's `local` provider at the now-active engine
            // so an agent bound to a local model keeps routing through the
            // gateway to the right engine (U19). A no-op when the swap was
            // idempotent. Best-effort: a gateway refresh failure must not fail
            // the swap itself, so surface it as a warning field.
            let mut gateway_refreshed = true;
            if !swap.unchanged {
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after engine swap failed: {e}");
                    gateway_refreshed = false;
                }
            }
            Json(json!({
                "success": true,
                "active": swap.active,
                "stopped": swap.stopped,
                "running": swap.running,
                "unchanged": swap.unchanged,
                "gateway_refreshed": gateway_refreshed,
            }))
        }
        Err(e) => {
            // A failed llama.cpp activation may have already stopped the prior
            // child. Refresh the managed Gateway so its local provider URL is
            // re-evaluated against the live sidecar instead of continuing to
            // label requests with the newly selected model through an old
            // listener. The refresh is best-effort; the activation error remains
            // the API result and the Gateway manager quarantines an existing
            // listener when no verified local engine is available.
            if name.eq_ignore_ascii_case("llamacpp") {
                if let Err(refresh_error) = state.gateway.refresh().await {
                    tracing::warn!(
                        error = %refresh_error,
                        "gateway: refresh after failed llama.cpp activation failed"
                    );
                }
            }
            Json(json!({ "success": false, "error": e.to_string() }))
        }
    }
}
