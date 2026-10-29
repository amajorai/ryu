//! Official ACP registry loader (`https://cdn.agentclientprotocol.com/registry/v1/latest`).
//!
//! Fetches the curated agent list published by the Agent Client Protocol project,
//! caches it under `~/.ryu/cache/acp-registry.json`, and converts each entry into
//! spawn/install metadata Core can run. Ryu-specific agents (the flagship `ryu`,
//! OpenClaw, ZeroClaw, Hermes) are merged separately in `AcpAgentRegistry::new`.

use std::collections::{HashMap, HashSet};
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
    /// `<data dir>/runtimes/acp-agents/<id>` — full archive is extracted here; spawn uses `cmd`.
    pub install_dir: PathBuf,
}

fn cache_path() -> PathBuf {
    crate::paths::cache_path("acp-registry.json")
}

fn cache_meta_path() -> PathBuf {
    crate::paths::cache_path("acp-registry.fetched")
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

/// Keep a small, stable ACP catalog available when the CDN and its cache are
/// both unavailable. The full registry is still preferred and merged ahead of
/// these rows; this only keeps a cold/offline install from losing the agents
/// that the Store advertises in its first-run catalog.
fn bundled_fallback_agents() -> Vec<RegistryAgent> {
    let npx = |id: &str, name: &str, package: &str, args: &[&str]| RegistryAgent {
        id: id.to_owned(),
        name: name.to_owned(),
        version: "0.0.0".to_owned(),
        description: format!("{name} ACP agent (offline catalog fallback)"),
        icon: None,
        distribution: RegistryDistribution {
            npx: Some(RegistryNpx {
                package: package.to_owned(),
                args: args.iter().map(|arg| (*arg).to_owned()).collect(),
                env: HashMap::new(),
            }),
            ..RegistryDistribution::default()
        },
    };
    let uvx = |id: &str, name: &str, package: &str, args: &[&str]| RegistryAgent {
        id: id.to_owned(),
        name: name.to_owned(),
        version: "0.0.0".to_owned(),
        description: format!("{name} ACP agent (offline catalog fallback)"),
        icon: None,
        distribution: RegistryDistribution {
            uvx: Some(RegistryUvx {
                package: package.to_owned(),
                args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            }),
            ..RegistryDistribution::default()
        },
    };
    vec![
        npx("cline", "Cline", "cline", &["--acp"]),
        npx("auggie", "Auggie CLI", "@augmentcode/auggie", &["--acp"]),
        npx(
            "qwen-code",
            "Qwen Code",
            "@qwen-code/qwen-code",
            &["--acp", "--experimental-skills"],
        ),
        npx(
            "github-copilot-cli",
            "GitHub Copilot",
            "@github/copilot",
            &["--acp"],
        ),
        npx(
            "grok-build",
            "Grok Build",
            "@xai-official/grok",
            &["agent", "stdio"],
        ),
        uvx("fast-agent", "fast-agent", "fast-agent-acp", &["-x"]),
        uvx("minion-code", "Minion Code", "minion-code", &["acp"]),
    ]
}

fn merge_bundled_fallback_agents(mut agents: Vec<RegistryAgent>) -> Vec<RegistryAgent> {
    let mut seen: HashSet<String> = agents.iter().map(|agent| agent.id.clone()).collect();
    for fallback in bundled_fallback_agents() {
        if seen.insert(fallback.id.clone()) {
            agents.push(fallback);
        }
    }
    agents
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
    if stale && !crate::offline_test_bootstrap::is_active() {
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
                                tracing::info!(
                                    count = agents.len(),
                                    "refreshed ACP registry from CDN"
                                );
                            }
                            return merge_bundled_fallback_agents(agents);
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
        return merge_bundled_fallback_agents(file.agents);
    }
    tracing::warn!("ACP registry unavailable (no cache); using bundled fallback agents");
    merge_bundled_fallback_agents(Vec::new())
}

