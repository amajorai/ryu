//! Suppress the console window that Windows attaches to spawned child processes.
//!
//! Ryu Core is launched by the GUI desktop shell. Every console (`CONSOLE`
//! subsystem) child it spawns — the gateway, llama.cpp, ACP agents, `git`,
//! `taskkill`, `powershell`, etc. — would otherwise pop its own black
//! command-prompt window (and some linger). `CREATE_NO_WINDOW` tells Windows to
//! spawn the child without a console window; on non-Windows it is a no-op.
//!
//! Call `.no_window()` on any `std`/`tokio` `Command` before `spawn()`/`output()`.

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
