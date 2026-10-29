//! AI calls from inside a session Box (design §7.6).
//!
//! Core mints a short-lived `gwb1` key for each live Box, scoped to the org,
//! the owner, the session, the Box and its lease epoch. It is signed with the
//! key the Gateway verifies Core with: the per-org Core proof key on a managed
//! node (the hosted fleet derives the same key), or the local `local-core`
//! forwarder key otherwise. The key is delivered with
//! `PUT /v1/boxes/:id/session-credential` (a 0600 tmpfs file inside the Box),
//! refreshed every 10 minutes while the Box is live, and never placed in the
//! create body, the Box's state, or argv. Parking aborts the refresher, so a
//! parked Box's key dies within its 20-minute TTL.
//!
//! A self-hosted node whose Gateway listens on loopback gives the Box
//! `{RYU_NODE_PUBLIC_URL}/api/session-boxes/inference`, a Core relay that
//! accepts only `gwb1` keys for Boxes live on this node and forwards them to
//! the loopback Gateway.
use super::{api_error, box_client, existing_slot, lock_registry, unix_now, Phase, SessionBoxKey};
use axum::{
    body::Body,
    extract::{Path, Request},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::TryStreamExt as _;
use ryu_gw_credentials::BoxInferenceScope;
use ryu_sandbox::{box_types::SecretString, box_types::SessionCredential, WorkspaceId};
use std::time::Duration;

/// How often a live Box's key is replaced.
pub(super) const REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// A key's lifetime: the longest the Gateway accepts (20 minutes).
pub(super) const KEY_TTL_SECONDS: u64 = 20 * 60;
/// Largest inference request body the relay forwards.
const MAX_RELAY_BODY_BYTES: usize = 16 * 1024 * 1024;
/// Path prefix of the Core inference relay.
pub(super) const RELAY_PREFIX: &str = "/api/session-boxes/inference";

/// The key Core signs `gwb1` scopes with: the key the Gateway that serves the
/// Box verifies Core with.
fn signer_key() -> anyhow::Result<String> {
    #[cfg(test)]
    if let Some(key) = super::tests::test_signer_key() {
        return Ok(key);
    }
    if crate::sidecar::gateway::remote_data_plane() {
        crate::sidecar::gateway::required_gateway_core_proof_key()
    } else {
        crate::sidecar::gateway::required_gateway_core_token()
    }
}

/// The Gateway URL a Box calls: the hosted fleet on a managed node, the Core
/// relay on a self-hosted node that advertises a public URL, or `None` when
/// the Box cannot reach any Gateway.
pub(super) fn gateway_url_for_box() -> Option<String> {
    #[cfg(test)]
    if let Some(url) = super::tests::test_gateway_url() {
        return url;
    }
    if crate::sidecar::gateway::remote_data_plane() {
        return Some(
            crate::sidecar::gateway::gateway_url()
                .trim_end_matches('/')
                .to_owned(),
        );
    }
    crate::sidecar::control_plane::node_public_url()
        .map(|base| format!("{}{RELAY_PREFIX}", base.trim_end_matches('/')))
}

/// The org a Box's key names: the node's registered org, or `local` on an
/// unregistered self-hosted node (whose local Gateway accepts any org label
/// from its own forwarder key).
fn org_id() -> String {
    crate::sidecar::control_plane::registered_org().map_or_else(|| "local".to_owned(), |org| org.id)
}

/// The scope of one Box's key.
pub(super) fn scope_for(
    key: &SessionBoxKey,
    box_id: &WorkspaceId,
    lease_epoch: u64,
    now: u64,
) -> BoxInferenceScope {
    BoxInferenceScope {
        org_id: org_id(),
        user_id: key.owner.strip_prefix("user:").map(str::to_owned),
        session_id: key.session_id(),
        box_id: box_id.0.clone(),
        lease_epoch,
        expires_at: now + KEY_TTL_SECONDS,
    }
}

/// Mint and deliver one key. `Ok(false)` when no Gateway is reachable from a
/// Box on this node (nothing is delivered).
pub(super) async fn deliver(
    key: &SessionBoxKey,
    box_id: &WorkspaceId,
    lease_epoch: u64,
) -> anyhow::Result<bool> {
    let Some(gateway_url) = gateway_url_for_box() else {
        return Ok(false);
    };
    let now = unix_now();
    let scope = scope_for(key, box_id, lease_epoch, now);
    let token = scope.sign_at(&signer_key()?, now)?;
    let credential = SessionCredential {
        gateway_url,
        key: SecretString::new(token),
        expires_at: super::rfc3339(scope.expires_at)
            .ok_or_else(|| anyhow::anyhow!("Box key expiry is out of range"))?,
    };
    box_client()
        .await?
        .put_session_credential(box_id, &credential)
        .await?;
    Ok(true)
}

/// Deliver a key now and every [`REFRESH_INTERVAL`] until aborted.
pub(super) fn start_refresher(
    key: SessionBoxKey,
    box_id: WorkspaceId,
    lease_epoch: u64,
) -> Option<tokio::task::JoinHandle<()>> {
    let interval = refresh_interval();
    let handle = tokio::runtime::Handle::try_current().ok()?;
    Some(handle.spawn(async move {
        loop {
            match deliver(&key, &box_id, lease_epoch).await {
                Ok(true) => {}
                Ok(false) => {
                    tracing::info!("No Gateway is reachable from session Boxes on this node; Box inference is unavailable");
                    return;
                }
                Err(error) => {
                    tracing::warn!(error = %error, "Session Box inference key could not be delivered; retrying");
                }
            }
            tokio::time::sleep(interval).await;
        }
    }))
}

fn refresh_interval() -> Duration {
    #[cfg(test)]
    if let Some(interval) = super::tests::test_refresh_interval() {
        return interval;
    }
    REFRESH_INTERVAL
}

fn unauthorized() -> Response {
    api_error(
        StatusCode::UNAUTHORIZED,
        "session_box_inference_unauthorized",
        "A live session Box inference key is required.",
    )
    .into_response()
}

/// Whether `scope` names a Box that is live on this node at its current epoch.
async fn scope_is_live(scope: &BoxInferenceScope) -> bool {
    let slots: Vec<_> = lock_registry()
        .iter()
        .filter(|(key, _)| key.session_id() == scope.session_id)
        .map(|(key, _)| key.clone())
        .collect();
    for key in slots {
        let Some(slot) = existing_slot(&key) else {
            continue;
        };
        let guard = slot.lock().await;
        if let Some(entry) = guard.as_ref() {
            if entry.phase == Phase::Live
                && entry.box_id.0 == scope.box_id
                && entry.lease_epoch == scope.lease_epoch
                && key.owner.strip_prefix("user:") == scope.user_id.as_deref()
            {
                return true;
            }
        }
    }
    false
}

/// Verify a relay request's bearer: a `gwb1` key this Core signed for a Box
/// that is live here.
pub(super) async fn verify_bearer(headers: &HeaderMap) -> Option<String> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?
        .trim()
        .to_owned();
    if !BoxInferenceScope::is_box_token(&token) {
        return None;
    }
    let scope = BoxInferenceScope::verify(&token, &signer_key().ok()?).ok()?;
    scope_is_live(&scope).await.then_some(token)
}

