//! `validate_sidecar_spec` must keep a binary sidecar's `version` to one plain
//! path segment: Core installs the binary under `<plugin_dir>/bin/<version>`,
//! so an absolute or `..` version would steer the download/extract/chmod
//! outside the plugin's own directory.

use super::*;

fn binary_spec(version: &str) -> SidecarSpec {
    let raw = serde_json::json!({
        "name": "engine",
        "process": {
            "kind": "binary",
            "url": "https://example.com/dl/engine",
            "version": version,
        },
        "port": 9099,
    });
    serde_json::from_value(raw).expect("binary sidecar spec parses")
}

#[test]
fn binary_version_accepts_plain_release_names() {
    for version in ["1.2.3", "v0.4.0-rc.1", "2024.11.01+build.7"] {
        assert!(
            validate_sidecar_spec(&binary_spec(version)).is_ok(),
            "{version} should be accepted"
        );
    }
}

#[test]
fn binary_version_rejects_paths_that_leave_the_install_dir() {
    for version in [
        "",
        "   ",
        "/home/u/.config/autostart",
        "../../x",
        "..",
        ".",
        "a/b",
        "../victim/bin/1",
        "a\\b",
        " 1.0",
        "1.0 ",
        "1.0\0",
    ] {
        let err = validate_sidecar_spec(&binary_spec(version))
            .expect_err(&format!("{version:?} must be rejected"));
        assert!(err.contains("'version'"), "{version:?}: {err}");
    }
}
