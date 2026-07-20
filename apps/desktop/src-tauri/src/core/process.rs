//! Managed child process for the Ryu Core sidecar.
//!
//! Handles spawning, stdio forwarding, graceful shutdown (SIGTERM → SIGKILL),
//! and a PID file for orphan recovery across restarts.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::win_process::NoWindow;

// ── Paths ──────────────────────────────────────────────────────────────────────

fn pid_path() -> PathBuf {
	crate::profile::ryu_home_dir().join("ryu-core.pid")
}

/// Resolve the Sentry DSN to hand the Core sidecar: an explicit runtime
/// `SENTRY_DSN` wins (dev shells, self-hosters), else the value baked into this
/// build via `option_env!` (packaged releases set `SENTRY_DSN` at `cargo build`
/// time). `None` leaves Core's crash tier a graceful no-op.
fn sentry_dsn() -> Option<String> {
	std::env::var("SENTRY_DSN")
		.ok()
		.or_else(|| option_env!("SENTRY_DSN").map(str::to_string))
		.map(|s| s.trim().to_string())
		.filter(|s| !s.is_empty())
}

// ── ProcessState ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessState {
	Starting,
	Running,
	Stopping,
	Stopped,
}

// ── RyuCoreProcess ─────────────────────────────────────────────────────────────

pub struct RyuCoreProcess {
	child: Option<Child>,
	binary_path: PathBuf,
	pid_path: PathBuf,
	state: ProcessState,
	/// Handles for stdout/stderr forwarding tasks.
	log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl RyuCoreProcess {
	pub fn new(binary_path: PathBuf) -> Self {
		Self {
			child: None,
			binary_path,
			pid_path: pid_path(),
			state: ProcessState::Stopped,
			log_tasks: Vec::new(),
		}
	}

	/// Check if Ryu Core is already running by hitting the health endpoint.
	pub async fn is_already_running(&self) -> bool {
		let client = reqwest::Client::builder()
			.timeout(Duration::from_secs(2))
			.build()
			.unwrap_or_else(|_| reqwest::Client::new());

		match client
			.get(format!("{}/api/health", crate::profile::core_base_url()))
			.send()
			.await
		{
			Ok(response) if response.status().is_success() => true,
			_ => false,
		}
	}

	/// Spawn the Ryu Core binary and begin forwarding its stdio to tracing.
	/// First checks if an instance is already running on port 7980.
	pub async fn start(&mut self) -> Result<()> {
		// Check if already running
		if self.is_already_running().await {
			tracing::info!("Ryu Core already running, connecting to existing instance");
			self.state = ProcessState::Running;
			return Ok(());
		}

		self.cleanup_orphan().await;
		self.state = ProcessState::Starting;

		let mut command = Command::new(&self.binary_path);
		command
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(false)
			// Core is a console binary; without CREATE_NO_WINDOW it opens a
			// command-prompt window that stays up for the whole app session.
			// Piping stdio does NOT suppress it — only the creation flag does.
			.no_window();
		// Isolate the dev variant's backend: hand the Core child our profile so it
		// binds the shifted port (8980) and uses the shifted data dir (~/.ryu-dev)
		// via its own `profile::apply_env_defaults`. Release passes nothing new
		// ("release" is byte-identical to unset), so the release path is untouched.
		if crate::profile::is_dev() {
			command.env(crate::profile::RYU_PROFILE_ENV, crate::profile::name());
		}
		// Crash reporting: hand the Sentry DSN to the Core sidecar so its (and the
		// gateway's, via Core's spawn-env forwarding) panic tier has a destination.
		// Core reads SENTRY_DSN from env and stays a graceful no-op without it; the
		// desktop `crash-reports-enabled` consent still gates capture inside Core.
		if let Some(dsn) = sentry_dsn() {
			command.env("SENTRY_DSN", dsn);
		}
		let mut child = command.spawn()?;

		// Write PID file so we can recover from a crash on next start.
		if let Some(pid) = child.id() {
			tokio::fs::write(&self.pid_path, pid.to_string()).await?;
		}

		// Forward stdout → tracing::info
		if let Some(stdout) = child.stdout.take() {
			let handle = tokio::spawn(async move {
				let mut lines = BufReader::new(stdout).lines();
				while let Ok(Some(line)) = lines.next_line().await {
					tracing::info!(target: "ryu-core", "{line}");
				}
			});
			self.log_tasks.push(handle);
		}

		// Forward stderr → tracing::warn
		if let Some(stderr) = child.stderr.take() {
			let handle = tokio::spawn(async move {
				let mut lines = BufReader::new(stderr).lines();
				while let Ok(Some(line)) = lines.next_line().await {
					tracing::warn!(target: "ryu-core", "{line}");
				}
			});
			self.log_tasks.push(handle);
		}

		self.child = Some(child);
		self.state = ProcessState::Running;
		Ok(())
	}

	/// Gracefully stop the process: SIGTERM → 5 s wait → SIGKILL.
	pub async fn stop(&mut self) -> Result<()> {
		// If we don't have a child handle, just cleanup the PID file
		if self.child.is_none() {
			let _ = tokio::fs::remove_file(&self.pid_path).await;
			self.state = ProcessState::Stopped;
			return Ok(());
		}

		self.state = ProcessState::Stopping;

		// Abort log forwarding tasks first.
		for handle in self.log_tasks.drain(..) {
			handle.abort();
		}

		let child = self.child.as_mut().unwrap();

		// Send graceful termination signal.
		#[cfg(unix)]
		if let Some(raw_pid) = child.id() {
			use nix::sys::signal::{kill, Signal};
			use nix::unistd::Pid;
			let _ = kill(Pid::from_raw(raw_pid as i32), Signal::SIGTERM);
		}

		#[cfg(windows)]
		{
			let _ = child.kill().await;
		}

		// Wait up to 5 s for the process to exit; force-kill on timeout.
		let child = self.child.as_mut().unwrap();
		match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
			Ok(_) => {}
			Err(_) => {
				tracing::warn!("ryu-core did not exit within 5 s — sending SIGKILL");
				let _ = child.kill().await;
				let _ = child.wait().await;
			}
		}

		let _ = tokio::fs::remove_file(&self.pid_path).await;
		self.state = ProcessState::Stopped;
		self.child = None;
		Ok(())
	}

