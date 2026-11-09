//! Resolving one caller's device-tool caps and org globs (P5).
//!
//! Caps come from the caller's own effective rules (`/gateway/tool-policy`,
//! `policy.rules.deviceToolCaps`), never from the node-wide snapshot, which
//! only carries the node credential's layers. Resolution is cached per
//! `(org, team, user)` like the per-caller tool rules: fresh for 60 s, then
//! re-fetched; an outage serves last-known-good; an authoritative refusal
//! (400/401/403) drops it. With no answer at all an org-bound caller gets
//! `never` for every app. A personal unbound node has no caps.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::caps::DeviceToolCaps;
use super::identity::DevicePrincipal;

const CAPS_TTL: Duration = Duration::from_secs(60);

/// Why a fetch produced no caps.
#[derive(Debug)]
pub(crate) enum FetchError {
    /// The control plane refused this caller (400/401/403): authoritative.
    Refused(u16),
    /// Anything else: an outage that keeps last-known-good.
    Unavailable(String),
}

struct Entry {
    at: Instant,
    caps: DeviceToolCaps,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(org_id: &str, team_id: Option<&str>, user_id: &str) -> String {
    format!("{org_id}\0{}\0{user_id}", team_id.unwrap_or_default())
}

fn cached(key: &str, fresh_only: bool) -> Option<DeviceToolCaps> {
    let map = cache().lock().ok()?;
    let entry = map.get(key)?;
    (!fresh_only || entry.at.elapsed() < CAPS_TTL).then(|| entry.caps.clone())
}

/// Resolve under one cache key: fresh cache, else `fetch`, else (outage only)
/// last-known-good, else `never`.
pub(crate) async fn resolve_at<Fetch, Pending>(key: &str, fetch: Fetch) -> DeviceToolCaps
where
    Fetch: FnOnce() -> Pending,
    Pending: std::future::Future<Output = Result<DeviceToolCaps, FetchError>>,
{
    if let Some(caps) = cached(key, true) {
        return caps;
    }
    match fetch().await {
        Ok(caps) => {
            if let Ok(mut map) = cache().lock() {
                map.insert(
                    key.to_owned(),
                    Entry {
                        at: Instant::now(),
                        caps: caps.clone(),
                    },
                );
            }
            caps
        }
        Err(FetchError::Refused(status)) => {
            if let Ok(mut map) = cache().lock() {
                map.remove(key);
            }
            tracing::info!(status, "device tool caps refused for this caller");
            DeviceToolCaps::never()
        }
        Err(FetchError::Unavailable(error)) => cached(key, false).unwrap_or_else(|| {
            tracing::debug!(%error, "device tool caps unavailable; failing closed");
            DeviceToolCaps::never()
        }),
    }
}

/// Parse a `/gateway/tool-policy` answer for this node's org.
pub(crate) fn caps_from_policy_response(
    body: &serde_json::Value,
    node_org_id: &str,
) -> Result<DeviceToolCaps, FetchError> {
    if body
        .get("organizationId")
        .and_then(serde_json::Value::as_str)
        != Some(node_org_id)
    {
        return Err(FetchError::Unavailable(
            "tool policy answered for another organization".to_owned(),
        ));
    }
    Ok(DeviceToolCaps::from_wire(
        body.pointer("/policy/rules/deviceToolCaps"),
    ))
}

async fn fetch_caps(org_id: String, user_id: String) -> Result<DeviceToolCaps, FetchError> {
    use crate::sidecar::control_plane as cp;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new);
    let key = cp::gateway_key()
        .ok_or_else(|| FetchError::Unavailable("no node credential".to_owned()))?;
    let mut request = client
        .get(format!(
            "{}/api/control-plane/gateway/tool-policy",
            cp::control_plane_url().trim_end_matches('/')
        ))
        .header("x-gateway-key", key)
        .query(&[("userId", user_id.as_str())])
        .timeout(Duration::from_secs(10));
    if let Some(project) = cp::node_project_id() {
        request = request.header("x-project-id", project);
    }
    let response = request
        .send()
        .await
        .map_err(|error| FetchError::Unavailable(error.to_string()))?;
    let status = response.status();
    if matches!(status.as_u16(), 400 | 401 | 403) {
        return Err(FetchError::Refused(status.as_u16()));
    }
    if !status.is_success() {
        return Err(FetchError::Unavailable(format!("status {status}")));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| FetchError::Unavailable(error.to_string()))?;
    caps_from_policy_response(&body, &org_id)
}

/// The caps in force for this caller on this node.
pub(crate) async fn caps_for(principal: &DevicePrincipal) -> DeviceToolCaps {
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return DeviceToolCaps::none();
    };
    let DevicePrincipal::User(user_id) = principal else {
        // An org-bound node has no device principal without a verified user.
        return DeviceToolCaps::never();
    };
    let key = cache_key(&node.org.id, node.team_id.as_deref(), user_id);
    let org_id = node.org.id.clone();
    let user_id = user_id.clone();
    resolve_at(&key, move || fetch_caps(org_id, user_id)).await
}

/// The org tool-glob denial for a canonical device tool, per caller. An
/// org-bound caller whose rules cannot be resolved is denied (fail closed).
pub(crate) async fn org_denial_for(
    principal: &DevicePrincipal,
    canonical_id: &str,
) -> Option<String> {
    let user_id = match principal {
        DevicePrincipal::User(user_id) => Some(user_id.as_str()),
        DevicePrincipal::LocalOwner => None,
    };
    match crate::org_policy::effective_tool_rules(user_id).await {
        Ok(rules) => crate::approvals::policy::org_policy_denial(rules.as_deref(), canonical_id),
        Err(reason) => Some(reason),
    }
}

/// Make a cached entry stale, as if `CAPS_TTL` had passed. Tests only.
#[cfg(test)]
pub(crate) fn age_for_tests(key: &str) {
    if let Ok(mut map) = cache().lock() {
        if let Some(entry) = map.get_mut(key) {
            if let Some(past) = Instant::now().checked_sub(CAPS_TTL * 2) {
                entry.at = past;
            }
        }
    }
}
