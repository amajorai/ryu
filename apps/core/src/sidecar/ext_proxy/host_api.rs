//! The host-API router, sidecar authentication and the RPC entry points.

use super::*;

/// The host-API sub-router (sidecar → Core). Registered on the PUBLIC router because
/// the sidecar process holds only its minted [`ext_token`], not the node bearer;
/// [`authorize_host_call`] does the auth + grant intersection in-handler.
///
/// **Three routes, no app names.** Every sidecar → Core callback in the product goes
/// through one of them:
/// - `/api/host/model/complete` — the proven single-purpose model callback;
/// - `/api/host/rpc` — the extension-host RPC vocabulary (`ryu-kernel-contracts`);
/// - `/api/host/capability/:cap` — the capability broker, which serves BOTH the
///   app-provided capabilities (proxied to the bound provider's sidecar) AND the
///   **kernel** capabilities Core itself implements ([`KERNEL_CAPABILITIES`]).
///
/// This used to carry seven more rows — `/api/host/monitors/{spider,alert}`,
/// `/api/host/meetings/save-notes` and `/api/host/recipes/{run,record-start,
/// record-status,record-stop}` — i.e. an app id baked into Core's route table right
/// next to the generic seam built to replace it. They are now
/// [`KERNEL_CAPABILITIES`] rows reached as `POST /api/host/capability/<cap>`: the
/// sidecar names the *capability* it needs, Core dispatches from a table, and adding
/// an app never adds a route again.
pub fn host_routes() -> Router<ServerState> {
    Router::new()
        .route("/api/host/model/complete", post(host_model_complete))
        .route(
            "/api/host/model/stream",
            post(crate::server::model_stream::host_model_stream),
        )
        .route(
            "/api/host/rpc",
            post(host_rpc).layer(axum::extract::DefaultBodyLimit::max(
                crate::backups::MAX_APP_BYTES + 64 * 1024,
            )),
        )
        .route("/api/host/capability/:cap", post(host_capability))
}

/// The grant a sidecar must hold (declared in `host_api.grants` AND Gateway-approved)
/// to call `POST /api/host/model/complete`.
pub(super) const GRANT_MODEL_COMPLETE: &str = "hook:side-model";

/// Authenticate a host-API callback and resolve the caller's usable grant set.
///
/// Steps, fail-closed at each: read the `x-ryu-plugin-id` header + bearer; recompute
/// that plugin's expected [`ext_token`] and constant-time-compare; confirm the plugin
/// is enabled; then return the intersection of the sidecar's declared
/// `host_api.grants` with the plugin's Gateway-*approved* grants (never the manifest
/// claim). The `required_grant` must survive that intersection.
/// Authenticate a sidecar callback: verify `x-ryu-plugin-id` + minted-token bearer,
/// confirm the plugin is enabled, and return its id + Gateway-approved grants. The
/// shared front half of every `/api/host/*` handler — both [`authorize_host_call`]
/// (kernel-primitive grant intersection) and the capability broker build on it.
pub(crate) async fn authenticate_sidecar(
    state: &ServerState,
    headers: &HeaderMap,
) -> Result<(String, HashSet<String>), (StatusCode, &'static str)> {
    let presented = headers
        .get(HDR_PLUGIN_ID)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or((StatusCode::UNAUTHORIZED, "missing plugin id"))?
        .to_owned();

    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "missing bearer"))?;

    // The ONE site that must canonicalize explicitly. Everything else sees only
    // canonical ids (the manifest loader rewrites them), but this id arrives from
    // OUTSIDE — a sidecar sends whatever its manifest said when it was spawned, and
    // an older third-party sidecar still sends its legacy id.
    //
    // Credentials are minted only for canonical ids. Never mint or accept a
    // second caller-controlled alias credential at this trust boundary.
    let plugin_id = crate::plugin_manifest::canonical_plugin_id(&presented).to_owned();
    if !crate::sidecar::plugin_credentials::verifies(&plugin_id, provided) {
        return Err((StatusCode::UNAUTHORIZED, "bad token"));
    }

    // Enabled gate + Gateway-approved grants (disabled ⇒ approved_grants == [] ⇒
    // deny-all).
    let record = match state.app_store.get(&plugin_id).await {
        Ok(Some(rec)) if rec.enabled => rec,
        Ok(_) => return Err((StatusCode::NOT_FOUND, "plugin not enabled")),
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "lookup failed")),
    };
    let approved =
        crate::plugin_host::current_approved_grants(state, &plugin_id, &record.approved_grants)
            .await;
    Ok((plugin_id, approved))
}

