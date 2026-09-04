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

#[derive(Debug, Serialize)]
pub struct LocalNodeToken {
    pub source: String,
    pub token: Option<String>,
}

/// A reachable Core found by the LAN sweep ([`discover_lan_nodes`]).
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

fn nodes_path() -> PathBuf {
    crate::profile::ryu_home_dir().join("nodes.json")
}

/// The file Core mints its node-admittance token into (`apps/core/src/node_token.rs`).
/// Profile-aware for the same reason `nodes_path` is: a dev Core writes into
/// `~/.ryu-dev`, and the dev desktop must read THAT token, not the release one.
fn node_auth_token_path() -> PathBuf {
    crate::profile::ryu_home_dir().join("node-auth.token")
}

/// Read the local Core's minted auth token, if it has one.
///
/// Core mints this on first boot so a default install is authenticated rather
/// than serving its whole API to any process on the machine. The desktop is
/// Core's PARENT, not its child, so it cannot inherit `RYU_TOKEN` from the
/// environment the way spawned sidecars do — it has to read the file.
///
/// `None` when absent (Core has not booted yet, or could not write it). Callers
/// must treat that as "send no bearer", which is exactly what Core's
/// `require_auth` accepts when it has no token configured either.
pub fn read_local_node_token() -> Option<String> {
    let raw = std::fs::read_to_string(node_auth_token_path()).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_owned())
}

/// True when `url` points at THIS machine's Core (the node whose token lives on
/// local disk). Compared on the normalized URL so a trailing slash does not
/// produce a miss. Mirrors `isLocalNode` in `useNodeStore.ts`.
fn is_local_node_url(url: &str) -> bool {
    let normalize = |u: &str| u.trim_end_matches('/').to_ascii_lowercase();
    normalize(url) == normalize(&crate::profile::core_base_url())
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
            fill_local_token(&mut config);
            return config;
        }
    }
    let mut config = NodesConfig {
        default: "local".into(),
        nodes: vec![Node {
            name: "local".into(),
            url: crate::profile::core_base_url(),
            token: None,
        }],
    };
    fill_local_token(&mut config);
    config
}

/// True only when `nodes.json` exists AND its default node is this machine's
/// Core — i.e. the user has actually committed to running Ryu locally.
///
/// Deliberately NOT built on [`load`], which fabricates a local default when the
/// file is missing. "No file yet" means the user has not picked a way to run Ryu
/// (onboarding's local / cloud / existing-node fork writes the file on the pick),
/// and boot must not download a Core binary on behalf of someone who may be
/// about to connect to their company's node instead. False on any read or parse
/// failure, so the cautious branch is also the fallback.
pub fn default_node_is_local() -> bool {
    let Ok(content) = std::fs::read_to_string(nodes_path()) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<NodesConfig>(&content) else {
        return false;
    };
    config
        .nodes
        .iter()
        .find(|n| n.name == config.default)
        .is_some_and(|n| is_local_node_url(&n.url))
}

/// Attach the on-disk minted token to any node pointing at THIS machine's Core.
///
/// Done at load time rather than persisted into `nodes.json`, deliberately:
///  - the token is a secret and `nodes.json` is not a secrets file (it has no
///    restrictive mode, and `data_path` copies it between profiles);
///  - it stays correct for free after Core rotates the token, with no migration;
///  - an explicit token already in `nodes.json` still WINS, so an operator who
///    pinned one by hand (or provisioned `RYU_TOKEN`) is never overridden.
fn fill_local_token(config: &mut NodesConfig) {
    let Some(token) = read_local_node_token() else {
        return;
    };
    for node in &mut config.nodes {
        if node.token.is_none() && is_local_node_url(&node.url) {
            node.token = Some(token.clone());
        }
    }
}

fn save(config: &NodesConfig) -> anyhow::Result<()> {
    let path = nodes_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Undo `fill_local_token` before writing. Every mutating command does
    // load -> mutate -> save, so without this the injected secret would be
    // round-tripped into `nodes.json` — a file with no restrictive mode that
    // `data_path` copies between profiles. Only a token that IS the current
    // on-disk one is stripped, so a token an operator pinned by hand survives.
    let mut to_write = NodesConfig {
        default: config.default.clone(),
        nodes: config.nodes.clone(),
    };
    if let Some(disk_token) = read_local_node_token() {
        for node in &mut to_write.nodes {
            if node.token.as_deref() == Some(disk_token.as_str()) && is_local_node_url(&node.url) {
                node.token = None;
            }
        }
    }
    std::fs::write(&path, serde_json::to_string_pretty(&to_write)?)?;
    Ok(())
}

#[tauri::command]
pub fn list_nodes() -> NodesConfig {
    load()
}

