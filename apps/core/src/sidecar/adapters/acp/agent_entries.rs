use super::*;

/// A single fallback provider entry in the default-agent recovery chain.
/// Returned by [`AcpAgentRegistry::fallback_chain_for_default`].
#[derive(Debug, Clone)]
pub struct FallbackProvider {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub enum AgentTransport {
    Acp {
        spawn_cmd: String,
    },
    OpenAiCompat {
        base_url: &'static str,
        model: Option<&'static str>,
    },
}

#[derive(Debug, Clone)]
pub struct AcpAgentEntry {
    pub id: String,
    /// Official ACP registry id (e.g. `claude-acp`), when this agent comes from the CDN catalog.
    pub registry_id: Option<String>,
    pub name: String,
    pub description: String,
    /// Binary name to probe in PATH; `None` for always-available agents.
    pub detect_binary: Option<&'static str>,
    /// User-facing install instructions shown when binary not found.
    pub install_hint: String,
    pub transport: AgentTransport,
    /// True for the single recommended/flagship agent (currently "ryu").
    pub recommended: bool,
    pub gateway_bypass: bool,
    /// GitHub-release archive spec (legacy goose path via `archive_agent`).
    pub archive_spec: Option<crate::sidecar::agents::archive_agent::ArchiveAgentSpec>,
    /// Registry `binary` distribution — full archive extracted under `~/.ryu/agents/<id>`.
    pub direct_archive: Option<crate::sidecar::agents::acp_registry::DirectArchiveDist>,
    /// Latest bridge version from the official ACP registry CDN.
    pub bridge_version: Option<String>,
    /// Brand icon URL (ACP registry CDN or curated local default).
    pub icon_url: Option<String>,
    pub version_probe: Option<AgentVersionProbe>,
}

#[derive(Debug, Clone)]
pub struct AgentVersionProbe {
    /// Underlying agent CLI binary (`claude`, `codex`, …).
    pub binary: Option<&'static str>,
    /// npm package for the underlying agent CLI.
    pub npm_package: Option<String>,
    /// npm package for the ACP bridge/wrapper (unpinned name).
    pub bridge_npm_package: Option<String>,
}

pub fn parse_cli_version(output: &str) -> Option<String> {
    static VERSION_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = VERSION_RE.get_or_init(|| {
        regex::Regex::new(r"\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b")
            .expect("valid CLI version regex")
    });
    re.captures(output)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().to_owned())
}

pub async fn probe_cli_version(binary: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args(["/c", binary, "--version"]).no_window();
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("--version").no_window();
        cmd
    };

    let output = tokio::time::timeout(
        Duration::from_secs(4),
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok)?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_cli_version(&combined)
}

/// A content-free description of one JSON-RPC frame for TRACE logs: its
/// method, id and byte length (never params, results or errors).
pub(super) fn acp_frame_summary(line: &str) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(line).ok();
    let method = parsed
        .as_ref()
        .and_then(|frame| frame.get("method"))
        .and_then(serde_json::Value::as_str)
        .filter(|method| {
            method.len() <= 64
                && method
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | '$'))
        })
        .unwrap_or("-");
    let id = parsed
        .as_ref()
        .and_then(|frame| frame.get("id"))
        .map(|id| match id {
            serde_json::Value::Number(number) => number.to_string(),
            serde_json::Value::String(text) if text.len() <= 64 => {
                crate::log_rotation::redact_log_text(text).into_owned()
            }
            _ => "-".to_owned(),
        })
        .unwrap_or_else(|| "-".to_owned());
    let kind = match parsed.as_ref() {
        None => "unparsed",
        Some(frame) if frame.get("error").is_some() => "error",
        Some(frame) if frame.get("result").is_some() => "result",
        Some(frame) if frame.get("method").is_some() && frame.get("id").is_some() => "request",
        Some(_) => "notification",
    };
    format!("{kind} method={method} id={id} bytes={}", line.len())
}

/// [`probe_cli_version`] behind a cache keyed by the binary's resolved path and
/// its size and modification time.
///
/// Each probe spawns the CLI (`cmd /c claude --version` on Windows), which costs
/// hundreds of milliseconds for a Node CLI, and the agent catalog probes every
/// installed agent each time it opens. Reinstalling or upgrading the CLI replaces
/// the file behind its path, which changes the key, so a cached version never
/// outlives the binary it came from. Entries also expire after ten minutes as a
/// backstop. Paths that need the live answer (the update flow's before/after
/// check) call [`probe_cli_version`] directly.
pub async fn probe_cli_version_cached(binary: &str) -> Option<String> {
    type Key = (std::path::PathBuf, u64, Option<std::time::SystemTime>);
    type Entry = (Key, std::time::Instant, String);
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, Entry>>> =
        OnceLock::new();
    const TTL: Duration = Duration::from_secs(600);

    let Some(path) = resolve_in_path(binary) else {
        return probe_cli_version(binary).await;
    };
    let meta = std::fs::metadata(&path).ok();
    let key: Key = (
        path,
        meta.as_ref().map_or(0, std::fs::Metadata::len),
        meta.as_ref().and_then(|m| m.modified().ok()),
    );
    let cache = CACHE.get_or_init(Default::default);
    if let Ok(entries) = cache.lock() {
        if let Some((cached_key, at, version)) = entries.get(binary) {
            if *cached_key == key && at.elapsed() < TTL {
                return Some(version.clone());
            }
        }
    }
    // A failed or timed-out probe is not cached, so the next open retries it.
    let version = probe_cli_version(binary).await?;
    if let Ok(mut entries) = cache.lock() {
        entries.insert(
            binary.to_owned(),
            (key, std::time::Instant::now(), version.clone()),
        );
    }
    Some(version)
}

/// Returns `true` if `binary` resolves to an executable file anywhere in `PATH`.
pub fn binary_in_path(binary: &str) -> bool {
    let path_var = match std::env::var("PATH") {
        Ok(v) => v,
        Err(_) => return false,
    };
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(format!("{binary}{ext}"));
        if candidate.is_file() {
            return true;
        }
        // Also try without extension on Windows in case shim has no ext
        if cfg!(target_os = "windows") && dir.join(binary).is_file() {
            return true;
        }
    }
    false
}

/// Resolve `binary` to its real on-disk path by walking `PATH` and following
/// symlinks.
///
/// `binary_in_path` answers *whether* a CLI is installed; this answers *which
/// install owns it*, which is what decides whether Ryu can upgrade it. A global
/// npm install lands as `<prefix>/bin/x` symlinked into `lib/node_modules/...`,
/// so a resolved path containing a `node_modules` component is npm-managed and
/// `npm install -g <pkg>@latest` upgrades it. Anything else (a vendor's own
/// installer, homebrew, volta/mise, a curl script) is not ours to move.
pub fn resolve_in_path(binary: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    for dir in std::env::split_paths(&path_var) {
        for candidate in [dir.join(format!("{binary}{ext}")), dir.join(binary)] {
            if candidate.is_file() {
                return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
            }
        }
    }
    None
}
