//! Tests for the update apply path (`apply.rs`).

use super::*;
use serde_json::json;

#[test]
fn exe_swap_installs_new_binary_and_keeps_backup() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("ryu-core.exe");
    let staged = dir.path().join("staged.bin");
    std::fs::write(&current, b"old binary").unwrap();
    std::fs::write(&staged, b"new binary").unwrap();
    replace_exe_at(&current, &staged).unwrap();
    assert_eq!(std::fs::read(&current).unwrap(), b"new binary");
    assert_eq!(
        std::fs::read(current.with_extension("old")).unwrap(),
        b"old binary"
    );
    assert!(!current.with_extension("new").exists());
    assert!(!staged.exists());
}

#[test]
fn exe_swap_failure_leaves_live_binary_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("ryu-core.exe");
    std::fs::write(&current, b"old binary").unwrap();
    let missing = dir.path().join("does-not-exist.bin");
    assert!(replace_exe_at(&current, &missing).is_err());
    assert_eq!(std::fs::read(&current).unwrap(), b"old binary");
}

fn asset() -> ReleaseAsset {
    ReleaseAsset {
        name: "ryu-core.zip".into(),
        url: format!(
            "https://github.com/{}/releases/download/v0.3.0/ryu-core.zip",
            super::super::RYU_REPO
        ),
        kind: "archive".into(),
        size: 123,
    }
}

#[test]
fn update_mutations_require_node_management_before_side_effects() {
    let source = include_str!("../server/mod.rs").replace("\r\n", "\n");
    for (handler, mutation) in [
        (
            "async fn update_apply(",
            "crate::update::apply::apply_update(",
        ),
        (
            "async fn schedule_update(",
            "crate::update::schedule::set_pending(",
        ),
        (
            "async fn cancel_update_schedule(",
            "crate::update::schedule::clear_pending(",
        ),
    ] {
        let body = source
            .split_once(handler)
            .unwrap()
            .1
            .split_once("\n}\n")
            .unwrap()
            .0;
        let permission = body
            .find("crate::identity_verify::permissions::NODES_MANAGE")
            .unwrap();
        assert!(body.contains("if let Err(status) = enforce_permission("));
        assert!(permission < body.find(mutation).unwrap(), "{handler}");
    }
}

#[test]
fn refuses_untrusted_update_paths_and_origins() {
    assert_eq!(release_tag(&asset()).unwrap(), "v0.3.0");
    for name in [
        "../ryu-core.zip",
        "/tmp/ryu-core.zip",
        "..\\ryu-core.zip",
        "ryu-core.zip?x",
        "ryu-core.zip#x",
    ] {
        let mut value = asset();
        value.name = name.into();
        assert!(release_tag(&value).is_err());
    }
    for url in [
        "http://github.com/other/file.zip",
        "https://evil.example/ryu-core.zip",
        "https://github.com/other/repo/releases/download/v0.3.0/ryu-core.zip",
    ] {
        let mut value = asset();
        value.url = url.into();
        assert!(release_tag(&value).is_err());
    }
}

#[test]
fn replace_exe_swaps_in_the_new_binary_and_keeps_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let live = dir.path().join("ryu-core");
    let staged = dir.path().join("staged");
    std::fs::write(&live, b"old").unwrap();
    std::fs::write(&staged, b"new").unwrap();

    replace_exe_at(&live, &staged).unwrap();

    assert_eq!(std::fs::read(&live).unwrap(), b"new");
    assert_eq!(std::fs::read(live.with_extension("old")).unwrap(), b"old");
    assert!(!live.with_extension("new").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&live).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}

#[test]
fn replace_exe_leaves_the_live_binary_when_the_new_one_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let live = dir.path().join("ryu-core");
    std::fs::write(&live, b"old").unwrap();

    assert!(replace_exe_at(&live, &dir.path().join("missing")).is_err());

    assert_eq!(std::fs::read(&live).unwrap(), b"old");
    assert!(!live.with_extension("new").exists());
}

