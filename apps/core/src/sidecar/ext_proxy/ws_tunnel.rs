//! The WebSocket lane: ticket checks and the upgrade.

use super::*;

/// Query param carrying the opaque one-use ticket minted by Core's HTTP issuer.
/// Node and user credentials are deliberately rejected on this WebSocket lane.
pub(super) const WS_TICKET_PARAM: &str = "ticket";

/// The tungstenite message type used by the WS tunnel's upstream hop. Aliased once
/// at module scope so both the bridge and the two converters name the same type.
pub(super) type TsMessage = tokio_tungstenite::tungstenite::Message;

/// The upstream path a WS tunnel forwards to (same mount rule as the HTTP lane).
pub(super) fn ws_upstream_path(mount: &str, sub_path: &str) -> String {
    upstream_path_for(mount, sub_path)
}

/// Handler for `/api/ext/ws/:plugin_id/*rest` — the WS twin of [`ext_proxy`]. The
/// `WebSocketUpgrade` extractor runs the enabled-gate + route-allowlist + node-token
/// checks BEFORE the upgrade is accepted, so an unauthenticated or undeclared socket
/// never reaches the sidecar.
pub(super) async fn ext_ws_proxy(
    State(state): State<ServerState>,
    Path((plugin_id, rest)): Path<(String, String)>,
    Extension(expected_node_token): Extension<Option<String>>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let (plugin_id, rest) = split_scoped_plugin_path(plugin_id, rest);
    ext_ws_tunnel(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        &query,
        ws,
    )
    .await
}

/// Handler for the bare `/api/ext/ws/:plugin_id` root (see [`ext_root_proxy`] for why
/// the exact route needs its own handler).
pub(super) async fn ext_ws_root_proxy(
    State(state): State<ServerState>,
    Path(plugin_id): Path<String>,
    Extension(expected_node_token): Extension<Option<String>>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    ext_ws_tunnel(&state, &plugin_id, "/", expected_node_token, &query, ws).await
}

/// Shared core of the two WS handlers: enabled-gate → route-allowlist → node-token →
/// wake → upgrade+bridge. Every refusal is a plain HTTP response that axum sends
/// instead of accepting the upgrade.
pub(super) async fn ext_ws_tunnel(
    state: &ServerState,
    plugin_id: &str,
    sub_path: &str,
    _startup_node_token: Option<String>,
    query: &HashMap<String, String>,
    ws: WebSocketUpgrade,
) -> Response {
    // Enabled gate (secrecy: a disabled/absent plugin's proxied surface must not exist).
    match state.app_store.get(plugin_id).await {
        Ok(Some(rec)) if rec.enabled => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::warn!("ext ws proxy: app_store lookup for '{plugin_id}' failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    // Route allowlist (undeclared path ⇒ 404) + sidecar + mount + max_body (unused for
    // WS, kept for parity of the resolve call).
    let manifests = state.app_manifests.read().await;
    let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some((spec, http, route)) = resolve_route(manifest, sub_path, "GET") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = route.auth;
    let required = required_permission_for(route, sub_path, plugin_id);
    let mount = http
        .mount
        .as_deref()
        .map(|m| m.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    let sidecar_name = crate::sidecar::manifest_sidecar::namespaced_name(plugin_id, &spec.name);
    drop(manifests);

    if query.contains_key("token") || query.contains_key("jwt") {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let ticket = if auth == RouteAuth::Protected {
        let expected_path = format!("/api/ext/ws/{plugin_id}{sub_path}");
        match crate::server::ws_ticket::consume(
            query.get(WS_TICKET_PARAM).map(String::as_str),
            crate::server::ws_ticket::WsTicketRoute::Extension,
            Some(&expected_path),
        ) {
            Some(ticket) => Some(ticket),
            None => return StatusCode::UNAUTHORIZED.into_response(),
        }
    } else {
        None
    };
    let revocation = match ext_ws_revocation_for(ticket.as_ref()) {
        Ok(revocation) => revocation,
        Err(status) => return status.into_response(),
    };

    // The ticket carries the verified caller from the HTTP exchange. The route
    // permission must be checked before waking the sidecar or accepting the
    // upgrade; otherwise a view-only caller could reach the control stream.
    if let Some((permission, resource_id)) = required {
        let caller = ticket.as_ref().and_then(|ticket| ticket.caller.clone());
        if let Err(status) = crate::server::enforce_permission_on(
            state,
            &caller,
            &permission,
            plugin_id,
            &resource_id,
        )
        .await
        {
            return status.into_response();
        }
    }

    let wake_eligible = state.manager.is_wake_eligible(&sidecar_name);

    // Registration gate + wake-on-demand — identical semantics to the HTTP lane.
    let mut target = match state.manager.forward_target(&sidecar_name) {
        Ok(t) => Some(t),
        Err(denied @ ForwardDenied::NotRegistered { .. }) => return sidecar_unavailable(&denied),
        Err(denied @ ForwardDenied::NotRunning { .. }) => {
            if !wake_eligible {
                return sidecar_unavailable(&denied);
            }
            None
        }
    };

    let _activity = if wake_eligible {
        if target.is_none() {
            match state
                .manager
                .wake_and_await_healthy(&sidecar_name, WAKE_WARMUP_TIMEOUT)
                .await
            {
                Ok(woke) => {
                    if woke {
                        fire_lazy_activation(state, ACTIVATION_ON_ROUTE);
                    }
                }
                Err(e) => return wake_failed_response("ext ws proxy", &sidecar_name, &e, false),
            }
            target = match state.manager.forward_target(&sidecar_name) {
                Ok(t) => Some(t),
                Err(denied) => return sidecar_unavailable(&denied),
            };
        }
        Some(state.manager.enter_request(&sidecar_name))
    } else {
        None
    };

    let Some(target) = target else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "sidecar unavailable, retry shortly",
        )
            .into_response();
    };

    let port = target.port();
    let upstream_path = ws_upstream_path(&mount, sub_path);
    let hop_token = ext_token(node_token().as_deref(), plugin_id);

    ws.on_upgrade(move |socket| {
        let revoked =
            wait_for_ext_ws_revocation(revocation, crate::node_token::subscribe_generation());
        bridge_ws_to_sidecar(socket, port, upstream_path, hop_token, revoked)
    })
}
