use serde::{Deserialize, Serialize};
use std::path::PathBuf;

mod discovery;
mod error;

use discovery::local_ipv4;
pub use discovery::DiscoveredNode;
use error::{is_valid_node_name, NodeCommandError, NodeCommandErrorCode};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Node {
    pub name: String,
    pub url: String,
    /// The node's bearer. Stored in plaintext in the owner-only (`0600`)
    /// `nodes.json`, NOT sealed: the Bun CLI/TUI (`apps/cli/src/core/nodes.ts`)
    /// reads this file directly and has no way to open a desktop-keychain
    /// envelope. A sealed `enc:v1:` token left by an earlier build is opened on
    /// load and written back in plaintext so the CLI can use it again.
    pub token: Option<String>,
    /// A sealed token this process could not open (another device's key, a
    /// reset keychain). Never sent as a bearer and never sent to the webview,
    /// but written back unchanged so a save does not destroy it.
    #[serde(skip)]
    pub unopened_token: Option<String>,
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

/// `<data dir>/state/nodes.json` — shared with Core and the CLI.
fn nodes_path() -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::profile::ryu_home_dir(), "nodes.json")
}

/// The file Core mints its node-admittance token into (`apps/core/src/node_token.rs`).
/// Profile-aware for the same reason `nodes_path` is: a dev Core writes into
/// `~/.ryu-dev`, and the dev desktop must read THAT token, not the release one.
/// Lives at `<data dir>/secrets/node-auth.token`.
fn node_auth_token_path() -> PathBuf {
    ryu_sidecar_runtime::layout::secret_path(&crate::profile::ryu_home_dir(), "node-auth.token")
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
    let local_token = read_local_node_token();
    let mut config = load_at(&nodes_path(), local_token.as_deref());
    fill_local_token_with(&mut config, local_token);
    config
}

/// Read `nodes.json` at `path` without the local token injected. Plaintext
/// tokens are used as-is. A sealed token written by an earlier build is opened
/// and the file rewritten with it in plaintext once (as is the old port-2049
/// local URL migration), because the CLI reads this file and cannot open it.
fn load_at(path: &std::path::Path, local_token: Option<&str>) -> NodesConfig {
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(mut config) = serde_json::from_str::<NodesConfig>(&content) {
            // Migrate old default local URL (port 2049 → the profile's Core port).
            let mut migrated = false;
            let local_url = crate::profile::core_base_url();
            for node in &mut config.nodes {
                if node.name == "local" && node.url == "http://127.0.0.1:2049" {
                    node.url = local_url.clone();
                    migrated = true;
                }
                migrated |= open_node_token(node);
            }
            if migrated {
                let _ = save_at(path, &config, local_token);
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
            unopened_token: None,
        }],
    }
}

/// Open a node's stored token in place. Returns true when a sealed token was
/// opened (the caller rewrites the file so the CLI can read it again).
fn open_node_token(node: &mut Node) -> bool {
    let Some(stored) = node.token.take() else {
        return false;
    };
    if !crate::desktop_seal::is_sealed(&stored) {
        node.token = Some(stored);
        return false;
    }
    match crate::desktop_seal::open(&stored) {
        Ok(token) => {
            node.token = Some(token);
            true
        }
        Err(error) => {
            tracing::warn!(node = %node.name, "a saved node token could not be opened: {error}");
            node.unopened_token = Some(stored);
            false
        }
    }
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
#[cfg(test)]
fn fill_local_token(config: &mut NodesConfig) {
    fill_local_token_with(config, read_local_node_token());
}

fn fill_local_token_with(config: &mut NodesConfig, token: Option<String>) {
    let Some(token) = token else {
        return;
    };
    for node in &mut config.nodes {
        if node.token.is_none() && is_local_node_url(&node.url) {
            node.token = Some(token.clone());
        }
    }
}

fn save(config: &NodesConfig) -> anyhow::Result<()> {
    save_at(&nodes_path(), config, read_local_node_token().as_deref())
}

/// Write `config` to `path`. Remote tokens are stored in plaintext because the
/// Bun CLI reads this file and cannot open a desktop-keychain envelope; the
/// file is owner-only (`0600`) and its `state/` directory `0700`. See
/// `docs/encryption-at-rest.md`.
fn save_at(
    path: &std::path::Path,
    config: &NodesConfig,
    local_token: Option<&str>,
) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        restrict_mode(parent, 0o700);
    }
    // Undo `fill_local_token` before writing. Every mutating command does
    // load -> mutate -> save, so without this the injected secret would be
    // round-tripped into `nodes.json` — a plaintext file that
    // `data_path` copies between profiles. Only a token that IS the current
    // on-disk one is stripped, so a token an operator pinned by hand survives.
    let mut to_write = NodesConfig {
        default: config.default.clone(),
        nodes: config.nodes.clone(),
    };
    if let Some(disk_token) = local_token {
        for node in &mut to_write.nodes {
            if node.token.as_deref() == Some(disk_token) && is_local_node_url(&node.url) {
                node.token = None;
            }
        }
    }
    for node in &mut to_write.nodes {
        if node.token.is_none() {
            node.token = node.unopened_token.take();
        }
    }
    // Stage + rename: an interrupted in-place write would leave truncated JSON,
    // which `load()` silently replaces with the default config — and the next
    // save would then erase every remote node (and its pinned token).
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("nodes.json has no parent directory"))?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    std::io::Write::write_all(
        &mut staged,
        serde_json::to_string_pretty(&to_write)?.as_bytes(),
    )?;
    staged.as_file().sync_all()?;
    staged.persist(path).map_err(|error| error.error)?;
    restrict_mode(path, 0o600);
    Ok(())
}

