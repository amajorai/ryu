use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Core port Core listens on.
const CORE_PORT: u16 = 7980;
// Bounded sweep: probe at most this many hosts per run to keep latency below ~3 s.
const MAX_SWEEP_HOSTS: u8 = 254;
// Per-host connection timeout in milliseconds.
const PROBE_TIMEOUT_MS: u64 = 800;

/// How to reach a node over the mesh (#478). When present, [`Node::mesh_client`]
/// dials the node's `url` through the node's userspace SOCKS5 proxy so the
/// connection rides the tailnet instead of the LAN.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct MeshAddr {
    /// The `host:port` of the userspace SOCKS5 proxy exposed by the node's
    /// Tailscale daemon (e.g. `127.0.0.1:1055` for a local proxy, or a peer's
    /// MagicDNS name when proxying remotely).
    pub socks5: String,
    /// Optional MagicDNS name of the peer, for display.
    #[serde(default)]
    pub magic_dns_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Node {
    pub name: String,
    pub url: String,
    pub token: Option<String>,
    /// Optional mesh address (#478). `#[serde(default)]` so a legacy
    /// `nodes.json` written before mesh support still deserializes.
    #[serde(default)]
    pub mesh: Option<MeshAddr>,
}

impl Node {
    /// Build a reqwest client for this node. When the node has a [`MeshAddr`],
    /// the client routes through the node's userspace SOCKS5 proxy via a
    /// `socks5h://` proxy (the `h` keeps DNS resolution on the proxy side, so
    /// MagicDNS names resolve on the tailnet). Without a mesh address it is a
    /// plain client (LAN/loopback).
    pub fn mesh_client(&self) -> reqwest::Result<reqwest::Client> {
        let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
        match &self.mesh {
            Some(mesh) if !mesh.socks5.is_empty() => {
                let proxy = reqwest::Proxy::all(format!("socks5h://{}", mesh.socks5))?;
                builder.proxy(proxy).build()
            }
            _ => builder.build(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NodesConfig {
    pub default: String,
    pub nodes: Vec<Node>,
}

pub fn nodes_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".ryu").join("nodes.json")
}

pub fn load() -> NodesConfig {
    let path = nodes_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str(&content) {
            return config;
        }
    }
    default_config()
}

fn default_config() -> NodesConfig {
    NodesConfig {
        default: "local".into(),
        nodes: vec![Node {
            name: "local".into(),
            url: "http://127.0.0.1:2049".into(),
            token: None,
            mesh: None,
        }],
    }
}

pub fn save(config: &NodesConfig) -> anyhow::Result<()> {
    let path = nodes_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(config)?)?;
    Ok(())
}

/// Returns the active node (the one named `config.default`).
/// Falls back to the local node if the default is missing.
pub fn active_node() -> Node {
    resolve_active_node(&load())
}

/// Returns the node named `name`, or an error if not found.
pub fn get_node(name: &str) -> anyhow::Result<Node> {
    resolve_node_by_name(&load(), name)
}

/// Persist `name` as the new default node.
/// Returns an error when the name does not exist in the config.
pub fn set_active(name: &str) -> anyhow::Result<()> {
    let mut config = load();
    if !config.nodes.iter().any(|n| n.name == name) {
        anyhow::bail!("node '{}' not found", name);
    }
    config.default = name.to_owned();
    save(&config)
}

/// Pure selector: prefers the first non-local node that has a corresponding
/// `true` in `reachable`, then falls back to the local node.
/// `nodes` and `reachable` are parallel slices.
pub fn select_preferred(nodes: &[Node], reachable: &[bool]) -> Node {
    // Prefer the first reachable non-local node.
    for (node, &ok) in nodes.iter().zip(reachable.iter()) {
        if ok && node.name != "local" {
            return node.clone();
        }
    }
    // Fall back to local (always present by invariant).
    nodes
        .iter()
        .find(|n| n.name == "local")
        .cloned()
        .unwrap_or_else(|| Node {
            name: "local".into(),
            url: "http://127.0.0.1:2049".into(),
            token: None,
            mesh: None,
        })
}

