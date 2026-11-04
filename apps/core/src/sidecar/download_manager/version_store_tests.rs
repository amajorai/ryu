//! Tests for [`super::VersionStore`].

use super::*;

/// Recording a second engine must not drop the first. This is the in-memory
/// invariant the `*_persisted` helpers rely on to let multiple local engines
/// (e.g. llama.cpp + ollama) coexist in versions.json.
#[test]
fn record_preserves_other_engines() {
    let mut store = VersionStore::default();
    store.record("llamacpp", "b8373", "aaa");
    store.record("ollama", "v0.5.0", "bbb");

    assert_eq!(store.versions.get("llamacpp"), Some(&"b8373".to_string()));
    assert_eq!(store.versions.get("ollama"), Some(&"v0.5.0".to_string()));
    assert_eq!(store.checksums.get("llamacpp"), Some(&"aaa".to_string()));
    assert_eq!(store.checksums.get("ollama"), Some(&"bbb".to_string()));
}

/// Setting a version (no checksum) must also leave sibling engines intact.
#[test]
fn insert_version_preserves_other_engines() {
    let mut store = VersionStore::default();
    store
        .versions
        .insert("llamacpp".to_string(), "b8373".to_string());
    store
        .versions
        .insert("ollama".to_string(), "v0.5.0".to_string());

    assert_eq!(store.versions.len(), 2);
    assert!(store.versions.contains_key("llamacpp"));
    assert!(store.versions.contains_key("ollama"));
}

/// Removing one engine leaves the others installed.
#[test]
fn remove_drops_only_named_engine() {
    let mut store = VersionStore::default();
    store.record("llamacpp", "b8373", "aaa");
    store.record("ollama", "v0.5.0", "bbb");

    store.versions.remove("ollama");
    store.checksums.remove("ollama");

    assert!(store.versions.contains_key("llamacpp"));
    assert!(!store.versions.contains_key("ollama"));
}

#[test]
fn version_store_serde_round_trips() {
    let mut store = VersionStore::default();
    store.record("llamacpp", "b10218", "deadbeef");
    let json = serde_json::to_string(&store).unwrap();
    let back: VersionStore = serde_json::from_str(&json).unwrap();
    assert_eq!(back.versions.get("llamacpp"), Some(&"b10218".to_string()));
    assert_eq!(back.installed_checksum("llamacpp"), Some("deadbeef"));
}

#[test]
fn installed_version_parses_semver_only() {
    let mut store = VersionStore::default();
    store.record("ollama", "0.5.1", "x");
    store.record("llamacpp", "b10218", "y"); // not semver
    assert_eq!(
        store.installed_version("ollama"),
        Some(semver::Version::new(0, 5, 1))
    );
    // Non-semver engine version strings yield None (still "installed" by key).
    assert!(store.installed_version("llamacpp").is_none());
    assert!(store.installed_version("absent").is_none());
}

#[test]
fn record_overwrites_existing_entry() {
    let mut store = VersionStore::default();
    store.record("ollama", "0.5.0", "old");
    store.record("ollama", "0.6.0", "new");
    assert_eq!(store.versions.get("ollama"), Some(&"0.6.0".to_string()));
    assert_eq!(store.installed_checksum("ollama"), Some("new"));
}

#[test]
fn version_store_load_defaults_on_bad_json() {
    // `from_str` failure path: garbage deserializes to the default store.
    let parsed: Option<VersionStore> = serde_json::from_str("{ not json").ok();
    assert!(parsed.is_none());
    assert!(VersionStore::default().versions.is_empty());
}

/// A pinned thread records and reads installs in its own data dir, so a reused
/// `RYU_DIR` that lists llama.cpp cannot leak into the pinned test.
#[test]
fn a_pinned_thread_keeps_its_own_versions_file() {
    let dir = tempfile::tempdir().unwrap();
    let _pin = crate::sidecar::active_engine::test_state::pin(dir.path());
    assert!(VersionStore::load().versions.is_empty());
    VersionStore::record_persisted("llamacpp", "b8373", "aaa").unwrap();
    assert!(ryu_sidecar_runtime::layout::state_path(dir.path(), "versions.json").is_file());
    assert_eq!(
        VersionStore::load()
            .versions
            .get("llamacpp")
            .map(String::as_str),
        Some("b8373")
    );
}
