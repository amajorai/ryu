//! Guard: the Gateway executable keeps its Windows DLL sideloading hardening.
//!
//! The Gateway holds every provider key, so a `winmm.dll` planted beside
//! `ryu-gateway.exe` must never load at process start. Its build script links
//! with `/DEPENDENTLOADFLAG:0x800` through the shared
//! `ryu_sidecar_runtime::dll_search::link_arg` fragment, whose flag logic is
//! unit-tested in `ryu-sidecar-runtime`. At run time `main` first calls
//! `ryu_sidecar_runtime::dll_search::harden_dll_search`, so libraries loaded by
//! name later resolve from System32, never the working directory. These checks
//! keep both from being dropped, and on an MSVC build read the flag back from
//! the linked PE.

use std::path::{Path, PathBuf};

const LINK_ARG_FRAGMENT: &str = "crates/core/sidecar-runtime/src/dll_search/link_arg.rs";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
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
    let code = code_only(&read("apps/gateway/build.rs"));
    assert!(
        code.contains(&format!("include!(\"../../{LINK_ARG_FRAGMENT}\")")),
        "apps/gateway/build.rs must include the shared {LINK_ARG_FRAGMENT} fragment"
    );
    let main = code
        .split("fn main()")
        .nth(1)
        .expect("the build script defines fn main()");
    assert!(
        main.contains("emit_dependent_load_flag_link_arg();"),
        "the build script's main must emit the /DEPENDENTLOADFLAG link argument"
    );
}

#[test]
fn main_restricts_the_dll_search_order_before_anything_else() {
    let code = code_only(&read("apps/gateway/src/main.rs"));
    let body = code
        .split("fn main() -> anyhow::Result<()> {")
        .nth(1)
        .expect("the Gateway defines fn main() -> anyhow::Result<()>");
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
fn the_link_argument_fragment_stays_includable_by_build_scripts() {
    // `include!` rejects inner attributes and doc comments, and a build script
    // cannot depend on a crate, so the fragment must stay self-contained.
    for line in read(LINK_ARG_FRAGMENT).lines().map(str::trim_start) {
        assert!(
            !line.starts_with("//!"),
            "inner doc comment in the fragment: {line}"
        );
        assert!(
            !line.starts_with("#!["),
            "inner attribute in the fragment: {line}"
        );
        assert!(!line.starts_with("use "), "import in the fragment: {line}");
    }
}

/// On an MSVC build, the linked executable's load-config directory carries
/// `DependentLoadFlags == LOAD_LIBRARY_SEARCH_SYSTEM32`.
#[cfg(all(windows, target_env = "msvc"))]
#[test]
fn the_linked_executable_resolves_static_imports_from_system32() {
    let pe = std::fs::read(env!("CARGO_BIN_EXE_ryu-gateway")).expect("read ryu-gateway.exe");
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
