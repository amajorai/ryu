use super::*;

fn clone_with_dispatcher() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let scripts = root.path().join("plugin").join("scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    std::fs::write(scripts.join("te-hook"), "#!/bin/sh\n").unwrap();
    root
}

fn settings(folder: &Path, microskills: &str, loopguard: &str) -> Settings {
    Settings {
        folder: folder.to_string_lossy().into_owned(),
        microskills: microskills.to_owned(),
        loopguard: loopguard.to_owned(),
    }
}

#[test]
fn resolves_the_clone_root_or_its_plugin_folder() {
    let clone = clone_with_dispatcher();
    let plugin = clone.path().join("plugin");
    assert_eq!(
        resolve_plugin_dir(&clone.path().to_string_lossy()),
        Some(plugin.clone())
    );
    assert_eq!(
        resolve_plugin_dir(&format!("  {}  ", plugin.display())),
        Some(plugin)
    );
}

#[test]
fn rejects_empty_relative_and_incomplete_folders() {
    assert_eq!(resolve_plugin_dir(""), None);
    assert_eq!(resolve_plugin_dir("   "), None);
    assert_eq!(resolve_plugin_dir("TokenEconomizer"), None);
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(resolve_plugin_dir(&empty.path().to_string_lossy()), None);
}

#[test]
fn pointer_carries_only_accepted_modes() {
    let clone = clone_with_dispatcher();
    let cli = PathBuf::from("/opt/ryu/pi");
    let body = pointer_json(&settings(clone.path(), "envfacts", "default"), Some(&cli)).unwrap();
    assert_eq!(
        body,
        json!({
            "pluginDir": clone.path().join("plugin").to_string_lossy(),
            "piCli": "/opt/ryu/pi",
            "microskills": "envfacts",
        })
    );
    let body = pointer_json(&settings(clone.path(), "turbo", "off"), None).unwrap();
    assert_eq!(
        body,
        json!({
            "pluginDir": clone.path().join("plugin").to_string_lossy(),
            "loopguard": "off",
        })
    );
}

#[test]
fn apply_writes_then_removes_the_pointer_file() {
    let clone = clone_with_dispatcher();
    let agent = tempfile::tempdir().unwrap();
    let pointer = agent.path().join(POINTER_FILE);

    assert!(apply_in(agent.path(), &settings(clone.path(), "on", "on"), None).unwrap());
    let written: Value = serde_json::from_slice(&std::fs::read(&pointer).unwrap()).unwrap();
    assert_eq!(written["microskills"], "on");
    assert_eq!(written["loopguard"], "on");
    assert!(!agent.path().join("tokeneconomizer.json.tmp").exists());

    // Clearing the folder turns the bridge off and removes the file.
    assert!(!apply_in(agent.path(), &Settings::default(), None).unwrap());
    assert!(!pointer.exists());
    // Removing again is not an error.
    assert!(!apply_in(agent.path(), &Settings::default(), None).unwrap());
}

#[test]
fn a_folder_that_loses_its_dispatcher_turns_the_bridge_off() {
    let clone = clone_with_dispatcher();
    let agent = tempfile::tempdir().unwrap();
    let configured = settings(clone.path(), "default", "default");
    assert!(apply_in(agent.path(), &configured, None).unwrap());
    std::fs::remove_file(clone.path().join("plugin").join("scripts").join("te-hook")).unwrap();
    assert!(!apply_in(agent.path(), &configured, None).unwrap());
    assert!(!agent.path().join(POINTER_FILE).exists());
}

#[test]
fn recognises_only_its_own_preference_keys() {
    assert!(is_pref_key(FOLDER_PREF_KEY));
    assert!(is_pref_key(MICROSKILLS_PREF_KEY));
    assert!(is_pref_key(LOOPGUARD_PREF_KEY));
    assert!(!is_pref_key("rtk-wrap-pi"));
}
