//! Relocation and profile-copy tree walks and their exclusions.

use super::*;

#[test]
fn copy_tree_replicates_files_and_subdirs_with_byte_count() {
    let base = std::env::temp_dir().join(format!("ryu-dp-copy-{}", uniq()));
    let from = base.join("from");
    let sub = from.join("nested");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(from.join("a.txt"), b"hello").unwrap();
    std::fs::write(sub.join("b.txt"), b"world!").unwrap();
    let to = base.join("to");

    let mut copied = 0u64;
    let mut ticks = 0u32;
    copy_tree(&from, &to, &mut copied, &mut |_| ticks += 1).unwrap();

    assert_eq!(copied, 11, "5 + 6 bytes copied");
    assert_eq!(ticks, 2, "on_bytes fires once per file");
    assert_eq!(std::fs::read(to.join("a.txt")).unwrap(), b"hello");
    assert_eq!(std::fs::read(to.join("nested/b.txt")).unwrap(), b"world!");
    let _ = std::fs::remove_dir_all(&base);
}

#[cfg(unix)]
#[test]
fn copy_tree_and_profile_copy_recreate_relative_symlinks() {
    let base = std::env::temp_dir().join(format!("ryu-dp-symlink-{}", uniq()));
    let from = base.join("from");
    let engine = from.join("engines/llm/llamacpp");
    std::fs::create_dir_all(&engine).unwrap();
    std::fs::write(engine.join("libllama.1.dylib"), b"lib").unwrap();
    std::os::unix::fs::symlink("libllama.1.dylib", engine.join("libllama.dylib")).unwrap();

    for (label, to) in [
        ("copy_tree", base.join("to")),
        ("filtered", base.join("profile")),
    ] {
        let mut copied = 0u64;
        if label == "copy_tree" {
            copy_tree(&from, &to, &mut copied, &mut |_| {}).unwrap();
        } else {
            copy_tree_filtered(&from, &to, &mut copied, &mut |_| {}).unwrap();
        }
        let alias = to.join("engines/llm/llamacpp/libllama.dylib");
        assert!(
            std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{label}: alias stays a symlink"
        );
        assert_eq!(
            std::fs::read_link(&alias).unwrap(),
            Path::new("libllama.1.dylib"),
            "{label}: target copied verbatim"
        );
        assert_eq!(
            std::fs::read(&alias).unwrap(),
            b"lib",
            "{label}: alias resolves"
        );
    }
    let _ = std::fs::remove_dir_all(&base);
}

// ── profile copy ────────────────────────────────────────────────────────────

/// Every entry here has a concrete failure if it travels. Pinned as a list so
/// removing one is a deliberate act with a visible diff, not an oversight.
#[test]
fn node_identity_and_runtime_files_never_travel_between_profiles() {
    for name in [
        "secrets/core.token", // target would claim the source's node identity (409 on init)
        "secrets/master.key", // key material travels only through the keychain copy operation
        "secrets/memory.key", // retired legacy raw key must never be resurrected on the target
        "secrets/node-auth.token", // this node's minted RYU_TOKEN — copying it leaks the secret
        "state/nodes.json",   // absolute URLs with the SOURCE profile's hardcoded port
        "secrets/auth.json",  // plaintext device sign-in token
        "state/ryu-core.pid", // the source's live process id
        ".reset-pending",     // a pending wipe would fire on the target
        "bin",                // .version markers make the target adopt source binaries
        "tmp",
        "cache",
    ] {
        assert!(
            is_profile_copy_excluded(name),
            "'{name}' must not travel between profiles"
        );
    }
}

/// The user's actual content MUST travel, or the feature is pointless.
#[test]
fn user_content_does_travel() {
    for name in [
        "db",
        "db/conversations.db",
        "db/spaces.db",
        "db/agents.db",
        "db/plugins.db",
        "db/preferences.db",
        "files",
        "files/media",
        "models",
        "plugins",
        "state",
        "state/workflows",
        "secrets",
    ] {
        assert!(
            !is_profile_copy_excluded(name),
            "'{name}' is user content and must be copied"
        );
    }
}