pub(crate) async fn authorize_host_call(
    state: &ServerState,
    headers: &HeaderMap,
    required_grant: &str,
) -> Result<(String, HashSet<String>), (StatusCode, &'static str)> {
    let (plugin_id, approved) = authenticate_sidecar(state, headers).await?;

    // The sidecar's declared host-API grant ceiling (union across its sidecars).
    let declared: HashSet<String> = {
        let manifests = state.app_manifests.read().await;
        let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
            return Err((StatusCode::NOT_FOUND, "manifest not found"));
        };
        manifest
            .sidecars
            .iter()
            .filter_map(|s| s.host_api.as_ref())
            .flat_map(|h| h.grants.iter().cloned())
            .collect()
    };

    // Usable = declared ∩ approved. The requested capability must survive it.
    let usable: HashSet<String> = declared.intersection(&approved).cloned().collect();
    if !usable.contains(required_grant) {
        return Err((StatusCode::FORBIDDEN, "capability not granted"));
    }
    Ok((plugin_id, usable))
}

/// `POST /api/host/model/complete` — a sidecar's authenticated model-completion
/// callback, gated on `hook:side-model` and routed through the SAME
/// [`PluginHookBridge`](crate::plugin_host::PluginHookBridge) `host.sideModel`
/// capability the JS turn-hook sandbox and the in-desktop bridge use (one
/// implementation, one grant vocabulary, one Gateway-governed egress).
pub(super) async fn host_model_complete(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(args): Json<serde_json::Value>,
) -> Response {
    let (plugin_id, grants) =
        match authorize_host_call(&state, &headers, GRANT_MODEL_COMPLETE).await {
            Ok(v) => v,
            Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
        };

    let bridge = crate::plugin_host::PluginHookBridge::new(plugin_id, grants, state);
    use crate::tool_exec::{InvokeOutcome, SandboxBridge};
    match bridge.handle("host.sideModel".to_owned(), args).await {
        InvokeOutcome::Result(r) if r.is_error => {
            let msg = r.error.unwrap_or_else(|| "completion failed".to_owned());
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
        }
        InvokeOutcome::Result(r) => Json(json!({ "result": r.value })).into_response(),
        InvokeOutcome::Suspend(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "completion cannot suspend" })),
        )
            .into_response(),
    }
}

/// `POST /api/host/rpc` — the **extension-host RPC** endpoint. A managed `kind:
/// "node"` sidecar (via the embedded bootstrap's `ctx.host.call`) invokes ONE
/// host-API method, which Core dispatches through the SAME
/// [`PluginHookBridge`](crate::plugin_host::PluginHookBridge) the JS turn-hook
/// sandbox and the iframe app-host use — arm-for-arm, one grant vocabulary, one
/// Gateway-governed egress.
///
/// No new vocabulary is minted: `method` MUST be a row in the single-sourced
/// kernel-contracts host-API table AND map to a bridge dispatch path
/// ([`crate::plugin_host::dispatch_path_for`]); anything else is `400`. Auth is the
/// standard three-way [`authenticate_sidecar`] (token → plugin identity + approved
/// grants) plus the declared∩approved intersection ([`authorize_host_call`]) on the
/// method's required grant — so a node backend can never exceed its plugin's
/// Gateway-approved authority.
pub(super) async fn host_rpc(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<HostRpcBody>,
) -> Response {
    let method = body.method.trim();
    // Resolve grant + bridge path from the single source of truth. A method with no
    // grant (local UI caps like `widget.state`) or no bridge path is not dispatchable.
    let Some(required_grant) = ryu_kernel_contracts::host_api::grant_for(method) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown or non-dispatchable host method '{method}'") })),
        )
            .into_response();
    };
    let Some(bridge_path) = crate::plugin_host::dispatch_path_for(method) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": format!("host method '{method}' is not dispatchable over rpc") }),
            ),
        )
            .into_response();
    };

    let (plugin_id, grants) = match authorize_host_call(&state, &headers, required_grant).await {
        Ok(v) => v,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    let caller = crate::server::verified_caller_from_headers(&headers).await;
    let bridge = crate::plugin_host::PluginHookBridge::new_for_request(
        plugin_id, grants, state, caller, None,
    );
    use crate::tool_exec::{InvokeOutcome, SandboxBridge};
    match bridge.handle(bridge_path.to_owned(), body.args).await {
        InvokeOutcome::Result(r) if r.is_error => {
            let msg = r.error.unwrap_or_else(|| "host call failed".to_owned());
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
        }
        InvokeOutcome::Result(r) => Json(json!({ "result": r.value })).into_response(),
        InvokeOutcome::Suspend(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "host call cannot suspend" })),
        )
            .into_response(),
    }
}

/// Request body for [`host_rpc`]: `{ method, args }`. `args` is forwarded to the
/// bridge VERBATIM — every bridge arm narrows its own fields defensively.
#[derive(serde::Deserialize)]
pub(super) struct HostRpcBody {
    pub(super) method: String,
    #[serde(default)]
    pub(super) args: serde_json::Value,
}

// ── Kernel capabilities (Core-implemented rows of the broker) ─────────────────
