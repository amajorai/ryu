//! Target validation, sizes, maintenance leases and CLI argument guards.

use super::*;

#[test]
fn mutating_maintenance_requires_stopped_runtime_but_export_can_read_online() {
    let base = tempfile::tempdir().unwrap();
    let data = base.path().join("data");
    std::fs::create_dir_all(data.join("nested")).unwrap();
    let cache = dirs::cache_dir().unwrap().join("ryu-update-recovery");
    let runtime =
        ryu_runtime_install::data_lease::DataLease::writer(&cache, &[data.clone()]).unwrap();
    assert!(maintenance_lease(&[data.join("nested")], true).is_err());
    assert!(maintenance_lease(&[data.clone()], false).is_ok());
    drop(runtime);
    assert!(maintenance_lease(&[data], true).is_ok());
}

#[test]
fn human_bytes_scales() {
    assert_eq!(human_bytes(512), "512.0 B");
    assert_eq!(human_bytes(1024), "1.0 KB");
    assert_eq!(human_bytes(1024 * 1024), "1.0 MB");
}

#[test]
fn validate_rejects_nested_target() {
    let base = std::env::temp_dir();
    let src = base.join("ryu-validate-src");
    let nested = src.join("inside");
    let r = validate_target(&src, &nested, false);
    assert!(!r.ok);
}

#[test]
fn human_bytes_scales_to_gb_and_tb() {
    assert_eq!(human_bytes(1024u64.pow(3)), "1.0 GB");
    assert_eq!(human_bytes(1024u64.pow(4)), "1.0 TB");
    // Beyond TB stays in TB (the top unit), never overflows the table.
    assert_eq!(human_bytes(5 * 1024u64.pow(5)), "5120.0 TB");
    assert_eq!(human_bytes(1536), "1.5 KB");
}

#[test]
fn check_target_rejects_empty_and_relative_paths() {
    let src = std::env::temp_dir().join(format!("ryu-dp-src-{}", uniq()));
    // Empty target.
    let r = validate_target(&src, std::path::Path::new(""), false);
    assert!(!r.ok);
    assert!(r.error.unwrap().contains("empty"));
    // Relative target.
    let r = validate_target(&src, std::path::Path::new("relative/dir"), false);
    assert!(!r.ok);
    assert!(r.error.unwrap().contains("absolute"));
}

#[test]
fn check_target_rejects_non_empty_dir() {
    let base = std::env::temp_dir().join(format!("ryu-dp-nonempty-{}", uniq()));
    let src = base.join("src");
    let target = base.join("target");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("existing.txt"), b"x").unwrap();

    let r = validate_target(&src, &target, false);
    assert!(!r.ok);
    assert!(r.error.unwrap().contains("not empty"));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn check_target_accepts_empty_absolute_writable_target() {
    let base = std::env::temp_dir().join(format!("ryu-dp-ok-{}", uniq()));
    let src = base.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("db.sqlite"), b"data").unwrap();
    // A not-yet-existing absolute path under a distinct base is accepted.
    let target = base.join("dest");

    let r = validate_target(&src, &target, false);
    assert!(r.ok, "unexpected error: {:?}", r.error);
    assert!(r.source_size_bytes >= 4);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn run_cli_returns_false_without_the_data_path_token() {
    // No "data-path" argument → not consumed, Core boots normally.
    assert!(!run_cli(&["ryu-core".to_string(), "serve".to_string()]));
    assert!(!run_cli(&[]));
}

/// Task #101. Every destructive profile flag on this CLI must be rejected
/// unless it NAMES a known profile — because `suffix_for` silently maps an
/// unknown or empty name onto the release suffix.
#[test]
fn an_unknown_or_empty_profile_flag_is_rejected() {
    assert!(!is_known_profile_arg(""), "the empty-string hole itself");
    assert!(!is_known_profile_arg("   "));
    assert!(!is_known_profile_arg("canary "), "no implicit trimming");
    assert!(!is_known_profile_arg("Canary"), "no implicit lowercasing");
    assert!(!is_known_profile_arg("typo"));
    assert!(
        !is_known_profile_arg("."),
        "a path fragment is not a profile"
    );
    assert!(!is_known_profile_arg(".."));
    // The names that must keep working.
    assert!(is_known_profile_arg("release"));
    assert!(is_known_profile_arg("dev"));
    assert!(is_known_profile_arg("canary"));
    assert!(is_known_profile_arg("nightly"));
    assert!(is_known_profile_arg("beta"));
}

/// WHY that guard is load-bearing, as assertions rather than a comment.
///
/// `suffix_for` maps an unknown name to `-<name>` verbatim, so an unvalidated
/// flag names a REAL, containment-legal directory that is simply the wrong
/// one — and the containment guard cannot object, because `~/.ryu-canry` is a
/// perfectly legal single component under home. The failure mode is a
/// destructive command that reports success having touched nothing (or, for
/// `copy-profile`, having written a junk root).
#[test]
fn an_unvalidated_profile_name_aims_at_a_real_but_wrong_directory() {
    // Not the release suffix — but not rejected by anything downstream either.
    assert_eq!(crate::profile::suffix_for(""), "-");
    assert_eq!(crate::profile::suffix_for("canry"), "-canry");
    assert_ne!(
        crate::profile::suffix_for("canry"),
        crate::profile::suffix_for("canary"),
        "a typo silently names a DIFFERENT profile root"
    );

    let home = std::env::temp_dir().join(format!("ryu-unvalidated-{}", uniq()));
    for name in ["", "canry", "Canary"] {
        let dir = home.join(format!(".ryu{}", crate::profile::suffix_for(name)));
        assert_eq!(
            dir.strip_prefix(&home).map(|r| r.components().count()),
            Ok(1),
            "'{name}' passes the containment guard, so only a name check can stop it"
        );
        assert!(!is_known_profile_arg(name));
    }
}
