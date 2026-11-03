//! Guard: the desktop executable keeps its Windows DLL sideloading hardening.
//!
//! `Ryu.exe` installs per user, so its directory is writable by anything the
//! user runs. A `winmm.dll` planted beside it (the "Yoba" pattern: a genuine
//! signed binary plus a sideloaded DLL) must never load. The build script links
//! with `/DEPENDENTLOADFLAG:0x800` through the shared
//! `ryu_sidecar_runtime::dll_search::link_arg` fragment, whose flag logic is
//! unit-tested in `ryu-sidecar-runtime`, and `main` first calls
//! `ryu_sidecar_runtime::dll_search::harden_dll_search`, so libraries loaded by
//! name later resolve from System32. These checks keep both from being dropped,
//! and on an MSVC build read the flag back from the linked PE.

use std::path::{Path, PathBuf};

const LINK_ARG_FRAGMENT: &str = "crates/core/sidecar-runtime/src/dll_search/link_arg.rs";

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Strip `//` comments so a commented-out call cannot satisfy the guard.
fn code_only(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split("//").next().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_build_script_links_with_the_dependent_load_flag() {
    let code = code_only(&read(&crate_root().join("build.rs")));
    assert!(
        code.contains(&format!("include!(\"../../../{LINK_ARG_FRAGMENT}\")")),
        "build.rs must include the shared {LINK_ARG_FRAGMENT} fragment"
    );
    assert!(
        crate_root()
            .join("../../..")
            .join(LINK_ARG_FRAGMENT)
            .is_file(),
        "the included fragment must exist"
    );
    let main = code
        .split("fn main()")
        .nth(1)
        .expect("the build script defines fn main()");
    let emit = main
        .find("emit_dependent_load_flag_link_arg();")
        .expect("the build script's main must emit the /DEPENDENTLOADFLAG link argument");
    let tauri = main
        .find("tauri_build::build()")
        .expect("the build script still runs tauri_build");
    assert!(
        emit < tauri,
        "emit the link argument before handing off to tauri_build"
    );
}

#[test]
fn main_restricts_the_dll_search_order_before_anything_else() {
    let code = code_only(&read(&crate_root().join("src/main.rs")));
    let body = code
        .split("fn main() {")
        .nth(1)
        .expect("the desktop defines fn main()");
    let first = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .expect("main has a body");
    assert!(
        first.contains("ryu_sidecar_runtime::dll_search::harden_dll_search()"),
        "the first statement of main must harden the DLL search order, found: {first}"
    );
}

#[test]
fn hardening_reports_what_it_did_on_this_platform() {
    let outcome = ryu_sidecar_runtime::dll_search::harden_dll_search()
        .expect("the DLL search policy applies");
    let expected = if cfg!(windows) {
        ryu_sidecar_runtime::dll_search::DllSearchHardening::Applied
    } else {
        ryu_sidecar_runtime::dll_search::DllSearchHardening::NotApplicable
    };
    assert_eq!(outcome, expected);
}

/// On an MSVC build, the linked executable's load-config directory carries
/// `DependentLoadFlags == LOAD_LIBRARY_SEARCH_SYSTEM32`.
#[cfg(all(windows, target_env = "msvc"))]
#[test]
fn the_linked_executable_resolves_static_imports_from_system32() {
    let pe = std::fs::read(env!("CARGO_BIN_EXE_desktop")).expect("read desktop.exe");
    let u16_at = |at: usize| u16::from_le_bytes([pe[at], pe[at + 1]]);
    let u32_at = |at: usize| u32::from_le_bytes([pe[at], pe[at + 1], pe[at + 2], pe[at + 3]]);
    let nt = u32_at(0x3c) as usize;
    let optional = nt + 24;
    assert_eq!(u16_at(optional), 0x20b, "a PE32+ image");
    let sections = optional + usize::from(u16_at(nt + 20));
    let section_count = usize::from(u16_at(nt + 6));
    // Data directory 10 is the load configuration (RVA, size).
    let load_config_rva = u32_at(optional + 112 + 10 * 8);
    assert_ne!(load_config_rva, 0, "the image has a load-config directory");
    let file_offset = (0..section_count)
        .map(|index| sections + index * 40)
        .find_map(|header| {
            let virtual_address = u32_at(header + 12);
            let raw_size = u32_at(header + 16);
            let raw_pointer = u32_at(header + 20);
            (load_config_rva >= virtual_address && load_config_rva < virtual_address + raw_size)
                .then(|| (load_config_rva - virtual_address + raw_pointer) as usize)
        })
        .expect("the load-config directory lies in a section");
    // IMAGE_LOAD_CONFIG_DIRECTORY64.DependentLoadFlags is at offset 0x4e.
    assert_eq!(u16_at(file_offset + 0x4e), 0x0800);
}
