use super::*;

// ── WS tunnel authorization lifetime ────────────────────────────────────────

const RAG_WS_PATH: &str = "/api/ext/ws/@ryu/rag/query";

fn ext_ws_ticket(jwt_expires_at: Option<i64>) -> crate::server::ws_ticket::WsTicketClaims {
    crate::server::ws_ticket::WsTicketClaims {
        app_id: None,
        caller: None,
        kind: None,
        path: Some(RAG_WS_PATH.to_owned()),
        member: false,
        peer_is_loopback: false,
        room_id: None,
        route: crate::server::ws_ticket::WsTicketRoute::Extension,
        jwt_expires_at,
        user_jwt: None,
        node_generation: crate::node_token::active_generation(),
    }
}

fn ext_ws_revocation(jwt_expires_at: Option<i64>, node_generation: u64) -> ExtWsRevocation {
    ExtWsRevocation {
        jwt_expires_at,
        node_generation,
    }
}

#[test]
fn an_ext_ws_ticket_whose_identity_already_expired_is_refused() {
    let now = chrono::Utc::now().timestamp();
    for expired in [now - 60, now] {
        assert_eq!(
            ext_ws_revocation_for(Some(&ext_ws_ticket(Some(expired)))),
            Err(StatusCode::UNAUTHORIZED),
            "a ticket whose JWT expired at {expired} (now {now}) must not upgrade"
        );
    }

    let live = ext_ws_ticket(Some(now + 3_600));
    assert_eq!(
        ext_ws_revocation_for(Some(&live)),
        Ok(Some(ext_ws_revocation(
            Some(now + 3_600),
            live.node_generation
        ))),
        "a live identity upgrades, carrying its expiry and node generation"
    );
    let local = ext_ws_ticket(None);
    assert_eq!(
        ext_ws_revocation_for(Some(&local)),
        Ok(Some(ext_ws_revocation(None, local.node_generation))),
        "a node-token ticket upgrades and is still bound to its generation"
    );
    assert_eq!(
        ext_ws_revocation_for(None),
        Ok(None),
        "a Public route has no ticket to revoke"
    );
}

/// End to end through the real `/api/ext/ws` router: a Protected route's ticket
/// whose JWT already expired is a 401 before the upgrade (and before any sidecar
/// wake), while a live ticket clears the gate and reaches the sidecar gate.
#[tokio::test]
async fn an_expired_ext_ws_ticket_is_a_401_before_the_upgrade() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    // The route is Protected (the default) and its sidecar is never registered.
    let manifest = provider_manifest(1, None);
    let app = manifest.id.clone();
    state.app_store.insert(&app, "1.0.0").await.unwrap();
    state.app_store.set_enabled(&app, &[]).await.unwrap();
    state.app_manifests.write().await.push(manifest);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = ext_routes(None).with_state(state);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let handshake_status = |ticket: String| async move {
        let url = format!("ws://127.0.0.1:{port}{RAG_WS_PATH}?{WS_TICKET_PARAM}={ticket}");
        match tokio_tungstenite::connect_async(url).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status(),
            Ok(_) => panic!("the socket must not upgrade without a registered sidecar"),
            Err(other) => panic!("unexpected handshake failure: {other}"),
        }
    };

    let now = chrono::Utc::now().timestamp();
    let expired = crate::server::ws_ticket::mint_for_test(ext_ws_ticket(Some(now - 60)));
    assert_eq!(
        handshake_status(expired).await.as_u16(),
        StatusCode::UNAUTHORIZED.as_u16()
    );

    let live = crate::server::ws_ticket::mint_for_test(ext_ws_ticket(Some(now + 3_600)));
    assert_eq!(
        handshake_status(live).await.as_u16(),
        StatusCode::SERVICE_UNAVAILABLE.as_u16(),
        "a live ticket passes the identity gate and stops only at the unregistered sidecar"
    );
}

#[tokio::test(start_paused = true)]
async fn an_ext_ws_tunnel_is_revoked_when_the_node_token_rotates() {
    use std::time::Duration;
    use tokio::time::timeout;

    // Rotated between minting the ticket and the upgrade: revoked at once.
    let (_tx, rx) = tokio::sync::watch::channel(5_u64);
    let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(None, 4)), rx);
    assert!(timeout(Duration::from_millis(1), revoked).await.is_ok());

    // Rotated while the tunnel is open.
    let (tx, rx) = tokio::sync::watch::channel(4_u64);
    let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(None, 4)), rx);
    tokio::pin!(revoked);
    assert!(
        timeout(Duration::from_secs(86_400), &mut revoked)
            .await
            .is_err(),
        "an unrotated node token keeps the tunnel open"
    );
    tx.send(4).unwrap();
    assert!(
        timeout(Duration::from_secs(3_600), &mut revoked)
            .await
            .is_err(),
        "republishing the same generation is not a rotation"
    );
    tx.send(5).unwrap();
    assert!(timeout(Duration::from_millis(1), &mut revoked)
        .await
        .is_ok());

    // The generation watch closing fails closed.
    let (tx, rx) = tokio::sync::watch::channel(4_u64);
    let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(None, 4)), rx);
    tokio::pin!(revoked);
    assert!(timeout(Duration::from_secs(3_600), &mut revoked)
        .await
        .is_err());
    drop(tx);
    assert!(timeout(Duration::from_millis(1), &mut revoked)
        .await
        .is_ok());
}

