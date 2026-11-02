// Windows DLL sideloading hardening (the "Yoba" pattern: a genuine, signed
// executable plus a planted `winmm.dll` or `version.dll` beside it). On MSVC
// targets, link the Gateway's executables with `/DEPENDENTLOADFLAG:0x800` so
// their static DLL imports resolve from System32 only, never from the
// directory the executable runs from. The shared logic and its unit tests live
// in `ryu_sidecar_runtime::dll_search::link_arg`; every other target gets no
// flag.
include!("../../crates/core/sidecar-runtime/src/dll_search/link_arg.rs");

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../../crates/core/sidecar-runtime/src/dll_search/link_arg.rs");
    emit_dependent_load_flag_link_arg();
}
