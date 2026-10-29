#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = desktop_lib::run_recovery_mode() {
        std::process::exit(code);
    }
    desktop_lib::run()
}