	/// Synchronous stop for use in non-async contexts (window destroy, app exit).
	/// Kills the process immediately and cleans up PID file.
	pub fn try_stop(&mut self) -> Result<()> {
		// Abort log forwarding tasks
		for handle in self.log_tasks.drain(..) {
			handle.abort();
		}

		// Kill the process if we have a handle
		if let Some(ref mut child) = self.child {
			#[cfg(unix)]
			if let Some(raw_pid) = child.id() {
				use nix::sys::signal::{kill, Signal};
				use nix::unistd::Pid;
				let _ = kill(Pid::from_raw(raw_pid as i32), Signal::SIGKILL);
			}

			#[cfg(windows)]
			{
				let _ = std::process::Command::new("taskkill")
					.args(["/F", "/PID", &child.id().unwrap().to_string()])
					.no_window()
					.output();
			}
		}

		// Clean up PID file synchronously
		let _ = std::fs::remove_file(&self.pid_path);

		self.state = ProcessState::Stopped;
		self.child = None;
		Ok(())
	}

	pub async fn restart(&mut self) -> Result<()> {
		self.stop().await?;
		self.start().await
	}

	/// Returns true if the child process is still alive.
	pub fn is_running(&mut self) -> bool {
		let Some(child) = self.child.as_mut() else {
			return false;
		};
		match child.try_wait() {
			Ok(None) => true,
			_ => {
				self.state = ProcessState::Stopped;
				self.child = None;
				false
			}
		}
	}

	/// Non-blocking exit check.
	pub fn poll_exit(&mut self) -> Option<std::process::ExitStatus> {
		let child = self.child.as_mut()?;
		match child.try_wait() {
			Ok(Some(status)) => {
				self.state = ProcessState::Stopped;
				self.child = None;
				Some(status)
			}
			_ => None,
		}
	}

	/// Returns `true` if a live child process handle is currently held.
	pub fn has_child(&self) -> bool {
		self.child.is_some()
	}

	/// Kill any leftover process whose PID is recorded in the PID file.
	pub async fn cleanup_orphan(&self) {
		let Ok(content) = tokio::fs::read_to_string(&self.pid_path).await else {
			return;
		};
		let Ok(pid) = content.trim().parse::<i32>() else {
			return;
		};

		#[cfg(unix)]
		{
			use nix::sys::signal::{kill, Signal};
			use nix::unistd::Pid;
			let nix_pid = Pid::from_raw(pid);
			let _ = kill(nix_pid, Signal::SIGTERM);
			tokio::time::sleep(Duration::from_secs(2)).await;
			let _ = kill(nix_pid, Signal::SIGKILL);
		}

		#[cfg(windows)]
		{
			let _ = std::process::Command::new("taskkill")
				.args(["/F", "/PID", &pid.to_string()])
				.no_window()
				.output();
		}
	}
}
