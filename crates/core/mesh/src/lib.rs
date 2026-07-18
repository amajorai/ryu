//! Mesh status + Funnel helpers (P5 of the unified-tool-gateway epic, #478).
//!
//! Extracted from `apps/core/src/mesh` into its own primitive crate (in-process
//! default preserved — every entry point is a plain function call, never IPC).
//!
//! Core owns **what runs** — the optional Tailscale/Headscale daemon (a `Sidecar`
//! managed by the `SidecarManager`, `apps/core/src/sidecar/tailscale.rs`). This
//! crate is the **read/shape side**: it shapes `tailscale status --json` into the
//! canonical `GET /api/mesh/status` contract (Appendix A Contract 6 of
//! `docs/unified-tool-gateway-spec.md`), resolves the fail-closed shared-mesh-token
//! bearer for `GET /api/mesh/peers`, and exposes the `ensure_funnel`/`funnel_url`
//! primitives P6 consumes for public webhook ingress.
//!
//! The one kernel coupling — the `tailscale`/`tailscaled` process shell-outs —
//! inverts through the narrow [`MeshHost`] trait (host shim implemented Core-side
//! in `apps/core/src/mesh_host.rs`, installed once at boot via [`set_global_host`],
//! mirroring the `CryptoHost`/`RecipesHost` precedent). So this crate has ZERO
//! dependency on apps/core.
//!
//! The mesh is **opt-in** (`RYU_MESH_ENABLED`), never in `startup_order`. When it
//! is off, [`query_status`] returns the all-default object (HTTP 200, never 500)
//! WITHOUT touching the host, so a build with no host installed still behaves
//! correctly for the default (mesh-disabled) install.

use std::sync::{Arc, OnceLock};

use serde::Serialize;

// ── Host seam (the "what runs" half — tailscale daemon shell-outs) ────────────

/// The kernel-side couplings this crate needs but cannot own: the three
/// `tailscale`/`tailscaled` process shell-outs (the "what runs" half of the mesh,
/// a `Sidecar` in Core). Core implements this in `apps/core/src/mesh_host.rs` and
/// installs it once at boot via [`set_global_host`].
///
/// Every method is only ever called when the mesh is **enabled**
/// (`RYU_MESH_ENABLED`); the disabled paths short-circuit before the host is
/// consulted, so a process that never installs a host still runs the default
/// (mesh-off) install correctly.
#[async_trait::async_trait]
pub trait MeshHost: Send + Sync {
    /// Run `tailscale status --json` and return the parsed JSON. Errors when the
    /// daemon is absent or returns non-JSON (the caller maps that to an
    /// enabled-but-unreachable status).
    async fn status_json(&self) -> anyhow::Result<serde_json::Value>;

    /// Ensure a Tailscale Funnel is serving `port`, returning the public URL.
    async fn ensure_funnel(&self, port: u16) -> anyhow::Result<String>;

    /// The active public Funnel URL for `port`, or `None` when unreachable.
    async fn funnel_url(&self, port: u16) -> Option<String>;
}

fn host_slot() -> &'static OnceLock<Arc<dyn MeshHost>> {
    static HOST: OnceLock<Arc<dyn MeshHost>> = OnceLock::new();
    &HOST
}

/// Install the process-global [`MeshHost`]. Idempotent (a second call is a no-op).
/// Called once from Core's `main` at boot.
pub fn set_global_host(host: Arc<dyn MeshHost>) {
    let _ = host_slot().set(host);
}

/// The installed host, or `None` when none was installed. Only consulted on the
/// mesh-**enabled** paths, so `None` here means "mesh enabled but no daemon host
/// wired" — treated as unreachable, never a panic.
fn host() -> Option<Arc<dyn MeshHost>> {
    host_slot().get().cloned()
}

// ── Node-admittance security model (anchored here) ────────────────────────────

