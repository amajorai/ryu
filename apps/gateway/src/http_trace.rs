//! Serving seams for the Gateway's HTTP listener: the shutdown signal and the
//! OTel HTTP server span around each inbound request.

use std::time::Duration;

use crate::telemetry;

/// Resolves on Ctrl-C or (Unix) SIGTERM.
pub(crate) async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

/// Liveness/metrics polling routes: never worth a server span.
pub(crate) fn is_polling_path(path: &str) -> bool {
    matches!(
        path,
        "/health" | "/healthz" | "/livez" | "/readyz" | "/metrics"
    )
}

/// The OTel HTTP server span for one inbound request: named `{method} {route}`
/// (or just `{method}` when no route matched), `otel.kind = server`, parented
/// under the caller's W3C `traceparent` when present. INFO so it clears the
/// OTLP layer's INFO+ filter. Carries no URL query or headers.
pub(crate) fn http_server_span<B>(request: &axum::http::Request<B>) -> tracing::Span {
    // Without the consented exporter nothing would leave the process, so build
    // no span at all (one atomic load), and keep health/metrics polls out of
    // the export stream entirely.
    if !telemetry::export_active() || is_polling_path(request.uri().path()) {
        return tracing::Span::none();
    }
    let method = request.method().as_str();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(axum::extract::MatchedPath::as_str);
    let name = match route {
        Some(route) => format!("{method} {route}"),
        None => method.to_owned(),
    };
    let span = tracing::info_span!(
        "http.server.request",
        "otel.name" = %name,
        "otel.kind" = "server",
        "otel.status_code" = tracing::field::Empty,
        "http.request.method" = method,
        "http.route" = route,
        "url.path" = request.uri().path(),
        "http.response.status_code" = tracing::field::Empty,
    );
    telemetry::propagation::set_parent_from_headers(&span, request.headers());
    span
}

/// Record the response status on the server span; 5xx marks it ERROR per the
/// OTel HTTP server conventions (4xx is the client's error, not the server's).
pub(crate) fn record_http_response<B>(
    response: &axum::http::Response<B>,
    _latency: Duration,
    span: &tracing::Span,
) {
    let status = response.status();
    span.record("http.response.status_code", status.as_u16());
    if status.is_server_error() {
        span.record("otel.status_code", "ERROR");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn polling_routes_get_no_server_span() {
        assert!(super::is_polling_path("/health"));
        assert!(super::is_polling_path("/metrics"));
        assert!(!super::is_polling_path("/v1/chat/completions"));
    }
}
