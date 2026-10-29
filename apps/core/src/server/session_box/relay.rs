//! The self-hosted screen relay (design §6.3). Used only when the node's Box
//! credential has no public ingress (the Box service is on loopback, or has
//! no `RYU_BOX_PUBLIC_URL`); in hosted mode it answers 409
//! `stream_direct_only`, so hosted video never crosses the base node.
//!
//! The client presents a one-use Core ticket (`route: "session-box"`, bound to
//! this exact path) whose caller must own the session. Core then mints a
//! single-use desktop token for this one connection and bridges the socket to
//! the Box service's `GET /v1/boxes/:id/desktop/ws`. The token travels in
//! `Sec-WebSocket-Protocol`, never in a URL.
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::Url;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::CloseFrame, Message as TsMessage,
};

/// The Box service's desktop stream URL for `box_id`, from its API base
/// (`http(s)://host[:port]/v1`).
pub(super) fn upstream_url(base: &Url, box_id: &str) -> Option<String> {
    let scheme = match base.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return None,
    };
    let host = base.host_str()?;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let port = base
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let path = base.path().trim_end_matches('/');
    let path = path.strip_suffix("/v1").unwrap_or(path);
    Some(format!(
        "{scheme}://{host}{port}{path}/v1/boxes/{box_id}/desktop/ws"
    ))
}

/// The absolute direct-stream URL a client dials, from the credential's
/// public ingress (`wss://box.<ingress>`, with or without `/v1`).
pub(super) fn direct_url(public_base: &Url, box_id: &str) -> Option<String> {
    upstream_url(public_base, box_id)
}

/// Dial the Box service's desktop socket with the per-connection token.
pub(super) async fn dial(
    url: &str,
    origin: &str,
    protocols: &[String],
) -> anyhow::Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let mut request = url.into_client_request()?;
    let headers = request.headers_mut();
    headers.insert("origin", origin.parse()?);
    headers.insert("sec-websocket-protocol", protocols.join(", ").parse()?);
    let (upstream, _) = tokio_tungstenite::connect_async(request).await?;
    Ok(upstream)
}

/// Pump frames both ways until either side closes. `on_frame` runs for every
/// client frame (it marks the session active).
pub(super) async fn bridge<S>(
    mut client: WebSocket,
    mut upstream: tokio_tungstenite::WebSocketStream<S>,
    on_frame: impl Fn(),
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            message = client.recv() => {
                let Some(Ok(message)) = message else { break };
                on_frame();
                let converted = to_tungstenite(message);
                let closing = matches!(converted, TsMessage::Close(_));
                if upstream.send(converted).await.is_err() || closing {
                    break;
                }
            }
            message = upstream.next() => {
                let Some(Ok(message)) = message else { break };
                let Some(converted) = to_axum(message) else { continue };
                let closing = matches!(converted, WsMessage::Close(_));
                if client.send(converted).await.is_err() || closing {
                    break;
                }
            }
        }
    }
    let _ = client.close().await;
    let _ = upstream.close(None).await;
}

fn to_tungstenite(message: WsMessage) -> TsMessage {
    match message {
        WsMessage::Text(text) => TsMessage::text(text),
        WsMessage::Binary(bytes) => TsMessage::binary(bytes),
        WsMessage::Ping(bytes) => TsMessage::Ping(bytes.into()),
        WsMessage::Pong(bytes) => TsMessage::Pong(bytes.into()),
        WsMessage::Close(Some(frame)) => TsMessage::Close(Some(CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.into(),
        })),
        WsMessage::Close(None) => TsMessage::Close(None),
    }
}

/// `None` for a raw frame, which a `connect_async` stream never yields.
fn to_axum(message: TsMessage) -> Option<WsMessage> {
    Some(match message {
        TsMessage::Text(text) => WsMessage::Text(text.to_string()),
        TsMessage::Binary(bytes) => WsMessage::Binary(bytes.into()),
        TsMessage::Ping(bytes) => WsMessage::Ping(bytes.into()),
        TsMessage::Pong(bytes) => WsMessage::Pong(bytes.into()),
        TsMessage::Close(Some(frame)) => WsMessage::Close(Some(axum::extract::ws::CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.into(),
        })),
        TsMessage::Close(None) => WsMessage::Close(None),
        TsMessage::Frame(_) => return None,
    })
}
