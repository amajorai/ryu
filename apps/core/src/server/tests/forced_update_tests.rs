use crate::server::{
    forced_update_version_keys, restore_cleared_version_record, sidecars_sharing_install,
};
use crate::sidecar::download_manager::VersionStore;
use crate::sidecar::providers::{outetts, parakeet, ryutts};

#[test]
fn llamacpp_and_its_embed_engine_stop_the_whole_shared_install() {
    let family = [
        "llamacpp",
        "llamacpp-embed",
        "llamacpp-rerank",
        "llamacpp-classify",
        "llamacpp-speech",
        "llamacpp-guard",
        "outetts",
    ];
    assert_eq!(sidecars_sharing_install("llamacpp"), family);
    assert_eq!(sidecars_sharing_install("llamacpp-embed"), family);
}

#[test]
fn other_sidecars_stop_only_themselves_and_unknown_names_stop_nothing() {
    assert_eq!(sidecars_sharing_install("whispercpp"), ["whispercpp"]);
    assert_eq!(
        sidecars_sharing_install("llamacpp-rerank"),
        ["llamacpp-rerank"]
    );
    assert!(sidecars_sharing_install("not-a-sidecar").is_empty());
}

#[test]
fn forced_update_clears_each_per_artifact_version_record() {
    assert_eq!(
        forced_update_version_keys("parakeet"),
        ["parakeet", parakeet::downloader::MODEL_STORE_KEY]
    );
    assert_eq!(
        forced_update_version_keys("outetts"),
        [
            "outetts",
            outetts::downloader::MODEL_STORE_KEY,
            outetts::downloader::VOCODER_STORE_KEY,
        ]
    );
    assert_eq!(
        forced_update_version_keys("ryutts"),
        [
            "ryutts",
            ryutts::kokoro::MODEL_STORE_KEY,
            ryutts::kokoro::VOICES_STORE_KEY,
        ]
    );
    assert_eq!(
        forced_update_version_keys("llamacpp-embed"),
        ["llamacpp-embed", "llamacpp"]
    );
    assert_eq!(forced_update_version_keys("whispercpp"), ["whispercpp"]);
    assert_eq!(
        forced_update_version_keys("not-a-sidecar"),
        ["not-a-sidecar"]
    );
}

#[test]
fn restoring_a_cleared_record_never_overwrites_one_the_installer_wrote() {
    let configured =
        std::path::PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
    assert!(configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp"));
    assert_eq!(crate::paths::ryu_dir(), configured);

    let missing = format!("restore-proof-missing-{}", uuid::Uuid::new_v4());
    restore_cleared_version_record(&missing, "1.0.0", Some("abc123"));
    let store = VersionStore::load();
    assert_eq!(
        store.versions.get(&missing).map(String::as_str),
        Some("1.0.0")
    );
    assert_eq!(store.installed_checksum(&missing), Some("abc123"));

    let unchecked = format!("restore-proof-unchecked-{}", uuid::Uuid::new_v4());
    restore_cleared_version_record(&unchecked, "2.0.0", None);
    assert_eq!(
        VersionStore::load()
            .versions
            .get(&unchecked)
            .map(String::as_str),
        Some("2.0.0")
    );

    let rewritten = format!("restore-proof-rewritten-{}", uuid::Uuid::new_v4());
    VersionStore::record_persisted(&rewritten, "3.1.0", "new").unwrap();
    restore_cleared_version_record(&rewritten, "3.0.0", Some("old"));
    let store = VersionStore::load();
    assert_eq!(
        store.versions.get(&rewritten).map(String::as_str),
        Some("3.1.0")
    );
    assert_eq!(store.installed_checksum(&rewritten), Some("new"));

    for key in [missing, unchecked, rewritten] {
        VersionStore::remove_persisted(&key).unwrap();
    }
}