/// Best-effort owner-only permissions (no-op off Unix).
fn restrict_mode(path: &std::path::Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) {
            tracing::warn!(path = %path.display(), "could not restrict permissions: {error}");
        }
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
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
pub fn add_node(name: String, url: String, token: Option<String>) -> Result<(), NodeCommandError> {
    if !is_valid_node_name(&name) {
        return Err(NodeCommandError::new(
            NodeCommandErrorCode::InvalidName,
            name,
        ));
    }
    let mut config = load();
    if config.nodes.iter().any(|n| n.name == name) {
        return Err(NodeCommandError::new(
            NodeCommandErrorCode::DuplicateName,
            name,
        ));
    }
    config.nodes.push(Node {
        name: name.clone(),
        url,
        token,
        unopened_token: None,
    });
    save(&config).map_err(|e| NodeCommandError::save_failed(name, e))
}

/// Replace the bearer for an existing remote node without changing its name or
/// URL. Re-entering onboarding with a refreshed token must not keep sending the
/// stale credential that was captured when the node was first added.
#[tauri::command]
pub fn update_node_token(name: String, token: Option<String>) -> Result<(), NodeCommandError> {
    let mut config = load();
    let Some(node) = config.nodes.iter_mut().find(|node| node.name == name) else {
        return Err(NodeCommandError::new(NodeCommandErrorCode::NotFound, name));
    };
    node.token = token.and_then(|value| {
        let trimmed = value.trim().to_owned();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    node.unopened_token = None;
    save(&config).map_err(|e| NodeCommandError::save_failed(name, e))
}

#[tauri::command]
pub fn remove_node(name: String) -> Result<(), NodeCommandError> {
    if name == "local" {
        return Err(NodeCommandError::new(NodeCommandErrorCode::LocalNode, name));
    }
    let mut config = load();
    let before = config.nodes.len();
    config.nodes.retain(|n| n.name != name);
    if config.nodes.len() == before {
        return Err(NodeCommandError::new(NodeCommandErrorCode::NotFound, name));
    }
    if config.default == name {
        config.default = "local".into();
    }
    save(&config).map_err(|e| NodeCommandError::save_failed(name, e))
}

#[tauri::command]
pub fn set_default_node(name: String) -> Result<(), NodeCommandError> {
    let mut config = load();
    if !config.nodes.iter().any(|n| n.name == name) {
        return Err(NodeCommandError::new(NodeCommandErrorCode::NotFound, name));
    }
    config.default = name.clone();
    save(&config).map_err(|e| NodeCommandError::save_failed(name, e))
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

/// Return this device's primary outbound LAN IPv4 as a dotted-quad string
/// (e.g. "192.168.1.50"). Used to prefill the "Connect a phone" QR with an
/// address other devices on the same Wi-Fi can actually reach, instead of a
/// localhost address a phone can't. Errors when no route can be resolved
/// (offline / no Wi-Fi); the caller falls back to a manually typed address.
#[tauri::command]
pub fn get_lan_ip() -> Result<String, String> {
    local_ipv4().ok_or_else(|| "could not determine this device's Wi-Fi address".to_string())
}

/// Sweep the local /24 subnet for Core nodes advertising on :7980.
///
/// Probes up to `MAX_SWEEP_HOSTS` host octets (1-254) concurrently, each with a
/// short per-request timeout, and returns every responding node sorted by
/// ascending latency. The caller's own address is excluded. Ported from the CLI
/// (`apps/cli/src/nodes.rs`). NodeSelector-only.
#[tauri::command]
pub async fn discover_lan_nodes() -> Result<Vec<DiscoveredNode>, String> {
    discovery::sweep().await
}

#[cfg(test)]
mod tests;
