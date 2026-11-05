//! WebSocket revocation and the bridge to the sidecar socket.

use super::*;

/// The authorization a Protected tunnel was opened under: the caller's JWT expiry
/// and the node-token generation the WS ticket was minted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ExtWsRevocation {
    pub(super) jwt_expires_at: Option<i64>,
    pub(super) node_generation: u64,
}

/// The pre-upgrade lifetime gate for a consumed WS ticket. A ticket outlives nothing
/// it was minted from: an identity that has already expired is refused with 401
/// here, exactly as the realtime and voice sockets refuse it. Otherwise it returns
/// what ends the tunnel's authorization once it is open. A Public route has no
/// ticket (`None`), so nothing revokes it beyond the sockets themselves.
pub(super) fn ext_ws_revocation_for(
    ticket: Option<&crate::server::ws_ticket::WsTicketClaims>,
) -> Result<Option<ExtWsRevocation>, StatusCode> {
    let Some(ticket) = ticket else {
        return Ok(None);
    };
    if ticket
        .jwt_expires_at
        .is_some_and(|expires_at| expires_at <= chrono::Utc::now().timestamp())
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Some(ExtWsRevocation {
        jwt_expires_at: ticket.jwt_expires_at,
        node_generation: ticket.node_generation,
    }))
}

/// WebSocket close code 1008 (policy violation), the code the realtime and voice
/// sockets close with when the caller's authorization lapses.
pub(super) const WS_CLOSE_POLICY: u16 = 1008;

/// Resolves when a Protected tunnel's authorization lapses: the caller's JWT expires,
/// or the node token rotates away from the generation the ticket was minted in (or
/// its watch closes, which fails closed). `None` (a Public route) never resolves.
/// The permission gate runs once before the upgrade, so without this signal a socket
/// would keep reaching the sidecar under Core's hop bearer for as long as it stayed
/// open.
pub(super) async fn wait_for_ext_ws_revocation(
    revocation: Option<ExtWsRevocation>,
    mut generation_updates: tokio::sync::watch::Receiver<u64>,
) {
    let Some(revocation) = revocation else {
        std::future::pending::<()>().await;
        return;
    };
    let rotation = async move {
        loop {
            if *generation_updates.borrow_and_update() != revocation.node_generation {
                return;
            }
            if generation_updates.changed().await.is_err() {
                return;
            }
        }
    };
    tokio::select! {
        () = crate::server::ws_ticket::wait_for_jwt_expiry(revocation.jwt_expires_at) => {}
        () = rotation => {}
    }
}

/// Bridge one accepted client socket to the sidecar's loopback WS endpoint, pumping
/// bytes (binary and text) both ways until either side closes or `revoked` resolves
/// (for a Protected route, the caller's authorization lapsed:
/// [`wait_for_ext_ws_revocation`]), which closes the client with 1008 and drops the
/// upstream socket. The hop bearer is re-stamped on the upstream dial, exactly like
/// the HTTP lane.
pub(super) async fn bridge_ws_to_sidecar(
    mut client: WebSocket,
    port: u16,
    upstream_path: String,
    hop_token: String,
    revoked: impl std::future::Future<Output = ()> + Send,
) {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    tokio::pin!(revoked);

    let url = format!("ws://127.0.0.1:{port}{upstream_path}");
    let mut request = match url.clone().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("ext ws tunnel: bad upstream URL '{url}': {e}");
            let _ = client.close().await;
            return;
        }
    };
    let mut headers = request.headers_mut();
    if let Ok(value) = axum::http::HeaderValue::from_str(&format!("Bearer {hop_token}")) {
        headers.insert("authorization", value);
    }
    headers.insert(
        "x-ryu-plugin-id",
        axum::http::HeaderValue::from_static("ext-proxy-ws"),
    );

    // Nagle off: the bridge flushes once per frame, so with it on a small frame
    // waits for the sidecar's delayed ACK (about 40 ms on Linux, up to 200 ms on
    // Windows) before it leaves.
    let dialed = tokio_tungstenite::connect_async_with_config(request, None, true).await;
    let (mut upstream, _) = match dialed {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("ext ws tunnel: sidecar WS unreachable at {url}: {e}");
            let _ = client.close().await;
            return;
        }
    };

    loop {
        tokio::select! {
            () = &mut revoked => {
                let _ = client
                    .send(WsMessage::Close(Some(axum::extract::ws::CloseFrame {
                        code: WS_CLOSE_POLICY,
                        reason: "authorization expired".into(),
                    })))
                    .await;
                break;
            }
            msg = client.recv() => {
                match msg {
                    Some(Ok(m)) => {
                        let converted = axum_to_tungstenite(m);
                        let is_close = matches!(converted, TsMessage::Close(_));
                        if upstream.send(converted).await.is_err() {
                            break;
                        }
                        if is_close {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            msg = upstream.next() => {
                match msg {
                    Some(Ok(m)) => {
                        let converted = tungstenite_to_axum(m);
                        let is_close = matches!(converted, WsMessage::Close(_));
                        if client.send(converted).await.is_err() {
                            break;
                        }
                        if is_close {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
        }
    }

    // Best-effort close propagation on the way out.
    let _ = client.close().await;
    let _ = upstream.close(None).await;
}

/// Convert an axum WS message to the tokio-tungstenite shape (same wire content).
pub(super) fn axum_to_tungstenite(msg: WsMessage) -> TsMessage {
    match msg {
        WsMessage::Text(s) => TsMessage::text(s),
        WsMessage::Binary(b) => TsMessage::binary(b),
        WsMessage::Ping(p) => TsMessage::Ping(p.into()),
        WsMessage::Pong(p) => TsMessage::Pong(p.into()),
        WsMessage::Close(Some(frame)) => {
            TsMessage::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.into(),
            }))
        }
        WsMessage::Close(None) => TsMessage::Close(None),
    }
}

/// Convert a tokio-tungstenite WS message back to the axum shape.
pub(super) fn tungstenite_to_axum(msg: TsMessage) -> WsMessage {
    match msg {
        TsMessage::Text(s) => WsMessage::Text(s.to_string()),
        TsMessage::Binary(b) => WsMessage::Binary(b.into()),
        TsMessage::Ping(p) => WsMessage::Ping(p.into()),
        TsMessage::Pong(p) => WsMessage::Pong(p.into()),
        TsMessage::Close(Some(frame)) => WsMessage::Close(Some(axum::extract::ws::CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.into(),
        })),
        TsMessage::Close(None) => WsMessage::Close(None),
        // `Frame` is the fully-parsed variant tokio-tungstenite only yields when
        // reading raw streams; a `connect_async` socket yields the typed variants
        // above. Fall back to nothing-to-forward rather than inventing bytes.
        TsMessage::Frame(_) => WsMessage::Ping(Vec::new()),
    }
}

// ── Host-API callback (/api/host/*) ───────────────────────────────────────────
