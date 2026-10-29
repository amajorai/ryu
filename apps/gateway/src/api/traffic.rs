//! `GET /v1/traffic`: live request traffic as a Server-Sent Events stream.
//!
//! Subscribes to the gateway's in-memory [`crate::traffic::TrafficBus`], seeds
//! the subscriber with the bounded recent ring buffer, then streams every
//! request that completes (audit records are broadcast by
//! [`crate::state::AppState::log_audit`]). This is the live feed behind the
//! desktop's LM-Studio-style traffic dashboard.
//!
//! Contract:
//!
//! * **SSE framing**: `Content-Type: text/event-stream`; each event carries a
//!   `data:` line with the redacted JSON request event and a `id:` line with the
//!   gateway request id (for `Last-Event-ID` resume if a client implements it).
//! * **Seeded on connect**: a new subscriber first receives the recent ring
//!   buffer (newest last), so the dashboard renders history immediately, then
//!   live events.
//! * **Keep-alive**: a comment line every 15s so proxies / browsers hold the
//!   connection open even during quiet periods.
//! * **Admin-gated**: same [`crate::api::config::require_local_admin`] gate the
//!   audit query uses: master key, or the zero-config loopback posture. The
//!   desktop reaches it through Core's proxy (which forwards the gateway admin
//!   token), never directly with the master key.
//! * **Org-scoped**: `?org=<id>` narrows the stream on the server. The master
//!   key sees every org; any other caller bound to an org only ever receives
//!   that org's events (seed and live alike) and is refused another org's.
//! * **Deduplicated by `seq`**: every event carries a strictly increasing
//!   sequence number, so a live event the seed already covered is skipped,
//!   while two rows of one request (a verdict, then its completion) both
//!   arrive.
//!
//! The stream is best-effort by design: if the client lags behind the broadcast
//! channel the missed events are skipped and the stream continues from the live
//! position (a reconnect re-seeds history from the ring).
//! There is no replay cursor beyond the ring — the SQLite audit store remains
//! the system of record for anything older.

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    Error as AxumError,
};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    api::config::require_local_admin,
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
    traffic::TrafficScope,
};

/// Keep-alive cadence. Comments carry no data and are ignored by SSE parsers;
/// they exist to keep intermediaries from closing an idle connection.
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// `GET /v1/traffic` query parameters.
#[derive(Debug, Default, Deserialize)]
pub struct TrafficParams {
    /// Only stream events for this organization id.
    pub org: Option<String>,
}

/// Build the live traffic SSE stream.
///
/// The handler authenticates and gate-checks BEFORE constructing the stream, so
/// an unauthorized caller gets a clean error instead of a half-open stream. The
/// returned `Sse` then lives independently: the broadcast receiver it holds is
/// 'static (cloned from the shared bus), so no state borrow is retained.
pub async fn live_traffic(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(params): Query<TrafficParams>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, AxumError>>>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Live traffic feed",
    )?;
    let scope = TrafficScope::for_caller(
        ctx.is_master_key,
        ctx.org_id.as_deref(),
        params.org.as_deref(),
    )?;

    let rx = state.traffic.subscribe();
    // Snapshot the ring AFTER subscribing so a request completing between the
    // snapshot and the subscribe cannot be lost. Anything in the snapshot is
    // skipped on the live channel by its `seq`.
    let (seed, seeded_through) = seed_events(state.traffic.recent(), &scope);

    // Map each broadcast event to an SSE `data:` + `id:` line. Uses
    // `stream::unfold` (the tree's convention) rather than the `async-stream`
    // macro: the receiver lives in the unfold state, so the stream owns it.
    //
    // Broadcast lag (`RecvError::Lagged`) means the client fell behind the ring
    // capacity: skip the lagged marker and continue from the live position;
    // the client's next reconnect re-seeds history.
    let stream = futures_util::stream::unfold(
        (rx, seed.into_iter(), seeded_through, scope),
        |(mut rx, mut seed_events, seeded_through, scope)| async move {
            // Drain the snapshot first.
            if let Some(value) = seed_events.next() {
                let event = to_sse_event(value);
                return Some((Ok(event), (rx, seed_events, seeded_through, scope)));
            }
            // Then follow the live channel.
            loop {
                match rx.recv().await {
                    Ok(value) => {
                        if !admits_live(&value, seeded_through, &scope) {
                            continue;
                        }
                        let event = to_sse_event(value);
                        return Some((Ok(event), (rx, seed_events, seeded_through, scope)));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // The bus sender lives for the process lifetime; Closed is
                        // unreachable in practice. End the stream defensively.
                        return None;
                    }
                }
            }
        },
    );

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEP_ALIVE_INTERVAL)))
}

/// The ring snapshot a subscriber is seeded with, filtered to its scope, and
/// the highest `seq` the snapshot covered (whether or not the scope admitted
/// it), so the live channel skips exactly what the ring already held.
fn seed_events(recent: Vec<Value>, scope: &TrafficScope) -> (Vec<Value>, u64) {
    let seeded_through = recent.iter().filter_map(event_seq).max().unwrap_or(0);
    let seed = recent
        .into_iter()
        .filter(|value| scope.admits(value))
        .collect();
    (seed, seeded_through)
}

/// Whether a live event is sent: newer than the seed and inside the scope.
fn admits_live(value: &Value, seeded_through: u64, scope: &TrafficScope) -> bool {
    event_seq(value).is_none_or(|seq| seq > seeded_through) && scope.admits(value)
}

fn event_seq(value: &Value) -> Option<u64> {
    value.get("seq").and_then(Value::as_u64)
}

/// Build a single SSE `traffic` event with `data:` + `id:` fields.
fn to_sse_event(value: Value) -> Event {
    let id = value
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut event = Event::default()
        .event("traffic")
        .json_data(value)
        .expect("traffic event is JSON-serializable");
    if !id.is_empty() {
        event = event.id(id);
    }
    event
}
