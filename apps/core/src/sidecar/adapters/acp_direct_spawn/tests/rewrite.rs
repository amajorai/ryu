use std::time::UNIX_EPOCH;

use super::*;

#[test]
fn cached_bin_cannot_escape_package() {
    let root = tempfile::tempdir().unwrap();
    let spec = "@agentclientprotocol/codex-acp";
    let outside = root.path().join("generic.js");
    std::fs::write(&outside, "#!/usr/bin/env node\n").unwrap();
    fake_install(
        root.path(),
        spec,
        1,
        serde_json::json!(outside),
        "dist/index.js",
    );
    assert!(installed_bin(root.path(), spec).is_none());
    fake_install(
        root.path(),
        spec,
        1,
        serde_json::json!("../../generic.js"),
        "dist/index.js",
    );
    assert!(installed_bin(root.path(), spec).is_none());
    fake_install(
        root.path(),
        spec,
        1,
        serde_json::json!("dist/index.js"),
        "dist/index.js",
    );
    assert!(installed_bin(root.path(), spec).is_some());
}

#[test]
fn rewrites_to_node_with_the_installed_bin_and_cmd_env() {
    let root = tempfile::tempdir().unwrap();
    let spec = "@agentclientprotocol/claude-agent-acp@latest";
    fake_install(
        root.path(),
        spec,
        100,
        serde_json::json!({ "claude-agent-acp": "dist/index.js" }),
        "dist/index.js",
    );
    let install = installed_bin(root.path(), spec).expect("installed");
    assert!(install.bin.ends_with("dist/index.js") || install.bin.ends_with("dist\\index.js"));
    assert!(install.is_stale(UNIX_EPOCH + Duration::from_secs(100 + 24 * 60 * 60)));
    assert!(!install.is_stale(UNIX_EPOCH + Duration::from_secs(200)));

    let original = from_spawn(&format!(
        "cmd /c set ANTHROPIC_BASE_URL=http://gw&& npx -y {spec} --flag"
    ));
    let invocation = parse_npx_invocation(&original).unwrap();
    let rewritten = rewrite(original, &invocation, Path::new("node"), &install);
    assert_eq!(rewritten.command, PathBuf::from("node"));
    // Node is handed the process form of the bin path: on Windows the
    // canonical `\\?\` prefix is stripped, elsewhere it is the path itself.
    assert_eq!(rewritten.args[0], process_path_argument(&install.bin));
    assert_eq!(rewritten.args[1], "--flag");
    assert!(rewritten
        .env
        .iter()
        .any(|entry| entry.name == "ANTHROPIC_BASE_URL" && entry.value == "http://gw"));
    let path = rewritten
        .env
        .iter()
        .find(|entry| entry.name == "PATH")
        .unwrap();
    assert!(path.value.contains(".bin"));
}

#[test]
fn windows_process_paths_preserve_drive_unc_device_and_literal_paths() {
    for (input, expected) in [
        (
            r"\\?\C:\Program Files\ACP\entry.js",
            r"C:\Program Files\ACP\entry.js",
        ),
        (
            r"\\?\UNC\server\shared path\entry.js",
            r"\\server\shared path\entry.js",
        ),
        (
            r"C:\Program Files\ACP\entry.js",
            r"C:\Program Files\ACP\entry.js",
        ),
        (
            r"\\server\shared path\entry.js",
            r"\\server\shared path\entry.js",
        ),
        (
            r"\\?\Volume{identifier}\entry.js",
            r"\\?\Volume{identifier}\entry.js",
        ),
        (r"\\.\pipe\agent", r"\\.\pipe\agent"),
        (r"\\?\relative\entry.js", r"\\?\relative\entry.js"),
        ("/opt/ACP scripts/entry.js", "/opt/ACP scripts/entry.js"),
    ] {
        assert_eq!(normalize_windows_process_path(input), expected);
    }
    #[cfg(not(windows))]
    assert_eq!(
        process_path_argument(Path::new(r"\\?\C:\literal-unix-name.js")),
        r"\\?\C:\literal-unix-name.js"
    );
}

#[test]
fn non_node_bins_and_missing_installs_are_not_rewritten() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(installed_bin(root.path(), "pi-acp"), None);

    fake_install(
        root.path(),
        "native-agent",
        1,
        serde_json::json!("bin/agent"),
        "bin/agent",
    );
    let package_dir = root
        .path()
        .join(spec_key("native-agent"))
        .join("1/node_modules/native-agent");
    std::fs::write(package_dir.join("bin/agent"), [0x7f, b'E', b'L', b'F']).unwrap();
    assert_eq!(installed_bin(root.path(), "native-agent"), None);
}
