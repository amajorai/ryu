use super::*;

#[test]
fn untrusted_masks_cover_home_credentials_and_core_state_files() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let ryu = root.path().join("ryu");
    std::fs::create_dir_all(ryu.join("bin")).unwrap();
    std::fs::write(ryu.join("preferences.db"), b"").unwrap();
    std::fs::write(ryu.join("node-auth.token"), b"").unwrap();
    let masks = untrusted_masks(Some(&home), &ryu);
    assert!(masks.contains(&home.join(".ssh")));
    assert!(masks.contains(&home.join(".aws")));
    assert!(masks.contains(&ryu.join("preferences.db")));
    assert!(masks.contains(&ryu.join("node-auth.token")));
    // Core keeps its tokens, databases and state in folders now; user
    // content, service state and logs are hidden too.
    for dir in ["secrets", "db", "state", "files", "services", "logs"] {
        assert!(masks.contains(&ryu.join(dir)), "{dir} is hidden");
    }
    for visible in ["bin", "runtimes", "models", "cache", "tmp", "plugin-data"] {
        assert!(
            !masks.iter().any(|mask| mask.starts_with(ryu.join(visible))),
            "{visible}/ stays visible for managed runtimes"
        );
    }
    assert!(!masks.iter().any(|mask| mask.ends_with(".claude")));
}

#[test]
fn untrusted_core_masks_keep_only_the_agents_own_custody_home() {
    let root = tempfile::tempdir().unwrap();
    let ryu = root.path().join("ryu");
    let secrets = ryu_sidecar_runtime::layout::secrets_dir(&ryu);
    let kiro = secrets.join("native-accounts").join("kiro");
    let own = kiro.join("ownnamespace");
    let other = kiro.join("othernamespace");
    for dir in [&own, &other, &secrets.join("vault")] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(secrets.join("node-auth.token"), b"").unwrap();
    std::fs::write(kiro.join("index.json"), b"").unwrap();
    let db = ryu_sidecar_runtime::layout::db_dir(&ryu);
    std::fs::create_dir_all(&db).unwrap();

    let masks = keep_visible(untrusted_core_masks(&ryu), std::slice::from_ref(&own));
    assert!(
        !masks.iter().any(|mask| own.starts_with(mask)),
        "the agent's own custody home stays reachable: {masks:?}"
    );
    for hidden in [
        secrets.join("node-auth.token"),
        secrets.join("vault"),
        kiro.join("index.json"),
        other,
        db,
        ryu.join("files"),
    ] {
        assert!(masks.contains(&hidden), "{} is masked", hidden.display());
    }
}

#[test]
fn ryu_app_data_masks_cover_the_browser_profile_and_desktop_identifiers() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let data = root.path().join("data");
    for dir in [
        config.join(RYU_BROWSER_PROFILE_DIR),
        config.join("ai.amajor.ryu.desktop"),
        data.join("ai.amajor.ryu.desktop.dev"),
        data.join("ai.amajor.ryu.bot"),
        data.join("ai.amajor.ryuish"),
        data.join("Google"),
    ] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(data.join("ai.amajor.ryu.desktop.plist"), b"").unwrap();
    let missing = root.path().join("missing");
    let masks = ryu_app_data_masks(&[config.clone(), data.clone(), missing.clone()]);
    for expected in [
        config.join(RYU_BROWSER_PROFILE_DIR),
        config.join("ai.amajor.ryu.desktop"),
        data.join("ai.amajor.ryu.desktop.dev"),
        data.join("ai.amajor.ryu.bot"),
        data.join("ai.amajor.ryu.desktop.plist"),
    ] {
        assert!(masks.contains(&expected), "{}", expected.display());
    }
    assert!(!masks.contains(&data.join("ai.amajor.ryuish")));
    assert!(!masks.contains(&data.join("Google")));
    assert!(!masks.contains(&missing));

    let home = root.path().join("home");
    let roots = ryu_app_data_roots(Some(&home));
    assert!(roots.contains(&home.join("Library/WebKit")));
    if let Some(config) = dirs::config_dir() {
        assert!(roots.contains(&config));
    }
}

