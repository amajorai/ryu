//! Managed child process for the Shadow sidecar.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use tokio::process::Command;

use crate::sidecar::tools::supervised_child::SupervisedChild;

// ── Paths ──────────────────────────────────────────────────────────────────────

fn shadow_dir() -> PathBuf {
    super::data_dir()
}

fn pid_path() -> PathBuf {
    shadow_dir().join("shadow.pid")
}

/// How long [`ShadowProcess::stop`] waits for Shadow to exit on its own before
/// killing it: Shadow's own stop deadline (20 s, `STOP_DEADLINE` in
/// `apps/shadow/src/server.rs`) plus a margin, so closing and encrypting the
/// open capture segments is never cut short by Core.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(25);

/// Ask the Shadow on `port` to stop over its bearer-gated `GET /stop`.
async fn request_http_stop(port: u16) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return;
    };
    let mut request = client.get(format!("http://127.0.0.1:{port}/stop"));
    if let Some(token) = super::api_token() {
        request = request.bearer_auth(token);
    }
    if let Err(error) = request.send().await {
        tracing::warn!("shadow: stop request failed: {error}");
    }
}

// ── ShadowProcess ──────────────────────────────────────────────────────────────

pub struct ShadowProcess {
    child: SupervisedChild,
    binary_path: PathBuf,
    port: u16,
}

impl ShadowProcess {
    pub fn new(binary_path: PathBuf, port: u16) -> Self {
        Self {
            child: SupervisedChild::new("shadow", pid_path()),
            binary_path,
            port,
        }
    }

