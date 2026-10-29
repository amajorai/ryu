//! "Route traffic through this computer": a cloud node's web traffic leaves
//! through the user's desktop, so destinations see the desktop's network and IP
//! address instead of the cloud's.
//!
//! Two roles live in this module, and one Core can play either:
//!
//! - **exit** ([`exit`]) runs on the desktop. When the user turns the setting
//!   on, desktop Core dials *out* to each of the user's cloud nodes over a
//!   WebSocket (no inbound port, mesh, or tunnel needed on the desktop) and
//!   connects the destinations those nodes request, after the shared SSRF
//!   screening, so a node can never reach the desktop's loopback or LAN.
//! - **entry** ([`entry`]) runs on the cloud node. It exposes a credentialed
//!   local proxy to the browser app and cloud task containers and forwards
//!   their connections over the attached desktop session. It fails closed:
//!   while routing is on and the desktop is away, connections are refused
//!   rather than silently leaving from the cloud.
//!
//! Organization admins can turn the route off for every member with the
//! [`ORG_FEATURE_KEY`] feature. The node enforces it: new sessions are refused,
//! live sessions end at the next policy recheck, and traffic returns to the
//! cloud path. Each member's own choice is preserved for when it is re-allowed.
//!
//! Model providers are not routed by default. The node owner can opt one in
//! from its provider settings ([`providers`]), for providers that refuse
//! data-center addresses.

pub(crate) mod entry;
pub(crate) mod exit;
mod frame;
mod mux;
pub(crate) mod providers;
mod proxy;

use frame::RefuseCode;
use std::time::Duration;
use tokio::net::TcpStream;

/// Desktop: the user's "Route traffic through this computer" choice.
pub(crate) const ENABLED_PREF_KEY: &str = "local-egress-route-enabled";
/// Node: a desktop asked for routing and has not turned it off.
pub(crate) const ROUTED_PREF_KEY: &str = "local-egress-routed";
/// Node: provider routes the owner turned on (a JSON array of route ids).
pub(crate) const PROVIDER_ROUTES_PREF_KEY: &str = "local-egress-provider-routes";
/// Organization feature gate ("Allow local egress routing").
pub(crate) const ORG_FEATURE_KEY: &str = "network.local_egress";
/// Node route the desktop dials (WebSocket upgrade).
pub(crate) const ROUTE_WS_PATH: &str = "/api/local-egress/route/ws";
/// Node route for status (GET) and explicit detach (DELETE).
pub(crate) const ROUTE_PATH: &str = "/api/local-egress/route";
/// HTTP status a node answers when its org has disabled the route.
pub(crate) const LOCKED_STATUS: u16 = 423;
/// Header carrying the desktop's display name on attach.
pub(crate) const DESKTOP_HEADER: &str = "x-ryu-egress-desktop";
/// Env var carrying the node proxy URL to the browser app sidecar.
pub(crate) const BROWSER_PROXY_ENV: &str = "RYU_EGRESS_PROXY_URL";
/// Env var carrying the provider proxy URL to the Gateway.
pub(crate) const PROVIDER_PROXY_ENV: &str = "RYU_PROVIDER_EGRESS_PROXY_URL";
/// Env var carrying the provider route state file to the Gateway.
pub(crate) const PROVIDER_STATE_ENV: &str = "RYU_PROVIDER_EGRESS_STATE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdminPolicy {
    Allowed,
    Disabled,
    /// The node is org-bound but its feature policy could not be resolved.
    Unknown,
}

/// Resolve the org's local-egress feature for this node's owner. Unbound nodes
/// have no org to consult and are always allowed.
pub(crate) async fn admin_policy() -> AdminPolicy {
    let owner =
        crate::sidecar::control_plane::registered_node().and_then(|node| node.owner_user_id);
    match crate::org_policy::effective_features(owner.as_deref()).await {
        Ok(None) => AdminPolicy::Allowed,
        Ok(Some(features)) => {
            if features.get(ORG_FEATURE_KEY).copied().unwrap_or(true) {
                AdminPolicy::Allowed
            } else {
                AdminPolicy::Disabled
            }
        }
        Err(_) => AdminPolicy::Unknown,
    }
}

/// Resolve, screen, and connect one destination with the same SSRF policy as
/// Core's guarded HTTP (no loopback, private, link-local, or metadata hosts),
/// pinning the connection to an approved address.
pub(crate) async fn connect_screened(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<TcpStream, RefuseCode> {
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    let addresses = if let Ok(ip) = literal.parse::<std::net::IpAddr>() {
        // IP literals skip DNS; screen the address itself.
        if ryu_egress::is_blocked_ip(ip) {
            return Err(RefuseCode::Blocked);
        }
        vec![std::net::SocketAddr::new(ip, port)]
    } else {
        ryu_egress::resolve_guarded_url(
            &format!("http://{host}:{port}/"),
            ryu_egress::GuardedFetchPolicy::default(),
        )
        .await
        .map_err(|error| {
            if error.contains("resolve") {
                RefuseCode::Unreachable
            } else if error.contains("not allowed") {
                RefuseCode::Blocked
            } else {
                RefuseCode::Invalid
            }
        })?
        .addresses
    };
    let mut last = RefuseCode::Unreachable;
    for address in addresses {
        match tokio::time::timeout(timeout, TcpStream::connect(address)).await {
            Ok(Ok(socket)) => {
                let _ = socket.set_nodelay(true);
                return Ok(socket);
            }
            Ok(Err(_)) => last = RefuseCode::Unreachable,
            Err(_) => last = RefuseCode::Timeout,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn screened_connect_refuses_internal_destinations() {
        for host in [
            "127.0.0.1",
            "localhost",
            "10.0.0.8",
            "169.254.169.254",
            "::1",
            "metadata.google.internal",
        ] {
            assert_eq!(
                connect_screened(host, 80, Duration::from_secs(1))
                    .await
                    .err(),
                Some(RefuseCode::Blocked),
                "{host}"
            );
        }
    }
}