#[test]
fn account_masks_hide_core_data_and_provider_stores_but_not_runtimes() {
    let root = tempfile::tempdir().unwrap();
    let ryu = root.path().join("ryu");
    std::fs::create_dir_all(ryu.join("runtimes/pi-agent")).unwrap();
    std::fs::write(ryu.join("core.token"), b"").unwrap();
    let pi_agent = ryu.join("runtimes/pi-agent");
    let gateway_config = root.path().join("config/ryu");
    let stores = vec![pi_agent.clone(), gateway_config.clone()];

    let core_only = account_restricted_masks(&ryu, None);
    for dir in [
        "secrets",
        "db",
        "state",
        "plugin-data",
        "services",
        "logs",
        "core.token",
    ] {
        assert!(core_only.contains(&ryu.join(dir)), "{dir} is hidden");
    }
    assert!(
        !core_only.contains(&pi_agent),
        "provider stores stay visible without a provider limit"
    );

    let limited = account_restricted_masks(&ryu, Some(&stores));
    assert!(limited.contains(&pi_agent));
    assert!(limited.contains(&gateway_config));
    // Limited agents' own Pi configs are hidden by the launcher, which
    // keeps only the agent's own folder visible.
    for visible in ["runtimes", "bin", "runtimes/pi"] {
        assert!(
            !limited.contains(&ryu.join(visible)),
            "{visible} stays visible"
        );
    }
}

#[test]
fn keep_visible_spares_the_engines_own_paths_and_hides_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let store = root.path().join("secrets");
    let own_home = store.join("native-accounts/kiro/ns1");
    std::fs::create_dir_all(&own_home).unwrap();
    std::fs::create_dir_all(store.join("native-accounts/kiro/ns2")).unwrap();
    std::fs::write(store.join("core.token"), b"t").unwrap();
    let claude = root.path().join(".claude");
    let codex = root.path().join(".codex");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::create_dir_all(&codex).unwrap();
    let workspace = root.path().join("work");
    let inside_workspace = workspace.join(".gemini");
    std::fs::create_dir_all(&inside_workspace).unwrap();

    let masks = keep_visible(
        vec![
            store.clone(),
            claude.clone(),
            codex.clone(),
            inside_workspace.clone(),
        ],
        &[own_home.clone(), claude.clone(), workspace.clone()],
    );
    assert!(!masks.contains(&claude), "the engine's own login stays");
    assert!(masks.contains(&codex), "another harness's login is hidden");
    assert!(
        masks.contains(&inside_workspace),
        "keeping a folder never un-hides a store inside it"
    );
    assert!(
        !masks.contains(&store),
        "a store holding a kept path is narrowed"
    );
    assert!(masks.contains(&store.join("core.token")));
    assert!(masks.contains(&store.join("native-accounts/kiro/ns2")));
    assert!(!masks.iter().any(|mask| own_home.starts_with(mask)));
}

#[test]
fn keep_visible_hides_a_store_whole_when_it_cannot_be_narrowed() {
    let root = tempfile::tempdir().unwrap();
    // Deeper than the narrowing limit: the store is hidden whole.
    let store = root.path().join("store");
    let mut deep = store.clone();
    for level in 0..=MAX_NARROW_DEPTH {
        deep = deep.join(format!("l{level}"));
    }
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(store.join("token"), b"t").unwrap();
    let masks = keep_visible(vec![store.clone()], &[deep.clone()]);
    assert!(masks.iter().any(|mask| deep.starts_with(mask)), "{masks:?}");
    assert!(masks
        .iter()
        .any(|mask| store.join("token").starts_with(mask)));

    // A store that cannot be listed (here: missing) is hidden whole.
    let missing = root.path().join("missing");
    let kept = missing.join("home");
    assert_eq!(keep_visible(vec![missing.clone()], &[kept]), vec![missing]);
}
