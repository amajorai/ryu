//! LAN discovery for the node selector: the /24 sweep for Core nodes on every
//! profile's port, and this device's outbound LAN address.

use serde::Serialize;

/// A reachable Core found by the LAN sweep ([`super::discover_lan_nodes`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiscoveredNode {
    pub url: String,
    pub latency_ms: u64,
    /// Which profile's Core answered — derived from the PORT it was found on, not
    /// from anything the node reports. A stable desktop discovering a canary node
    /// needs to say so, or two entries differing only by port read as duplicates.
    pub profile: String,
}

// Port Core listens on (the LAN sweep target). Profile-aware so a dev variant
// sweeps for dev nodes on :8980; release stays :7980 via `crate::profile`.
// Bounded sweep: probe at most this many host octets per run to cap latency.
const MAX_SWEEP_HOSTS: u8 = 254;
// Per-host connection/response timeout in milliseconds.
const PROBE_TIMEOUT_MS: u64 = 800;

/// Parse the local subnet prefix from a dotted-quad address string.
/// e.g. "192.168.1.42" -> "192.168.1"
pub(super) fn subnet_prefix(addr: &str) -> Option<String> {
    let parts: Vec<&str> = addr.split('.').collect();
    if parts.len() == 4 {
        Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
    } else {
        None
    }
}

/// Resolve the default outbound IPv4 address by connecting a UDP socket to a
/// well-known external address (8.8.8.8:80). No packets are sent — the connect
/// only picks the route's source address.
pub(super) fn local_ipv4() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

/// Probe a single `host:port` for a live Core `/api/health` endpoint.
/// Returns `Some(latency_ms)` when the response is 2xx, `None` otherwise.
async fn probe(client: &reqwest::Client, host: &str, port: u16) -> Option<u64> {
    let url = format!("http://{host}:{port}/api/health");
    let start = std::time::Instant::now();
    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => Some(start.elapsed().as_millis() as u64),
        _ => None,
    }
}

/// The LAN sweep behind [`super::discover_lan_nodes`].
pub(super) async fn sweep() -> Result<Vec<DiscoveredNode>, String> {
    // Resolve our own address once (opens a single UDP socket), then derive the
    // /24 prefix from it — avoids binding twice.
    let own_ip = local_ipv4().unwrap_or_default();
    let prefix = match subnet_prefix(&own_ip) {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(PROBE_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())?;

    // EVERY profile's port, not just our own. Sweeping a single port meant a
    // stable desktop (:7980) could never see a canary node (:9980) — not even on
    // this machine — so "use a stable app against a canary node" was impossible to
    // set up without hand-entering the URL.
    let mut tasks = tokio::task::JoinSet::new();
    for (profile, offset) in crate::profile::PROFILE_PORT_OFFSETS {
        let port = crate::profile::CORE_BASE_PORT.saturating_add(*offset);
        // Localhost first and always: the common case is a second profile running
        // on THIS machine, which the /24 sweep skips (it excludes our own IP).
        let c = client.clone();
        let p = (*profile).to_string();
        tasks.spawn(async move {
            let latency = probe(&c, "127.0.0.1", port).await;
            ("127.0.0.1".to_string(), port, p, latency)
        });
        for host_octet in 1u8..=MAX_SWEEP_HOSTS {
            let host = format!("{prefix}.{host_octet}");
            if host == own_ip {
                continue;
            }
            let c = client.clone();
            let p = (*profile).to_string();
            tasks.spawn(async move {
                let latency = probe(&c, &host, port).await;
                (host, port, p, latency)
            });
        }
    }

    let mut found: Vec<DiscoveredNode> = Vec::new();
    while let Some(Ok((host, port, profile, Some(latency_ms)))) = tasks.join_next().await {
        found.push(DiscoveredNode {
            url: format!("http://{host}:{port}"),
            latency_ms,
            profile,
        });
    }

    // Deduplicate: 127.0.0.1 and this machine's LAN address can both answer for the
    // same Core, and listing one node twice reads as two nodes.
    found.sort_by(|a, b| a.url.cmp(&b.url));
    found.dedup_by(|a, b| a.url == b.url);
    found.sort_by_key(|n| n.latency_ms);
    Ok(found)
}