#[test]
fn gateway_asset_is_read_from_the_same_release_and_verified_alike() {
    let hex = "cd".repeat(32);
    let name = "ryu-gateway-linux-x86_64";
    let url = format!(
        "https://github.com/{}/releases/download/v0.3.0/{name}",
        super::super::RYU_REPO
    );
    let release = json!({"tag_name":"v0.3.0","draft":false,"assets":[
        {"name":"ryu-core-linux-x86_64","browser_download_url":"x","size":1},
        {"name":name,"browser_download_url":url,"size":42,"digest":format!("sha256:{hex}")}
    ]});
    let asset = release_asset_named(&release, name).expect("gateway asset listed");
    assert_eq!(asset.url, url);
    assert_eq!(asset.size, 42);
    assert_eq!(release_digest(&asset, "v0.3.0", &release).unwrap(), hex);
    assert!(release_asset_named(&release, "ryu-gateway-windows-x86_64.exe").is_none());
}

#[test]
fn requires_matching_published_metadata_and_sha256() {
    let asset = asset();
    let digest = "ab".repeat(32);
    let mut release = json!({"tag_name":"v0.3.0", "draft":false, "assets":[{"name":asset.name,"browser_download_url":asset.url,"size":123,"digest":format!("sha256:{digest}")}]});
    assert_eq!(release_digest(&asset, "v0.3.0", &release).unwrap(), digest);
    for invalid in [
        serde_json::Value::Null,
        json!("sha256:bad"),
        json!("md5:abc"),
    ] {
        release["assets"][0]["digest"] = invalid;
        assert!(release_digest(&asset, "v0.3.0", &release).is_err());
    }
    release["assets"][0]["digest"] = json!(format!("sha256:{digest}"));
    release["draft"] = json!(true);
    assert!(release_digest(&asset, "v0.3.0", &release).is_err());
    release["draft"] = json!(false);
    release["assets"][0]["size"] = json!(124);
    assert!(release_digest(&asset, "v0.3.0", &release).is_err());
}

#[test]
fn apply_outcomes_carry_a_stable_id_values_and_an_english_sentence() {
    let result = ApplyResult::rendered(
        false,
        "/tmp/staged".into(),
        &ApplyOutcome::RunInstaller { kind: "dmg".into() },
        false,
        "en",
    );
    assert_eq!(result.message_id, "update.run_installer");
    assert_eq!(
        result.message,
        "Update downloaded. Run the dmg installer to complete the update."
    );
    assert_eq!(
        result.message_values.get("kind").map(String::as_str),
        Some("dmg")
    );
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["message_id"], "update.run_installer");
    assert_eq!(wire["message_values"]["kind"], "dmg");
    assert!(wire.get("gateway_left_behind").is_none());

    let left_behind = ApplyOutcome::GatewayLeftBehind {
        detail: "disk full".into(),
    };
    let result = ApplyResult::rendered(true, String::new(), &left_behind, true, "en");
    assert_eq!(result.message_id, "update.gateway_left_behind");
    assert!(result.message.contains("(disk full)"), "{}", result.message);
    assert_eq!(
        result.message_values.get("detail").map(String::as_str),
        Some("disk full")
    );
}

#[test]
fn apply_outcome_messages_are_rendered_through_the_catalog_locale() {
    // An unsupported tag falls back to the English source with values filled in.
    let message = ApplyOutcome::ReplaceBinary.message();
    assert_eq!(
        message.render("xx"),
        "Update downloaded. Extract and replace the binary to complete the update."
    );
    for outcome in [
        ApplyOutcome::InstalledWithGateway,
        ApplyOutcome::Installed,
        ApplyOutcome::ReplaceBinary,
    ] {
        assert!(outcome.values().is_empty());
        assert!(!outcome.message().render("de").contains('{'));
    }
}
