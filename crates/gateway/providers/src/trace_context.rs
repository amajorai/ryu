//! Outbound W3C trace context and request observation for provider HTTP calls.
//!
//! The gateway opens one OTel GenAI model-call span per provider attempt. This
//! crate has no OpenTelemetry dependency, so the gateway hands the already
//! serialized `traceparent`/`tracestate` pairs down through a task-local
//! ([`scope`]) and the provider send helpers stamp them onto the upstream request
//! ([`apply`], and `ChatOptions::extra_headers` for the GenAI SDK path). The same
//! scope records what the span cannot otherwise know — the upstream host/port and
//! HTTP status — so `server.address`, `server.port` and
//! `http.response.status_code` describe the request that actually went out.
//!
//! Outside a scope, or with an empty header set (export consent off → the
//! gateway has no exportable context and never opens a scope with headers),
//! every helper here is a no-op: no header is added and nothing is observed.

use std::future::Future;
use std::sync::{Arc, Mutex};

tokio::task_local! {
    static OUTBOUND: Arc<OutboundTrace>;
}

/// What the scope saw of the last outbound provider request.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ObservedRequest {
    /// Upstream host (`server.address`).
    pub server_address: Option<String>,
    /// Upstream port, explicit or the scheme default (`server.port`).
    pub server_port: Option<u16>,
    /// Upstream HTTP status (`http.response.status_code`).
    pub status: Option<u16>,
}

/// Trace headers to inject plus the observation sink for one model call.
#[derive(Debug, Default)]
pub struct OutboundTrace {
    headers: Vec<(String, String)>,
    observed: Mutex<ObservedRequest>,
}

impl OutboundTrace {
    /// A scope that injects `headers` (W3C `traceparent` and, if present,
    /// `tracestate`) into every provider request made inside it.
    pub fn new(headers: Vec<(String, String)>) -> Arc<Self> {
        Arc::new(Self {
            headers,
            observed: Mutex::default(),
        })
    }

    /// The W3C trace-context headers this scope injects.
    pub fn headers(&self) -> &[(String, String)] {
        &self.headers
    }

    /// The last observed upstream request (host, port, status).
    pub fn observed(&self) -> ObservedRequest {
        self.observed
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn update(&self, apply: impl FnOnce(&mut ObservedRequest)) {
        if let Ok(mut guard) = self.observed.lock() {
            apply(&mut guard);
        }
    }
}

/// Run `future` with `trace` as the outbound trace scope.
pub async fn scope<F: Future>(trace: Arc<OutboundTrace>, future: F) -> F::Output {
    OUTBOUND.scope(trace, future).await
}

/// Carry the active scope, if any, into `future`, which will run on another
/// task: a task-local does not follow `tokio::spawn`. The scope is captured
/// here, on the calling task.
pub fn carry<F: Future>(future: F) -> impl Future<Output = F::Output> {
    let trace = OUTBOUND.try_with(Arc::clone).ok();
    async move {
        match trace {
            Some(trace) => OUTBOUND.scope(trace, future).await,
            None => future.await,
        }
    }
}

/// The active scope, if it carries headers to inject.
fn active() -> Option<Arc<OutboundTrace>> {
    OUTBOUND
        .try_with(Arc::clone)
        .ok()
        .filter(|trace| !trace.headers.is_empty())
}

/// The trace headers of the active scope (empty outside one).
pub(crate) fn current_headers() -> Vec<(String, String)> {
    active()
        .map(|trace| trace.headers.clone())
        .unwrap_or_default()
}

/// Stamp the active scope's trace headers onto `builder` and record the
/// upstream host/port. A no-op outside a scope.
pub(crate) fn apply(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    let Some(trace) = active() else {
        return builder;
    };
    let mut builder = builder;
    for (name, value) in &trace.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    // Peek at the URL through a clone; a streaming body cannot be cloned, in
    // which case the endpoint simply stays unobserved.
    if let Some(request) = builder.try_clone().and_then(|clone| clone.build().ok()) {
        observe_url(&trace, request.url());
    }
    builder
}

fn observe_url(trace: &OutboundTrace, url: &reqwest::Url) {
    let address = url.host_str().map(str::to_owned);
    let port = url.port_or_known_default();
    trace.update(|observed| {
        observed.server_address = address;
        observed.server_port = port;
    });
}

/// Record an upstream HTTP status in the active scope. A no-op outside one.
pub(crate) fn observe_status(status: reqwest::StatusCode) {
    if let Some(trace) = active() {
        trace.update(|observed| observed.status = Some(status.as_u16()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    #[tokio::test]
    async fn scope_injects_headers_and_observes_endpoint() {
        let trace = OutboundTrace::new(vec![("traceparent".into(), TRACEPARENT.into())]);
        let client = reqwest::Client::new();
        let request = scope(Arc::clone(&trace), async {
            let builder = apply(client.post("https://api.example.com/v1/chat"));
            observe_status(reqwest::StatusCode::OK);
            builder.build().unwrap()
        })
        .await;
        assert_eq!(request.headers()["traceparent"], TRACEPARENT);
        assert_eq!(
            trace.observed(),
            ObservedRequest {
                server_address: Some("api.example.com".into()),
                server_port: Some(443),
                status: Some(200),
            }
        );
    }

    #[tokio::test]
    async fn outside_a_scope_or_without_headers_nothing_is_added() {
        let client = reqwest::Client::new();
        let request = apply(client.get("http://127.0.0.1:9/x")).build().unwrap();
        assert!(request.headers().get("traceparent").is_none());
        assert!(current_headers().is_empty());

        let empty = OutboundTrace::new(Vec::new());
        let request = scope(Arc::clone(&empty), async {
            observe_status(reqwest::StatusCode::OK);
            apply(client.get("http://127.0.0.1:9/x")).build().unwrap()
        })
        .await;
        assert!(request.headers().get("traceparent").is_none());
        assert_eq!(empty.observed(), ObservedRequest::default());
    }
}
