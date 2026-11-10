//! Deep clean and profile data clean.

use super::*;
use crate::data_path::clean::{auxiliary_roots, clean_profile_data, deep_clean, CleanDepth};

// ── deep clean ──────────────────────────────────────────────────────────────

/// A node reset wipes only the DATA dir, so these roots survive it. Pinned as
/// a list because each one is several gigabytes or carries real config, and a
/// user who clicked "reset node" reasonably expects them gone.
#[test]
fn deep_clean_targets_the_roots_a_node_reset_never_reaches() {
    let home = if cfg!(windows) {
        std::env::temp_dir().join("ryu-test-home")
    } else {
        std::path::PathBuf::from("/home/tester")
    };
    let config = home.join(".config");
    let roots = auxiliary_roots(Some(&config), "-canary");
    let paths: Vec<String> = roots
        .iter()
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .collect();
    assert_eq!(paths.len(), 1, "shadow/ghost live under the data dir now");
    // The config dir IS profile-suffixed — clearing release's must never take
    // canary's gateway.toml with it.
    assert!(paths.contains(&config.join("ryu-canary").to_string_lossy().to_string()));
    assert!(!paths.contains(&config.join("ryu").to_string_lossy().to_string()));
}

/// Deleting a real tree, and proving the home-containment guard bites.
#[test]
fn deep_clean_removes_only_paths_inside_home() {
    let base = std::env::temp_dir().join(format!("ryu-dc-{}", uniq()));
    let home = base.join("home");
    let config = home.join(".config");
    std::fs::create_dir_all(config.join("ryu")).unwrap();
    std::fs::write(config.join("ryu/gateway.toml"), b"[gateway]").unwrap();
    // Must survive: not one of the auxiliary roots.
    std::fs::create_dir_all(home.join(".ryu")).unwrap();

    let removed = deep_clean(&home, Some(&config), "");
    assert_eq!(removed.len(), 1, "the config dir");
    assert!(!config.join("ryu").exists());
    assert!(
        home.join(".ryu").exists(),
        "the DATA dir is the node reset's job, not deep-clean's"
    );

    // Second run is a no-op rather than an error.
    assert!(deep_clean(&home, Some(&config), "").is_empty());
    let _ = std::fs::remove_dir_all(&base);
}

/// `state` keeps the multi-GB downloads; `full` does not. Re-fetching an
/// engine is the slowest possible route back to a clean node.
#[test]
fn a_state_clean_keeps_the_downloads_and_a_full_clean_does_not() {
    let base = std::env::temp_dir().join(format!("ryu-cd-{}", uniq()));
    let home = base.join("home");
    let dir = home.join(".ryu-canary");
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::create_dir_all(dir.join("models")).unwrap();
    std::fs::create_dir_all(dir.join("engines")).unwrap();
    std::fs::create_dir_all(dir.join("plugins")).unwrap();
    std::fs::create_dir_all(dir.join("db")).unwrap();
    std::fs::create_dir_all(dir.join("secrets")).unwrap();
    std::fs::write(dir.join("db/conversations.db"), b"db").unwrap();
    std::fs::write(dir.join("bin/ryu-core"), b"ELF").unwrap();
    std::fs::write(dir.join("secrets/master.key"), b"key").unwrap();
    std::fs::write(dir.join("secrets/core.token"), b"token").unwrap();

    assert!(!clean_profile_data(&home, "-canary", CleanDepth::State).is_empty());
    assert!(
        dir.join("bin/ryu-core").exists(),
        "bin survives a state clean"
    );
    assert!(dir.join("models").exists(), "models survive a state clean");
    assert!(
        dir.join("engines").exists(),
        "engines survive a state clean"
    );
    assert!(
        dir.join("secrets/master.key").exists(),
        "the key is node identity and must survive — there is no rekey path"
    );
    assert!(!dir.join("secrets/core.token").exists());
    assert!(!dir.join("db").exists());
    assert!(!dir.join("plugins").exists());

    assert!(!clean_profile_data(&home, "-canary", CleanDepth::Full).is_empty());
    assert!(!dir.exists(), "full removes the data dir outright");

    let _ = std::fs::remove_dir_all(&base);
}

/// The default depth touches no data at all — the original behaviour before
/// deep clean grew a profile axis.
#[test]
fn depth_none_never_touches_the_data_dir() {
    let base = std::env::temp_dir().join(format!("ryu-cdn-{}", uniq()));
    let home = base.join("home");
    std::fs::create_dir_all(home.join(".ryu/plugins")).unwrap();
    assert!(clean_profile_data(&home, "", CleanDepth::None).is_empty());
    assert!(home.join(".ryu/plugins").exists());
    let _ = std::fs::remove_dir_all(&base);
}
