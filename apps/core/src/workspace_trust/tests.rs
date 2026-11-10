use super::*;

fn with_trusted<T>(entries: &[&Path], body: impl FnOnce() -> T) -> T {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::remove_var(ENV_TRUST_ALL);
    let value = serde_json::to_string(
        &entries
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    set_from_pref(&value);
    let result = body();
    set_from_pref("");
    result
}

#[test]
fn untrusted_until_a_parent_folder_is_trusted() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("geopy");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    with_trusted(&[], || assert!(!is_trusted(&repo)));
    with_trusted(&[root.path()], || {
        assert!(is_trusted(&repo));
        assert!(is_trusted(&repo.join("src")));
    });
    with_trusted(&[&repo.join("src")], || assert!(!is_trusted(&repo)));
}

#[test]
fn sibling_prefix_is_not_trusted() {
    let root = tempfile::tempdir().unwrap();
    let trusted = root.path().join("app");
    let sibling = root.path().join("app-evil");
    std::fs::create_dir_all(&trusted).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    with_trusted(&[&trusted], || assert!(!is_trusted(&sibling)));
}

#[test]
fn worktree_inherits_origin_trust() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let worktree = root.path().join("wt");
    std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display()),
    )
    .unwrap();
    std::fs::write(
        repo.join(".git/worktrees/wt/gitdir"),
        format!("{}\n", worktree.join(".git").display()),
    )
    .unwrap();
    with_trusted(&[], || assert!(!is_trusted(&worktree)));
    with_trusted(&[&repo], || assert!(is_trusted(&worktree)));
}

