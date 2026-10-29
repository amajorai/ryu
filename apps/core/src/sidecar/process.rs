use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use anyhow::Result;

use crate::win_process::NoWindow;

/// Shared process lifecycle handle used by all sidecar managers.
///
/// Wraps an optional child process and an atomic running flag so that
/// `stop()` and `is_running()` can be delegated consistently without
/// each manager reimplementing the same pattern.
#[derive(Clone)]
pub struct ProcessHandle {
    running: Arc<AtomicBool>,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
    /// Serializes async start/stop transitions. `is_running()` is synchronous and
    /// cannot hold this lock, so every async transition re-checks liveness after
    /// acquiring it before spawning or taking the child.
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    /// The Job Object containing an OS-isolated child (Windows, `enforce` mode
    /// only). Dropping it on `stop` terminates the whole process tree.
    #[cfg(windows)]
    job: Arc<Mutex<Option<ryu_sandbox::os_isolation::JobGuard>>>,
}

impl ProcessHandle {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(windows)]
            job: Arc::new(Mutex::new(None)),
        }
    }

    /// Spawn `binary` with no extra arguments.
    pub async fn start(&self, binary: &Path) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(binary);
        command.kill_on_drop(true).no_window();
        remove_seal_env(&mut command);
        let child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", binary.display()))?;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Spawn `binary` with additional CLI arguments.
    pub async fn start_with_args(&self, binary: &Path, args: &[&'static str]) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(binary);
        command.args(args).kill_on_drop(true).no_window();
        remove_seal_env(&mut command);
        let child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", binary.display()))?;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Spawn a command resolved by name (via PATH) with owned string args.
    ///
    /// Unlike [`start_with_args`], the program is a `&str` resolved through the
    /// OS `PATH` (which includes `~/.ryu/bin`), and arguments are owned
    /// `String`s rather than `'static` literals. The child inherits the current
    /// process environment so configuration (e.g. provider credentials) flows
    /// through.
    pub async fn start_path_with_args(&self, program: &str, args: &[String]) -> Result<()> {
        self.start_path_with_env(program, args, &[]).await
    }

    /// Spawn a PATH-resolved command with owned args plus extra environment
    /// variables layered on top of the inherited environment.
    ///
    /// The child still inherits the current process environment; `env` entries
    /// override or add to it. This is how Core points the gateway at the active
    /// local engine (e.g. `LOCAL_LLM_URL`) without mutating Core's own process
    /// env (U19).
    pub async fn start_path_with_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true).no_window();
        // The child inherits Core's environment, but never its sealing keys:
        // with `RYU_MASTER_KEY` set (the headless/server setup) an inherited
        // copy would hand every sidecar the master key. A child that needs a
        // key gets its own scoped subkey through `env`, layered after this.
        remove_seal_env(&mut command);
        for (key, value) in env {
            command.env(key, value);
        }
        let child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {program}: {e}"))?;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Like [`ProcessHandle::start_path_with_args`], but pipes the child's stderr:
    /// each line is forwarded to tracing (tagged with `label`) and kept in `tail`
    /// so a readiness probe can report why a child died during startup.
    pub async fn start_path_with_args_capturing_stderr(
        &self,
        program: &str,
        args: &[String],
        label: &'static str,
        tail: crate::sidecar::providers::readiness::StderrTail,
    ) -> Result<()> {
        use tokio::io::AsyncBufReadExt;

        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .kill_on_drop(true)
            .no_window()
            .stderr(std::process::Stdio::piped());
        remove_seal_env(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {program}: {e}"))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "ryu_core::sidecar::stderr", sidecar = label, "{line}");
                    tail.push(&line);
                }
            });
        }
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Like [`ProcessHandle::start_path_with_env`] but the child does NOT inherit
    /// Core's full environment: it starts from a `env_clear()`ed command seeded
    /// with a SCRUBBED copy of the parent env (secret-like keys dropped via
    /// [`crate::sidecar::env_scrub::scrub_child_env`]), then layers `env` on top.
    ///
    /// Used as defense-in-depth for gateway and manifest-owned children,
    /// where the child must never inherit provider keys from Core's own process
    /// env. `env_clear()` before seeding is load-bearing — without it the child
    /// keeps the full inherited env and the scrub is a no-op.
    pub async fn start_path_with_scrubbed_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true).no_window();
        command.env_clear();
        for (key, value) in crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]) {
            command.env(key, value);
        }
        remove_seal_env(&mut command);
        for (key, value) in env {
            command.env(key, value);
        }
        let child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {program}: {e}"))?;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Like [`ProcessHandle::start_path_with_scrubbed_env`], but detaches all
    /// standard streams from the child.
    ///
    /// Some adopted tools print bearer-like connection material to stderr as
    /// part of normal startup. A caller that already has a structured status
    /// channel must not inherit that output into Core's logs, so it can choose
    /// this variant while retaining the same secret-scrubbed environment.
    pub async fn start_path_with_scrubbed_env_quiet(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .kill_on_drop(true)
            .no_window()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command.env_clear();
        for (key, value) in crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]) {
            command.env(key, value);
        }
        remove_seal_env(&mut command);
        for (key, value) in env {
            command.env(key, value);
        }
        let child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {program}: {e}"))?;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Spawn a PATH-resolved command with a MINIMAL env: the child does NOT inherit
    /// Core's environment at all. It starts from an `env_clear()`ed command seeded
    /// with ONLY the small benign allow-list
    /// ([`crate::sidecar::env_scrub::mcp_safe_env`]: PATH/HOME/Windows essentials +
    /// `XDG_*`), then layers the explicit `env` on top.
    ///
    /// This is the containment for the experimental node extension host: a
    /// third-party JS backend must never see Core's `RYU_TOKEN` (the per-plugin
    /// ext-token seed), `RYU_MASTER_KEY`, or any provider API key — inheriting
    /// `RYU_TOKEN` alone would let it forge every other plugin's ext-token. The
    /// allow-list is stricter than the deny-list scrub used for the gateway child
    /// because the node host declares its own env explicitly (the reserved
    /// `RYU_EXT_*`/`RYU_HOST_*`/`RYU_DIR`/`RYU_CORE_PORT` contract in `env`), so it
    /// needs nothing else from the parent. `env_clear()` before seeding is
    /// load-bearing — without it the child keeps the full inherited env.
    pub async fn start_path_with_clean_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<()> {
        self.start_clean_env_inner(program, args, env, false, None)
            .await
    }

    /// [`Self::start_path_with_clean_env`] plus the conservative per-process
    /// resource limits of [`apply_sidecar_rlimits`] (Unix only). Used for
    /// manifest-declared (plugin-owned) native sidecars, which otherwise run with
    /// no OS-level restriction at all. This is NOT a sandbox — see
    /// `docs/native-sidecar-resource-limits.md` for what remains unenforced.
    pub async fn start_path_with_clean_env_limited(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<()> {
        self.start_clean_env_inner(program, args, env, true, None)
            .await
    }

    /// [`Self::start_path_with_clean_env_limited`] under an OS isolation launch
    /// prepared by [`ryu_sandbox::os_isolation::prepare`]: the program/args come
    /// from `isolation` (on macOS, the Seatbelt launcher wrapping the original
    /// command), the Linux Landlock + `no_new_privs` hook runs after the rlimit
    /// hook, and on Windows the child is placed in a kill-on-close Job Object.
    /// An inactive launch (`off`/`audit`) spawns exactly as the limited variant.
    pub async fn start_path_with_clean_env_isolated(
        &self,
        env: &[(String, String)],
        isolation: &ryu_sandbox::os_isolation::PreparedIsolation,
    ) -> Result<()> {
        let program = isolation.program().to_owned();
        let args = isolation.args().to_vec();
        self.start_clean_env_inner(&program, &args, env, true, Some(isolation))
            .await
    }

    async fn start_clean_env_inner(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
        resource_limits: bool,
        isolation: Option<&ryu_sandbox::os_isolation::PreparedIsolation>,
    ) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true).no_window();
        #[cfg(unix)]
        if resource_limits {
            // SAFETY: the closure runs in the forked child before `exec` and only
            // issues `getrlimit`/`setrlimit` syscalls (async-signal-safe); it
            // allocates nothing and touches no locks.
            unsafe {
                command.pre_exec(|| {
                    apply_sidecar_rlimits();
                    Ok(())
                });
            }
        }
        #[cfg(not(unix))]
        let _ = resource_limits;
        // Registered after the rlimit hook so the limits are set before the
        // process loses the privilege to change them.
        #[cfg(target_os = "linux")]
        if let Some(isolation) = isolation {
            isolation.install_pre_exec(&mut command);
        }
        command.env_clear();
        for (key, value) in crate::sidecar::env_scrub::mcp_safe_env(std::env::vars()) {
            command.env(key, value);
        }
        remove_seal_env(&mut command);
        for (key, value) in env {
            command.env(key, value);
        }
        let child = command
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {program}: {e}"))?;
        #[cfg(windows)]
        if let Some(isolation) = isolation {
            match isolation.contain(&child) {
                Ok(job) => *self.job.lock().unwrap() = job,
                Err(e) => {
                    let mut child = child;
                    let _ = child.start_kill();
                    return Err(anyhow::anyhow!(
                        "failed to place {program} in a Job Object: {e}"
                    ));
                }
            }
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        let _ = isolation;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        let child = { self.child.lock().unwrap().take() };
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
        #[cfg(windows)]
        {
            self.job.lock().unwrap().take();
        }
        self.running.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Stop the child cooperatively: SIGTERM first (Unix), wait up to `grace`
    /// for it to exit — so it can drain and flush buffered telemetry — then
    /// SIGKILL. On other platforms this is [`Self::stop`].
    pub async fn stop_graceful(&self, grace: std::time::Duration) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        let child = { self.child.lock().unwrap().take() };
        if let Some(mut c) = child {
            #[cfg(unix)]
            if let Some(pid) = c.id().and_then(|pid| i32::try_from(pid).ok()) {
                use nix::sys::signal::{kill, Signal};
                use nix::unistd::Pid;
                if kill(Pid::from_raw(pid), Signal::SIGTERM).is_ok()
                    && tokio::time::timeout(grace, c.wait()).await.is_ok()
                {
                    self.running.store(false, Ordering::Relaxed);
                    return Ok(());
                }
            }
            #[cfg(not(unix))]
            let _ = grace;
            let _ = c.kill().await;
        }
        self.running.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Whether this handle's process is alive **right now** — the flag AND, when we
    /// hold a child, a non-blocking `try_wait` that asks the OS.
    ///
    /// # Why the flag alone was a security bug
    ///
    /// `running` is set `true` by every `start_*` and set `false` only by
    /// [`Self::stop`]. Nothing polls the child, so a sidecar whose process OOMed or
    /// was `kill -9`ed stayed `running: true` forever while its OS port went free.
    /// The manager's [`forward_target`] gates on exactly this predicate, so it would
    /// keep answering `Ok(port)` and the ext proxy would stamp the plugin's minted
    /// `RYU_EXT_TOKEN` onto a request aimed at whatever local process had since
    /// bound the vacated port. `try_wait` costs one `waitpid(WNOHANG)` and removes
    /// the whole class: a dead child can no longer masquerade as a live one.
    ///
    /// # The adopt-mode invariant: `child == None` ⇒ still running
    ///
    /// **Only ever downgrade when a child is held and has exited.** Several managers
    /// legitimately reach `running == true` with no resident child — the adopt-mode
    /// sidecars (whisper/sdcpp/ryutts/research) point at an already-running external
    /// server they did not spawn, and [`Self::pid`]'s own contract documents that
    /// shape. Polling is meaningless there, so the flag is the only evidence we have
    /// and it is trusted. Without this arm, changing this one method would silently
    /// declare every adopted server dead.
    ///
    /// # `try_wait` errors fail CLOSED here and OPEN in [`Self::has_exited`]
    ///
    /// A transient `Err` from the wait syscall is not proof of death, but it is also
    /// not proof of life. So it reads as "not running" (refuse to forward — the
    /// conservative side of a security gate) while [`Self::has_exited`] stays `false`
    /// (no durable crash record, monitor keeps polling). Collapsing the two onto one
    /// answer would either forward into the dark or brand a live sidecar permanently
    /// crashed on a one-off `EINTR`.
    ///
    /// [`forward_target`]: crate::sidecar::SidecarManager::forward_target
    pub fn is_running(&self) -> bool {
        if !self.running.load(Ordering::Relaxed) {
            return false;
        }
        // `try_wait` needs `&mut Child`; the `&mut` comes from the existing mutex
        // guard, so the `&self` signature (and the `Sidecar` trait) is unchanged.
        let mut child = self.child.lock().unwrap();
        match child.as_mut() {
            // Adopt mode — see the invariant above.
            None => true,
            Some(c) => matches!(c.try_wait(), Ok(None)),
        }
    }

    /// Whether a child we spawned is held **and** has already exited — i.e. this
    /// process died on its own rather than being stopped.
    ///
    /// Deliberately NOT `!is_running()`: [`Self::stop`] *takes* the child, so after a
    /// deliberate stop (plugin disable, idle scale-to-zero) `child` is `None` and this
    /// is `false`. That is the whole point — it separates a crash, which deserves a
    /// durable reason on `/api/sidecar/status` and must cancel the health monitor
    /// (whose probe hands the port holder `RYU_EXT_TOKEN` every 30s), from a routine
    /// scale-to-zero, which deserves neither. `!is_running()` cannot tell them apart.
    pub fn has_exited(&self) -> bool {
        let mut child = self.child.lock().unwrap();
        match child.as_mut() {
            None => false,
            // `Err` is not proof of death — see the note on `is_running`.
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
        }
    }

    /// Test-only seam for the adopt-mode state (`running == true`, no child). No
    /// `start_*` can produce it — adopt-mode managers return before spawning and
    /// track adoption in their own flag — so the invariant that keeps them alive is
    /// otherwise unreachable from a test. Same justification as
    /// `ForwardTarget::for_test`: a production constructor would be a way to assert
    /// liveness without evidence.
    #[cfg(test)]
    pub(crate) fn mark_running_without_child(&self) {
        self.running.store(true, Ordering::Relaxed);
    }

    /// OS process id of the spawned child, when one is currently held.
    ///
    /// Returns `None` when no child is running (stopped, never started, or an
    /// adopt-mode manager that reused an external server it did not spawn). Used
    /// by the resource sampler to attribute per-engine memory/CPU.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().and_then(|c| c.id())
    }

    /// Verify the actual listener belongs to this live child before forwarding
    /// any bytes. Health responses are never evidence of process ownership.
    pub async fn owns_loopback_listener(&self, port: u16) -> bool {
        self.owns_loopback_socket(port, "LISTEN", None).await
    }

    /// The accepted socket in the child must match the already-connected
    /// forwarding socket's reverse tuple. A listener at the same port could
    /// have appeared after a different process accepted this connection.
    pub async fn owns_loopback_connection(
        &self,
        local: std::net::SocketAddr,
        peer: std::net::SocketAddr,
    ) -> bool {
        if local.ip() != std::net::Ipv4Addr::LOCALHOST || peer.ip() != std::net::Ipv4Addr::LOCALHOST
        {
            return false;
        }
        let expected = format!("{peer}->{local}");
        self.owns_loopback_socket(peer.port(), "ESTABLISHED", Some(&expected))
            .await
    }

    async fn owns_loopback_socket(&self, port: u16, state: &str, expected: Option<&str>) -> bool {
        let Some(pid) = self.pid().filter(|_| self.is_running()) else {
            return false;
        };
        #[cfg(target_os = "macos")]
        {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                tokio::process::Command::new("/usr/sbin/lsof")
                    .args([
                        "-nP",
                        "-a",
                        "-p",
                        &pid.to_string(),
                        &format!("-iTCP@127.0.0.1:{port}"),
                        &format!("-sTCP:{state}"),
                        "-Fpn",
                    ])
                    .env_clear()
                    .kill_on_drop(true)
                    .output(),
            )
            .await;
            return matches!(result, Ok(Ok(output)) if output.status.success()
                && listener_pid_matches(&output.stdout, pid)
                && expected.is_none_or(|expected| established_socket_matches(&output.stdout, pid, expected)))
                && self.pid() == Some(pid)
                && self.is_running();
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (pid, port, state, expected);
            false
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn listener_pid_matches(output: &[u8], pid: u32) -> bool {
    let Ok(output) = std::str::from_utf8(output) else {
        return false;
    };
    let expected = format!("p{pid}");
    output.lines().any(|line| line == expected)
        && output
            .lines()
            .filter(|line| line.starts_with('p'))
            .all(|line| line == expected)
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn established_socket_matches(output: &[u8], pid: u32, expected: &str) -> bool {
    listener_pid_matches(output, pid)
        && std::str::from_utf8(output).is_ok_and(|output| {
            output
                .lines()
                .any(|line| line.strip_prefix('n') == Some(expected))
        })
}

/// Upper bound on open file descriptors for a plugin-owned native sidecar.
/// Generous enough for servers, headless browsers and Python/Node runtimes,
/// while bounding a descriptor leak/exhaustion to the sidecar itself.
pub const SIDECAR_MAX_OPEN_FILES: u64 = 16_384;

/// The `(soft, hard)` descriptor limit to apply given the inherited one: never
/// RAISES anything (an inherited lower limit is kept), only caps at
/// [`SIDECAR_MAX_OPEN_FILES`]. `u64::MAX` stands for `RLIM_INFINITY`.
pub fn capped_nofile(soft: u64, hard: u64) -> (u64, u64) {
    let hard = hard.min(SIDECAR_MAX_OPEN_FILES);
    (soft.min(hard), hard)
}

/// Conservative, best-effort resource limits for a plugin-owned native sidecar,
/// applied in the child between `fork` and `exec`:
///
/// - `RLIMIT_CORE = 0` (soft and hard): a crashing sidecar never writes a core
///   dump, which would otherwise persist its injected per-process secrets
///   (`RYU_EXT_TOKEN`, provider keys it was handed) to disk.
/// - `RLIMIT_NOFILE` capped via [`capped_nofile`].
///
/// Deliberately NOT set: `RLIMIT_AS`/`RLIMIT_DATA` (break V8/JIT and mmap-heavy
/// ML runtimes), `RLIMIT_NPROC` (per-USER, would starve Core itself),
/// `RLIMIT_FSIZE` (fine-tune/model sidecars legitimately write very large files),
/// `RLIMIT_CPU` (long-lived servers). Failures are ignored: a limit that cannot be
/// applied must not stop an existing sidecar from starting.
#[cfg(unix)]
fn apply_sidecar_rlimits() {
    // SAFETY (for the libc calls): plain syscalls on stack-owned structs.
    unsafe {
        let no_core = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        let _ = libc::setrlimit(libc::RLIMIT_CORE, &no_core);

        let mut current = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) == 0 {
            #[allow(clippy::unnecessary_cast)]
            let (soft, hard) = capped_nofile(current.rlim_cur as u64, current.rlim_max as u64);
            let capped = libc::rlimit {
                rlim_cur: soft as libc::rlim_t,
                rlim_max: hard as libc::rlim_t,
            };
            let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &capped);
        }
    }
}

