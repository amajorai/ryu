use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use anyhow::Result;

/// Shared process lifecycle handle used by all sidecar managers.
///
/// Wraps an optional child process and an atomic running flag so that
/// `stop()` and `is_running()` can be delegated consistently without
/// each manager reimplementing the same pattern.
#[derive(Clone)]
pub struct ProcessHandle {
    running: Arc<AtomicBool>,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
}

impl ProcessHandle {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Spawn `binary` with no extra arguments.
    pub async fn start(&self, binary: &Path) -> Result<()> {
        let child = tokio::process::Command::new(binary)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", binary.display()))?;
        *self.child.lock().unwrap() = Some(child);
        self.running.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Spawn `binary` with additional CLI arguments.
    pub async fn start_with_args(&self, binary: &Path, args: &[&'static str]) -> Result<()> {
        let child = tokio::process::Command::new(binary)
            .args(args)
            .kill_on_drop(true)
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
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true);
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
        let child = { self.child.lock().unwrap().take() };
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
        self.running.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
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
