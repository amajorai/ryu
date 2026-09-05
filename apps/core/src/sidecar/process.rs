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
}

impl ProcessHandle {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Spawn `binary` with no extra arguments.
    pub async fn start(&self, binary: &Path) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let child = tokio::process::Command::new(binary)
            .kill_on_drop(true)
            .no_window()
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
        let child = tokio::process::Command::new(binary)
            .args(args)
            .kill_on_drop(true)
            .no_window()
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
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true).no_window();
        command.env_clear();
        for (key, value) in crate::sidecar::env_scrub::mcp_safe_env(std::env::vars()) {
            command.env(key, value);
        }
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

    pub async fn stop(&self) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        let child = { self.child.lock().unwrap().take() };
        if let Some(mut c) = child {
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