/// Bounded fetch used by [`ensure_registry_cached`]. A cold first launch must not
/// hang boot behind an unreachable CDN, so the wait is capped and failure is
/// non-fatal (we fall through to the bundled fallback agents).
const COLD_START_FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// Populate the on-disk registry cache **before** the process builds its
/// in-memory [`crate::sidecar::adapters::acp::AcpAgentRegistry`].
///
/// Why this exists: `AcpAgentRegistry::new()` is built exactly once, at boot, and
/// its `entries` are frozen into an `Arc` for the process lifetime. It reaches
/// [`load_registry_agents`] from *inside* the Tokio runtime, where that function
/// deliberately refuses to block on the network — it kicks a background refresh
/// and serves the disk cache. On a cold first launch there is no disk cache, so
/// the registry froze with only the hardcoded curated agents; the background
/// refresh then wrote a perfectly good 38-agent cache that nothing re-read. The
/// Store's Agents tab therefore showed ~8 agents *for the rest of that process's
/// life*, and only a restart fixed it — which is exactly the "the other agents
/// vanished" report.
///
/// Awaiting the first fetch here closes that window: by the time the registry is
/// constructed the cache exists, so the frozen snapshot is complete. Only the
/// genuinely-cold case pays the wait (cache absent or unreadable); a warm boot
/// returns immediately and leaves staleness to the existing background refresh —
/// a stale cache still yields the full agent list, it just lags CDN *additions*
/// by one restart.
pub async fn ensure_registry_cached() {
    if read_cache().is_some() {
        return;
    }
    match tokio::time::timeout(COLD_START_FETCH_TIMEOUT, fetch_remote()).await {
        Ok(Ok(file)) => {
            let count = file.agents.len();
            match write_cache(&file) {
                Ok(()) => tracing::info!(count, "seeded ACP registry cache on cold start"),
                Err(e) => tracing::warn!(error = %e, "could not write ACP registry cache"),
            }
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "cold-start ACP registry fetch failed; using bundled fallback agents until the next refresh");
        }
        Err(_) => {
            tracing::warn!(
                timeout_secs = COLD_START_FETCH_TIMEOUT.as_secs(),
                "cold-start ACP registry fetch timed out; using bundled fallback agents until the next refresh"
            );
        }
    }
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
        install_dir: crate::paths::runtime_dir("acp-agents").join(&agent.id),
    })
}

/// Registry ids overridden by curated first-class entries in `AcpAgentRegistry`.
pub const CURATED_OVERRIDE_IDS: &[&str] = &["claude-acp", "codex-acp", "gemini", "pi-acp", "kiro"];

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
        if !safe_registry_argument(&npx.package)
            || npx.args.iter().any(|arg| !safe_registry_argument(arg))
        {
            return None;
        }
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
        if !safe_registry_argument(&uvx.package)
            || uvx.args.iter().any(|arg| !safe_registry_argument(arg))
        {
            return None;
        }
        let pkg_base = npm_package_name(&uvx.package);
        // Unpinned name so `uvx` resolves the latest release on each fetch.
        return Some(RegistrySpawnPlan {
            spawn_cmd: uvx_spawn_from_registry(&pkg_base, &uvx.args),
            direct_archive: None,
            bridge_npm_package: None,
        });
    }
    if let Some(dist) = direct_archive_for_agent(agent) {
        if safe_archive_command(&dist.cmd).is_none()
            || dist.args.iter().any(|arg| !safe_registry_argument(arg))
        {
            return None;
        }
        return Some(RegistrySpawnPlan {
            spawn_cmd: spawn_cmd_for_direct_archive(&dist),
            direct_archive: Some(dist),
            bridge_npm_package: None,
        });
    }
    None
}

fn safe_registry_argument(value: &str) -> bool {
    !value.trim().is_empty()
        && !value.chars().any(|ch| {
            ch.is_control()
                || matches!(
                    ch,
                    '&' | '|' | ';' | '<' | '>' | '`' | '$' | '(' | ')' | '^' | '%' | '!' | '"'
                )
        })
}

