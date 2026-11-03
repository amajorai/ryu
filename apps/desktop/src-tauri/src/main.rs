#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // First, before anything can load a library by name: resolve DLLs from
    // System32 only, so a DLL planted in Ryu's per-user install directory is
    // never sideloaded (this also covers `ryu-update-guard`, which is a copy of
    // this executable). A refusal is reported, not fatal: the link-time
    // `/DEPENDENTLOADFLAG` still protects the static imports.
    if let Err(error) = ryu_sidecar_runtime::dll_search::harden_dll_search() {
        eprintln!("ryu: could not restrict the DLL search order: {error}");
    }
    if let Some(code) = desktop_lib::run_recovery_mode() {
        std::process::exit(code);
    }
    desktop_lib::run()
}