#[test]
fn forged_worktree_marker_does_not_borrow_trust() {
    // A downloaded project ships a `.git` file naming a trusted repository's
    // real worktree; the repository's back-link names that worktree, not it.
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let real = root.path().join("wt");
    let forged = root.path().join("download");
    std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
    std::fs::create_dir_all(&real).unwrap();
    std::fs::create_dir_all(&forged).unwrap();
    let marker = format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display());
    std::fs::write(real.join(".git"), &marker).unwrap();
    std::fs::write(forged.join(".git"), &marker).unwrap();
    std::fs::write(
        repo.join(".git/worktrees/wt/gitdir"),
        format!("{}\n", real.join(".git").display()),
    )
    .unwrap();
    with_trusted(&[&repo], || {
        assert!(is_trusted(&real));
        assert!(!is_trusted(&forged));
    });

    // No back-link at all: not a worktree git created.
    let orphan_repo = root.path().join("orphan");
    let orphan = root.path().join("orphan-wt");
    std::fs::create_dir_all(orphan_repo.join(".git/worktrees/x")).unwrap();
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(
        orphan.join(".git"),
        format!(
            "gitdir: {}\n",
            orphan_repo.join(".git/worktrees/x").display()
        ),
    )
    .unwrap();
    with_trusted(&[&orphan_repo], || assert!(!is_trusted(&orphan)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_trust_and_untrust_edits_all_persist() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("preferences.db");
    let preferences = PreferencesStore::open(path.clone()).unwrap();
    let removed: Vec<String> = (0..8).map(|index| format!("/old/{index}")).collect();
    preferences
        .set(
            TRUSTED_WORKSPACES_PREF_KEY,
            &serde_json::to_string(&removed).unwrap(),
        )
        .await
        .unwrap();
    let added: Vec<String> = (0..8).map(|index| format!("/new/{index}")).collect();

    let mut tasks = tokio::task::JoinSet::new();
    for (add, remove) in added.iter().cloned().zip(removed.iter().cloned()) {
        let trust_store = preferences.clone();
        tasks.spawn(async move { trust_folders(&trust_store, &[add]).await.map(drop) });
        let untrust_store = preferences.clone();
        tasks.spawn(async move { untrust_folder(&untrust_store, &remove).await.map(drop) });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap().unwrap();
    }

    let reopened = PreferencesStore::open(path).unwrap();
    let mut stored = stored_entries(
        reopened
            .get(TRUSTED_WORKSPACES_PREF_KEY)
            .await
            .unwrap()
            .as_deref(),
    );
    stored.sort();
    assert_eq!(stored, added);
    set_from_pref("");
}

#[tokio::test]
async fn edits_keep_spelling_and_skip_duplicates() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let preferences = PreferencesStore::open(directory.path().join("p.db")).unwrap();
    preferences
        .set(TRUSTED_WORKSPACES_PREF_KEY, "not json")
        .await
        .unwrap();
    let folders = [
        "/a".to_owned(),
        " /b ".to_owned(),
        "/a".to_owned(),
        String::new(),
    ];
    assert_eq!(
        trust_folders(&preferences, &folders).await.unwrap(),
        ["/a", "/b"]
    );
    assert_eq!(untrust_folder(&preferences, " /a").await.unwrap(), ["/b"]);
    assert_eq!(
        preferences
            .get(TRUSTED_WORKSPACES_PREF_KEY)
            .await
            .unwrap()
            .as_deref(),
        Some(r#"["/b"]"#)
    );
    set_from_pref("");
}

#[test]
fn malformed_and_relative_entries_are_ignored() {
    assert!(parse_pref("not json").is_empty());
    assert!(parse_pref(r#"["relative/path", ""]"#).is_empty());
    assert_eq!(parse_pref("").len(), 0);
}

/// An absolute fixture path on this platform. `/home/dev` is absolute on Unix
/// only; on Windows the same fixture needs a drive (`C:/home/dev`), or the
/// rule rejects it for being relative and a negative assertion passes vacuously.
fn abs(path: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!("C:{path}"))
    } else {
        PathBuf::from(path)
    }
}

#[test]
fn dev_core_trusts_the_checkout_it_runs_from() {
    let home = &abs("/home/dev");
    let temp = &abs("/tmp");
    assert!(working_directory_is_implicitly_trusted(
        &abs("/home/dev/src/ryu"),
        "dev",
        Some(home.as_path()),
        temp,
    ));
    assert!(working_directory_is_implicitly_trusted(
        &abs("/srv/checkouts/ryu"),
        "dev",
        Some(home.as_path()),
        temp,
    ));
}

#[test]
fn shipped_core_never_trusts_its_working_directory() {
    // A desktop launcher or service manager picks Core's working directory;
    // a repository the user chose is not implied by it.
    for profile in ["release", "beta", "canary", "nightly", ""] {
        assert!(
            !working_directory_is_implicitly_trusted(
                &abs("/home/dev/src/ryu"),
                profile,
                Some(abs("/home/dev").as_path()),
                &abs("/tmp"),
            ),
            "{profile}"
        );
    }
}

#[test]
fn broad_working_directories_are_never_trusted() {
    let home = &abs("/home/dev");
    let temp = &abs("/var/folders/ab/T");
    for broad in [
        "/",
        "/home",
        "/home/dev",
        "/Users",
        "/tmp",
        "/var/folders",
        "/var/folders/ab/T",
        "/var/folders/ab/T/download",
    ] {
        assert!(
            !working_directory_is_implicitly_trusted(
                &abs(broad),
                "dev",
                Some(home.as_path()),
                temp
            ),
            "{broad}"
        );
    }
    assert!(!working_directory_is_implicitly_trusted(
        Path::new("relative/dir"),
        "dev",
        Some(home.as_path()),
        temp,
    ));
}

#[test]
fn shared_temp_folders_and_an_unknown_home_are_never_trusted() {
    // `std::env::temp_dir()` names only one temp folder (on macOS a
    // per-user `/var/folders/...`); the shared world-writable ones are
    // still not a checkout.
    let home = Path::new("/Users/dev");
    let temp = Path::new("/private/var/folders/ab/T");
    for shared in [
        "/private/tmp",
        "/private/tmp/download",
        "/var/tmp",
        "/var/tmp/x",
        "/dev/shm",
        "/private/var/tmp",
    ] {
        assert!(
            !working_directory_is_implicitly_trusted(Path::new(shared), "dev", Some(home), temp),
            "{shared}"
        );
    }
    // Without a home directory Ryu cannot tell `/home/dev` from a checkout.
    assert!(!working_directory_is_implicitly_trusted(
        Path::new("/home/dev"),
        "dev",
        None,
        Path::new("/tmp"),
    ));
}

#[test]
fn working_directory_trust_follows_the_dev_rule() {
    // `is_trusted` itself: Core's working directory (the crate directory
    // under `cargo test`) is trusted exactly when the pure rule says so.
    let cwd = canonical(&std::env::current_dir().unwrap());
    let expected = working_directory_is_implicitly_trusted(
        &cwd,
        crate::profile::profile(),
        dirs::home_dir().map(|home| canonical(&home)).as_deref(),
        &canonical(&std::env::temp_dir()),
    );
    with_trusted(&[], || assert_eq!(is_trusted(&cwd), expected));
    if let Some(home) = dirs::home_dir() {
        with_trusted(&[], || assert!(!is_trusted(&home)));
    }
    with_trusted(&[], || assert!(!is_trusted(Path::new("/"))));
}

#[test]
fn projectless_folder_is_trusted_but_not_repositories_inside_it() {
    // Paths that do not exist compare as given, so this touches no files.
    let Some(projectless) = default_projectless_folder() else {
        return;
    };
    with_trusted(&[], || {
        assert!(is_trusted(&projectless));
        assert!(!is_trusted(&projectless.join("cloned-repo")));
    });
}

#[test]
fn permission_skipping_modes_are_recognized_per_agent() {
    assert!(mode_skips_permission_prompts("bypassPermissions", true));
    assert!(mode_skips_permission_prompts("auto", true));
    assert!(!mode_skips_permission_prompts("auto", false));
    assert!(mode_skips_permission_prompts("full-access", false));
    assert!(mode_skips_permission_prompts("dontAsk", true));
    for safe in ["default", "plan", "acceptEdits", "read-only"] {
        assert!(!mode_skips_permission_prompts(safe, true), "{safe}");
    }
}
