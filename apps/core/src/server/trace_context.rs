//! Inbound W3C trace context for Core's HTTP server.
//!
//! A request that carries a `traceparent` (the Gateway forwarding a governed
//! tool call, an SDK caller starting a chat turn) gets an INFO
//! `http.server.request` span parented under the caller, so Core's agent-turn
//! and tool spans nest in the caller's trace. Mirrors the Gateway's
//! `http_server_span`. Requests without a `traceparent`, and every request while
//! export consent is off, pass straight through: the UI's polling traffic never
//! produces spans and the off path costs one atomic load.

use axum::body::Body;
use axum::extract::MatchedPath;
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

/// Route-layer middleware: wrap a traced inbound request in a server span.
pub(crate) async fn server_span(request: Request<Body>, next: Next) -> Response<Body> {
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
}
