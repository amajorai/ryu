//! Self-bootstrap: if the active node is a local loopback address and no Core is
//! answering there, resolve (or download) the `ryu-core` binary, spawn it bound to
//! that address, and wait for it to come up — the same "just works" behaviour the
//! desktop app gives (`apps/desktop/src-tauri/src/core/{install,process}.rs`), ported
//! to the headless CLI so `ryu-cli` alone brings a node online.
//!
//! It is a no-op when Core is already healthy, when the target is remote, or when
//! `RYU_CLI_NO_BOOTSTRAP` is set. Core self-exits if the bind address is already in
//! use, so a redundant spawn is harmless.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Public GitHub Releases base — same assets the desktop and one-line installer use.
const RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn ryu_bin_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ryu").join("bin"))
}

/// One of the headless binaries the CLI can bootstrap. Core spawns the Gateway
/// itself from `~/.ryu/bin`, so both must be present for the governed stack to work.
#[derive(Clone, Copy)]
enum Bin {
    Core,
    Gateway,
}

impl Bin {
    /// On-disk file name (with `.exe` on Windows).
    fn file_name(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Bin::Core, false) => "ryu-core",
            (Bin::Core, true) => "ryu-core.exe",
            (Bin::Gateway, false) => "ryu-gateway",
            (Bin::Gateway, true) => "ryu-gateway.exe",
        }
    }

    /// Env var that overrides binary resolution (matches Core's own lookup).
    fn env_override(self) -> &'static str {
        match self {
            Bin::Core => "RYU_CORE_BIN",
            Bin::Gateway => "RYU_GATEWAY_BIN",
        }
    }

    /// Release asset name for this platform, or `None` if unsupported (Intel Mac, ARM Linux).
    fn asset_name(self) -> Option<&'static str> {
        match (self, std::env::consts::OS, std::env::consts::ARCH) {
            (Bin::Core, "linux", "x86_64") => Some("ryu-core-linux-x86_64"),
            (Bin::Core, "macos", "aarch64") => Some("ryu-core-macos-aarch64"),
            (Bin::Core, "windows", "x86_64") => Some("ryu-core-windows-x86_64.exe"),
            (Bin::Gateway, "linux", "x86_64") => Some("ryu-gateway-linux-x86_64"),
            (Bin::Gateway, "macos", "aarch64") => Some("ryu-gateway-macos-aarch64"),
            (Bin::Gateway, "windows", "x86_64") => Some("ryu-gateway-windows-x86_64.exe"),
            _ => None,
        }
    }
}

/// `true` for loopback URLs we're allowed to bootstrap. Remote nodes are never spawned.
pub fn is_local(url: &str) -> bool {
    let host = host_port(url);
    host.starts_with("127.0.0.1")
        || host.starts_with("localhost")
        || host.starts_with("[::1]")
        || host.starts_with("0.0.0.0")
}

/// Strip scheme and any path, leaving `host:port` for `--bind=`.
fn host_port(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    after_scheme.split('/').next().unwrap_or(after_scheme).to_string()
}