/// Absolute spawn command for a direct-archive agent (runs from `install_dir`),
/// falling back to the user's own copy of the CLI when Ryu never downloaded the
/// archive.
///
/// The fallback is what makes a self-installed binary agent actually usable.
/// `list_infos` reports a registry agent as **installed** purely from
/// `detect_binary` being on `PATH` (`opencode`, `goose`, `cursor-agent`, …), so
/// an agent the user installed themselves shows up as ready and is selectable —
/// but a binary-distribution agent's spawn command pointed unconditionally at
/// `~/.ryu/agents/<id>/<cmd>`, a path that only exists once Ryu has downloaded
/// the archive. Selecting such an agent therefore spawned a file that was not
/// there: `session/new` never answered, `probe_acp_config` failed, and the
/// composer's Model / Approval / thinking submenus stayed empty while npx-
/// distributed agents (Claude, Codex) worked — because npx self-fetches and
/// needs no install directory. That asymmetry was the whole bug.
///
/// So: prefer Ryu's own copy when it is present (it is the version Ryu pins and
/// updates), otherwise spawn the detected CLI by bare name and let `PATH`
/// resolve it. The registry's `args` are carried over unchanged in both cases —
/// `cmd` and the user's binary are the same program, only reached differently.
/// Falling all the way back to the archive path when neither exists is
/// deliberate: the failure then names the path the install flow will fill.
pub fn spawn_cmd_for_direct_archive(dist: &DirectArchiveDist) -> String {
    let cmd_rel = safe_archive_command(&dist.cmd).unwrap_or_else(|| {
        // Keep an invalid registry row inside the Ryu-owned install directory so
        // a malicious absolute/parent path can only produce a failed spawn.
        "__invalid_registry_command__".to_owned()
    });
    let bin = dist.install_dir.join(&cmd_rel);
    let program = if bin.is_file() {
        bin.display().to_string()
    } else {
        underlying_cli_probe(&dist.registry_id)
            .map(|(binary, _)| binary)
            .filter(|binary| crate::sidecar::adapters::acp::binary_in_path(binary))
            .map_or_else(|| bin.display().to_string(), str::to_owned)
    };
    let mut parts = vec![program];
    parts.extend(dist.args.clone());
    let joined = parts.join(" ");
    shell_wrap_npx(&joined)
}

fn safe_archive_command(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || std::path::Path::new(trimmed).is_absolute() {
        return None;
    }
    let normalized = trimmed.trim_start_matches("./").replace('\\', "/");
    if normalized.is_empty()
        || normalized
            .split('/')
            .any(|segment| segment.is_empty() || segment == "..")
    {
        return None;
    }
    Some(normalized.replace('/', std::path::MAIN_SEPARATOR_STR))
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
        // The long tail. Every row above was a first-class agent; these are the
        // rest of the registry whose ACP entry wraps a CLI the user installs
        // separately. Without a row here `detect_binary` is `None`, so the agent
        // can never be reported as found — onboarding's "Found on your system"
        // section could only ever name the eight agents above, no matter what was
        // actually installed. The mapping is registry id → (the binary the USER
        // has, the npm package that upgrades it); an agent whose underlying CLI
        // name is not publicly settled is deliberately left out rather than
        // guessed, since a wrong name detects some unrelated binary.
        "opencode" => Some(("opencode", "opencode-ai")),
        "grok-build" => Some(("grok", "@xai-official/grok")),
        "factory-droid" => Some(("droid", "droid")),
        "auggie" => Some(("auggie", "@augmentcode/auggie")),
        "cline" => Some(("cline", "cline")),
        "kilo" => Some(("kilo", "@kilocode/cli")),
        "codebuddy-code" => Some(("codebuddy", "@tencent-ai/codebuddy-code")),
        "qoder" => Some(("qoder", "@qoder-ai/qodercli")),
        "dimcode" => Some(("dimcode", "dimcode")),
        "dirac" => Some(("dirac", "dirac-cli")),
        "nova" => Some(("nova", "@compass-ai/nova")),
        "sigit" => Some(("sigit", "@smbcloud/sigit")),
        "stakpak" => Some(("stakpak", "stakpak")),
        "vtcode" => Some(("vtcode", "vtcode")),
        "devin" => Some(("devin", "devin")),
        _ => None,
    }
}

