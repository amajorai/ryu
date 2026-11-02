use std::io;

use base64::Engine as _;

use super::{
    download_preference, install_then_clear, is_prepared_newer, prepared_metadata_matches_feed,
    verify_minisign, AppUpdateSource, PreparedUpdateCandidate, PreparedUpdateStore,
};

const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

fn encoded(value: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(value)
}

fn candidate(version: &str) -> PreparedUpdateCandidate {
    PreparedUpdateCandidate {
        signature: encoded(SIGNATURE),
        source: AppUpdateSource::Stable,
        version: version.to_string(),
    }
}

#[test]
fn packaged_distribution_routes_every_source_without_changing_validation() {
    let base = "https://localhost:9443/releases";
    assert_eq!(
        AppUpdateSource::Stable.endpoint_with_base(base).unwrap(),
        format!("{base}/latest/download/latest.json")
    );
    for channel in ["beta", "nightly", "canary"] {
        let expected = if channel == "beta" {
            format!("{base}/latest/download/latest-beta.json")
        } else {
            format!("{base}/download/{channel}/latest-{channel}.json")
        };
        assert_eq!(
            AppUpdateSource::Channel {
                channel: channel.into()
            }
            .endpoint_with_base(base)
            .unwrap(),
            expected
        );
    }
    assert_eq!(
        AppUpdateSource::Tag {
            tag: "v0.4.0".into(),
            channel: "stable".into()
        }
        .endpoint_with_base(base)
        .unwrap(),
        format!("{base}/download/v0.4.0/latest.json")
    );
    assert!(AppUpdateSource::Tag {
        tag: "../v0.4.0".into(),
        channel: "stable".into()
    }
    .endpoint_with_base(base)
    .is_err());
    for channel in ["nightly", "canary"] {
        let tag = format!("v0.4.1-{channel}.20260804.36");
        assert_eq!(
            AppUpdateSource::Tag {
                tag: tag.clone(),
                channel: channel.into()
            }
            .endpoint_with_base(base)
            .unwrap(),
            format!("{base}/download/{tag}/latest-{channel}.json")
        );
    }
}

#[test]
fn bot_build_reads_its_own_feed_family() {
    let base = "https://github.com/amajorai/ryu/releases";
    let stem = crate::distribution::feed_stem("ai.amajor.ryu.bot");
    assert_eq!(
        AppUpdateSource::Stable
            .endpoint_for_product(base, stem)
            .unwrap(),
        format!("{base}/latest/download/latest-bot.json")
    );
    assert_eq!(
        AppUpdateSource::Channel {
            channel: "beta".into()
        }
        .endpoint_for_product(base, stem)
        .unwrap(),
        format!("{base}/latest/download/latest-bot-beta.json")
    );
    assert!(AppUpdateSource::Channel {
        channel: "nightly".into()
    }
    .endpoint_for_product(base, stem)
    .is_err());
    assert_eq!(
        AppUpdateSource::Tag {
            tag: "v0.4.0".into(),
            channel: "beta".into()
        }
        .endpoint_for_product(base, stem)
        .unwrap(),
        format!("{base}/download/v0.4.0/latest-bot-beta.json")
    );
    assert!(AppUpdateSource::Tag {
        tag: "v0.4.1-canary.1".into(),
        channel: "canary".into()
    }
    .endpoint_for_product(base, stem)
    .is_err());
    assert_eq!(
        crate::distribution::feed_stem("ai.amajor.ryu.desktop"),
        "latest"
    );
}

#[test]
fn update_sources_only_resolve_app_owned_https_feeds() {
    let stable = AppUpdateSource::Stable.endpoint().expect("stable endpoint");
    assert_eq!(
        stable.as_str(),
        "https://github.com/amajorai/ryu/releases/latest/download/latest.json"
    );

    let nightly = AppUpdateSource::Channel {
        channel: "nightly".to_string(),
    }
    .endpoint()
    .expect("nightly endpoint");
    assert_eq!(
        nightly.as_str(),
        "https://github.com/amajorai/ryu/releases/download/nightly/latest-nightly.json"
    );

    let pinned = AppUpdateSource::Tag {
        tag: "v0.2.1".to_string(),
        channel: "stable".to_string(),
    }
    .endpoint()
    .expect("pinned endpoint");
    assert_eq!(
        pinned.as_str(),
        "https://github.com/amajorai/ryu/releases/download/v0.2.1/latest.json"
    );
}

#[test]
fn update_sources_reject_path_traversal_and_unknown_channels() {
    let traversal = AppUpdateSource::Tag {
        tag: "../v0.2.1".to_string(),
        channel: "stable".to_string(),
    };
    assert!(traversal.endpoint().is_err());

    let unknown = AppUpdateSource::Channel {
        channel: "preview".to_string(),
    };
    assert!(unknown.endpoint().is_err());

    let injected = AppUpdateSource::Tag {
        tag: "v0.2.1".to_string(),
        channel: "stable/../../nightly".to_string(),
    };
    assert!(injected.endpoint().is_err());
}

#[test]
fn minisign_verification_accepts_the_signed_bytes_and_rejects_tampering() {
    let public_key = encoded(PUBLIC_KEY);
    let signature = encoded(SIGNATURE);
    assert!(verify_minisign(b"test", &signature, &public_key).is_ok());
    assert!(verify_minisign(b"Test", &signature, &public_key).is_err());
}