/// Probe `GET {url}/api/health`; `true` on a 2xx within the timeout.
async fn is_healthy(url: &str, token: Option<&str>) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let mut req = client.get(format!("{url}/api/health"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    req.send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

/// Auto-detect an already-installed binary: `$RYU_*_BIN` → `~/.ryu/bin` → `$PATH`.
/// `None` means it's not installed anywhere we look.
fn resolve_binary(bin: Bin) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(bin.env_override()).map(PathBuf::from) {
        if p.exists() {
            return Some(p);
        }
    }
    let name = bin.file_name();
    if let Some(dir) = ryu_bin_dir() {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// Download a binary into `~/.ryu/bin` (temp file + atomic rename, chmod 0o755 on unix).
async fn download_binary(bin: Bin) -> anyhow::Result<PathBuf> {
    let asset = bin.asset_name().ok_or_else(|| {
        anyhow::anyhow!(
            "no prebuilt {} for {}-{} — build from source or install manually",
            bin.file_name(),
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let dir = ryu_bin_dir().ok_or_else(|| anyhow::anyhow!("could not resolve home directory"))?;
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(bin.file_name());
    let url = format!("{RELEASE_BASE}/{asset}");

    eprintln!("ryu: downloading {} ({asset})…", bin.file_name());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()?;
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("download {url}: HTTP {}", resp.status());
    }
    let bytes = resp.bytes().await?;

    // Temp path then rename, so an interrupted download never leaves a truncated
    // binary that looks installed.
    let tmp = dest.with_extension("download");
    std::fs::write(&tmp, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, &dest)?;
    Ok(dest)
}

/// Auto-detect, then download only if missing. Returns the resolved path.
async fn ensure_binary(bin: Bin) -> anyhow::Result<PathBuf> {
    match resolve_binary(bin) {
        Some(p) => Ok(p),
        None => download_binary(bin).await,
    }
}

/// Spawn Core bound to `host:port`, detached from the terminal, logging to
/// `~/.ryu/ryu-core.log`. The child is intentionally not held — Core keeps running
/// as the node after the CLI exits.
fn spawn_core(bin: &Path, bind: &str) -> anyhow::Result<()> {
    use std::process::{Command, Stdio};

    let (out, err) = match home_dir().map(|h| h.join(".ryu").join("ryu-core.log")) {
        Some(log) => match std::fs::OpenOptions::new().create(true).append(true).open(&log) {
            Ok(f) => match f.try_clone() {
                Ok(f2) => (Stdio::from(f), Stdio::from(f2)),
                Err(_) => (Stdio::null(), Stdio::null()),
            },
            Err(_) => (Stdio::null(), Stdio::null()),
        },
        None => (Stdio::null(), Stdio::null()),
    };

    let mut cmd = Command::new(bin);
    cmd.arg(format!("--bind={bind}"))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);

    // Detach into its own session so closing the CLI (and its terminal) doesn't
    // SIGHUP the node.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    // Not stored: dropping the Child does not kill it (std, unlike tokio's
    // kill_on_drop), so Core survives this process.
    cmd.spawn()?;
    Ok(())
}

/// Poll health until Core answers or `timeout` elapses.
async fn wait_healthy(url: &str, token: Option<&str>, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if is_healthy(url, token).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    false
}

/// Ensure a local Core is running at `url`, starting one if needed. Best-effort:
/// on any failure it logs to stderr and returns, leaving the caller to surface the
/// usual "core not running" path. No-op when Core is already up, the target is
/// remote, or `RYU_CLI_NO_BOOTSTRAP` is set.
pub async fn ensure_core(url: &str, token: Option<&str>) {
    if !is_local(url) {
        return;
    }
    if std::env::var_os("RYU_CLI_NO_BOOTSTRAP").is_some() {
        return;
    }
    if is_healthy(url, token).await {
        return;
    }

    let bin = match ensure_binary(Bin::Core).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ryu: could not install ryu-core: {e}");
            return;
        }
    };

    // Core spawns the Gateway itself from ~/.ryu/bin, so it must be installed too —
    // otherwise Core boots without the governance layer (routing/firewall/budgets).
    if let Err(e) = ensure_binary(Bin::Gateway).await {
        eprintln!("ryu: could not install ryu-gateway ({e}); Core will run without the Gateway");
    }

    let bind = host_port(url);
    eprintln!("ryu: starting ryu-core on {bind}…");
    if let Err(e) = spawn_core(&bin, &bind) {
        eprintln!("ryu: could not start ryu-core: {e}");
        return;
    }

    if !wait_healthy(url, token, Duration::from_secs(30)).await {
        eprintln!("ryu: ryu-core did not become healthy within 30s (see ~/.ryu/ryu-core.log)");
    }
}
