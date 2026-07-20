use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Node {
	pub name: String,
	pub url: String,
	pub token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NodesConfig {
	pub default: String,
	pub nodes: Vec<Node>,
}

#[derive(Debug, Serialize)]
pub struct NodeStatus {
	pub name: String,
	pub online: bool,
	pub latency_ms: Option<u64>,
}

/// A reachable Core found by the LAN sweep ([`discover_lan_nodes`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiscoveredNode {
	pub url: String,
	pub latency_ms: u64,
}

// Port Core listens on (the LAN sweep target). Profile-aware so a dev variant
// sweeps for dev nodes on :8980; release stays :7980 via `crate::profile`.
// Bounded sweep: probe at most this many host octets per run to cap latency.
const MAX_SWEEP_HOSTS: u8 = 254;
// Per-host connection/response timeout in milliseconds.
const PROBE_TIMEOUT_MS: u64 = 800;

fn nodes_path() -> PathBuf {
	crate::profile::ryu_home_dir().join("nodes.json")
}

fn load() -> NodesConfig {
	let path = nodes_path();
	if let Ok(content) = std::fs::read_to_string(&path) {
		if let Ok(mut config) = serde_json::from_str::<NodesConfig>(&content) {
			// Migrate old default local URL (port 2049 → the profile's Core port).
			let mut migrated = false;
			let local_url = crate::profile::core_base_url();
			for node in &mut config.nodes {
				if node.name == "local" && node.url == "http://127.0.0.1:2049" {
					node.url = local_url.clone();
					migrated = true;
				}
			}
			if migrated {
				let _ = save(&config);
			}
			return config;
		}
	}
	NodesConfig {
		default: "local".into(),
		nodes: vec![Node {
			name: "local".into(),
			url: crate::profile::core_base_url(),
			token: None,
		}],
	}
}

fn save(config: &NodesConfig) -> anyhow::Result<()> {
	let path = nodes_path();
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	std::fs::write(&path, serde_json::to_string_pretty(config)?)?;
	Ok(())
}

#[tauri::command]
pub fn list_nodes() -> serde_json::Value {
	let config = load();
	serde_json::json!({
		"default": config.default,
		"nodes": config.nodes,
	})
}