    /// Spawn `shadow start` and begin forwarding its stdio to tracing.
    pub async fn start(&mut self) -> Result<()> {
        self.child.begin_start(&self.binary_path).await;

        let mut command = Command::new(&self.binary_path);
        command.args(["start", "--port", &self.port.to_string()]);
        Self::apply_llm_env(&mut command);
        // Isolate Shadow's on-disk state per profile: `services/shadow` and
        // `models/vision/shadow` under the profile-aware data dir, so a dev and a
        // release Shadow never share — and thus never corrupt — each other's memory /
        // timeline / search-index DBs. Shadow reads both (apps/shadow/src/paths.rs);
        // an operator-exported `SHADOW_DATA_DIR` wins via `super::data_dir`.
        command
            .env("RYU_DIR", crate::paths::ryu_dir())
            .env("SHADOW_DATA_DIR", super::data_dir())
            .env("SHADOW_MODELS_DIR", super::models_dir());
        if std::env::var_os("RYU_CORE_URL").is_none() {
            command.env(
                "RYU_CORE_URL",
                format!("http://127.0.0.1:{}", crate::profile::port(7980)),
            );
        }
        // The optional Laya planner calls this node's authenticated extension
        // proxy. Shadow is a trusted first-party child, so give it the current
        // in-memory node bearer explicitly; runtime token rotation need not rely
        // on the parent's startup environment snapshot.
        if let Some(token) = crate::node_token::active_token() {
            command.env("RYU_TOKEN", token);
        }
        // Shadow reads this credential only for its explicitly selected Jev
        // planner. Keep it in Core's encrypted plugin-secret store; never copy
        // it into Shadow's JSON settings file or return it through the API.
        if std::env::var_os("SHADOW_JEV_API_KEY").is_none() {
            if let Some(secrets) = crate::plugin_secrets::global() {
                match secrets.get("@ryu/shadow", "SHADOW_JEV_API_KEY").await {
                    Ok(Some(key)) if !key.trim().is_empty() => {
                        command.env("SHADOW_JEV_API_KEY", key);
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(
                        "shadow: Jev credential could not be loaded from encrypted storage: {error:#}"
                    ),
                }
            }
        }
        // Shared-secret bearer for Shadow's HTTP surface (apps/shadow/src/server.rs
        // gates everything except /health): read-or-create the persisted token and
        // inject it so the spawned Shadow and Core's clients (`sidecar/mcp/shadow`,
        // `ShadowManager::stop`) always agree — even when an operator overrode
        // `SHADOW_DATA_DIR`. An operator-exported `SHADOW_API_TOKEN` wins (Shadow
        // prefers the env var too).
        if std::env::var_os("SHADOW_API_TOKEN").is_none() {
            match super::ensure_api_token() {
                Ok(token) => {
                    command.env("SHADOW_API_TOKEN", token);
                }
                Err(e) => tracing::warn!(
                    "shadow: could not prepare the API token (Shadow's gated routes will fail closed): {e}"
                ),
            }
        }
        // Shadow's own component subkey (HKDF of the master key, never the master
        // key). Shadow seals its capture log, indexes, side databases and media
        // with it; without it Shadow refuses capture writes (never plaintext).
        if let Err(error) = apply_seal_env(&mut command) {
            tracing::warn!(
                "shadow: no seal key for the child ({error}); capture stays off until the key is available"
            );
        }

        self.child
            .spawn(
                &mut command,
                |line| tracing::info!(target: "shadow", "{line}"),
                |line| tracing::warn!(target: "shadow", "{line}"),
            )
            .await
    }

    /// Point Shadow's LLM egress at the governed Gateway instead of its own
    /// built-in default (Ollama on `localhost:11434`, absent on a fresh
    /// install). Shadow reads `SHADOW_LLM_{BASE_URL,MODEL,API_KEY}`
    /// (`apps/shadow/src/config.rs`) and calls `{base_url}/chat/completions`,
    /// so we append `/v1`: every Shadow LLM path then flows through the same
    /// firewall/budget/audit as Core's own chat. node-config.json
    /// `settings.shadow.{llmBaseUrl,llmModel}` (`RYU_SHADOW_LLM_*`) override
    /// that; an inherited `SHADOW_LLM_*` still wins (BYO). A `llmBaseUrl` from
    /// the file never receives the Gateway token.
    fn apply_llm_env(command: &mut Command) {
        let set = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let custom_url = std::env::var_os("SHADOW_LLM_BASE_URL").is_none()
            && set("RYU_SHADOW_LLM_BASE_URL").is_some();
        if std::env::var_os("SHADOW_LLM_BASE_URL").is_none() {
            let base_url = set("RYU_SHADOW_LLM_BASE_URL").unwrap_or_else(|| {
                let gateway = crate::sidecar::gateway::gateway_url();
                format!("{}/v1", gateway.trim_end_matches('/'))
            });
            command.env("SHADOW_LLM_BASE_URL", base_url);
        }
        if std::env::var_os("SHADOW_LLM_MODEL").is_none() {
            // `default` mirrors Core's own OpenAI-compat chat; the gateway
            // router maps it to the active local engine.
            let model = set("RYU_SHADOW_LLM_MODEL").unwrap_or_else(|| "default".to_owned());
            command.env("SHADOW_LLM_MODEL", model);
        }
        if !custom_url && std::env::var_os("SHADOW_LLM_API_KEY").is_none() {
            if let Some(token) = crate::sidecar::gateway::gateway_token() {
                command.env("SHADOW_LLM_API_KEY", token);
            }
        }
    }

    /// Gracefully stop the process: SIGTERM (Unix) or the bearer-gated
    /// `GET /stop` (Windows, which has no SIGTERM), then wait up to
    /// [`STOP_GRACE`] before a hard kill. Shadow closes capture first on a stop
    /// request, writing and encrypting the open microphone and screen-video
    /// segments; killing it early would leave the open video segment
    /// unencrypted until the next start and lose the buffered audio.
    pub async fn stop(&mut self) -> Result<()> {
        self.child
            .stop_within(STOP_GRACE, Some(request_http_stop(self.port)))
            .await
    }

    /// Returns true if the child process is still alive.
    pub fn is_running(&mut self) -> bool {
        self.child.is_running()
    }

    /// OS process id of the live child, when this process spawned one.
    pub fn pid(&mut self) -> Option<u32> {
        self.child.pid()
    }

    /// Stop a leftover process recorded in the PID file, but only while it is
    /// still this binary's own orphan (the PID may have been reused since).
    pub async fn cleanup_orphan(&self) {
        self.child.cleanup_orphan(&self.binary_path).await;
    }
}

// ── Listener ownership ─────────────────────────────────────────────────────────

/// Whether every TCP listener that serves `127.0.0.1:<port>` belongs to `pid`.
///
/// Used only for a Shadow child this Core spawned whose binary predates the
/// loopback peer challenge: the listener's owner, not a health response, is the
/// evidence that the port holds that child. Linux reads `/proc`, macOS asks
/// `lsof`. Other platforms return `false` (fail closed), so an old binary there
/// must be updated before Core sends it the token.
pub(super) async fn loopback_listener_owned_by(pid: u32, port: u16) -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(table) = tokio::fs::read_to_string("/proc/net/tcp").await else {
            return false;
        };
        let inodes = loopback_listen_inodes(&table, port);
        if inodes.is_empty() {
            return false;
        }
        let Ok(mut fds) = tokio::fs::read_dir(format!("/proc/{pid}/fd")).await else {
            return false;
        };
        let mut owned = std::collections::HashSet::new();
        while let Ok(Some(entry)) = fds.next_entry().await {
            if let Ok(target) = tokio::fs::read_link(entry.path()).await {
                if let Some(inode) = socket_inode(&target.to_string_lossy()) {
                    owned.insert(inode);
                }
            }
        }
        inodes.iter().all(|inode| owned.contains(inode))
    }
    #[cfg(target_os = "macos")]
    {
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            Command::new("/usr/sbin/lsof")
                .args([
                    "-nP",
                    &format!("-iTCP@127.0.0.1:{port}"),
                    "-sTCP:LISTEN",
                    "-Fp",
                ])
                .env_clear()
                .kill_on_drop(true)
                .output(),
        )
        .await;
        matches!(result, Ok(Ok(output)) if output.status.success()
            && crate::sidecar::process::listener_pid_matches(&output.stdout, pid))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (pid, port);
        false
    }
}

