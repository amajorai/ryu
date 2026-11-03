use std::{env, fs, path::PathBuf};

// Windows DLL sideloading hardening: on MSVC targets, link Ryu.exe with
// `/DEPENDENTLOADFLAG:0x800` so its static DLL imports resolve from System32
// only, never from its per-user install directory. Shared with Core and Gateway;
// tested in `ryu_sidecar_runtime::dll_search::link_arg`.
include!("../../../crates/core/sidecar-runtime/src/dll_search/link_arg.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=RYU_STANDALONE_APP_ID");
    println!("cargo:rerun-if-env-changed=RYU_STANDALONE_APP_BUNDLE");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let standalone_id = env::var_os("RYU_STANDALONE_APP_ID")
        .map(|value| value.to_string_lossy().trim().to_owned())
        .filter(|value| !value.is_empty());
    let bundle_path = out_dir.join("standalone-app-bundle.json");
    let bundle = match (
        standalone_id.as_deref(),
        env::var_os("RYU_STANDALONE_APP_BUNDLE").map(PathBuf::from),
    ) {
        (None, None) => "{}\n".to_owned(),
        (Some(_), None) => {
            panic!("RYU_STANDALONE_APP_ID is set but RYU_STANDALONE_APP_BUNDLE is missing")
        }
        (None, Some(_)) => {
            panic!("RYU_STANDALONE_APP_BUNDLE is set but RYU_STANDALONE_APP_ID is missing")
        }
        (Some(expected_id), Some(path)) => {
            let contents = fs::read_to_string(&path).unwrap_or_else(|error| {
                panic!(
                    "could not read standalone app bundle {}: {error}",
                    path.display()
                )
            });
            let value: serde_json::Value =
                serde_json::from_str(&contents).unwrap_or_else(|error| {
                    panic!(
                        "standalone app bundle {} is invalid JSON: {error}",
                        path.display()
                    )
                });
            if value
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
            {
                panic!(
                    "standalone app bundle {} must declare schemaVersion 1",
                    path.display()
                );
            }
            if value.get("appId").and_then(serde_json::Value::as_str) != Some(expected_id) {
                panic!(
                    "standalone app bundle {} does not match RYU_STANDALONE_APP_ID {expected_id:?}",
                    path.display()
                );
            }
            contents
        }
    };
    fs::write(bundle_path, bundle).expect("write standalone app bundle carriage");
    if let Some(app_id) = env::var_os("RYU_STANDALONE_APP_ID") {
        println!(
            "cargo:rustc-env=RYU_STANDALONE_APP_ID={}",
            app_id.to_string_lossy()
        );
    }
    emit_dependent_load_flag_link_arg();
    tauri_build::build()
}
