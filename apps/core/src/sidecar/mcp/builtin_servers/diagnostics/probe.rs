//! Read-only loopback requests to this Core's own documented routes.
//!
//! The diagnostics tools compose their report from routes Core already
//! documents and serves to the desktop, over the same loopback the self-API
//! uses. Only `GET` is ever sent, so nothing here can change the node.

use std::time::Duration;

use serde_json::Value;

/// Bound on one read, so a slow route cannot hold up the whole report.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Where, and as whom, the diagnostics tools read Core's own routes.
pub(crate) struct Loopback<'a> {
    pub(crate) http: &'a reqwest::Client,
    /// This Core's own base URL.
    pub(crate) base: String,
    /// The node's own credential. Never part of any result.
    pub(crate) node_token: Option<String>,
    /// The person the request acts for on an org-bound node. Every handler
    /// then applies that person's role and conversation access.
    pub(crate) acting_user: Option<String>,
}

/// What one route answered.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Probe {
    /// A success status. The body is `null` when it was not JSON.
    Answered(Value),
    /// Any other status.
    Refused(u16),
    /// No answer at all, with a short reason that holds no address.
    Unreachable(&'static str),
}

impl<'a> Loopback<'a> {
    /// This node's own address and credential.
    pub(crate) fn for_this_node(http: &'a reqwest::Client, acting_user: Option<String>) -> Self {
        Self {
            http,
            base: crate::sidecar::gateway::core_self_url(),
            node_token: crate::node_token::active_token().filter(|token| !token.is_empty()),
            acting_user,
        }
    }

    /// `GET` one route of this Core. `path` starts with `/` and may carry a
    /// query string. The caller builds it from constants and from ids that
    /// passed [`is_single_segment`], never from model input.
    pub(super) async fn get(&self, path: &str) -> Probe {
        let url = format!("{}{}", self.base.trim_end_matches('/'), path);
        let mut request = self.http.get(&url).timeout(PROBE_TIMEOUT);
        if let Some(token) = self.node_token.as_deref() {
            request = request.bearer_auth(token);
        }
        if let Some(user) = self.acting_user.as_deref() {
            request = request
                .header(
                    crate::self_api::SELF_CALL_PROOF_HEADER,
                    crate::self_api::self_call_proof(),
                )
                .header(crate::self_api::SELF_CALL_USER_HEADER, user);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(fault) if fault.is_timeout() => return Probe::Unreachable("it timed out"),
            Err(fault) if fault.is_connect() => return Probe::Unreachable("the connection failed"),
            Err(_) => return Probe::Unreachable("the request failed"),
        };
        let status = response.status();
        if !status.is_success() {
            return Probe::Refused(status.as_u16());
        }
        let text = response.text().await.unwrap_or_default();
        Probe::Answered(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
}

/// Whether `id` can stand as one path segment. An id that could leave its
/// segment (`/`, `\`, `..`, `%`, `?`, `#`, a control character) is refused, so
/// a read of one conversation can never be bent into another route.
pub(super) fn is_single_segment(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.contains("..")
        && !id.chars().any(|c| {
            matches!(c, '/' | '\\' | '?' | '#' | '%') || c.is_control() || c.is_whitespace()
        })
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
