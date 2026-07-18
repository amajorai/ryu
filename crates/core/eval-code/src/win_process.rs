//! Suppress the console window Windows attaches to spawned child processes.
//!
//! The sandbox backends spawn `deno` / `bun` children; on Windows a `CONSOLE`
//! subsystem child would otherwise pop its own black command-prompt window.
//! `CREATE_NO_WINDOW` suppresses it; on non-Windows it is a no-op.
//!
//! This is a byte-for-byte copy of `apps/core/src/win_process.rs` — a generic,
//! zero-drift OS-flag helper (a Windows constant, not business logic). It is
//! duplicated rather than shared so the crate keeps ZERO dependency on
//! `apps/core` (the extracted-crate standard); Core keeps its own copy for its
//! ~50 other spawn sites.

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
