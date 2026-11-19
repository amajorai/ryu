//! Per-request context: client address and the authenticating token.

use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

// ── Request context ───────────────────────────────────────────────────────

/// Per-request facts the token layer needs: the resolved client address and
/// the accessor of the token that authenticated the request (for lease
/// attribution).
#[derive(Clone, Default)]
pub struct RequestContext {
    client_ip: Option<IpAddr>,
    token_accessor: Arc<Mutex<Option<String>>>,
}

impl RequestContext {
    pub fn new(client_ip: Option<IpAddr>) -> Self {
        Self {
            client_ip,
            token_accessor: Arc::default(),
        }
    }

    /// The accessor of the token that authenticated this request, if any.
    pub fn token_accessor(&self) -> Option<String> {
        self.token_accessor
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }
}

tokio::task_local! {
    static REQUEST: RequestContext;
}

/// Run `future` with `context` as the current request context.
pub async fn with_request_context<F: Future>(context: RequestContext, future: F) -> F::Output {
    REQUEST.scope(context, future).await
}

/// The current request's client address. `None` outside an HTTP request or
/// when the address cannot be trusted, so CIDR-bound tokens fail closed.
pub fn request_client_ip() -> Option<IpAddr> {
    REQUEST.try_with(|context| context.client_ip).ok().flatten()
}

pub(super) fn note_request_token(accessor: &str) {
    let _ = REQUEST.try_with(|context| {
        if let Ok(mut guard) = context.token_accessor.lock() {
            *guard = Some(accessor.to_owned());
        }
    });
}

/// The accessor of the token that authenticated the current request.
pub fn request_token_accessor() -> Option<String> {
    REQUEST
        .try_with(RequestContext::token_accessor)
        .ok()
        .flatten()
}