/// Whether an auth token is a well-known insecure placeholder. This is the
/// canonical home for the node-admittance placeholder check: [`resolve_mesh_bearer`]
/// refuses to hand out such a token as a peer bearer (a peer provisioned with a
/// placeholder refuses to start under mesh, so offering it would be a lie), and
/// Core's `enforce_remote_auth` startup gate consults the same predicate so both
/// agree on the same signal. Pure + const — no dependency on apps/core.
pub fn is_insecure_auth_token_placeholder(token: &str) -> bool {
    const PLACEHOLDERS: &[&str] = &[
        "CHANGE_ME",
        "CHANGEME",
        "REPLACE_ME",
        "REPLACEME",
        "YOUR_TOKEN_HERE",
        "TOKEN",
        "SECRET",
        "PASSWORD",
    ];

    let trimmed = token.trim();
    PLACEHOLDERS
        .iter()
        .any(|placeholder| trimmed.eq_ignore_ascii_case(placeholder))
}

// ── Mesh plane handle + enabled gate ──────────────────────────────────────────

/// Handle held by Core's `ServerState` for the mesh plane. Cheap to clone. Today
/// it is a stateless façade over the env-driven [`query_status`]/[`is_enabled`]
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
/// all-default object without shelling out (HTTP 200, never 500) and WITHOUT
/// consulting the host. When enabled but the daemon is absent/erroring (or no
/// host is installed), it returns an enabled-but-unreachable object so the
/// desktop can render an amber "configured but down" state.
pub async fn query_status() -> MeshStatus {
    let enabled = is_enabled();
    if !enabled {
        return MeshStatus::default();
    }
    let Some(h) = host() else {
        // Mesh enabled but no daemon host wired — treat as unreachable, never
        // panic. (Core installs the host at boot; this is the defensive path.)
        return MeshStatus {
            enabled: true,
            ..Default::default()
        };
    };
    match h.status_json().await {
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
    let h = host().ok_or_else(|| anyhow::anyhow!("mesh host not installed"))?;
    h.ensure_funnel(port).await
}

/// The public Funnel URL for `port` if one is active, else `None`. Cheap read
/// (no mutation) used by P6's status surface.
pub async fn funnel_url(port: u16) -> Option<String> {
    if !is_enabled() {
        return None;
    }
    host()?.funnel_url(port).await
}

// ── Peer token bridge (#478, P7 desktop NodeSelector handoff) ─────────────────
//
// Adding a mesh peer as a node is fail-closed: every exposed peer runs
// `enforce_remote_auth`, so its protected routes 401 without a valid bearer. The
// desktop's `addNode(name, url)` is tokenless, which is exactly why a freshly
// added peer's requests bounce. This seam provides the bearer WITHOUT weakening
// the peer's check: the peer still requires a valid token; we hand the caller one.
//
// The bearer we can offer is **this node's own `RYU_TOKEN`**. `require_auth` on the
// peer is a string compare (`provided == expected`), and `enforce_remote_auth` on
// the peer accepts any non-placeholder token at startup — so this node's token
// authenticates on a peer **iff that peer was provisioned with the same
// `RYU_TOKEN`** (the shared-fleet convention: a tailnet operator gives every node
// the same node-admittance secret). The code cannot verify the peer's token, so
// `bearer_source: "shared-mesh-token"` means "candidate bearer, valid on peers
// sharing this RYU_TOKEN"; a peer running a distinct token still 401s and the
// operator must supply that peer's token by hand. Returning this token is not a
// disclosure: `/api/mesh/peers` sits behind `require_auth`, so only a caller who
// already holds this node's `RYU_TOKEN` can read it back.

/// How the offered bearer was derived, surfaced so the desktop (and a human) know
/// whether the token is a real candidate or absent.
pub const BEARER_SOURCE_SHARED: &str = "shared-mesh-token";
pub const BEARER_SOURCE_NONE: &str = "none";

/// Provisioning guidance returned when no usable bearer exists on this node. Names
/// the EXACT secret a peer must share for the fail-closed check to pass.
pub const BEARER_NONE_NOTE: &str =
    "No usable RYU_TOKEN on this node. Provision every mesh node with the SAME strong \
     RYU_TOKEN (the shared node-admittance secret) so a peer's require_auth accepts it; \
     otherwise supply the target peer's own RYU_TOKEN when adding it.";

/// The default Core listen port peers are assumed to serve on (`127.0.0.1:7980`
/// default bind, reached over the tailnet on the same port). Overridable per
/// deployment via `RYU_MESH_PEER_PORT` when the fleet binds a non-default port.
const DEFAULT_CORE_PORT: u16 = 7980;

/// Resolve the port peers are dialed on: `RYU_MESH_PEER_PORT` when set to a valid
/// `u16`, else the default 7980.
fn peer_core_port() -> u16 {
    std::env::var("RYU_MESH_PEER_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_CORE_PORT)
}

/// Build the URL the desktop should register for a peer. Prefers the MagicDNS
/// name (stable, resolvable inside the tailnet), falling back to `host_or_dns`
/// (which itself falls back to a Tailscale IP). `http://` is correct: the tailnet
/// wire is WireGuard-encrypted and Core does not serve TLS itself.
fn peer_url(peer: &MeshPeer, port: u16) -> String {
    let host = if peer.magic_dns_name.is_empty() {
        peer.host_or_dns.as_str()
    } else {
        peer.magic_dns_name.as_str()
    };
    format!("http://{host}:{port}")
}

/// Resolve the candidate bearer to hand the desktop from this node's node token
/// (`RYU_TOKEN`, passed in). Returns `None` — meaning "no usable bearer" — when the
/// token is absent, empty/whitespace, or a known insecure placeholder (a peer with
/// a placeholder token refuses to start under mesh, so offering it would be a lie).
///
/// Pure + unit-testable: the returned string, when a peer runs the same token, is
/// exactly what that peer's `enforce_remote_auth` accepts at startup and its
/// `require_auth` compares equal against.
pub fn resolve_mesh_bearer(node_token: Option<&str>) -> Option<String> {
    let token = node_token?.trim();
    if token.is_empty() || is_insecure_auth_token_placeholder(token) {
        return None;
    }
    Some(token.to_owned())
}

/// One peer entry in the `GET /api/mesh/peers` response.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MeshPeerEntry {
    pub name: String,
    /// The URL to register with `addNode` — `http://<magic_dns>:<port>`.
    pub url: String,
    pub magic_dns_name: String,
    pub host_or_dns: String,
    pub port: u16,
    pub online: bool,
    pub os: String,
    /// Whether a candidate bearer is obtainable for this peer (true when this node
    /// has a usable `RYU_TOKEN` under the shared-fleet convention).
    pub bearer_available: bool,
    /// The candidate bearer to attach when adding this peer, or `null`. Same shared
    /// token for every peer; valid only on peers provisioned with this `RYU_TOKEN`.
    pub bearer: Option<String>,
}

/// The `GET /api/mesh/peers` response (Contract 6 companion, P7). `enabled:false`
/// ⇒ empty `peers`, `bearer_source:"none"`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MeshPeersResponse {
    pub enabled: bool,
    pub reachable: bool,
    pub peers: Vec<MeshPeerEntry>,
    /// `"shared-mesh-token"` when a candidate bearer is offered, else `"none"`.
    pub bearer_source: String,
    /// Present only when no bearer is available: names the exact secret to
    /// provision. `null` when a bearer is offered.
    pub note: Option<String>,
}

