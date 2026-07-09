//! Official ACP registry loader (`https://cdn.agentclientprotocol.com/registry/v1/latest`).
//!
//! Fetches the curated agent list published by the Agent Client Protocol project,
//! caches it under `~/.ryu/cache/acp-registry.json`, and converts each entry into
//! spawn/install metadata Core can run. Ryu-specific agents (the flagship `ryu`,
//! OpenClaw, ZeroClaw, Hermes) are merged separately in `AcpAgentRegistry::new`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const CACHE_MAX_AGE_SECS: u64 = 6 * 60 * 60;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryFile {
    pub version: String,
    pub agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// Brand icon URL from the official registry CDN (e.g. `…/claude-acp.svg`).
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub distribution: RegistryDistribution,
}

/// Default icon URL for a registry agent id on the ACP CDN.
pub fn default_icon_url(registry_id: &str) -> String {
    format!("https://cdn.agentclientprotocol.com/registry/v1/latest/{registry_id}.svg")
}

/// Resolved icon URL for a registry row (explicit `icon` field or CDN default).
pub fn icon_url_for_agent(agent: &RegistryAgent) -> String {
    agent
        .icon
        .clone()
        .unwrap_or_else(|| default_icon_url(&agent.id))
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDistribution {
    #[serde(default)]
    pub npx: Option<RegistryNpx>,
    #[serde(default)]
    pub uvx: Option<RegistryUvx>,
    #[serde(default)]
    pub binary: Option<HashMap<String, RegistryBinaryPlatform>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryNpx {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryUvx {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryBinaryPlatform {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Resolved binary distribution for the current host platform.
#[derive(Debug, Clone)]
pub struct DirectArchiveDist {
    pub registry_id: String,
    pub archive_url: String,
    /// Path inside the extracted archive root (e.g. `./goose`, `./bin/devin`).
    pub cmd: String,
    pub args: Vec<String>,
    /// `~/.ryu/agents/<id>` — full archive is extracted here; spawn uses `cmd`.
    pub install_dir: PathBuf,
}

fn cache_path() -> PathBuf {
    crate::paths::ryu_dir()
        .join("cache")
        .join("acp-registry.json")
}

fn cache_meta_path() -> PathBuf {
    crate::paths::ryu_dir()
        .join("cache")
        .join("acp-registry.fetched")
}

fn cache_age_secs() -> Option<u64> {
    let meta = std::fs::read_to_string(cache_meta_path()).ok()?;
    let fetched: u64 = meta.trim().parse().ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    now.checked_sub(fetched)
}

fn read_cache() -> Option<RegistryFile> {
    let raw = std::fs::read_to_string(cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(file: &RegistryFile) -> Result<()> {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(file)?)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    std::fs::write(cache_meta_path(), now.to_string())?;
    Ok(())
}

async fn fetch_remote() -> Result<RegistryFile> {
    let client = crate::sidecar::download_manager::build_http_client();
    let file: RegistryFile = client
        .get(REGISTRY_URL)
        .send()
        .await
        .context("GET ACP registry")?
        .error_for_status()
        .context("ACP registry HTTP error")?
        .json()
        .await
        .context("parse ACP registry JSON")?;
    Ok(file)
}

/// Load the registry: fresh CDN fetch when cache is stale, else disk cache.
///
/// This is a *sync* function reached from both plain-sync callers (before the
/// runtime exists) and from inside async code (`AcpAgentRegistry::new` at
/// startup). Spinning a nested `Runtime` inside a running Tokio runtime panics
/// ("Cannot start a runtime from within a runtime"), so when a runtime is
/// already driving this thread we must NOT block on the network here: serve the
/// disk cache immediately and kick the refresh onto a background task so the
/// next boot is fresh. Only the pure-sync path blocks on a fresh fetch.
pub fn load_registry_agents() -> Vec<RegistryAgent> {
    let stale = cache_age_secs().is_none_or(|age| age > CACHE_MAX_AGE_SECS);
    if stale {
        match tokio::runtime::Handle::try_current() {
            // Inside a Tokio runtime: never block on the network here. Refresh
            // in the background and fall through to the disk cache.
            Ok(handle) => {
                // Guard against a thundering herd: many sync callers hit this on
                // a cold boot, and each would otherwise spawn an identical CDN
                // GET. Let exactly one refresh run at a time.
                static REFRESHING: AtomicBool = AtomicBool::new(false);
                if REFRESHING
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    handle.spawn(async {
                        match fetch_remote().await {
                            Ok(file) => {
                                let count = file.agents.len();
                                if write_cache(&file).is_ok() {
                                    tracing::info!(
                                        count,
                                        "refreshed ACP registry from CDN (background)"
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "ACP registry background refresh failed")
                            }
                        }
                        REFRESHING.store(false, Ordering::Release);
                    });
                }
            }
            // No runtime yet (pure sync context): safe to block on a fresh fetch.
            Err(_) => {
                if let Ok(rt) = tokio::runtime::Runtime::new() {
                    match rt.block_on(fetch_remote()) {
                        Ok(file) => {
                            let agents = file.agents.clone();
                            if write_cache(&file).is_ok() {
                                tracing::info!(count = agents.len(), "refreshed ACP registry from CDN");
                            }
                            return agents;
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "ACP registry fetch failed; using cache")
                        }
                    }
                }
            }
        }
    }
    if let Some(file) = read_cache() {
        tracing::debug!(count = file.agents.len(), "loaded ACP registry from cache");
        return file.agents;
    }
    tracing::warn!("ACP registry unavailable (no cache); agent catalog will be partial");
    Vec::new()
}

/// Map a registry id to Ryu's stable internal catalog id (preserves installs).
pub fn canonical_agent_id(registry_id: &str) -> String {
    match registry_id {
        "claude-acp" => "acp:claude".into(),
        "codex-acp" => "acp:codex".into(),
        "gemini" => "acp:gemini".into(),
        "pi-acp" => "acp:pi".into(),
        "qwen-code" => "acp:qwen".into(),
        "github-copilot-cli" => "acp:copilot".into(),
        "codebuddy-code" => "acp:codebuddy".into(),
        "grok-build" => "acp:grok".into(),
        "factory-droid" => "acp:droid".into(),
        "glm-acp-agent" => "acp:glm".into(),
        "agoragentic-acp" => "acp:agoragentic".into(),
        "minion-code" => "acp:minion".into(),
        other => format!("acp:{other}"),
    }
}

fn host_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64";
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return "darwin-x86_64";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64";
    #[cfg(target_os = "windows")]
    return "windows-x86_64";
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return "linux-x86_64";
}

/// npm / uv package name without a pinned version suffix (`@x.y.z`, `==x.y.z`).
pub fn npm_package_name(spec: &str) -> String {
    let spec = spec.trim();
    if let Some(idx) = spec.find("==") {
        return spec[..idx].to_string();
    }
    if let Some(at) = spec.rfind('@') {
        if at > 0 {
            return spec[..at].to_string();
        }
    }
    spec.to_string()
}

/// Build an `npx -y <package> [args…]` spawn command from registry metadata.
pub fn npx_spawn_from_registry(pkg: &str, args: &[String]) -> String {
    let mut parts = vec!["npx".to_string(), "-y".to_string(), pkg.to_string()];
    parts.extend(args.iter().cloned());
    shell_wrap_npx(&parts.join(" "))
}

#[cfg(target_os = "windows")]
fn shell_wrap_npx(cmd: &str) -> String {
    format!("cmd /c {cmd}")
}

#[cfg(not(target_os = "windows"))]
fn shell_wrap_npx(cmd: &str) -> String {
    cmd.to_owned()
}

/// Build a `uvx <package> [args…]` spawn command from registry metadata.
pub fn uvx_spawn_from_registry(pkg: &str, args: &[String]) -> String {
    let mut parts = vec!["uvx".to_string(), pkg.to_string()];
    parts.extend(args.iter().cloned());
    parts.join(" ")
}

pub fn direct_archive_for_agent(agent: &RegistryAgent) -> Option<DirectArchiveDist> {
    let platforms = agent.distribution.binary.as_ref()?;
    let platform = host_platform_key();
    let spec = platforms.get(platform)?;
    Some(DirectArchiveDist {
        registry_id: agent.id.clone(),
        archive_url: spec.archive.clone(),
        cmd: spec.cmd.clone(),
        args: spec.args.clone(),
        install_dir: crate::sidecar::download_manager::ryu_dir()
            .join("agents")
            .join(&agent.id),
    })
}

/// Registry ids overridden by curated first-class entries in `AcpAgentRegistry`.
pub const CURATED_OVERRIDE_IDS: &[&str] = &["claude-acp", "codex-acp", "gemini", "pi-acp"];

/// Spawn metadata derived from a registry agent row.
#[derive(Debug, Clone)]
pub struct RegistrySpawnPlan {
    pub spawn_cmd: String,
    pub direct_archive: Option<DirectArchiveDist>,
    /// Unpinned npm package name for the ACP bridge (npx agents).
    pub bridge_npm_package: Option<String>,
}

/// Build spawn/install metadata from a registry distribution block.
pub fn spawn_plan_for(agent: &RegistryAgent) -> Option<RegistrySpawnPlan> {
    if let Some(npx) = &agent.distribution.npx {
        let pkg_base = npm_package_name(&npx.package);
        // Unpinned `@latest` so npx auto-updates the bridge on install/spawn.
        let spawn_pkg = format!("{pkg_base}@latest");
        return Some(RegistrySpawnPlan {
            spawn_cmd: npx_spawn_from_registry(&spawn_pkg, &npx.args),
            direct_archive: None,
            bridge_npm_package: Some(pkg_base),
        });
    }
    if let Some(uvx) = &agent.distribution.uvx {
        let pkg_base = npm_package_name(&uvx.package);
        // Unpinned name so `uvx` resolves the latest release on each fetch.
        return Some(RegistrySpawnPlan {
            spawn_cmd: uvx_spawn_from_registry(&pkg_base, &uvx.args),
            direct_archive: None,
            bridge_npm_package: None,
        });
    }
    if let Some(dist) = direct_archive_for_agent(agent) {
        return Some(RegistrySpawnPlan {
            spawn_cmd: spawn_cmd_for_direct_archive(&dist),
            direct_archive: Some(dist),
            bridge_npm_package: None,
        });
    }
    None
}

/// Absolute spawn command for a direct-archive agent (runs from `install_dir`).
pub fn spawn_cmd_for_direct_archive(dist: &DirectArchiveDist) -> String {
    let cmd_rel = dist
        .cmd
        .trim_start_matches("./")
        .replace('/', std::path::MAIN_SEPARATOR_STR);
    let bin = dist.install_dir.join(&cmd_rel);
    let mut parts = vec![bin.display().to_string()];
    parts.extend(dist.args.clone());
    let joined = parts.join(" ");
    shell_wrap_npx(&joined)
}

/// Optional underlying agent CLI to probe (`binary`, npm package name).
pub fn underlying_cli_probe(registry_id: &str) -> Option<(&'static str, &'static str)> {
    match registry_id {
        "claude-acp" => Some(("claude", "@anthropic-ai/claude-code")),
        "codex-acp" => Some(("codex", "@openai/codex")),
        "gemini" => Some(("gemini", "@google/gemini-cli")),
        "pi-acp" => Some(("pi", "@earendil-works/pi-coding-agent")),
        "github-copilot-cli" => Some(("copilot", "@github/copilot")),
        "qwen-code" => Some(("qwen", "@qwen-code/qwen-code")),
        "goose" => Some(("goose", "goose")),
        "cursor" => Some(("cursor-agent", "cursor-agent")),
        _ => None,
    }
}

/// Default gateway-bypass for a registry agent (most ACP subprocesses self-route).
pub fn registry_gateway_bypass(registry_id: &str) -> bool {
    !matches!(registry_id, "codex-acp" | "pi-acp")
}

/// Download and extract a registry `binary` distribution into `install_dir`.
pub async fn ensure_direct_archive(
    dist: &DirectArchiveDist,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<()> {
    use crate::sidecar::download_manager::{
        build_http_client, extract_tar_bz2_to_dir, extract_tar_gz_to_dir, extract_zip_to_dir,
        retry_download, ryu_dir,
    };

    let marker = dist.install_dir.join(".installed");
    if marker.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(&dist.install_dir)?;
    let url = dist.archive_url.clone();
    let id = dist.registry_id.clone();
    let client = build_http_client();
    let archive_data = retry_download(&id, 3, || {
        let client = client.clone();
        let url = url.clone();
        async move {
            client
                .get(&url)
                .send()
                .await
                .context("GET agent archive")?
                .error_for_status()
                .context("agent archive HTTP error")?
                .bytes()
                .await
                .context("reading agent archive bytes")
                .map(|b| b.to_vec())
        }
    })
    .await
    .with_context(|| format!("downloading {} archive", dist.registry_id))?;

    let dest = dist.install_dir.clone();
    let url_for_kind = dist.archive_url.clone();
    tokio::task::spawn_blocking(move || {
        if url_for_kind.ends_with(".tar.bz2") || url_for_kind.ends_with(".tbz2") {
            extract_tar_bz2_to_dir(&archive_data, &dest, None)
        } else if url_for_kind.ends_with(".tar.gz") || url_for_kind.ends_with(".tgz") {
            extract_tar_gz_to_dir(&archive_data, &dest, None)
        } else if url_for_kind.ends_with(".zip") {
            extract_zip_to_dir(&archive_data, &dest, None)
        } else {
            anyhow::bail!("unsupported archive format: {url_for_kind}");
        }
    })
    .await
    .context("extract archive task")??;

    std::fs::write(&marker, dist.archive_url.as_bytes())?;
    let _ = ryu_dir(); // ensure ryu dir exists
    let _ = downloads;
    Ok(())
}

/// Look up a registry row by id from cache/CDN.
pub fn find_registry_agent(registry_id: &str) -> Option<RegistryAgent> {
    load_registry_agents()
        .into_iter()
        .find(|a| a.id == registry_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_ids_preserve_legacy_installs() {
        assert_eq!(canonical_agent_id("claude-acp"), "acp:claude");
        assert_eq!(canonical_agent_id("cursor"), "acp:cursor");
        assert_eq!(canonical_agent_id("qwen-code"), "acp:qwen");
    }

    #[test]
    fn npm_package_name_strips_version() {
        assert_eq!(
            npm_package_name("@agentclientprotocol/claude-agent-acp@0.55.0"),
            "@agentclientprotocol/claude-agent-acp"
        );
        assert_eq!(npm_package_name("cline@3.0.37"), "cline");
        assert_eq!(npm_package_name("fast-agent-acp==0.9.1"), "fast-agent-acp");
    }
}
