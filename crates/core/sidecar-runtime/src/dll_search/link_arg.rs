// Build-script half of Windows DLL search hardening.
//
// This file is compiled as `ryu_sidecar_runtime::dll_search::link_arg` (where its
// tests run) and is meant to be pulled, through `include!`, into the build script
// of every Ryu-shipped Rust executable (Core, Gateway, the desktop app). Build
// scripts cannot depend on the crate they build, so the shared logic stays a
// dependency-free fragment with plain `//` comments (an included
// file may not carry inner doc attributes).

/// `LOAD_LIBRARY_SEARCH_SYSTEM32`, the only directory a hardened Ryu executable
/// resolves its static DLL imports from.
pub const DEPENDENT_LOAD_FLAG_SYSTEM32: u32 = 0x0000_0800;

/// The linker argument that writes [`DEPENDENT_LOAD_FLAG_SYSTEM32`] into the PE
/// load-config `DependentLoadFlags` field, or `None` when the target's linker does
/// not understand it.
///
/// Only the MSVC `link.exe`/`lld-link` accept `/DEPENDENTLOADFLAG`; Windows GNU
/// builds (and every non-Windows target) get no flag. The value restricts static
/// import resolution to System32 on Windows 10 1607 and later, so a `winmm.dll` or
/// `version.dll` dropped next to the executable is never loaded at process start.
#[must_use]
pub fn dependent_load_flag_link_arg(target_os: &str, target_env: &str) -> Option<String> {
    (target_os == "windows" && target_env == "msvc")
        .then(|| format!("/DEPENDENTLOADFLAG:{DEPENDENT_LOAD_FLAG_SYSTEM32:#x}"))
}

/// Emit the hardening link argument for the binaries of the package whose build
/// script calls this, reading the target from Cargo's `CARGO_CFG_*` variables.
pub fn emit_dependent_load_flag_link_arg() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if let Some(argument) = dependent_load_flag_link_arg(&target_os, &target_env) {
        println!("cargo:rustc-link-arg-bins={argument}");
    }
}
