//! Inbound W3C trace context for Core's HTTP server.
//!
//! A request that carries a `traceparent` (the Gateway forwarding a governed
//! tool call, an SDK caller starting a chat turn) gets an INFO
//! `http.server.request` span parented under the caller, so Core's agent-turn
//! and tool spans nest in the caller's trace. Mirrors the Gateway's
//! `http_server_span`. Requests without a `traceparent`, and every request while
//! export consent is off, pass straight through: the UI's polling traffic never
//! produces spans and the off path costs one atomic load.
//!
//! The same route layer records the connection's peer address for the request
//! ([`request_peer`]). Handlers that re-enter another route's pipeline in
//! process (the hosted MCP broker tools dispatch through the vault request
//! layer) read it there, so client-address checks see the real caller.

use axum::body::Body;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, MatchedPath};
use axum::http::{Request, Response};
use axum::middleware::Next;
use tracing::Instrument as _;

use crate::telemetry::propagation::{set_parent_from_headers, TRACEPARENT};

/// `{method} {route}`, or just `{method}` when no route matched.
pub(crate) fn server_span_name(method: &str, route: Option<&str>) -> String {
    match route {
        Some(route) => format!("{method} {route}"),
        None => method.to_owned(),
    }
}

fn http_server_span<B>(request: &Request<B>) -> tracing::Span {
    let method = request.method().as_str();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str);
    let span = tracing::info_span!(
        "http.server.request",
        "otel.name" = %server_span_name(method, route),
        "otel.kind" = "server",
        "otel.status_code" = tracing::field::Empty,
        "http.request.method" = method,
        "http.route" = route,
        "url.path" = request.uri().path(),
        "http.response.status_code" = tracing::field::Empty,
    );
    set_parent_from_headers(&span, request.headers());
    span
}

tokio::task_local! {
    /// The connection peer of the HTTP request currently being served.
    static REQUEST_PEER: Option<SocketAddr>;
}

/// The connection peer of the HTTP request currently being served, or `None`
/// outside a request or on a listener without connect info.
pub(crate) fn request_peer() -> Option<SocketAddr> {
    REQUEST_PEER.try_with(|peer| *peer).ok().flatten()
}

/// Route-layer middleware: record the request's peer and wrap a traced
/// inbound request in a server span.
pub(crate) async fn server_span(request: Request<Body>, next: Next) -> Response<Body> {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    REQUEST_PEER.scope(peer, traced(request, next)).await
}

async fn traced(request: Request<Body>, next: Next) -> Response<Body> {
    if !crate::telemetry::is_export_consented() || !request.headers().contains_key(TRACEPARENT) {
        return next.run(request).await;
    }
    let span = http_server_span(&request);
    let response = next.run(request).instrument(span.clone()).await;
    let status = response.status();
    span.record("http.response.status_code", status.as_u16());
    // 5xx is the server's failure; 4xx is the caller's (OTel HTTP conventions).
    if status.is_server_error() {
        span.record("otel.status_code", "ERROR");
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_span_is_named_by_method_and_route_template() {
        assert_eq!(
            server_span_name("POST", Some("/api/mcp/tools/call")),
            "POST /api/mcp/tools/call"
        );
        assert_eq!(server_span_name("GET", None), "GET");
    }

    #[tokio::test]
    async fn the_route_layer_exposes_the_connection_peer_to_the_handler() {
        use tower::ServiceExt as _;
        let router = axum::Router::new()
            .route(
                "/peer",
                axum::routing::get(|| async {
                    request_peer().map_or_else(|| "none".to_owned(), |peer| peer.to_string())
                }),
            )
            .route_layer(axum::middleware::from_fn(server_span));
        let read = |peer: Option<SocketAddr>| {
            let mut request = Request::builder().uri("/peer").body(Body::empty()).unwrap();
            if let Some(peer) = peer {
                request.extensions_mut().insert(ConnectInfo(peer));
            }
            let router = router.clone();
            async move {
                let response = router.oneshot(request).await.unwrap();
                let body = axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap();
                String::from_utf8(body.to_vec()).unwrap()
            }
        };
        assert_eq!(
            read(Some("203.0.113.9:4100".parse().unwrap())).await,
            "203.0.113.9:4100"
        );
        assert_eq!(read(None).await, "none");
        assert_eq!(request_peer(), None, "no peer outside a request");
    }
}
