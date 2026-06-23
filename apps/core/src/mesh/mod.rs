//! Mesh status + Funnel helpers (P5 of the unified-tool-gateway epic, #478).
//!
//! Core owns **what runs** — here, the optional Tailscale/Headscale daemon (see
//! [`crate::sidecar::tailscale`]). This module is the read side: it shells out to
//! `tailscale status --json` and shapes the result into the canonical
//! `GET /api/mesh/status` contract (Appendix A Contract 6 of
//! `docs/unified-tool-gateway-spec.md`), plus the `ensure_funnel`/`funnel_url`
//! primitives P6 consumes for public webhook ingress.
//!
//! The mesh is **opt-in** (`RYU_MESH_ENABLED`), never in `startup_order`. When it
//! is off, `query_status` returns the all-default object (HTTP 200, never 500).

use serde::Serialize;

use crate::sidecar::tailscale;

/// Handle held by `ServerState` for the mesh plane. Cheap to clone. Today it is
/// a stateless façade over the env-driven [`query_status`]/[`is_enabled`]
/// free functions (the daemon itself is a Sidecar managed by the
/// `SidecarManager`), but giving the server a typed handle keeps the call site
/// stable for when P6 wires Funnel-backed ingress through here.
#[derive(Clone, Default)]
pub struct MeshHandle;

impl MeshHandle {
    pub fn new() -> Self {
        Self
    }

    /// Live mesh status for `GET /api/mesh/status` (Contract 6).
    pub async fn status(&self) -> MeshStatus {
        query_status().await
    }

    /// Whether the mesh is enabled on this node.
    pub fn enabled(&self) -> bool {
        is_enabled()
    }
}

/// Whether the mesh is enabled for this node. Opt-in via `RYU_MESH_ENABLED`
/// (truthy = anything but empty/`0`/`false`/`no`). Kept in lockstep with the
/// gateway's `tools::mesh_enabled()` so the loopback-trust neutralization (B-9)
/// and Core fail-closed gate agree on the same signal.
pub fn is_enabled() -> bool {
    std::env::var("RYU_MESH_ENABLED")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !matches!(v.as_str(), "" | "0" | "false" | "no")
        })
        .unwrap_or(false)
}

/// A peer node on the tailnet, as surfaced in Contract 6. Carries both the P7
/// fields (`name`, `host_or_dns`) and the P5 fields (`magic_dns_name`,
/// `tailscale_ips`, `os`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MeshPeer {
    pub name: String,
    pub host_or_dns: String,
    pub magic_dns_name: String,
    pub tailscale_ips: Vec<String>,
    pub online: bool,
    pub os: String,
}

/// The canonical `GET /api/mesh/status` superset (Contract 6). snake_case keys;
/// `reachable` and `up` are both present and equal. `enabled:false` ⇒ all-default.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MeshStatus {
    pub enabled: bool,
    pub reachable: bool,
    /// `up == reachable` — both present in the wire shape per Contract 6.
    pub up: bool,
    /// `"tailscale"` | `"headscale"` | `null`.
    pub backend: Option<String>,
    /// Raw `BackendState` string from `tailscale status --json` (e.g.
    /// `"Running"`, `"NeedsLogin"`, `"Stopped"`).
    pub backend_state: String,
    /// Control-plane server URL (Headscale → its login server; Tailscale SaaS →
    /// the coordination server). `null` when unknown.
    pub control_server: Option<String>,
    pub magic_dns_name: Option<String>,
    pub tailscale_ips: Vec<String>,
    pub peers: Vec<MeshPeer>,
    /// Independent of mesh — P7 reads the ingress mode from
    /// `/api/webhook-ingress/status`, not here. Always `null` in this object.
    pub webhook_ingress_mode: Option<String>,
}

impl Default for MeshStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            reachable: false,
            up: false,
            backend: None,
            backend_state: "Stopped".to_owned(),
            control_server: None,
            magic_dns_name: None,
            tailscale_ips: Vec::new(),
            peers: Vec::new(),
            webhook_ingress_mode: None,
        }
    }
}

