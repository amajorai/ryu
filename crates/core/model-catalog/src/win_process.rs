//! Vendored console-window suppression util.
//!
//! The device-detection (`device.rs`) and llama.cpp-fit-probe (`llmfit.rs`) paths
//! shell out to child processes (`system_profiler`, `wmic`, the engine binary,
//! …). On Windows every `CONSOLE`-subsystem child pops its own black
//! command-prompt window unless spawned with `CREATE_NO_WINDOW`.
//!
//! This is a byte-for-byte copy of Core's `win_process::NoWindow` (a tiny,
//! cross-cutting std/tokio `Command` extension shared repo-wide). It is vendored
//! rather than inverted through the host trait — it is a pure, dependency-free
//! `Command`-builder helper with no process-global state, so a host round-trip
//! would add nothing. The `ryu-knowledge` extraction vendored the same util for
//! the same reason.

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