#[test]
fn prepared_store_commits_the_manifest_last_and_preserves_the_previous_record() {
    let root = tempfile::tempdir().expect("temporary cache");
    let store = PreparedUpdateStore::new(root.path().to_path_buf());
    store
        .commit(candidate("0.2.1"), b"old artifact")
        .expect("first prepared update");

    let failed = store.commit_with_manifest_writer(
        candidate("0.2.2"),
        b"new artifact",
        |_directory, _manifest| Err(io::Error::other("simulated manifest failure")),
    );
    assert!(failed.is_err());

    let prepared = store.read().expect("read cache").expect("prepared update");
    assert_eq!(prepared.version, "0.2.1");
    assert_eq!(
        store.artifact_bytes(&prepared).expect("old artifact"),
        b"old artifact"
    );
}

#[test]
fn prepared_store_keeps_only_the_committed_artifact() {
    let root = tempfile::tempdir().expect("temporary cache");
    let store = PreparedUpdateStore::new(root.path().to_path_buf());
    store
        .commit(candidate("0.2.1"), b"old artifact")
        .expect("first prepared update");
    let current = store
        .commit(candidate("0.2.2"), b"new artifact")
        .expect("replacement prepared update");

    let entries = std::fs::read_dir(root.path())
        .expect("list cache")
        .collect::<Result<Vec<_>, _>>()
        .expect("cache entries");
    assert_eq!(entries.len(), 2, "manifest plus one artifact");
    assert_eq!(
        store.artifact_bytes(&current).expect("new artifact"),
        b"new artifact"
    );
}

#[test]
fn automatic_download_defaults_on_and_only_an_explicit_false_disables_it() {
    assert!(download_preference(None));
    assert!(download_preference(Some(&serde_json::json!("invalid"))));
    assert!(download_preference(Some(&serde_json::json!(true))));
    assert!(!download_preference(Some(&serde_json::json!(false))));
}

#[test]
fn runtime_gate_reopens_on_failure_and_stays_closed_until_successful_relaunch() {
    assert!(!super::runtime_update_in_progress());
    {
        let _guard = super::RuntimeUpdateGuard::enter().unwrap();
        assert!(super::runtime_update_in_progress());
        assert!(super::RuntimeUpdateGuard::enter().is_err());
    }
    assert!(!super::runtime_update_in_progress());
    let mut guard = super::RuntimeUpdateGuard::enter().unwrap();
    guard.wait_for_relaunch();
    drop(guard);
    assert!(super::runtime_update_in_progress());
    super::RUNTIME_UPDATE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[test]
fn prepared_version_must_be_strictly_newer_than_the_running_app() {
    assert!(is_prepared_newer("0.2.1", "0.2.0"));
    assert!(!is_prepared_newer("0.2.1", "0.2.1"));
    assert!(!is_prepared_newer("0.2.0", "0.2.1"));
    assert!(!is_prepared_newer("not-semver", "0.2.0"));
}

#[test]
fn prepared_metadata_must_match_the_current_signed_feed() {
    assert!(prepared_metadata_matches_feed(
        "0.2.1",
        "signature-a",
        "0.2.1",
        "signature-a"
    ));
    assert!(!prepared_metadata_matches_feed(
        "0.2.2",
        "signature-a",
        "0.2.1",
        "signature-a"
    ));
    assert!(!prepared_metadata_matches_feed(
        "0.2.1",
        "signature-a",
        "0.2.1",
        "signature-b"
    ));
    assert!(!prepared_metadata_matches_feed(
        "not-semver",
        "signature-a",
        "also-invalid",
        "signature-a"
    ));
}

#[test]
fn prepared_store_rejects_bytes_changed_after_commit() {
    let root = tempfile::tempdir().expect("temporary cache");
    let store = PreparedUpdateStore::new(root.path().to_path_buf());
    let prepared = store
        .commit(candidate("0.2.1"), b"test")
        .expect("prepared update");
    assert!(store
        .verified_artifact(&prepared, &encoded(PUBLIC_KEY))
        .is_ok());

    std::fs::write(root.path().join(&prepared.artifact_file), b"Test").expect("tamper artifact");
    assert!(store
        .verified_artifact(&prepared, &encoded(PUBLIC_KEY))
        .is_err());
}

#[test]
fn clearing_a_prepared_update_removes_manifest_and_artifacts() {
    let root = tempfile::tempdir().expect("temporary cache");
    let store = PreparedUpdateStore::new(root.path().to_path_buf());
    store
        .commit(candidate("0.2.1"), b"test")
        .expect("prepared update");

    store.clear().expect("clear cache");

    assert!(store.read().expect("read cache").is_none());
    assert_eq!(
        std::fs::read_dir(root.path()).expect("list cache").count(),
        0
    );
}

#[test]
fn failed_install_keeps_the_verified_download_available_for_retry() {
    let root = tempfile::tempdir().expect("temporary cache");
    let store = PreparedUpdateStore::new(root.path().to_path_buf());
    let prepared = store
        .commit(candidate("0.2.1"), b"test")
        .expect("prepared update");

    let error = install_then_clear(&store, || Err("simulated install failure".to_string()))
        .expect_err("install must fail");

    assert_eq!(error, "simulated install failure");
    assert_eq!(
        store.read().expect("read cache after failure"),
        Some(prepared)
    );
}

#[test]
fn successful_install_clears_the_prepared_download() {
    let root = tempfile::tempdir().expect("temporary cache");
    let store = PreparedUpdateStore::new(root.path().to_path_buf());
    store
        .commit(candidate("0.2.1"), b"test")
        .expect("prepared update");

    install_then_clear(&store, || Ok(())).expect("install and clear");

    assert!(store.read().expect("read cache after install").is_none());
}

#[test]
fn auxiliary_windows_cannot_change_app_updates() {
    assert!(super::require_update_window("main").is_ok());
    for label in ["", "capture", "settings", "main-2"] {
        assert!(super::require_update_window(label).is_err());
    }
}
