//! Public RHP pairing ingress (`POST /api/hardware/pair`, PROTOCOL.md §5/§6).
//!
//! This is **kernel ingress** that forwards to the extracted [`ryu_hardware`]
//! crate. It stays Core-side (not in the crate) because the node-URL resolution is
//! welded to two kernel couplings the crate must not depend on:
//!   - the mesh handle (`state.mesh`) for the MagicDNS name, and
//!   - the shared SSRF guard (`super::is_blocked_ip`) that decides whether an
//!     attacker-controllable `Host` header may be reflected into a device's
//!     `node_url`.
//!
//! ## Auth split
//!
//! `pair` is **public**: the proof-of-possession is the pairing nonce shown
//! out-of-band on the device (QR / BLE), and the companion app may hold only a
//! better-auth session, not the node's `RYU_TOKEN`. Once the node-url is resolved,
//! the actual nonce verification + token issuance + registry write happen in
//! [`ryu_hardware::pairing::pair`].
//!
//! Placement (Core vs Gateway): the registry decides *which device may drive this
//! node*, so it is Core.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::json;

use super::ServerState;
use ryu_hardware::pairing::{self, PairError};
use ryu_hardware::protocol::PairRequest;

/// Resolve the WS URL a freshly-paired device should connect to. Prefers the
/// `Host` the app actually reached the node on (the address that demonstrably
/// works from the app's network), then the mesh MagicDNS name, then the bound
/// address. Nothing is hardcoded; `RYU_HARDWARE_NODE_URL` overrides everything.
async fn resolve_node_url(state: &ServerState, headers: &HeaderMap) -> String {
    // 1. Explicit operator override always wins.
    if let Ok(explicit) = std::env::var("RYU_HARDWARE_NODE_URL") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    let bind = std::env::var("RYU_BIND").unwrap_or_else(|_| "127.0.0.1:7980".to_string());
    let magic_dns = state
        .mesh
        .status()
        .await
        .magic_dns_name
        .filter(|d| !d.is_empty());

    // 2. The `Host` the app reached the node on — but ONLY when it names an
    // address in the device's own trust domain. The `Host` header is attacker-
    // controllable, so a forged public host must never be reflected into the
    // node_url: that would redirect the freshly-paired device (and its
    // device_token) to attacker infrastructure. See `host_is_trusted`.
    if let Some(host) = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|h| !h.is_empty())
    {
        if host_is_trusted(&host, &bind, magic_dns.as_deref()) {
            return format!("{}://{host}/api/hardware/ws", ws_scheme(&host));
        }
        tracing::warn!(
            host = %host,
            "hardware: ignoring untrusted Host header for device node_url; using mesh/bind address"
        );
    }

    // 3. Mesh MagicDNS name (stable across networks) when the daemon is up. A
    // tailnet host is not loopback, so it uses the secure scheme.
    if let Some(dns) = magic_dns {
        return format!("wss://{dns}:7980/api/hardware/ws");
    }
    // 4. The bound address.
    format!("{}://{bind}/api/hardware/ws", ws_scheme(&bind))
}

/// Extract the IP literal from a `Host`/bind value, with or without a `:port`
/// and with or without `[..]` brackets for IPv6. Returns `None` for hostnames.
fn host_ip(host: &str) -> Option<std::net::IpAddr> {
    if let Ok(sa) = host.parse::<std::net::SocketAddr>() {
        return Some(sa.ip());
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Some(ip);
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok()
}

/// Whether a `Host` header may be reflected verbatim into a device's `node_url`.
///
/// The header is attacker-controllable, so it is honored ONLY when it names an
/// address in the device's own trust domain:
///   - a loopback / private / link-local / CGNAT IP literal (leaking the token
///     to such an address keeps it on the same LAN/tailnet as the device), as
///     classified by the shared SSRF guard [`super::is_blocked_ip`];
///   - `localhost`, or the address Core is actually bound to (`RYU_BIND`);
///   - the node's mesh MagicDNS name;
///   - an operator allowlist (`RYU_HARDWARE_ALLOWED_HOSTS`, comma-separated).
///
/// Any other host (an arbitrary public name/IP) is refused, so a forged `Host`
/// cannot redirect a paired device and its token off-box.
fn host_is_trusted(host: &str, bind: &str, magic_dns: Option<&str>) -> bool {
    // IP literal: trust exactly the private/loopback/link-local ranges.
    if let Some(ip) = host_ip(host) {
        return super::is_blocked_ip(ip);
    }
    // Hostname: strip an optional `:port`, then match known-good names.
    let name = host
        .rsplit_once(':')
        .map_or(host, |(h, _)| h)
        .to_ascii_lowercase();
    if name == "localhost" {
        return true;
    }
    let bind_name = bind
        .rsplit_once(':')
        .map_or(bind, |(h, _)| h)
        .to_ascii_lowercase();
    if name == bind_name {
        return true;
    }
    if magic_dns.is_some_and(|d| d.to_ascii_lowercase() == name) {
        return true;
    }
    if let Ok(allowed) = std::env::var("RYU_HARDWARE_ALLOWED_HOSTS") {
        return allowed
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .any(|a| !a.is_empty() && a == name);
    }
    false
}

/// The WS scheme for a host: plain `ws` for loopback (no TLS in front), secure
/// `wss` for anything reachable off-box (PROTOCOL.md §2 uses `wss` for the
/// non-loopback endpoint). A node fronted by a non-loopback bind / tunnel is
/// expected to terminate TLS, so the device dials `wss`.
fn ws_scheme(host: &str) -> &'static str {
    let bare = host.split(':').next().unwrap_or(host);
    let loopback = bare == "localhost"
        || bare == "127.0.0.1"
        || bare == "::1"
        || bare == "[::1]"
        || bare.starts_with("127.");
    if loopback {
        "ws"
    } else {
        "wss"
    }
}

/// `POST /api/hardware/pair` — register a device from a pairing nonce. **Public**.
#[utoipa::path(
    post,
    path = "/api/hardware/pair",
    tag = "Hardware",
    summary = "register a device from a pairing nonce. **Public**.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn pair_device(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<PairRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let node_url = resolve_node_url(&state, &headers).await;
    match pairing::pair(&state.hardware, &req, &node_url).await {
        Ok(resp) => (StatusCode::OK, Json(json!(resp))),
        Err(e) => {
            let status = match e {
                PairError::AlreadyPaired => StatusCode::CONFLICT,
                PairError::BadNonce => StatusCode::UNAUTHORIZED,
                PairError::Storage => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (
                status,
                Json(json!({ "error": { "code": e.code(), "message": e.message() } })),
            )
        }
    }
}
