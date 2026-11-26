//! TC-9: what the 30 second folder sync worker does with a `SKILL.md` folder.
//!
//! The worker installs every new or changed skill folder of a synced root with
//! nobody present, and the install name is the front-matter `name` of a file in
//! that folder. Before the fix it replaced any installed skill of that name and
//! kept the file's `always-on` flag, which puts the whole body into every turn.
//! `reconcile_import` is the body of one tick of `spawn_worker` for one profile;
//! calling it again is the next tick.
use super::*;

/// A synced root, a skills directory of its own, a ledger and a profile. The
/// skills directory is process-global state, so the guard holds the skills
/// environment lock for the whole test and puts the environment back.
struct SyncedSkills {
    _directory: tempfile::TempDir,
    root: PathBuf,
    skills_home: PathBuf,
    state: ServerState,
    store: AgentSyncStore,
    profile: SyncProfile,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl SyncedSkills {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        // Built before the skills lock is taken, so nothing it does can wait on it.
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let lock = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = directory.path().join("synced");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let skills_home = directory.path().join("skills-home");
        fs::create_dir_all(&skills_home).unwrap();
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var(
            "RYU_SKILLS_ACTIVE_FILE",
            directory.path().join("active.json"),
        );
        let store = AgentSyncStore::open_in_memory().unwrap();
        let profile = store
            .upsert_profile(ProfileInput {
                id: Some(format!("tc9-{}", uuid::Uuid::new_v4())),
                provider: "claude".to_owned(),
                root: root.to_string_lossy().to_string(),
                import_enabled: true,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        Self {
            _directory: directory,
            root,
            skills_home,
            state,
            store,
            profile,
            _lock: lock,
        }
    }

    fn write_source(&self, folder: &str, skill_md: &str) {
        let dir = self.root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), skill_md).unwrap();
    }

    fn installed(&self, name: &str) -> String {
        fs::read_to_string(self.skills_home.join(name).join("SKILL.md"))
            .unwrap_or_else(|error| panic!("skill {name} is not installed: {error}"))
    }

    async fn tick(&self) {
        reconcile_import(&self.state, &self.store, &self.profile).await;
    }

    async fn ledger(&self, folder: &str) -> Option<SyncItemStatus> {
        self.store
            .item(
                &self.profile.id,
                crate::import::kind::SKILL,
                &format!("skill/{folder}"),
            )
            .await
            .unwrap()
    }
}

impl Drop for SyncedSkills {
    fn drop(&mut self) {
        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
    }
}

#[tokio::test]
async fn a_synced_skill_is_never_installed_always_on() {
    let synced = SyncedSkills::new().await;
    synced.write_source(
        "x",
        "---\nname: demo\ndescription: A demo\nalways-on: true\n---\nSYNCED-BODY-MARKER",
    );

    synced.tick().await;

    let installed = synced.installed("demo");
    let record = ryu_skills::parse_skill_md("demo", &installed).unwrap();
    assert!(
        !record.always_on,
        "the installed copy kept always-on: {installed}"
    );
    assert!(installed.contains("SYNCED-BODY-MARKER"), "{installed}");
    // What a turn gets: the body of an always-on skill is injected in full.
    let (block, injected) = synced
        .state
        .skills
        .progressive_block(&[])
        .unwrap_or_default();
    assert!(
        !injected.iter().any(|id| id == "demo"),
        "the synced skill is in the always-on set: {injected:?}"
    );
    assert!(
        !block.contains("SYNCED-BODY-MARKER"),
        "the synced skill's body is injected into every turn"
    );
}

#[tokio::test]
async fn a_synced_folder_never_replaces_an_installed_skill_of_the_same_name() {
    let synced = SyncedSkills::new().await;
    let mine = synced.skills_home.join("demo");
    fs::create_dir_all(&mine).unwrap();
    fs::write(mine.join("SKILL.md"), "---\nname: demo\n---\nMINE").unwrap();
    fs::write(mine.join("notes.md"), "keep me").unwrap();
    synced.write_source("other", "---\nname: demo\n---\nTHEIRS");

    synced.tick().await;

    assert_eq!(synced.installed("demo"), "---\nname: demo\n---\nMINE");
    assert_eq!(
        fs::read_to_string(mine.join("notes.md")).unwrap(),
        "keep me"
    );
    let row = synced
        .ledger("other")
        .await
        .expect("the worker handled the folder");
    assert_eq!(
        row.generated_hash, None,
        "a kept skill is not the worker's own"
    );

    // The folder changes: the next tick sees a new hash and must keep the
    // installed skill again.
    synced.write_source("other", "---\nname: demo\n---\nTHEIRS, second try");
    synced.tick().await;
    assert_eq!(synced.installed("demo"), "---\nname: demo\n---\nMINE");
}

#[tokio::test]
async fn a_skill_the_worker_installed_follows_its_source_until_the_user_changes_it() {
    let synced = SyncedSkills::new().await;
    synced.write_source("x", "---\nname: demo\n---\nVERSION ONE");
    synced.tick().await;
    assert!(synced.installed("demo").contains("VERSION ONE"));
    let row = synced
        .ledger("x")
        .await
        .expect("the worker installed the skill");
    assert!(
        row.generated_hash
            .as_deref()
            .is_some_and(|hash| hash.starts_with("installed:")),
        "{row:?}"
    );

    // The source changes: the worker's own install is updated.
    synced.write_source("x", "---\nname: demo\n---\nVERSION TWO");
    synced.tick().await;
    assert!(synced.installed("demo").contains("VERSION TWO"));

    // The user edits the installed copy: from now on the timer leaves it alone.
    fs::write(
        synced.skills_home.join("demo").join("SKILL.md"),
        "---\nname: demo\nalways-on: true\n---\nEDITED BY THE USER",
    )
    .unwrap();
    synced.write_source("x", "---\nname: demo\n---\nVERSION THREE");
    synced.tick().await;
    assert!(synced.installed("demo").contains("EDITED BY THE USER"));

    // Another item cannot take the name of a skill this profile installed.
    synced.write_source("y", "---\nname: demo\n---\nFROM ANOTHER FOLDER");
    synced.tick().await;
    assert!(synced.installed("demo").contains("EDITED BY THE USER"));
}