/// The default control server for Tailscale's SaaS coordination plane. A
/// `control_server` that is empty or this host classifies the backend as
/// `tailscale`; anything else (a self-hosted `--login-server`) is `headscale`.
const TAILSCALE_SAAS_CONTROL: &str = "controlplane.tailscale.com";

/// Classify the mesh backend from the control server URL. A Headscale install is
/// reached via `--login-server <url>`; Tailscale's SaaS uses its own coordination
/// server. When no control URL is reported (the caller passes `None` — the URL is
/// absent or was filtered out as empty), the backend stays `null`: a valid
/// Contract 6 value, since we cannot distinguish Tailscale from Headscale without
/// it.
fn classify_backend(control_url: Option<&str>) -> Option<String> {
    match control_url {
        None => None,
        Some(url) if url.contains(TAILSCALE_SAAS_CONTROL) => Some("tailscale".to_owned()),
        Some(_) => Some("headscale".to_owned()),
    }
}

/// Parse the JSON emitted by `tailscale status --json` into a [`MeshStatus`].
///
/// `enabled` is supplied by the caller (it reflects `RYU_MESH_ENABLED`, not the
/// daemon). The shape is defensive: missing fields degrade to the defaults so a
/// `NeedsLogin` daemon never panics this path.
pub fn parse_status_json(enabled: bool, raw: &serde_json::Value) -> MeshStatus {
    let backend_state = raw
        .get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or("Stopped")
        .to_owned();
    let reachable = backend_state == "Running";

    // Control plane: CurrentTailnet is absent on Headscale; ControlURL (under
    // Self / the top-level) carries the login server when configured.
    let control_server = raw
        .get("Self")
        .and_then(|s| s.get("ControlURL"))
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("ControlURL").and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let backend = if backend_state == "Stopped" || backend_state == "NoState" {
        None
    } else {
        classify_backend(control_server.as_deref())
    };

    let self_node = raw.get("Self");
    let magic_dns_name = self_node
        .and_then(|s| s.get("DNSName"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('.').to_owned())
        .filter(|s| !s.is_empty());
    let tailscale_ips = self_node
        .and_then(|s| s.get("TailscaleIPs"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    let peers = raw
        .get("Peer")
        .and_then(|v| v.as_object())
        .map(|map| map.values().map(parse_peer).collect::<Vec<_>>())
        .unwrap_or_default();

    MeshStatus {
        enabled,
        reachable,
        up: reachable,
        backend,
        backend_state,
        control_server,
        magic_dns_name,
        tailscale_ips,
        peers,
        webhook_ingress_mode: None,
    }
}

/// Map one entry of the `Peer` map into a [`MeshPeer`]. The MagicDNS name has its
/// trailing `.` stripped; `host_or_dns` prefers the MagicDNS name and falls back
/// to the first Tailscale IP so P7 always has something to dial.
fn parse_peer(peer: &serde_json::Value) -> MeshPeer {
    let dns = peer
        .get("DNSName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('.').to_owned())
        .unwrap_or_default();
    let host = peer
        .get("HostName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned();
    let tailscale_ips: Vec<String> = peer
        .get("TailscaleIPs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let online = peer
        .get("Online")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let os = peer
        .get("OS")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned();

    // host_or_dns: prefer MagicDNS, then the first Tailscale IP, then HostName.
    let host_or_dns = if !dns.is_empty() {
        dns.clone()
    } else if let Some(ip) = tailscale_ips.first() {
        ip.clone()
    } else {
        host.clone()
    };
    // name: prefer HostName, fall back to the leftmost MagicDNS label.
    let name = if !host.is_empty() {
        host
    } else {
        dns.split('.').next().unwrap_or_default().to_owned()
    };

    MeshPeer {
        name,
        host_or_dns,
        magic_dns_name: dns,
        tailscale_ips,
        online,
        os,
    }
}

/// Query the live mesh status. When the mesh is disabled this returns the
/// all-default object without shelling out (HTTP 200, never 500). When enabled
/// but the daemon is absent/erroring, it returns an enabled-but-unreachable
/// object so the desktop can render an amber "configured but down" state.
pub async fn query_status() -> MeshStatus {
    let enabled = is_enabled();
    if !enabled {
        return MeshStatus::default();
    }
    match tailscale::status_json().await {
        Ok(raw) => parse_status_json(true, &raw),
        Err(e) => {
            tracing::debug!("mesh: status query failed: {e}");
            MeshStatus {
                enabled: true,
                ..Default::default()
            }
        }
    }
}

/// Ensure a Tailscale Funnel is serving `port` to the public internet, returning
/// the public HTTPS URL. Consumed by P6's `TailscaleFunnelSource`.
///
/// Requires the mesh to be enabled and the daemon running with HTTPS certs
/// provisioned; otherwise returns a clear error so the ingress seam can fall back
/// or surface the reason.
pub async fn ensure_funnel(port: u16) -> anyhow::Result<String> {
    if !is_enabled() {
        anyhow::bail!("mesh disabled: set RYU_MESH_ENABLED to use Tailscale Funnel");
    }
    tailscale::ensure_funnel(port).await
}

/// The public Funnel URL for `port` if one is active, else `None`. Cheap read
/// (no mutation) used by P6's status surface.
pub async fn funnel_url(port: u16) -> Option<String> {
    if !is_enabled() {
        return None;
    }
    tailscale::funnel_url(port).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running_status_json() -> serde_json::Value {
        serde_json::json!({
            "BackendState": "Running",
            "Self": {
                "DNSName": "ryu-host.tailnet-x.ts.net.",
                "TailscaleIPs": ["100.64.0.1", "fd7a:115c::1"],
                "ControlURL": "https://controlplane.tailscale.com"
            },
            "Peer": {
                "nodekey:abc": {
                    "HostName": "ryu-pi",
                    "DNSName": "ryu-pi.tailnet-x.ts.net.",
                    "TailscaleIPs": ["100.64.0.8"],
                    "Online": true,
                    "OS": "macOS"
                }
            }
        })
    }

    #[test]
    fn parse_status_json_running() {
        let status = parse_status_json(true, &running_status_json());
        assert!(status.enabled);
        assert!(status.reachable);
        assert!(status.up);
        assert_eq!(status.reachable, status.up);
        assert_eq!(status.backend.as_deref(), Some("tailscale"));
        assert_eq!(status.backend_state, "Running");
        assert_eq!(
            status.magic_dns_name.as_deref(),
            Some("ryu-host.tailnet-x.ts.net")
        );
        assert_eq!(status.tailscale_ips.len(), 2);
        assert_eq!(status.peers.len(), 1);
        let peer = &status.peers[0];
        assert_eq!(peer.name, "ryu-pi");
        assert_eq!(peer.host_or_dns, "ryu-pi.tailnet-x.ts.net");
        assert_eq!(peer.magic_dns_name, "ryu-pi.tailnet-x.ts.net");
        assert_eq!(peer.tailscale_ips, vec!["100.64.0.8".to_owned()]);
        assert!(peer.online);
        assert_eq!(peer.os, "macOS");
    }

    #[test]
    fn parse_status_json_needs_login() {
        let raw = serde_json::json!({ "BackendState": "NeedsLogin", "Self": {} });
        let status = parse_status_json(true, &raw);
        assert!(status.enabled);
        assert!(!status.reachable);
        assert!(!status.up);
        assert_eq!(status.backend_state, "NeedsLogin");
        // With no control URL the backend cannot be classified yet → None
        // (defensive: we never guess a backend we can't see).
        assert!(status.backend.is_none());
        assert!(status.peers.is_empty());
        assert!(status.tailscale_ips.is_empty());
    }

    #[test]
    fn parse_status_json_headscale_backend() {
        let mut raw = running_status_json();
        raw["Self"]["ControlURL"] = serde_json::json!("https://headscale.example.org");
        let status = parse_status_json(true, &raw);
        assert_eq!(status.backend.as_deref(), Some("headscale"));
        assert_eq!(
            status.control_server.as_deref(),
            Some("https://headscale.example.org")
        );
    }

    #[test]
    fn disabled_shape_is_all_default() {
        let status = MeshStatus::default();
        assert!(!status.enabled);
        assert!(!status.reachable);
        assert!(!status.up);
        assert!(status.backend.is_none());
        assert_eq!(status.backend_state, "Stopped");
        assert!(status.control_server.is_none());
        assert!(status.magic_dns_name.is_none());
        assert!(status.tailscale_ips.is_empty());
        assert!(status.peers.is_empty());
        assert!(status.webhook_ingress_mode.is_none());
    }

    #[test]
    fn disabled_shape_serializes_to_contract6() {
        let json = serde_json::to_value(MeshStatus::default()).unwrap();
        assert_eq!(json["enabled"], serde_json::json!(false));
        assert_eq!(json["reachable"], serde_json::json!(false));
        assert_eq!(json["up"], serde_json::json!(false));
        assert_eq!(json["backend"], serde_json::Value::Null);
        assert_eq!(json["backend_state"], serde_json::json!("Stopped"));
        assert_eq!(json["control_server"], serde_json::Value::Null);
        assert_eq!(json["magic_dns_name"], serde_json::Value::Null);
        assert_eq!(json["tailscale_ips"], serde_json::json!([]));
        assert_eq!(json["peers"], serde_json::json!([]));
        assert_eq!(json["webhook_ingress_mode"], serde_json::Value::Null);
    }

    #[test]
    fn is_enabled_default_off() {
        // In the test process RYU_MESH_ENABLED is unset → off.
        if std::env::var("RYU_MESH_ENABLED").is_err() {
            assert!(!is_enabled());
        }
    }

    #[test]
    fn core_refuses_tokenless_start_under_mesh() {
        // Mesh on + no token → refuse (Err), the fail-closed control.
        let r = crate::server::enforce_remote_auth(None, true, false);
        assert!(r.is_err(), "tokenless start under mesh must be refused");
        // An empty/whitespace token is also rejected.
        let r = crate::server::enforce_remote_auth(Some("   ".to_owned()), true, false);
        assert!(r.is_err());
        // A real token under mesh is accepted and returned unchanged.
        let r = crate::server::enforce_remote_auth(Some("ryu_secret".to_owned()), true, false);
        assert_eq!(r.unwrap().as_deref(), Some("ryu_secret"));
    }

    #[test]
    fn core_refuses_tokenless_non_loopback_bind() {
        // Non-loopback bind alone (mesh off) also requires a token.
        assert!(crate::server::enforce_remote_auth(None, false, true).is_err());
    }

    #[test]
    fn loopback_tokenless_start_is_allowed() {
        // Vanilla install: no mesh, loopback bind, no token → allowed (None).
        let r = crate::server::enforce_remote_auth(None, false, false);
        assert!(r.is_ok());
        assert!(r.unwrap().is_none());
    }

    #[test]
    fn host_non_loopback_classification() {
        use crate::server::host_is_non_loopback;
        // Loopback binds (default + explicit) are NOT exposed.
        assert!(!host_is_non_loopback(""));
        assert!(!host_is_non_loopback("127.0.0.1:7980"));
        assert!(!host_is_non_loopback("[::1]:7980"));
        // Wildcard + concrete public binds ARE exposed.
        assert!(host_is_non_loopback("0.0.0.0:7980"));
        assert!(host_is_non_loopback("[::]:7980"));
        assert!(host_is_non_loopback(":7980"));
        assert!(host_is_non_loopback("192.168.1.10:7980"));
        // An unparseable host fails closed (assumed reachable).
        assert!(host_is_non_loopback("my-host.local:7980"));
    }

    #[test]
    fn bind_flag_value_is_caught_by_gate() {
        // #478 V1 regression: a `--bind=0.0.0.0:7980` value (the chain `main()`
        // resolves and passes to `create_router`) must trip the fail-closed gate
        // when tokenless, even with mesh off — the old gate only read RYU_BIND and
        // missed the flag entirely.
        let exposed = crate::server::host_is_non_loopback("0.0.0.0:7980");
        assert!(exposed);
        assert!(crate::server::enforce_remote_auth(None, false, exposed).is_err());
    }

    #[test]
    fn peer_host_or_dns_falls_back_to_ip() {
        let peer = serde_json::json!({
            "HostName": "",
            "DNSName": "",
            "TailscaleIPs": ["100.64.0.9"],
            "Online": false,
            "OS": "linux"
        });
        let parsed = parse_peer(&peer);
        assert_eq!(parsed.host_or_dns, "100.64.0.9");
        assert!(!parsed.online);
    }
}