/// Drop every key-carrying variable ([`ryu_crypto::SEAL_ENV_VARS`]:
/// `RYU_MASTER_KEY`, `RYU_SEAL_KEY`, `RYU_SEAL_SCOPE`, `RYU_SEAL_RETIRED_KEYS`)
/// from a child command, the
/// `tokio::process::Command` counterpart of [`ryu_crypto::scrub_seal_env`].
fn remove_seal_env(command: &mut tokio::process::Command) {
    for name in ryu_crypto::SEAL_ENV_VARS {
        command.env_remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nofile_cap_never_raises_and_bounds_unlimited() {
        assert_eq!(capped_nofile(256, 10_240), (256, 10_240));
        assert_eq!(
            capped_nofile(1_024, u64::MAX),
            (1_024, SIDECAR_MAX_OPEN_FILES)
        );
        assert_eq!(
            capped_nofile(1_048_576, 1_048_576),
            (SIDECAR_MAX_OPEN_FILES, SIDECAR_MAX_OPEN_FILES)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn limited_spawn_applies_core_and_nofile_limits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("limits.txt");
        let script = format!("ulimit -c > '{0}'; ulimit -H -n >> '{0}'", out.display());
        let handle = ProcessHandle::new();
        handle
            .start_path_with_clean_env_limited("/bin/sh", &["-c".to_owned(), script], &[])
            .await
            .expect("spawn");
        for _ in 0..100 {
            if std::fs::read_to_string(&out).is_ok_and(|text| text.lines().count() >= 2) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let text = std::fs::read_to_string(&out).expect("limits written");
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("0"));
        let hard: u64 = lines
            .next()
            .and_then(|line| line.trim().parse().ok())
            .expect("numeric hard nofile");
        assert!(hard <= SIDECAR_MAX_OPEN_FILES, "hard nofile {hard}");
        let _ = handle.stop().await;
    }

    /// The isolated spawn path composes the rlimit hook with the Landlock hook:
    /// the sandboxed child writes in its own dir and is refused outside it.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn isolated_spawn_confines_writes_and_keeps_rlimits() {
        use ryu_sandbox::os_isolation::{
            derive_policy, landlock_abi_version, prepare, IsolationMode, IsolationRoots,
        };
        if landlock_abi_version().is_none() {
            eprintln!(
                "SKIPPED isolated_spawn_confines_writes_and_keeps_rlimits: \
                 Landlock is not available on this kernel"
            );
            return;
        }
        let base = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(base.path()).expect("canonical tempdir");
        let ryu_dir = root.join("ryu");
        let plugins_dir = ryu_dir.join("plugins");
        let app_data = plugins_dir.join("demo");
        let plugin_data = ryu_dir.join("plugin-data").join("demo");
        let temp = root.join("tmp");
        let outside = root.join("outside");
        for dir in [&app_data, &temp, &outside] {
            std::fs::create_dir_all(dir).expect("mkdir");
        }
        let roots = IsolationRoots {
            app_data: app_data.clone(),
            plugin_data,
            ryu_dir,
            plugins_dir,
            home: None,
            temp,
        };
        let policy =
            derive_policy(None, &roots, Some(std::path::Path::new("/bin/sh"))).expect("policy");
        let script = format!(
            "ulimit -c > '{own}/limits.txt'; echo no > '{out}/escape.txt'; echo done > '{own}/done.txt'",
            own = app_data.display(),
            out = outside.display()
        );
        let prepared = prepare(
            IsolationMode::Enforce,
            &policy,
            "/bin/sh",
            &["-c".to_owned(), script],
        )
        .expect("prepare");
        let handle = ProcessHandle::new();
        handle
            .start_path_with_clean_env_isolated(&[], &prepared)
            .await
            .expect("spawn");
        for _ in 0..100 {
            if app_data.join("done.txt").exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            app_data.join("done.txt").exists(),
            "own-dir write must succeed"
        );
        assert_eq!(
            std::fs::read_to_string(app_data.join("limits.txt")).expect("limits"),
            "0\n"
        );
        assert!(
            !outside.join("escape.txt").exists(),
            "a write outside the policy must be refused"
        );
        let _ = handle.stop().await;
    }

    #[test]
    fn listener_identity_requires_the_exact_owned_pid() {
        assert!(listener_pid_matches(b"p123\nf9\n", 123));
        assert!(!listener_pid_matches(b"p1234\nf9\n", 123));
        assert!(!listener_pid_matches(b"p123\np456\n", 123));
        assert!(!listener_pid_matches(b"", 123));
        assert!(!listener_pid_matches(b"HTTP/1.1 200 OK\n", 123));
        assert!(!listener_pid_matches(&[255], 123));
    }

    #[test]
    fn established_socket_requires_the_owned_peer_tuple_not_a_new_listener() {
        let tuple = "127.0.0.1:11234->127.0.0.1:50123";
        assert!(established_socket_matches(
            b"p123\nf9\nn127.0.0.1:11234->127.0.0.1:50123\n",
            123,
            tuple
        ));
        assert!(!established_socket_matches(
            b"p123\nf9\nn127.0.0.1:11234\n",
            123,
            tuple
        ));
        assert!(!established_socket_matches(
            b"p123\nf9\nn127.0.0.1:11234->127.0.0.1:50124\n",
            123,
            tuple
        ));
        assert!(!established_socket_matches(
            b"p456\nf9\nn127.0.0.1:11234->127.0.0.1:50123\n",
            123,
            tuple
        ));
    }

    /// Poll `f` until it holds or the deadline passes. A freshly-killed child is not
    /// reaped instantly, so a bare assert right after `kill` is a coin flip; every
    /// liveness assertion below goes through here.
    #[cfg(unix)]
    async fn eventually(label: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..100 {
            if f() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("condition never held within 2s: {label}");
    }

    /// The defect-1 fix at the layer that actually changes. Before it, `is_running`
    /// was a bare `AtomicBool` that only `stop()` ever cleared, so a child that died
    /// on its own reported `true` forever — and the manager's `forward_target` gated
    /// on exactly that, handing `RYU_EXT_TOKEN` to whatever bound the vacated port.
    ///
    /// Unix-only: `/bin/sh` is the portable-enough short-lived child.
    #[cfg(unix)]
    #[tokio::test]
    async fn process_handle_reports_dead_child_as_not_running() {
        let handle = ProcessHandle::new();
        handle
            .start_path_with_args("/bin/sh", &["-c".to_owned(), "exit 0".to_owned()])
            .await
            .expect("spawn /bin/sh");
        // The child is held, so both predicates go through `try_wait`.
        eventually("child exits", || handle.has_exited()).await;
        assert!(
            !handle.is_running(),
            "a child that exited must not report running — this is the forwarding gate"
        );
        assert!(
            handle.has_exited(),
            "has_exited is the crash discriminator the health monitor breaks on"
        );
        // Idempotent: tokio fuses the exit status, so repeated polls keep agreeing.
        assert!(!handle.is_running());
        assert!(handle.has_exited());
    }

    /// Core's managed children (the Gateway's local-plane spawn goes through
    /// `start_path_with_env`) inherit Core's environment but never its sealing
    /// keys: with `RYU_MASTER_KEY` set in Core, the child sees only the scoped
    /// subkey passed explicitly through `env`.
    #[cfg(unix)]
    #[tokio::test]
    async fn spawned_child_env_carries_the_subkey_not_the_master_key() {
        // Same fixed test key every caller of this helper sets, so concurrent
        // tests reading `RYU_MASTER_KEY` see a consistent value.
        crate::server::gateway_seal_test_key();
        let master = std::env::var("RYU_MASTER_KEY").expect("test master key set");
        let dir = tempfile::tempdir().expect("tempdir");
        for scrubbed in [false, true] {
            let out = dir.path().join(format!("env-{scrubbed}.txt"));
            let script = format!("env > '{}'", out.display());
            let env = vec![
                ("RYU_SEAL_KEY".to_owned(), "delivered-subkey".to_owned()),
                ("RYU_SEAL_SCOPE".to_owned(), "component:gateway".to_owned()),
            ];
            let handle = ProcessHandle::new();
            let args = ["-c".to_owned(), script];
            if scrubbed {
                handle
                    .start_path_with_scrubbed_env("/bin/sh", &args, &env)
                    .await
                    .expect("spawn /bin/sh");
            } else {
                handle
                    .start_path_with_env("/bin/sh", &args, &env)
                    .await
                    .expect("spawn /bin/sh");
            }
            eventually("child exits", || handle.has_exited()).await;
            let child_env = std::fs::read_to_string(&out).expect("child env dump");
            assert!(
                !child_env
                    .lines()
                    .any(|line| line.starts_with("RYU_MASTER_KEY=")),
                "child (scrubbed={scrubbed}) inherited RYU_MASTER_KEY"
            );
            assert!(!child_env.contains(&master));
            assert!(child_env
                .lines()
                .any(|line| line == "RYU_SEAL_KEY=delivered-subkey"));
            assert!(child_env
                .lines()
                .any(|line| line == "RYU_SEAL_SCOPE=component:gateway"));
        }
    }

    /// A deliberate `stop()` TAKES the child, so it is not a crash. This pins the
    /// choice of `has_exited()` over `!is_running()` at the recording site: both are
    /// "not running", only one deserves a durable failure reason.
    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_handle_is_not_running_but_did_not_crash() {
        let handle = ProcessHandle::new();
        handle
            .start_path_with_args("/bin/sh", &["-c".to_owned(), "sleep 30".to_owned()])
            .await
            .expect("spawn /bin/sh");
        assert!(handle.is_running());
        handle.stop().await.expect("stop");
        assert!(!handle.is_running());
        assert!(
            !handle.has_exited(),
            "a stopped sidecar must never be reported as crashed"
        );
    }

    /// The adopt-mode invariant. `running == true` with no child is how the
    /// whisper/sdcpp/ryutts/research managers represent an external server they did
    /// not spawn; downgrading it would declare every adopted server dead the moment
    /// `is_running` started polling.
    #[test]
    fn adopted_sidecar_without_child_stays_running() {
        let handle = ProcessHandle::new();
        handle.mark_running_without_child();
        assert!(handle.is_running(), "child == None must mean still running");
        assert!(
            !handle.has_exited(),
            "no child means no evidence of a crash, not evidence of one"
        );
    }

    /// A never-started handle is neither running nor crashed.
    #[test]
    fn fresh_handle_is_neither_running_nor_exited() {
        let handle = ProcessHandle::new();
        assert!(!handle.is_running());
        assert!(!handle.has_exited());
    }
}