#[tauri::command]
pub fn add_node(name: String, url: String, token: Option<String>) -> Result<(), String> {
	if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '-') {
		return Err("node name must be alphanumeric + hyphens only".into());
	}
	let mut config = load();
	if config.nodes.iter().any(|n| n.name == name) {
		return Err(format!("node '{}' already exists", name));
	}
	config.nodes.push(Node { name, url, token });
	save(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_node(name: String) -> Result<(), String> {
	if name == "local" {
		return Err("cannot remove the local node".into());
	}
	let mut config = load();
	let before = config.nodes.len();
	config.nodes.retain(|n| n.name != name);
	if config.nodes.len() == before {
		return Err(format!("node '{}' not found", name));
	}
	if config.default == name {
		config.default = "local".into();
	}
	save(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_default_node(name: String) -> Result<(), String> {
	let mut config = load();
	if !config.nodes.iter().any(|n| n.name == name) {
		return Err(format!("node '{}' not found", name));
	}
	config.default = name;
	save(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_node(
	name: String,
	http: tauri::State<'_, crate::HttpClient>,
) -> Result<NodeStatus, String> {
	let config = load();
	let node = config
		.nodes
		.iter()
		.find(|n| n.name == name)
		.ok_or_else(|| format!("node '{}' not found", name))?;

	let url = format!("{}/api/health", node.url);
	let start = std::time::Instant::now();

	let mut req = http.0.get(&url);
	if let Some(token) = &node.token {
		req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", token));
	}

	match req.send().await {
		Ok(r) if r.status().is_success() => Ok(NodeStatus {
			name,
			online: true,
			latency_ms: Some(start.elapsed().as_millis() as u64),
		}),
		_ => Ok(NodeStatus {
			name,
			online: false,
			latency_ms: None,
		}),
	}
}

/// Probe every configured node in a single batched call. Runs all health
/// checks concurrently and returns a NodeStatus for each node. This avoids
/// N independent invoke() round-trips from the fleet view.
#[tauri::command]
pub async fn test_all_nodes(
	http: tauri::State<'_, crate::HttpClient>,
) -> Result<Vec<NodeStatus>, String> {
	let config = load();
	let client = http.0.clone();

	let futs: Vec<_> = config
		.nodes
		.into_iter()
		.map(|node| {
			let client = client.clone();
			async move {
				let url = format!("{}/api/health", node.url);
				let start = std::time::Instant::now();
				let mut req = client.get(&url);
				if let Some(token) = &node.token {
					req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", token));
				}
				match req.send().await {
					Ok(r) if r.status().is_success() => NodeStatus {
						name: node.name,
						online: true,
						latency_ms: Some(start.elapsed().as_millis() as u64),
					},
					_ => NodeStatus {
						name: node.name,
						online: false,
						latency_ms: None,
					},
				}
			}
		})
		.collect();

	Ok(futures::future::join_all(futs).await)
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

/// Resolve the default outbound IPv4 address by connecting a UDP socket to a
/// well-known external address (8.8.8.8:80). No packets are sent — the connect
/// only picks the route's source address.
fn local_ipv4() -> Option<String> {
	use std::net::UdpSocket;
	let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
	socket.connect("8.8.8.8:80").ok()?;
	let addr = socket.local_addr().ok()?;
	Some(addr.ip().to_string())
}

/// Return this computer's primary outbound LAN IPv4 as a dotted-quad string
/// (e.g. "192.168.1.50"). Used to prefill the "Connect a phone" QR with an
/// address other devices on the same Wi-Fi can actually reach, instead of a
/// localhost address a phone can't. Errors when no route can be resolved
/// (offline / no Wi-Fi); the caller falls back to a manually typed address.
#[tauri::command]
pub fn get_lan_ip() -> Result<String, String> {
	local_ipv4().ok_or_else(|| "could not determine this computer's Wi-Fi address".to_string())
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

/// Sweep the local /24 subnet for Core nodes advertising on :7980.
///
/// Probes up to `MAX_SWEEP_HOSTS` host octets (1-254) concurrently, each with a
/// short per-request timeout, and returns every responding node sorted by
/// ascending latency. The caller's own address is excluded. Ported from the CLI
/// (`apps/cli/src/nodes.rs`). NodeSelector-only.
#[tauri::command]
pub async fn discover_lan_nodes() -> Result<Vec<DiscoveredNode>, String> {
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

	let core_port = crate::profile::core_port();
	let mut tasks = tokio::task::JoinSet::new();
	for host_octet in 1u8..=MAX_SWEEP_HOSTS {
		let host = format!("{prefix}.{host_octet}");
		if host == own_ip {
			continue;
		}
		let c = client.clone();
		tasks.spawn(async move {
			let latency = probe(&c, &host, core_port).await;
			(host, latency)
		});
	}

	let mut found: Vec<DiscoveredNode> = Vec::new();
	while let Some(Ok((host, Some(latency_ms)))) = tasks.join_next().await {
		found.push(DiscoveredNode {
			url: format!("http://{host}:{core_port}"),
			latency_ms,
		});
	}

	found.sort_by_key(|n| n.latency_ms);
	Ok(found)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn subnet_prefix_extracts_24() {
		assert_eq!(subnet_prefix("192.168.1.42"), Some("192.168.1".to_owned()));
		assert_eq!(subnet_prefix("10.0.0.5"), Some("10.0.0".to_owned()));
	}

	#[test]
	fn subnet_prefix_rejects_malformed() {
		assert_eq!(subnet_prefix("192.168.1"), None);
		assert_eq!(subnet_prefix("not-an-ip"), None);
		assert_eq!(subnet_prefix("1.2.3.4.5"), None);
	}
}
