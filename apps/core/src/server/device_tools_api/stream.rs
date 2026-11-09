//! `GET /api/device-tools/stream` (signed connect, P3): the per-device SSE
//! stream that carries calls routed to this phone from a turn it did not
//! start. One subscriber per device; a new signed connect replaces the old.

use std::convert::Infallible;
use std::time::Duration;

use super::auth::{require_principal, require_store, verify_signed};
use crate::device_tools::device_stream;
use crate::device_tools::frames::{data_part_bytes, DeviceUiEvent};
use crate::server::*;
use axum::response::Response;

pub(in crate::server) const STREAM_ROUTE: &str = "/api/device-tools/stream";

/// A comment line that keeps proxies from closing an idle stream.
const KEEP_ALIVE: &[u8] = b": keep-alive\n\n";
const KEEP_ALIVE_EVERY: Duration = Duration::from_secs(25);

/// SSE bytes for a device-stream event; only id-carrying data parts travel
/// on this stream.
pub(in crate::server) fn render_stream_event(event: &DeviceUiEvent) -> Vec<u8> {
    match event {
        DeviceUiEvent::Data { name, id, data } => data_part_bytes(name, id, data),
        DeviceUiEvent::ToolInput { .. } | DeviceUiEvent::ToolOutput { .. } => KEEP_ALIVE.to_vec(),
    }
}

/// `GET /api/device-tools/stream` — signed with method `GET`, the route
/// template and the SHA-256 of an empty body. Hold it only while Ryu is in the
/// foreground. Refused while the flag is off.
#[utoipa::path(get, path = "/api/device-tools/stream", tag = "Device tools",
    summary = "Per-phone stream of routed device calls",
    responses((status = 200, description = "Server-sent events", content_type = "text/event-stream", body = String)))]
pub(in crate::server) async fn device_tools_stream(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(VerifiedUserJwt(user_jwt)): Extension<VerifiedUserJwt>,
    auth: Option<Extension<ResolvedAuthorization>>,
) -> Response {
    let principal = match require_principal(auth.as_ref().map(|a| &a.0), caller.as_ref()) {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    if let Err(response) =
        super::routes::require_enabled(&state, &principal, user_jwt.as_deref()).await
    {
        return response;
    }
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let device_id = match verify_signed(&headers, "GET", STREAM_ROUTE, &principal, b"", &store) {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let (receiver, guard) = device_stream::connect(&principal.id(), &device_id);
    let opened = futures_util::stream::once(async {
        Ok::<_, Infallible>(axum::body::Bytes::from_static(b": connected\n\n"))
    });
    let events =
        futures_util::stream::unfold((receiver, guard), |(mut receiver, guard)| async move {
            match tokio::time::timeout(KEEP_ALIVE_EVERY, receiver.recv()).await {
                Ok(Some(event)) => Some((
                    Ok::<_, Infallible>(axum::body::Bytes::from(render_stream_event(&event))),
                    (receiver, guard),
                )),
                // Replaced by a newer connection, or the device was forgotten.
                Ok(None) => None,
                Err(_) => Some((
                    Ok(axum::body::Bytes::from_static(KEEP_ALIVE)),
                    (receiver, guard),
                )),
            }
        });
    let body = axum::body::Body::from_stream(futures_util::StreamExt::chain(opened, events));
    let mut response = Response::new(body);
    let response_headers = response.headers_mut();
    response_headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/event-stream"),
    );
    response_headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-cache"),
    );
    response_headers.insert(
        "x-accel-buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    response
}