#[tokio::test(start_paused = true)]
async fn an_ext_ws_tunnel_is_revoked_when_the_callers_jwt_expires() {
    use std::time::Duration;
    use tokio::time::timeout;

    let now = chrono::Utc::now().timestamp();
    let (_tx, rx) = tokio::sync::watch::channel(7_u64);
    let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(Some(now + 600), 7)), rx);
    tokio::pin!(revoked);
    assert!(
        timeout(Duration::from_secs(540), &mut revoked)
            .await
            .is_err(),
        "still within the JWT's lifetime"
    );
    assert!(
        timeout(Duration::from_secs(120), &mut revoked)
            .await
            .is_ok(),
        "the tunnel's authorization ends with the JWT"
    );

    let (_tx, rx) = tokio::sync::watch::channel(7_u64);
    let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(Some(now - 1), 7)), rx);
    assert!(timeout(Duration::from_millis(1), revoked).await.is_ok());
}

#[tokio::test(start_paused = true)]
async fn a_public_ext_ws_tunnel_is_never_revoked() {
    use std::time::Duration;
    use tokio::time::timeout;

    let (tx, rx) = tokio::sync::watch::channel(1_u64);
    let revoked = wait_for_ext_ws_revocation(None, rx);
    tokio::pin!(revoked);
    assert!(timeout(Duration::from_secs(86_400), &mut revoked)
        .await
        .is_err());
    let _ = tx.send(2);
    drop(tx);
    assert!(timeout(Duration::from_secs(86_400), &mut revoked)
        .await
        .is_err());
}

/// An open tunnel whose authorization is revoked tells the client why (1008,
/// "authorization expired") and drops its upstream socket to the sidecar.
#[tokio::test]
async fn a_revoked_ext_ws_tunnel_closes_with_1008_and_drops_the_sidecar_socket() {
    use futures_util::{SinkExt as _, StreamExt as _};
    use std::time::Duration;
    use tokio::time::timeout;

    // Sidecar stub: echoes text frames and reports when its socket ends.
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream.local_addr().unwrap().port();
    let (upstream_ended_tx, upstream_ended) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let (stream, _) = upstream.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
            if message.is_text() && socket.send(message).await.is_err() {
                break;
            }
        }
        let _ = upstream_ended_tx.send(());
    });

    // Core side: the real bridge under a revocation the test fires by hand.
    let revoke = std::sync::Arc::new(tokio::sync::Notify::new());
    let handler_revoke = revoke.clone();
    let router = Router::new().route(
        "/ws",
        get(move |ws: WebSocketUpgrade| {
            let revoke = handler_revoke.clone();
            async move {
                ws.on_upgrade(move |socket| {
                    bridge_ws_to_sidecar(
                        socket,
                        upstream_port,
                        "/".to_owned(),
                        "hop".to_owned(),
                        async move { revoke.notified().await },
                    )
                })
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    client.send(TsMessage::text("ping")).await.unwrap();
    let echoed = timeout(Duration::from_secs(10), client.next())
        .await
        .expect("the tunnel carries frames while authorized")
        .expect("a frame")
        .unwrap();
    assert_eq!(echoed.into_text().unwrap(), "ping");

    revoke.notify_one();
    let closed = timeout(Duration::from_secs(10), client.next())
        .await
        .expect("the tunnel closes once revoked")
        .expect("a close frame")
        .unwrap();
    let TsMessage::Close(Some(frame)) = closed else {
        panic!("expected a close frame, got {closed:?}");
    };
    assert_eq!(u16::from(frame.code), WS_CLOSE_POLICY);
    assert_eq!(&*frame.reason, "authorization expired");
    timeout(Duration::from_secs(10), upstream_ended)
        .await
        .expect("the sidecar socket is dropped")
        .unwrap();
}

// ── WebSocket tunnel converters ────────────────────────────────────────────

#[test]
fn ws_message_converters_roundtrip_payloads() {
    use axum::extract::ws::CloseFrame as AxumClose;

    // Text.
    let text = WsMessage::Text("hello".into());
    let ts = axum_to_tungstenite(text.clone());
    assert!(matches!(ts, TsMessage::Text(ref s) if s.as_str() == "hello"));
    assert_eq!(tungstenite_to_axum(ts), text);

    // Binary (the RFB wire form — byte-exact is load-bearing for VNC).
    let binary = WsMessage::Binary(vec![1u8, 2, 3, 255]);
    let ts = axum_to_tungstenite(binary.clone());
    assert!(matches!(&ts, TsMessage::Binary(b) if **b == [1u8, 2, 3, 255]));
    assert_eq!(tungstenite_to_axum(ts), binary);

    // Ping / Pong are forwarded verbatim.
    let ping = WsMessage::Ping(vec![9u8]);
    assert_eq!(tungstenite_to_axum(axum_to_tungstenite(ping.clone())), ping);
    let pong = WsMessage::Pong(vec![8u8]);
    assert_eq!(tungstenite_to_axum(axum_to_tungstenite(pong.clone())), pong);

    // Close carries code + reason through both directions. axum's `CloseCode` is
    // a `u16`; tungstenite's is a distinct type, and both convert via `.into()`.
    let close = WsMessage::Close(Some(AxumClose {
        code: 1000,
        reason: "bye".into(),
    }));
    let ts = axum_to_tungstenite(close.clone());
    assert!(
        matches!(&ts, TsMessage::Close(Some(c)) if u16::from(c.code) == 1000 && c.reason.as_ref() == "bye")
    );
    let back = tungstenite_to_axum(ts);
    assert!(matches!(&back, WsMessage::Close(Some(c)) if c.code == 1000 && c.reason == "bye"));

    // No-reason close.
    assert!(matches!(
        tungstenite_to_axum(TsMessage::Close(None)),
        WsMessage::Close(None)
    ));
    // A `Frame` variant (only reachable via raw streams) degrades to Ping, never
    // invents bytes.
    let frame =
        TsMessage::Frame(tokio_tungstenite::tungstenite::protocol::frame::Frame::ping(vec![]));
    assert!(matches!(tungstenite_to_axum(frame), WsMessage::Ping(_)));
}