/// Default gateway-bypass for a registry agent (most ACP subprocesses self-route).
///
/// A registry ACP agent's *chat* egress is governable only when BOTH (a) its CLI
/// honours a base-URL env var Core injects at spawn AND (b) the Gateway speaks
/// that wire format (OpenAI `/v1`, or the Anthropic / OpenAI-Responses
/// passthroughs). Only `codex-acp` and `pi-acp` satisfy both here — they honour
/// `OPENAI_BASE_URL` and are wrapped by their dedicated cmd builders — so every
/// other registry agent bypasses the Gateway for chat and carries `true`:
///   - `gemini` reads `GOOGLE_GEMINI_BASE_URL` / `CODE_ASSIST_ENDPOINT` (Google
///     format), which the Gateway has no ingress for — governing it needs a new
///     Gateway passthrough, not Core injection.
///   - the self-fetching long tail (`cline`/`goose`/`opencode`/`qwen-code`/…)
///     makes its own provider calls; only `qwen-code` is known to read
///     `OPENAI_BASE_URL`, and only under its `openai` auth type, so it is
///     coverable solely via the fully-configured BYO `acp-exec:` path — not here.
/// See `docs/routing-planes.md` (the per-agent chat-egress coverage matrix).
pub fn registry_gateway_bypass(registry_id: &str) -> bool {
    !matches!(registry_id, "codex-acp" | "pi-acp")
}

