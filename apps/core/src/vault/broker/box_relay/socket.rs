//! The relay endpoint: `GET /api/vault/broker/box-relay`, a WebSocket whose
//! binary messages carry one Box proxy connection, served by the broker as
//! the Box's own session.
//!
//! Public (the sidecar has no node bearer) and authenticated in the handler:
//! `Authorization: Bearer rvb_…` must name a live relay session (subject
//! `box:<lease>`) whose lease the `x-ryu-box-lease` header names. Anything
//! else is a 401 before the upgrade.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use super::{is_box_session, subject_for, LEASE_HEADER, RELAY_PATH};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::broker::proxy::Broker;
use crate::vault::broker::sessions;

/// Bytes buffered between the socket and the broker, each way.
const PIPE_BYTES: usize = 64 * 1024;
/// How long a reply may still flow after the Box stops sending.
const DRAIN: std::time::Duration = std::time::Duration::from_secs(30);

/// Where the handler finds the store and the running broker.
pub(super) type Source =
    Arc<dyn Fn() -> Option<(&'static PluginSecretStore, Arc<Broker>)> + Send + Sync>;

/// The relay route over the process-wide store and broker.
pub fn routes<S: Clone + Send + Sync + 'static>() -> axum::Router<S> {
    router_with(Arc::new(|| {
        Some((
            crate::plugin_secrets::global()?,
            crate::vault::broker::serving()?,
        ))
    }))
}

pub(super) fn router_with<S: Clone + Send + Sync + 'static>(source: Source) -> axum::Router<S> {
    axum::Router::new().route(
        RELAY_PATH,
        axum::routing::get(move |headers: HeaderMap, upgrade: WebSocketUpgrade| {
            let source = source.clone();
            async move { relay(source(), headers, upgrade).await }
        }),
    )
}

/// A refusal for the egress sidecar, which reads only the status and code
/// (no human reads this endpoint's answers).
fn refusal(status: StatusCode, code: &str) -> Response {
    (
        status,
        axum::Json(serde_json::json!({ "error": { "code": code } })),
    )
        .into_response()
}

async fn relay(
    source: Option<(&'static PluginSecretStore, Arc<Broker>)>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some((store, broker)) = source else {
        return refusal(StatusCode::SERVICE_UNAVAILABLE, "broker_relay_unavailable");
    };
    match admit(store, &headers).await {
        Some(session_id) => upgrade
            .on_upgrade(move |socket| bridge(socket, broker, session_id))
            .into_response(),
        None => refusal(StatusCode::UNAUTHORIZED, "broker_relay_unauthorized"),
    }
}

/// The id of the live relay session the request names, bound to its lease.
pub(super) async fn admit(store: &PluginSecretStore, headers: &HeaderMap) -> Option<String> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?
        .trim()
        .to_owned();
    let lease = headers.get(LEASE_HEADER)?.to_str().ok()?.trim().to_owned();
    if !token.starts_with(sessions::TOKEN_PREFIX) || lease.is_empty() {
        return None;
    }
    let conn = store.conn.lock().await;
    let session = sessions::lookup(&conn, &token, None).ok()??;
    (is_box_session(&session) && session.minted_by == subject_for(&lease)).then_some(session.id)
}

/// Pipe the socket's binary messages to the broker and its replies back,
/// until either side closes.
async fn bridge(socket: WebSocket, broker: Arc<Broker>, session_id: String) {
    let (relay_end, broker_end) = tokio::io::duplex(PIPE_BYTES);
    let served = tokio::spawn(broker.serve_relayed(broker_end, session_id));
    let (mut from_broker, mut to_broker) = tokio::io::split(relay_end);
    let (mut sink, mut stream) = socket.split();
    let inbound = async {
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Binary(data) => {
                    if to_broker.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) | Message::Text(_) => break,
                Message::Ping(_) | Message::Pong(_) => {}
            }
        }
        let _ = to_broker.shutdown().await;
    };
    let outbound = async {
        let mut buffer = vec![0u8; PIPE_BYTES];
        loop {
            match from_broker.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sink
                        .send(Message::Binary(buffer[..read].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = sink.send(Message::Close(None)).await;
    };
    tokio::pin!(inbound, outbound);
    tokio::select! {
        () = &mut outbound => {}
        // The Box is done sending: let the broker finish its reply.
        () = &mut inbound => {
            let _ = tokio::time::timeout(DRAIN, outbound).await;
        }
    }
    served.abort();
}