/// The exclusion matches exact data-dir-relative paths. A plugin that keeps
/// its own `cache/` inside its data directory is the plugin's business, and
/// dropping it would corrupt that plugin's state rather than protect anything.
#[test]
fn exclusion_is_by_exact_path_not_by_substring() {
    assert!(is_profile_copy_excluded("cache"));
    assert!(!is_profile_copy_excluded("plugin-data/acme/cache"));
    assert!(!is_profile_copy_excluded("my-cache"));
    assert!(is_profile_copy_excluded("bin"));
    assert!(!is_profile_copy_excluded("binaries"));
    assert!(!is_profile_copy_excluded("nodes.json"));
}

/// The predicate tests above prove intent; this proves the COPY. Excluded
/// entries must be absent from the target and user content must arrive byte
/// for byte — "data intact" is the entire point of the feature.
#[test]
fn copy_tree_filtered_drops_identity_files_and_preserves_content() {
    let base = std::env::temp_dir().join(format!("ryu-cpf-{}", uniq()));
    let from = base.join("src");
    let to = base.join("dst");
    std::fs::create_dir_all(from.join("bin")).unwrap();
    std::fs::create_dir_all(from.join("files/media/clips")).unwrap();
    std::fs::create_dir_all(from.join("plugin-data/acme/cache")).unwrap();
    std::fs::create_dir_all(from.join("secrets")).unwrap();
    std::fs::create_dir_all(from.join("state")).unwrap();
    std::fs::create_dir_all(from.join("db")).unwrap();

    // Must NOT travel.
    std::fs::write(from.join("secrets/core.token"), b"node-identity").unwrap();
    std::fs::write(from.join("secrets/master.key"), b"raw-master-key").unwrap();
    std::fs::write(from.join("secrets/memory.key"), b"raw-legacy-key").unwrap();
    std::fs::write(
        from.join("state/nodes.json"),
        b"{\"url\":\"127.0.0.1:7980\"}",
    )
    .unwrap();
    std::fs::write(from.join("state/ryu-core.pid"), b"1234").unwrap();
    std::fs::write(from.join("bin/ryu-core"), b"ELF").unwrap();

    // Must travel.
    let db = b"SQLite format 3\0payload";
    std::fs::write(from.join("db/conversations.db"), db).unwrap();
    std::fs::write(from.join("state/catalog-sources.json"), b"{}").unwrap();
    std::fs::write(from.join("files/media/clips/a.mp4"), b"video-bytes").unwrap();
    // A plugin's OWN nested cache is its business — exact-path exclusion only.
    std::fs::write(from.join("plugin-data/acme/cache/warm"), b"warm").unwrap();

    let mut copied = 0u64;
    let mut sink = |_: u64| {};
    copy_tree_filtered(&from, &to, &mut copied, &mut sink).unwrap();

    for gone in [
        "secrets/core.token",
        "secrets/master.key",
        "secrets/memory.key",
        "state/nodes.json",
        "state/ryu-core.pid",
        "bin",
    ] {
        assert!(
            !to.join(gone).exists(),
            "'{gone}' must not be copied between profiles"
        );
    }
    assert_eq!(
        std::fs::read(to.join("db/conversations.db")).unwrap(),
        db,
        "user content must arrive byte for byte"
    );
    assert!(to.join("state/catalog-sources.json").exists());
    assert_eq!(
        std::fs::read(to.join("files/media/clips/a.mp4")).unwrap(),
        b"video-bytes"
    );
    assert!(
        to.join("plugin-data/acme/cache/warm").exists(),
        "a NESTED cache dir belongs to the plugin and must survive"
    );
    assert!(copied > 0, "byte counter must advance");

    let _ = std::fs::remove_dir_all(&base);
}

/// Copying onto a profile that already has data is refused. `check_target`
/// enforces it, but assert it here too: this is the path a user reaches from a
/// Settings button, where "it merged into my existing canary" is unrecoverable.
#[test]
fn copying_into_a_non_empty_profile_is_refused() {
    let tmp = std::env::temp_dir().join(format!("ryu-copy-profile-test-{}", std::process::id()));
    let from = tmp.join("src");
    let to = tmp.join("dst");
    std::fs::create_dir_all(&from).unwrap();
    std::fs::create_dir_all(&to).unwrap();
    std::fs::write(to.join("conversations.db"), b"existing").unwrap();

    let result = validate_target(&from, &to, false);
    assert!(!result.ok, "a non-empty target must be refused");
    let err = result.error.expect("an error message");
    assert!(
        err.to_lowercase().contains("empty"),
        "error should explain the target is not empty, got: {err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}