/// Socket inodes of the IPv4 listeners in a `/proc/net/tcp` table that accept
/// connections to `127.0.0.1:<port>` (bound to `127.0.0.1` or `0.0.0.0`).
#[cfg(any(target_os = "linux", test))]
fn loopback_listen_inodes(table: &str, port: u16) -> Vec<u64> {
    const TCP_LISTEN: &str = "0A";
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (local, state, inode) = (fields.get(1)?, fields.get(3)?, fields.get(9)?);
            if *state != TCP_LISTEN {
                return None;
            }
            let (address, local_port) = local.split_once(':')?;
            if u16::from_str_radix(local_port, 16).ok()? != port {
                return None;
            }
            // The kernel prints the address as the in-memory (network order) u32
            // in host-endian hex, so reading it back with native endianness
            // recovers the octets.
            let octets = u32::from_str_radix(address, 16).ok()?.to_ne_bytes();
            if octets != [127, 0, 0, 1] && octets != [0, 0, 0, 0] {
                return None;
            }
            inode.parse().ok()
        })
        .collect()
}

/// The inode of a `/proc/<pid>/fd/*` link target such as `socket:[12345]`.
#[cfg(any(target_os = "linux", test))]
fn socket_inode(link_target: &str) -> Option<u64> {
    link_target
        .strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// Give the shadow child its component subkey and nothing else: every
/// key-carrying variable inherited from Core (`RYU_MASTER_KEY` above all) is
/// removed first, so the child's initial environment block, which stays in
/// `/proc/<pid>/environ` whatever it later unsets, never holds the master key.
fn apply_seal_env(command: &mut Command) -> anyhow::Result<()> {
    for name in ryu_crypto::SEAL_ENV_VARS {
        command.env_remove(name);
    }
    command.envs(ryu_crypto::component_child_env(
        ryu_crypto::components::SHADOW,
    )?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::tools::supervised_child::ProcessState;

    #[test]
    fn proc_net_tcp_parsing_finds_only_loopback_listeners_on_the_port() {
        // 127.0.0.1 and 0.0.0.0 in /proc's host-endian hex.
        let loopback = format!("{:08X}", u32::from_ne_bytes([127, 0, 0, 1]));
        let any = "00000000";
        let other = format!("{:08X}", u32::from_ne_bytes([10, 0, 0, 5]));
        let table = format!(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
             0: {loopback}:0BD6 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0\n\
             1: {any}:0BD6 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 222 1 0 100 0 0 10 0\n\
             2: {other}:0BD6 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 100 0 0 10 0\n\
             3: {loopback}:0BD6 {loopback}:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0 100 0 0 10 0\n\
             4: {loopback}:0FBE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0 100 0 0 10 0\n"
        );
        // Port 0x0BD6 = 3030: the loopback and wildcard listeners, not the
        // other-interface listener, the established socket, or port 4030.
        assert_eq!(loopback_listen_inodes(&table, 3030), vec![111, 222]);
        assert_eq!(loopback_listen_inodes(&table, 4030), vec![555]);
        assert!(loopback_listen_inodes(&table, 9).is_empty());
        assert!(loopback_listen_inodes("garbage", 3030).is_empty());
    }

    #[test]
    fn socket_inode_parses_only_socket_links() {
        assert_eq!(socket_inode("socket:[12345]"), Some(12345));
        assert_eq!(socket_inode("pipe:[12345]"), None);
        assert_eq!(socket_inode("/dev/null"), None);
        assert_eq!(socket_inode("socket:[x]"), None);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn listener_ownership_matches_this_process_only() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(loopback_listener_owned_by(std::process::id(), port).await);
        // PID 1 (init) does not own this test's listener.
        assert!(!loopback_listener_owned_by(1, port).await);
        drop(listener);
        assert!(!loopback_listener_owned_by(std::process::id(), port).await);
    }

    /// Core keeps `RYU_MASTER_KEY` in its own environment (headless setups);
    /// the shadow child must start with that variable removed and only its
    /// component subkey and scope set.
    #[test]
    fn child_env_drops_the_master_key_and_carries_only_the_subkey() {
        crate::server::gateway_seal_test_key();
        let master = std::env::var("RYU_MASTER_KEY").expect("test master key set");
        let mut command = Command::new("/bin/true");
        apply_seal_env(&mut command).expect("a key is available");
        let envs: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("RYU_MASTER_KEY"),
            Some(&None),
            "RYU_MASTER_KEY must be removed from the child"
        );
        assert_eq!(
            envs.get("RYU_SEAL_SCOPE"),
            Some(&Some("component:shadow".to_owned()))
        );
        let subkey = envs
            .get("RYU_SEAL_KEY")
            .cloned()
            .flatten()
            .expect("subkey delivered");
        assert_ne!(subkey, master);
        assert!(envs
            .values()
            .flatten()
            .all(|value| !value.contains(&master)));
    }

    // Only pure state-machine defaults and path helpers are covered here.
    // `start`/`stop` spawn or signal real processes and are not exercised in a
    // unit test; the orphan identity checks are covered in
    // `sidecar::tools::orphan`.

    #[test]
    fn new_starts_in_stopped_state_and_keeps_port() {
        let mut proc = ShadowProcess::new(PathBuf::from("/bin/shadow"), 7994);
        assert_eq!(proc.child.state(), &ProcessState::Stopped);
        assert_eq!(proc.port, 7994);
        // No child spawned: not running, state untouched.
        assert!(!proc.is_running());
        assert_eq!(proc.child.state(), &ProcessState::Stopped);
    }

    #[test]
    fn pid_path_lives_under_the_shadow_dir() {
        let path = pid_path();
        assert!(path.ends_with("shadow.pid"));
        assert_eq!(path.parent().unwrap(), shadow_dir());
        assert!(shadow_dir().ends_with("shadow"));
    }

    #[test]
    fn stop_grace_outlasts_shadows_own_stop_deadline() {
        // Shadow allows itself 20 s to close and encrypt its open capture
        // segments; Core must not kill it before that.
        assert!(STOP_GRACE >= Duration::from_secs(25));
    }

    /// A Shadow that takes longer than the old 5 s to close capture after
    /// SIGTERM is waited for, not killed (which would leave the open video
    /// segment unencrypted).
    #[cfg(unix)]
    #[tokio::test]
    async fn stop_waits_for_a_slow_graceful_exit() {
        let child = Command::new("sh")
            .args([
                "-c",
                "trap 'sleep 6; exit 0' TERM; while :; do sleep 0.1; done",
            ])
            .spawn()
            .expect("spawn sh");
        let mut proc = ShadowProcess::new(PathBuf::from("/bin/sh"), 1);
        proc.child = SupervisedChild::new(
            "shadow",
            std::env::temp_dir().join(format!("shadow-stop-{}.pid", std::process::id())),
        );
        proc.child.adopt_for_test(child);
        // Let the shell install its trap.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = std::time::Instant::now();
        proc.stop().await.unwrap();
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(5_500),
            "killed after {elapsed:?}"
        );
        assert!(elapsed < STOP_GRACE, "{elapsed:?}");
        assert_eq!(proc.child.state(), &ProcessState::Stopped);
    }
}