fn resolve_active_node(config: &NodesConfig) -> Node {
    config
        .nodes
        .iter()
        .find(|n| n.name == config.default)
        .cloned()
        .unwrap_or_else(|| Node {
            name: "local".into(),
            url: "http://127.0.0.1:2049".into(),
            token: None,
            mesh: None,
        })
}

fn resolve_node_by_name(config: &NodesConfig, name: &str) -> anyhow::Result<Node> {
    config
        .nodes
        .iter()
        .find(|n| n.name == name)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("node '{}' not found", name))
}

/// Discovered node returned by [`discover_lan`].
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredNode {
    pub url: String,
    pub latency_ms: u64,
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

/// Parse the local subnet prefix from a dotted-quad address string.
/// e.g. "192.168.1.42" -> "192.168.1"
fn subnet_prefix(addr: &str) -> Option<String> {
    let parts: Vec<&str> = addr.split('.').collect();
    if parts.len() == 4 {
        Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
    } else {
        None
    }
}

/// Resolve the default outbound IPv4 address by connecting a UDP socket
/// to a well-known external address (8.8.8.8:80).  No packets are sent.
fn local_ipv4() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

/// Sweep the local /24 subnet for Core nodes advertising on `port`.
///
/// Probes up to `MAX_SWEEP_HOSTS` hosts concurrently (one per host-octet,
/// 1-254) and returns every responding node sorted by ascending latency.
/// The caller's own address is always excluded.
pub async fn discover_lan(port: Option<u16>) -> Vec<DiscoveredNode> {
    let port = port.unwrap_or(CORE_PORT);
    let own_ip = local_ipv4().unwrap_or_default();
    let prefix = match local_ipv4().and_then(|ip| subnet_prefix(&ip)) {
        Some(p) => p,
        None => return vec![],
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(PROBE_TIMEOUT_MS))
        .build()
        .unwrap_or_default();

    let mut tasks = tokio::task::JoinSet::new();
    for host_octet in 1u8..=MAX_SWEEP_HOSTS {
        let host = format!("{prefix}.{host_octet}");
        if host == own_ip {
            continue;
        }
        let c = client.clone();
        tasks.spawn(async move {
            let latency = probe(&c, &host, port).await;
            (host, latency)
        });
    }

    let mut found: Vec<DiscoveredNode> = Vec::new();
    while let Some(Ok((host, Some(latency_ms)))) = tasks.join_next().await {
        found.push(DiscoveredNode {
            url: format!("http://{host}:{port}"),
            latency_ms,
        });
    }

    found.sort_by_key(|n| n.latency_ms);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config() -> NodesConfig {
        NodesConfig {
            default: "local".into(),
            nodes: vec![
                Node { name: "local".into(), url: "http://127.0.0.1:2049".into(), token: None, mesh: None },
                Node { name: "pi".into(), url: "http://192.168.1.5:2049".into(), token: Some("ryu_abc".into()), mesh: None },
            ],
        }
    }

    #[test]
    fn active_node_returns_default() {
        let config = make_config();
        let node = resolve_active_node(&config);
        assert_eq!(node.name, "local");
        assert_eq!(node.url, "http://127.0.0.1:2049");
    }

    #[test]
    fn active_node_falls_back_when_default_missing() {
        let config = NodesConfig {
            default: "nonexistent".into(),
            nodes: vec![
                Node { name: "local".into(), url: "http://127.0.0.1:2049".into(), token: None, mesh: None },
            ],
        };
        let node = resolve_active_node(&config);
        assert_eq!(node.name, "local");
    }

    #[test]
    fn get_node_finds_by_name() {
        let config = make_config();
        let pi = resolve_node_by_name(&config, "pi").unwrap();
        assert_eq!(pi.token, Some("ryu_abc".into()));
    }

    #[test]
    fn get_node_returns_error_when_missing() {
        let config = make_config();
        let result = resolve_node_by_name(&config, "does-not-exist");
        assert!(result.is_err());
    }

    #[test]
    fn default_config_has_local() {
        let config = default_config();
        assert_eq!(config.default, "local");
        assert_eq!(config.nodes.len(), 1);
        assert_eq!(config.nodes[0].name, "local");
        assert!(config.nodes[0].token.is_none());
    }

    #[test]
    fn select_preferred_picks_reachable_remote() {
        let nodes = vec![
            Node { name: "local".into(), url: "http://127.0.0.1:2049".into(), token: None, mesh: None },
            Node { name: "pi".into(), url: "http://192.168.1.5:2049".into(), token: Some("tok".into()), mesh: None },
        ];
        // local unreachable, remote reachable
        let chosen = select_preferred(&nodes, &[false, true]);
        assert_eq!(chosen.name, "pi");
    }

    #[test]
    fn select_preferred_falls_back_to_local_when_no_remote_reachable() {
        let nodes = vec![
            Node { name: "local".into(), url: "http://127.0.0.1:2049".into(), token: None, mesh: None },
            Node { name: "pi".into(), url: "http://192.168.1.5:2049".into(), token: Some("tok".into()), mesh: None },
        ];
        // both unreachable — must fall back to local
        let chosen = select_preferred(&nodes, &[false, false]);
        assert_eq!(chosen.name, "local");
    }

    #[test]
    fn node_without_mesh_deserializes() {
        // A legacy nodes.json (no `mesh` key) must still parse, with mesh = None.
        let json = r#"{ "name": "pi", "url": "http://192.168.1.5:7980", "token": "ryu_x" }"#;
        let node: Node = serde_json::from_str(json).expect("legacy node deserializes");
        assert_eq!(node.name, "pi");
        assert_eq!(node.token.as_deref(), Some("ryu_x"));
        assert!(node.mesh.is_none());
    }

    #[test]
    fn node_with_mesh_deserializes() {
        let json = r#"{ "name": "pi", "url": "http://ryu-pi:7980", "token": null,
            "mesh": { "socks5": "127.0.0.1:1055", "magic_dns_name": "ryu-pi.ts.net" } }"#;
        let node: Node = serde_json::from_str(json).expect("mesh node deserializes");
        let mesh = node.mesh.expect("mesh present");
        assert_eq!(mesh.socks5, "127.0.0.1:1055");
        assert_eq!(mesh.magic_dns_name.as_deref(), Some("ryu-pi.ts.net"));
    }

    #[test]
    fn mesh_client_builds() {
        // Plain node (no mesh) → a client builds without a proxy.
        let plain = Node {
            name: "local".into(),
            url: "http://127.0.0.1:7980".into(),
            token: None,
            mesh: None,
        };
        assert!(plain.mesh_client().is_ok());

        // Mesh node → a socks5h:// proxied client builds.
        let meshed = Node {
            name: "pi".into(),
            url: "http://ryu-pi:7980".into(),
            token: None,
            mesh: Some(MeshAddr {
                socks5: "127.0.0.1:1055".into(),
                magic_dns_name: Some("ryu-pi.ts.net".into()),
            }),
        };
        assert!(meshed.mesh_client().is_ok());
    }

    #[test]
    fn select_preferred_ignores_reachable_local_picks_remote() {
        let nodes = vec![
            Node { name: "local".into(), url: "http://127.0.0.1:2049".into(), token: None, mesh: None },
            Node { name: "remote".into(), url: "http://10.0.0.1:2049".into(), token: None, mesh: None },
        ];
        // both reachable — should still prefer the non-local remote
        let chosen = select_preferred(&nodes, &[true, true]);
        assert_eq!(chosen.name, "remote");
    }
}