/// Build the peers response from a live [`MeshStatus`] and this node's token.
///
/// Pure so the token-resolution + URL shaping is unit-testable without shelling out
/// to `tailscale`. Every reported peer is returned with its `online` flag (the
/// desktop filters/labels), each carrying the same shared bearer when one exists.
pub fn build_peers_response(status: &MeshStatus, node_token: Option<&str>) -> MeshPeersResponse {
    let bearer = resolve_mesh_bearer(node_token);
    let bearer_available = bearer.is_some();
    let port = peer_core_port();

    let peers = status
        .peers
        .iter()
        .map(|p| MeshPeerEntry {
            name: p.name.clone(),
            url: peer_url(p, port),
            magic_dns_name: p.magic_dns_name.clone(),
            host_or_dns: p.host_or_dns.clone(),
            port,
            online: p.online,
            os: p.os.clone(),
            bearer_available,
            bearer: bearer.clone(),
        })
        .collect();

    MeshPeersResponse {
        enabled: status.enabled,
        reachable: status.reachable,
        peers,
        bearer_source: if bearer_available {
            BEARER_SOURCE_SHARED.to_owned()
        } else {
            BEARER_SOURCE_NONE.to_owned()
        },
        note: if bearer_available {
            None
        } else {
            Some(BEARER_NONE_NOTE.to_owned())
        },
    }
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

    #[test]
    fn resolve_mesh_bearer_returns_real_token() {
        // A real (non-placeholder) token is handed back verbatim — this is the
        // exact bearer a peer provisioned with the same RYU_TOKEN accepts.
        assert_eq!(
            resolve_mesh_bearer(Some("ryu_shared_secret")).as_deref(),
            Some("ryu_shared_secret")
        );
    }

    #[test]
    fn resolve_mesh_bearer_is_fail_closed_without_a_real_token() {
        // Fail-closed (crate side): the bearer resolver NEVER fabricates a token.
        // Absent, empty/whitespace, and every known placeholder resolve to None,
        // so `/api/mesh/peers` reports `bearer_source:"none"` rather than handing
        // out a bearer that would not authenticate (offering one would be a lie).
        assert!(resolve_mesh_bearer(None).is_none());
        assert!(resolve_mesh_bearer(Some("")).is_none());
        assert!(resolve_mesh_bearer(Some("   ")).is_none());
        assert!(resolve_mesh_bearer(Some("CHANGE_ME")).is_none());
        assert!(resolve_mesh_bearer(Some("change_me")).is_none());
        assert!(resolve_mesh_bearer(Some("REPLACE_ME")).is_none());
        assert!(resolve_mesh_bearer(Some("SECRET")).is_none());
    }

    #[test]
    fn placeholder_predicate_matches_known_weak_tokens() {
        // The canonical node-admittance placeholder check (Core's
        // `enforce_remote_auth` startup gate consults this same predicate).
        assert!(is_insecure_auth_token_placeholder("CHANGE_ME"));
        assert!(is_insecure_auth_token_placeholder("  changeme  "));
        assert!(is_insecure_auth_token_placeholder("PASSWORD"));
        assert!(!is_insecure_auth_token_placeholder("ryu_strong_random"));
        assert!(!is_insecure_auth_token_placeholder(""));
    }

    #[test]
    fn peers_response_carries_shared_bearer_and_urls() {
        let status = parse_status_json(true, &running_status_json());
        let resp = build_peers_response(&status, Some("ryu_shared_secret"));
        assert!(resp.enabled);
        assert_eq!(resp.bearer_source, BEARER_SOURCE_SHARED);
        assert!(resp.note.is_none());
        assert_eq!(resp.peers.len(), 1);
        let peer = &resp.peers[0];
        assert_eq!(peer.name, "ryu-pi");
        assert_eq!(peer.url, "http://ryu-pi.tailnet-x.ts.net:7980");
        assert_eq!(peer.port, 7980);
        assert!(peer.bearer_available);
        assert_eq!(peer.bearer.as_deref(), Some("ryu_shared_secret"));
    }

    #[test]
    fn peers_response_without_token_is_honest_and_documents_secret() {
        let status = parse_status_json(true, &running_status_json());
        let resp = build_peers_response(&status, None);
        assert_eq!(resp.bearer_source, BEARER_SOURCE_NONE);
        assert_eq!(resp.note.as_deref(), Some(BEARER_NONE_NOTE));
        let peer = &resp.peers[0];
        assert!(!peer.bearer_available);
        assert!(peer.bearer.is_none());
        // The peer is still returned (URL usable) so the desktop can add it and the
        // operator can attach the peer's own token manually.
        assert_eq!(peer.url, "http://ryu-pi.tailnet-x.ts.net:7980");
    }

    #[test]
    fn disabled_mesh_yields_empty_peers() {
        let resp = build_peers_response(&MeshStatus::default(), Some("ryu_shared_secret"));
        assert!(!resp.enabled);
        assert!(resp.peers.is_empty());
        // A token exists, so the source still reflects a candidate bearer even with
        // no peers to attach it to yet.
        assert_eq!(resp.bearer_source, BEARER_SOURCE_SHARED);
    }

    #[tokio::test]
    async fn disabled_query_status_never_touches_host() {
        // With mesh disabled (default in the test process), query_status returns
        // the all-default object WITHOUT a host installed — the mesh-off install
        // path must never depend on the daemon host being wired.
        if std::env::var("RYU_MESH_ENABLED").is_err() {
            let status = query_status().await;
            assert_eq!(status, MeshStatus::default());
            // ensure_funnel bails and funnel_url is None, both without a host.
            assert!(ensure_funnel(443).await.is_err());
            assert!(funnel_url(443).await.is_none());
        }
    }
}