/// Headers forwarded to the Gateway besides the bearer.
const FORWARDED_HEADERS: [&str; 5] = [
    "content-type",
    "accept",
    "x-ryu-session-id",
    "x-ryu-user-id",
    "x-ryu-agent-id",
];

/// `ANY /api/session-boxes/inference/v1/*rest`: relay a Box's inference call
/// to the loopback Gateway. Only on nodes whose Box gets this relay as its
/// Gateway (self-hosted); a managed node's Boxes call the hosted fleet.
pub(super) async fn relay(Path(rest): Path<String>, request: Request) -> Response {
    if crate::sidecar::gateway::remote_data_plane() {
        return api_error(
            StatusCode::NOT_FOUND,
            "session_box_inference_unavailable",
            "Boxes on this node call the hosted Gateway directly.",
        )
        .into_response();
    }
    let (parts, body) = request.into_parts();
    let Some(token) = verify_bearer(&parts.headers).await else {
        return unauthorized();
    };
    if rest.split('/').any(|segment| segment == "..") {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "Invalid path.")
            .into_response();
    }
    let Ok(body) = axum::body::to_bytes(body, MAX_RELAY_BODY_BYTES).await else {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            "The request body is too large.",
        )
        .into_response();
    };
    let mut url = format!(
        "{}/v1/{}",
        upstream_gateway().trim_end_matches('/'),
        rest.trim_start_matches('/')
    );
    if let Some(query) = parts.uri.query() {
        url.push('?');
        url.push_str(query);
    }
    let mut upstream = reqwest::Client::new()
        .request(parts.method.clone(), url)
        .bearer_auth(&token)
        .body(body);
    for name in FORWARDED_HEADERS {
        if let Some(value) = parts.headers.get(name) {
            upstream = upstream.header(name, value.clone());
        }
    }
    let response = match upstream.send().await {
        Ok(response) => response,
        Err(_) => {
            return api_error(
                StatusCode::BAD_GATEWAY,
                "session_box_inference_unavailable",
                "The Gateway could not be reached.",
            )
            .into_response()
        }
    };
    let status = response.status();
    let content_type = response.headers().get("content-type").cloned();
    let stream = response.bytes_stream().map_err(std::io::Error::other);
    let mut relayed = Response::new(Body::from_stream(stream));
    *relayed.status_mut() = status;
    relayed.headers_mut().insert(
        "content-type",
        content_type.unwrap_or_else(|| HeaderValue::from_static("application/json")),
    );
    relayed
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    relayed
}

/// The loopback Gateway the relay forwards to.
fn upstream_gateway() -> String {
    #[cfg(test)]
    if let Some(url) = super::tests::test_upstream_gateway() {
        return url;
    }
    crate::sidecar::gateway::gateway_url()
}
