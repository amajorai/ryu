//! Suppress the console window that Windows attaches to spawned child processes.
//!
//! The desktop shell itself is a GUI binary (`windows_subsystem = "windows"` in
//! `main.rs`), but every CONSOLE-subsystem child it spawns — the Ryu Core
//! sidecar, `ryu-core data-path …`, `taskkill`, `nvidia-smi` — pops its own
//! black command-prompt window, and the long-lived ones (Core) keep theirs open
//! for the whole session. `CREATE_NO_WINDOW` spawns the child with no console;
//! on non-Windows it is a no-op.
//!
//! Call `.no_window()` on any `std`/`tokio` `Command` before `spawn()`/`output()`.
//! Mirrors `apps/core/src/win_process.rs`, which does the same for the sidecars
//! Core itself spawns.

/// Windows `CREATE_NO_WINDOW` process creation flag.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Extension adding `.no_window()` to both `std` and `tokio` `Command` builders.
pub trait NoWindow {
	/// Spawn the child without a console window on Windows (no-op elsewhere).
	fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
	fn no_window(&mut self) -> &mut Self {
		#[cfg(windows)]
		{
			use std::os::windows::process::CommandExt;
			self.creation_flags(CREATE_NO_WINDOW);
		}
		self
	}
}

impl NoWindow for tokio::process::Command {
	fn no_window(&mut self) -> &mut Self {
		#[cfg(windows)]
		{
			self.creation_flags(CREATE_NO_WINDOW);
		}
		self
	}
}
