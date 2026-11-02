//! Windows DLL search-order hardening for Ryu-shipped executables.
//!
//! Ryu's executables run from per-user writable directories (the desktop's
//! per-user install and `~/.ryu/bin`). With the default loader search order, a
//! DLL planted beside a genuine Ryu executable (the "Yoba" sideloading pattern:
//! a signed binary plus a malicious `winmm.dll`) runs inside Ryu's process and
//! inherits its credentials. Two layers close that:
//!
//! - [`link_arg`]: the build-time `/DEPENDENTLOADFLAG:0x800` that limits static
//!   imports to System32, for each executable's build script to emit;
//! - [`harden_dll_search`]: the run-time policy, for `main` to call first, that
//!   limits later `LoadLibrary` calls to System32 and drops the current
//!   directory from the legacy search path.
//!
//! A library Ryu itself loads by full path, together with dependencies shipped
//! beside it, must then be loaded with [`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`] |
//! [`LOAD_LIBRARY_SEARCH_SYSTEM32`].

pub mod link_arg;

pub use link_arg::{
    dependent_load_flag_link_arg, emit_dependent_load_flag_link_arg, DEPENDENT_LOAD_FLAG_SYSTEM32,
};

/// `LOAD_LIBRARY_SEARCH_SYSTEM32`.
pub const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
/// `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`: search the loaded DLL's own directory
/// for its dependencies (valid only with a fully qualified path).
pub const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;

/// The flags a full-path load of a Ryu-managed native library uses once
/// [`harden_dll_search`] has run: the library's own directory, then System32.
pub const MANAGED_LIBRARY_LOAD_FLAGS: u32 =
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32;

/// What [`harden_dll_search`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DllSearchHardening {
    /// Windows: the process now resolves `LoadLibrary` calls from System32
    /// only and no longer searches the current directory.
    Applied,
    /// Not Windows: the platform has no DLL search order to harden.
    NotApplicable,
}

/// Restrict this process's DLL search order. Call it as the first statement of
/// `main`, before any code that could load a library by name.
///
/// # Errors
///
/// Returns the OS error when Windows refuses either policy call. Callers report
/// it and keep running: the build-time `/DEPENDENTLOADFLAG` still protects the
/// static imports.
pub fn harden_dll_search() -> std::io::Result<DllSearchHardening> {
    imp::harden()
}

#[cfg(windows)]
mod imp {
    use super::{DllSearchHardening, LOAD_LIBRARY_SEARCH_SYSTEM32};

    #[link(name = "kernel32")]
    extern "system" {
        fn SetDllDirectoryW(path: *const u16) -> i32;
        fn SetDefaultDllDirectories(directory_flags: u32) -> i32;
    }

    pub(super) fn harden() -> std::io::Result<DllSearchHardening> {
        let empty: [u16; 1] = [0];
        // SAFETY: `empty` is a valid NUL-terminated wide string that outlives
        // the call; an empty string removes the current directory from the
        // legacy search path.
        if unsafe { SetDllDirectoryW(empty.as_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: plain flag argument; available on Windows 8+ and Windows 7
        // with KB2533623.
        if unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(DllSearchHardening::Applied)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::DllSearchHardening;

    #[allow(clippy::unnecessary_wraps)]
    pub(super) fn harden() -> std::io::Result<DllSearchHardening> {
        Ok(DllSearchHardening::NotApplicable)
    }
}

#[cfg(test)]
mod tests;