/// Download and extract a registry `binary` distribution into `install_dir`.
pub async fn ensure_direct_archive(
    dist: &DirectArchiveDist,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<()> {
    let marker = dist.install_dir.join(".installed");
    if marker.exists() {
        return Ok(());
    }
    let _ = downloads;
    anyhow::bail!(
        "registry agent archive {} has no trusted digest; refusing to download or execute it",
        dist.registry_id
    )
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

    fn agent_with(id: &str, dist: RegistryDistribution) -> RegistryAgent {
        RegistryAgent {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            description: String::new(),
            icon: None,
            distribution: dist,
        }
    }

    #[test]
    fn canonical_ids_cover_every_curated_mapping_and_fallthrough() {
        assert_eq!(canonical_agent_id("codex-acp"), "acp:codex");
        assert_eq!(canonical_agent_id("gemini"), "acp:gemini");
        assert_eq!(canonical_agent_id("pi-acp"), "acp:pi");
        assert_eq!(canonical_agent_id("github-copilot-cli"), "acp:copilot");
        assert_eq!(canonical_agent_id("codebuddy-code"), "acp:codebuddy");
        assert_eq!(canonical_agent_id("grok-build"), "acp:grok");
        assert_eq!(canonical_agent_id("factory-droid"), "acp:droid");
        assert_eq!(canonical_agent_id("glm-acp-agent"), "acp:glm");
        assert_eq!(canonical_agent_id("agoragentic-acp"), "acp:agoragentic");
        assert_eq!(canonical_agent_id("minion-code"), "acp:minion");
        // Unknown id → generic acp: prefix.
        assert_eq!(canonical_agent_id("brand-new-agent"), "acp:brand-new-agent");
    }

    #[test]
    fn npm_package_name_edge_cases() {
        // Scoped package with NO version: leading '@' at index 0 is not a version sep.
        assert_eq!(npm_package_name("@scope/pkg"), "@scope/pkg");
        // Bare package, no version.
        assert_eq!(npm_package_name("goose"), "goose");
        // Surrounding whitespace is trimmed.
        assert_eq!(npm_package_name("  cline@1.2.3  "), "cline");
        // `==` takes precedence and wins even if an '@' is also present.
        assert_eq!(npm_package_name("pkg==1.0.0"), "pkg");
    }

    #[test]
    fn default_and_resolved_icon_urls() {
        assert_eq!(
            default_icon_url("claude-acp"),
            "https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg"
        );
        // No explicit icon → CDN default derived from id.
        let plain = agent_with("goose", RegistryDistribution::default());
        assert_eq!(icon_url_for_agent(&plain), default_icon_url("goose"));
        // Explicit icon field wins verbatim.
        let mut branded = agent_with("goose", RegistryDistribution::default());
        branded.icon = Some("https://example.com/x.png".to_owned());
        assert_eq!(icon_url_for_agent(&branded), "https://example.com/x.png");
    }

    #[test]
    fn npx_and_uvx_spawn_commands_include_package_and_args() {
        let args = vec!["--acp".to_owned(), "--verbose".to_owned()];
        let npx = npx_spawn_from_registry("cline@latest", &args);
        assert!(npx.contains("npx"));
        assert!(npx.contains("-y"));
        assert!(npx.contains("cline@latest"));
        assert!(npx.contains("--acp") && npx.contains("--verbose"));

        let uvx = uvx_spawn_from_registry("fast-agent-acp", &args);
        assert!(uvx.starts_with("uvx "));
        assert!(uvx.contains("fast-agent-acp"));
        assert!(uvx.contains("--acp"));
    }

    #[test]
    fn spawn_plan_prefers_npx_then_uvx_then_binary_then_none() {
        // npx present → npx plan with unpinned bridge package.
        let npx_agent = agent_with(
            "cline",
            RegistryDistribution {
                npx: Some(RegistryNpx {
                    package: "cline@3.0.0".to_owned(),
                    args: vec!["--acp".to_owned()],
                    env: HashMap::new(),
                }),
                ..Default::default()
            },
        );
        let plan = spawn_plan_for(&npx_agent).expect("npx plan");
        assert_eq!(plan.bridge_npm_package.as_deref(), Some("cline"));
        assert!(plan.spawn_cmd.contains("cline@latest"));
        assert!(plan.direct_archive.is_none());

        // uvx present (no npx) → uvx plan, no bridge package.
        let uvx_agent = agent_with(
            "fast",
            RegistryDistribution {
                uvx: Some(RegistryUvx {
                    package: "fast-agent-acp==0.9.1".to_owned(),
                    args: vec![],
                }),
                ..Default::default()
            },
        );
        let plan = spawn_plan_for(&uvx_agent).expect("uvx plan");
        assert!(plan.bridge_npm_package.is_none());
        assert!(plan.spawn_cmd.contains("fast-agent-acp"));

        // No distribution at all → no plan.
        assert!(spawn_plan_for(&agent_with("empty", RegistryDistribution::default())).is_none());
    }

    #[test]
    fn registry_shell_metadata_with_metacharacters_is_rejected() {
        let agent = agent_with(
            "evil",
            RegistryDistribution {
                npx: Some(RegistryNpx {
                    package: "evil".to_owned(),
                    args: vec!["--ok".to_owned(), ";touch-pwned".to_owned()],
                    env: HashMap::new(),
                }),
                ..Default::default()
            },
        );
        assert!(spawn_plan_for(&agent).is_none());

        for arg in ["%PATH%", "^&whoami", "!COMSPEC!", "\"quoted\""] {
            let agent = agent_with(
                "evil",
                RegistryDistribution {
                    npx: Some(RegistryNpx {
                        package: "evil".to_owned(),
                        args: vec![arg.to_owned()],
                        env: HashMap::new(),
                    }),
                    ..Default::default()
                },
            );
            assert!(spawn_plan_for(&agent).is_none(), "accepted {arg:?}");
        }
    }

    #[test]
    fn direct_archive_resolves_only_for_the_host_platform() {
        // A binary map covering every platform key resolves on any host.
        let mut all_platforms = HashMap::new();
        for key in [
            "darwin-aarch64",
            "darwin-x86_64",
            "linux-aarch64",
            "linux-x86_64",
            "windows-x86_64",
        ] {
            all_platforms.insert(
                key.to_owned(),
                RegistryBinaryPlatform {
                    archive: format!("https://dl.example.com/{key}.tar.gz"),
                    cmd: "./goose".to_owned(),
                    args: vec!["--acp".to_owned()],
                },
            );
        }
        let agent = agent_with(
            "goose",
            RegistryDistribution {
                binary: Some(all_platforms),
                ..Default::default()
            },
        );
        let dist = direct_archive_for_agent(&agent).expect("host platform present");
        assert_eq!(dist.registry_id, "goose");
        assert!(dist.archive_url.ends_with(".tar.gz"));
        assert!(dist.install_dir.ends_with("runtimes/acp-agents/goose"));

        // The spawn command joins the resolved binary path with its args, and the
        // relative "./goose" is stripped of the leading "./".
        let cmd = spawn_cmd_for_direct_archive(&dist);
        assert!(cmd.contains("goose"));
        assert!(!cmd.contains("./goose"));
        assert!(cmd.contains("--acp"));

        // An empty binary map (no host key) → no direct archive.
        let none_agent = agent_with(
            "nobin",
            RegistryDistribution {
                binary: Some(HashMap::new()),
                ..Default::default()
            },
        );
        assert!(direct_archive_for_agent(&none_agent).is_none());
        // No binary block at all → no direct archive.
        assert!(
            direct_archive_for_agent(&agent_with("x", RegistryDistribution::default())).is_none()
        );
    }

    #[test]
    fn direct_archive_commands_cannot_escape_install_root() {
        let dist = DirectArchiveDist {
            registry_id: "evil".to_owned(),
            archive_url: "https://dl.example.com/evil.zip".to_owned(),
            cmd: "../../tmp/evil".to_owned(),
            args: Vec::new(),
            install_dir: PathBuf::from("/tmp/ryu/agents/evil"),
        };
        let command = spawn_cmd_for_direct_archive(&dist);
        assert!(command.contains("__invalid_registry_command__"));
        assert!(!command.contains("../../tmp/evil"));
    }

    #[test]
    fn spawn_falls_back_to_the_users_own_cli_when_the_archive_is_absent() {
        // A binary-distribution agent Ryu has NOT downloaded. This is the state a
        // self-installed agent is permanently in: `list_infos` reports it as
        // installed from `detect_binary` being on PATH, so it is selectable, while
        // nothing was ever written to `~/.ryu/agents/<id>`. Spawning the archive
        // path anyway is what left `opencode` with no session and no pickers.
        let missing_dir = tempfile::tempdir().expect("missing archive tempdir");
        let missing_opencode = missing_dir.path().join("agents").join("opencode");
        let dist = DirectArchiveDist {
            registry_id: "opencode".to_owned(),
            archive_url: "https://dl.example.com/opencode.zip".to_owned(),
            cmd: "./opencode".to_owned(),
            args: vec!["acp".to_owned()],
            install_dir: missing_opencode.clone(),
        };
        let cmd = spawn_cmd_for_direct_archive(&dist);
        // The registry's args ride along either way — only the program changes.
        assert!(cmd.ends_with(" acp"), "args must survive: {cmd}");
        // Which program is correct depends on the host, so assert the INVARIANT
        // rather than a machine-specific string: the spawn target agrees with the
        // same PATH probe that decides whether the agent is reported installed.
        // Those two disagreeing is the entire bug this covers.
        if crate::sidecar::adapters::acp::binary_in_path("opencode") {
            let expected = if cfg!(windows) {
                "cmd /c opencode acp"
            } else {
                "opencode acp"
            };
            assert_eq!(cmd, expected);
        } else {
            let missing_program = missing_opencode.to_string_lossy();
            assert!(
                cmd.contains(missing_program.as_ref()),
                "with no CLI on PATH the archive path is still the target: {cmd}"
            );
        }

        // An agent with no `underlying_cli_probe` row has no user-installed CLI to
        // fall back TO, so it keeps naming the archive path — the install flow is
        // the only way to make it runnable, and the error should say so.
        let missing_x = missing_dir.path().join("agents").join("x");
        let unknown = DirectArchiveDist {
            registry_id: "no-such-registry-agent".to_owned(),
            archive_url: "https://dl.example.com/x.zip".to_owned(),
            cmd: "./x".to_owned(),
            args: vec!["acp".to_owned()],
            install_dir: missing_x.clone(),
        };
        let missing_program = missing_x.to_string_lossy();
        assert!(
            spawn_cmd_for_direct_archive(&unknown).contains(missing_program.as_ref()),
            "no probe row ⇒ no fallback"
        );

        // And an archive Ryu HAS downloaded wins over anything on PATH: it is the
        // build Ryu pins and updates.
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin = tmp.path().join("opencode");
        std::fs::write(&bin, b"#!/bin/sh\n").expect("write stub");
        let installed = DirectArchiveDist {
            registry_id: "opencode".to_owned(),
            archive_url: "https://dl.example.com/opencode.zip".to_owned(),
            cmd: "./opencode".to_owned(),
            args: vec!["acp".to_owned()],
            install_dir: tmp.path().to_path_buf(),
        };
        assert_eq!(
            spawn_cmd_for_direct_archive(&installed),
            shell_wrap_npx(&format!("{} acp", bin.display())),
            "a present archive binary must win over PATH"
        );
    }

    #[test]
    fn gateway_bypass_only_false_for_codex_and_pi() {
        assert!(!registry_gateway_bypass("codex-acp"));
        assert!(!registry_gateway_bypass("pi-acp"));
        assert!(registry_gateway_bypass("gemini"));
        assert!(registry_gateway_bypass("claude-acp"));
        assert!(registry_gateway_bypass("goose"));
    }

    #[test]
    fn underlying_cli_probe_maps_known_agents_only() {
        assert_eq!(
            underlying_cli_probe("claude-acp"),
            Some(("claude", "@anthropic-ai/claude-code"))
        );
        assert_eq!(underlying_cli_probe("goose"), Some(("goose", "goose")));
        assert_eq!(
            underlying_cli_probe("cursor"),
            Some(("cursor-agent", "cursor-agent"))
        );
        assert_eq!(underlying_cli_probe("unknown-agent"), None);
    }

    #[test]
    fn registry_file_serde_round_trips_with_defaults() {
        // A minimal agent row with no icon/distribution deserializes (serde default).
        let raw = r#"{
            "version": "1",
            "agents": [
                { "id": "goose", "name": "Goose", "version": "1.0", "description": "d" }
            ]
        }"#;
        let file: RegistryFile = serde_json::from_str(raw).unwrap();
        assert_eq!(file.agents.len(), 1);
        let a = &file.agents[0];
        assert!(a.icon.is_none());
        assert!(a.distribution.npx.is_none());
        // Re-serialize and re-parse to confirm the round trip is stable.
        let back = serde_json::to_string(&file).unwrap();
        let again: RegistryFile = serde_json::from_str(&back).unwrap();
        assert_eq!(again.agents[0].id, "goose");
    }

    #[test]
    fn curated_override_ids_are_the_first_class_four() {
        assert!(CURATED_OVERRIDE_IDS.contains(&"claude-acp"));
        assert!(CURATED_OVERRIDE_IDS.contains(&"pi-acp"));
        assert!(CURATED_OVERRIDE_IDS.contains(&"kiro"));
        assert_eq!(CURATED_OVERRIDE_IDS.len(), 5);
    }
}
