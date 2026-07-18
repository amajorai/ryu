//! Suppress the console window that Windows attaches to spawned child processes.
//!
//! Copied verbatim from `apps/core/src/win_process.rs` (a 40-LoC pure
//! `#[cfg(windows)]` utility). A `Command`-builder extension trait is the wrong
//! shape to invert through the async host, and it has no shared crate home, so a
//! small UTIL duplication is the right call — see the extraction adjudication.
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