/// The local Core's auth token, for the settings UI (show / copy / share with a
/// browser surface that cannot read the file itself).
///
/// Returns `{ token, source }` where `source` is `"env"` when an operator
/// provisioned `RYU_TOKEN` (in which case rotating the file would have no
/// effect, and the UI says so), `"file"` when Core minted it, or `"none"` when
/// there is no token yet.
#[tauri::command]
pub fn local_node_token() -> LocalNodeToken {
    // An operator-provisioned RYU_TOKEN wins in Core's own resolution order, so
    // the UI must report the same precedence or it would offer to rotate a file
    // that is being ignored.
    if let Ok(env_token) = std::env::var("RYU_TOKEN") {
        let trimmed = env_token.trim();
        if !trimmed.is_empty() {
            return LocalNodeToken {
                source: "env".to_owned(),
                token: Some(trimmed.to_owned()),
            };
        }
    }
    let token = read_local_node_token();
    match token {
        Some(token) => LocalNodeToken {
            source: "file".to_owned(),
            token: Some(token),
        },
        None => LocalNodeToken {
            source: "none".to_owned(),
            token: None,
        },
    }
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

/// Replace the bearer for an existing remote node without changing its name or
/// URL. Re-entering onboarding with a refreshed token must not keep sending the
/// stale credential that was captured when the node was first added.
#[tauri::command]
pub fn update_node_token(name: String, token: Option<String>) -> Result<(), String> {
	let mut config = load();
	let node = config
		.nodes
		.iter_mut()
		.find(|node| node.name == name)
		.ok_or_else(|| format!("node '{}' not found", name))?;
	node.token = token.and_then(|value| {
		let trimmed = value.trim().to_owned();
		(!trimmed.is_empty()).then_some(trimmed)
	});
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

/// Return this device's primary outbound LAN IPv4 as a dotted-quad string
/// (e.g. "192.168.1.50"). Used to prefill the "Connect a phone" QR with an
/// address other devices on the same Wi-Fi can actually reach, instead of a
/// localhost address a phone can't. Errors when no route can be resolved
/// (offline / no Wi-Fi); the caller falls back to a manually typed address.
#[tauri::command]
pub fn get_lan_ip() -> Result<String, String> {
    local_ipv4().ok_or_else(|| "could not determine this device's Wi-Fi address".to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Discovery must cover EVERY profile's port. Sweeping only our own meant a
    /// stable desktop (:7980) could not see a canary node (:9980) even on this
    /// machine, so "stable app against a canary node" could not be set up without
    /// hand-entering a URL.
    #[test]
    fn every_profile_port_is_swept() {
        let ports: Vec<u16> = crate::profile::PROFILE_PORT_OFFSETS
            .iter()
            .map(|(_, off)| crate::profile::CORE_BASE_PORT.saturating_add(*off))
            .collect();
        assert!(ports.contains(&7980), "release");
        assert!(ports.contains(&8980), "dev");
        assert!(ports.contains(&9980), "canary");
        assert!(ports.contains(&10_980), "nightly");
        assert!(ports.contains(&11_980), "beta");
        // Distinct, or two profiles would be reported as one node.
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ports.len());
    }

    /// The profile is derived from the PORT, never from anything the node claims,
    /// so a discovered entry can always be labelled.
    #[test]
    fn a_port_maps_back_to_exactly_one_profile() {
        for (profile, offset) in crate::profile::PROFILE_PORT_OFFSETS {
            let port = crate::profile::CORE_BASE_PORT.saturating_add(*offset);
            let matches: Vec<&str> = crate::profile::PROFILE_PORT_OFFSETS
                .iter()
                .filter(|(_, o)| crate::profile::CORE_BASE_PORT.saturating_add(*o) == port)
                .map(|(n, _)| *n)
                .collect();
            assert_eq!(matches, vec![*profile], "port {port} must name one profile");
        }
    }

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

    // ── local node auth token ────────────────────────────────────────────────

    #[test]
    fn local_node_urls_match_regardless_of_trailing_slash_or_case() {
        let base = crate::profile::core_base_url();
        assert!(is_local_node_url(&base));
        assert!(is_local_node_url(&format!("{base}/")));
        assert!(is_local_node_url(&base.to_uppercase()));
        // A different host is NOT this machine's Core, so its token file must
        // never be attached to it.
        assert!(!is_local_node_url("http://192.168.1.50:7980"));
        assert!(!is_local_node_url("https://node.example.com"));
    }

    #[test]
    fn fill_local_token_never_overrides_an_explicit_token() {
        // An operator who pinned a token by hand (or a peer's own token) must win
        // over the on-disk mint, or a hand-configured node silently breaks.
        let mut config = NodesConfig {
            default: "local".into(),
            nodes: vec![
                Node {
                    name: "local".into(),
                    url: crate::profile::core_base_url(),
                    token: Some("pinned-by-hand".into()),
                },
                Node {
                    name: "remote".into(),
                    url: "http://192.168.1.50:7980".into(),
                    token: None,
                },
            ],
        };
        fill_local_token(&mut config);
        assert_eq!(config.nodes[0].token.as_deref(), Some("pinned-by-hand"));
        // A REMOTE node never receives this machine's token: it would be a secret
        // sent to a third party, and that peer would reject it anyway.
        assert_eq!(config.nodes[1].token, None);
    }
}
