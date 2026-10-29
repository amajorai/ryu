//! Automatic re-import of a watched ChatGPT export folder, driven through the
//! shipping `reconcile_import` against a real conversation store and a real
//! (in-memory) sync ledger: the fingerprint memo that spares an unchanged export
//! another scan, what a changed export does, the retry rules after a failed
//! import, and what the files around the conversations do to the fingerprint.
//!
//! `reconcile_import` is the body of one 30-second tick of `spawn_worker` for one
//! profile; calling it again is the next tick. `spawn_worker` itself reads the
//! process-global ledger, which a process can set only once, so the tests that
//! start the real worker (its interval, the Import switch and the 256-item
//! limit) each run in a child process of their own, under a paused clock.
use super::*;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use std::time::{Duration, Instant, SystemTime};

/// The one item a plain ChatGPT export scans to: its chats outside any project.
const CHATS_ITEM: &str = "conversations/conversations.json#chats";
const ORIGIN: &str = "import:chatgpt";
const CONVERSATION_ID: &str = "watched-chatgpt-1";

fn chatgpt_export(messages: &[(&str, &str)]) -> Value {
    json!([chatgpt_conversation(CONVERSATION_ID, None, messages)])
}

/// One ChatGPT conversation. A `g-p-` project id puts it in a project group, which
/// the importer turns into a project folder.
fn chatgpt_conversation(
    conversation_id: &str,
    project: Option<&str>,
    messages: &[(&str, &str)],
) -> Value {
    let mut mapping = serde_json::Map::new();
    mapping.insert(
        "root".into(),
        json!({ "id": "root", "message": null, "parent": null, "children": ["m0"] }),
    );
    for (index, (role, text)) in messages.iter().enumerate() {
        let parent = if index == 0 {
            "root".to_owned()
        } else {
            format!("m{}", index - 1)
        };
        let children: Vec<String> = if index + 1 < messages.len() {
            vec![format!("m{}", index + 1)]
        } else {
            Vec::new()
        };
        mapping.insert(
            format!("m{index}"),
            json!({ "id": format!("m{index}"), "parent": parent, "children": children, "message": {
                "author": { "role": role },
                "create_time": 1_700_000_000.0 + index as f64,
                "content": { "content_type": "text", "parts": [text] } } }),
        );
    }
    json!({
        "conversation_id": conversation_id,
        "gizmo_id": project,
        "title": "Trip planning",
        "create_time": 1_700_000_000.0,
        "update_time": 1_700_000_100.0,
        "current_node": format!("m{}", messages.len() - 1),
        "mapping": mapping,
    })
}

/// A node that is registered with an organization: automatic import has no
/// signed-in member to act for, so Core refuses it as it would refuse any
/// anonymous chat-history import there.
fn managed_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".into(),
            name: "Org".into(),
            slug: None,
        },
        node_id: "node-1".into(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

/// Move a file's modification time without touching its bytes.
fn set_modified_ahead(path: &Path, seconds: u64) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(seconds))
        .unwrap();
}

/// A watched export folder with its profile, ledger and conversation store.
struct Watched {
    _directory: tempfile::TempDir,
    root: PathBuf,
    state: ServerState,
    store: AgentSyncStore,
    profile: SyncProfile,
}

impl Watched {
    async fn new(messages: &[(&str, &str)]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("chatgpt-export");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(
            root.join("conversations.json"),
            chatgpt_export(messages).to_string(),
        )
        .unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let store = AgentSyncStore::open_in_memory().unwrap();
        // The memo is process-wide and keyed by profile id, so every test needs
        // an id of its own.
        let profile = store
            .upsert_profile(ProfileInput {
                id: Some(format!("watched-{}", uuid::Uuid::new_v4())),
                provider: "chatgpt".to_owned(),
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
            state,
            store,
            profile,
        }
    }

    fn conversations_file(&self) -> PathBuf {
        self.root.join("conversations.json")
    }

    fn write_export(&self, messages: &[(&str, &str)]) {
        fs::write(
            self.conversations_file(),
            chatgpt_export(messages).to_string(),
        )
        .unwrap();
    }

    fn fingerprint(&self) -> String {
        chat_export_fingerprint(&self.root).unwrap()
    }

    /// One tick of the worker for this profile.
    async fn pass(&self) {
        reconcile_import(&self.state, &self.store, &self.profile).await;
    }

    /// One tick on a node that refuses an anonymous chat-history import.
    async fn pass_on_a_managed_node(&self) {
        with_test_node_binding(true, Some(managed_node()), self.pass()).await;
    }

    async fn ledger(&self) -> Option<SyncItemStatus> {
        self.store
            .item(
                &self.profile.id,
                crate::import::kind::CONVERSATIONS,
                CHATS_ITEM,
            )
            .await
            .unwrap()
    }

    async fn forget_ledger(&self) {
        self.store
            .conn
            .lock()
            .await
            .execute(
                "DELETE FROM sync_items WHERE profile_id = ?1",
                [&self.profile.id],
            )
            .unwrap();
    }

    /// The imported conversation's message texts, `None` before it exists.
    async fn imported(&self) -> Option<Vec<String>> {
        let tenancy = crate::server::caller_tenancy(&None);
        let (conversation, _) = self
            .state
            .conversations
            .find_imported_conversation_with_generation(ORIGIN, CONVERSATION_ID, &tenancy)
            .await
            .unwrap()?;
        let messages = self
            .state
            .conversations
            .get_messages(&conversation)
            .await
            .unwrap();
        Some(
            messages
                .into_iter()
                .map(|message| message.content)
                .collect(),
        )
    }

    fn remembered(&self) -> Option<String> {
        reconciled_chat_exports()
            .lock()
            .unwrap()
            .get(&self.profile.id)
            .cloned()
    }

    fn forget_memo(&self) {
        reconciled_chat_exports()
            .lock()
            .unwrap()
            .remove(&self.profile.id);
    }
}

fn texts(messages: &[&str]) -> Option<Vec<String>> {
    Some(messages.iter().map(|text| (*text).to_owned()).collect())
}

const LISBON: &[(&str, &str)] = &[("user", "Plan Lisbon"), ("assistant", "Day 1: Alfama")];
const LISBON_AND_SINTRA: &[(&str, &str)] = &[
    ("user", "Plan Lisbon"),
    ("assistant", "Day 1: Alfama"),
    ("user", "Add Sintra"),
];
const LISBON_SINTRA_AND_PORTO: &[(&str, &str)] = &[
    ("user", "Plan Lisbon"),
    ("assistant", "Day 1: Alfama"),
    ("user", "Add Sintra"),
    ("assistant", "Day 2: Sintra"),
];

#[tokio::test]
async fn an_unchanged_export_is_not_scanned_again_and_a_changed_one_is_imported() {
    let watched = Watched::new(LISBON).await;

    watched.pass().await;
    let first = watched
        .ledger()
        .await
        .expect("the first pass records the chats item");
    assert_eq!(first.state, "imported");
    assert_eq!(first.revision, 1);
    assert_eq!(first.source_hash, Some(watched.fingerprint()));
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );
    assert_eq!(watched.remembered(), Some(watched.fingerprint()));

    // An unchanged export is not scanned again: a scan would record the chats
    // item once more, so a ledger emptied behind the worker's back stays empty.
    watched.forget_ledger().await;
    watched.pass().await;
    assert!(
        watched.ledger().await.is_none(),
        "an unchanged export must not be scanned on the next tick"
    );

    // Same bytes, newer modification time: a newer export unzipped over the
    // folder counts as changed even when it reads the same, and importing it
    // again adds nothing.
    set_modified_ahead(&watched.conversations_file(), 60);
    assert_ne!(watched.fingerprint(), first.source_hash.clone().unwrap());
    watched.pass().await;
    let rescanned = watched
        .ledger()
        .await
        .expect("a newer modification time makes the export a changed one");
    assert_eq!(rescanned.state, "imported");
    assert_eq!(rescanned.source_hash, Some(watched.fingerprint()));
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );

    // New content is imported on the next tick, and only its new messages.
    watched.write_export(LISBON_AND_SINTRA);
    watched.pass().await;
    let changed = watched.ledger().await.unwrap();
    assert_eq!(changed.state, "imported");
    assert_eq!(changed.revision, rescanned.revision + 1);
    assert_eq!(changed.source_hash, Some(watched.fingerprint()));
    assert_ne!(changed.source_hash, rescanned.source_hash);
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama", "Add Sintra"])
    );
    assert_eq!(watched.remembered(), Some(watched.fingerprint()));
}

#[tokio::test]
async fn a_failed_import_waits_for_the_export_to_change_and_then_retries() {
    let watched = Watched::new(LISBON).await;

    // Tick 1: the node refuses the import, so the chats item is recorded as
    // failed under the export's fingerprint and nothing is imported.
    watched.pass_on_a_managed_node().await;
    let failed = watched
        .ledger()
        .await
        .expect("a failed import is recorded, not dropped");
    assert_eq!(failed.state, "failed");
    assert_eq!(failed.revision, 1);
    assert_eq!(failed.source_hash, Some(watched.fingerprint()));
    assert_eq!(watched.imported().await, None);

    // Tick 2, the refusal gone but the export untouched: a failed chat export
    // is not retried every tick. The folder is large and the same files would
    // fail the same way.
    watched.pass().await;
    let waiting = watched.ledger().await.unwrap();
    assert_eq!((waiting.state.as_str(), waiting.revision), ("failed", 1));
    assert_eq!(watched.imported().await, None);

    // A restart empties the memo; the stored fingerprint alone still holds the
    // retry back.
    watched.forget_memo();
    watched.pass().await;
    let after_restart = watched.ledger().await.unwrap();
    assert_eq!(
        (after_restart.state.as_str(), after_restart.revision),
        ("failed", 1)
    );
    assert_eq!(watched.imported().await, None);

    // A changed export is retried on the next tick, and fails again here, with
    // the new fingerprint recorded.
    watched.write_export(LISBON_AND_SINTRA);
    watched.pass_on_a_managed_node().await;
    let retried = watched.ledger().await.unwrap();
    assert_eq!((retried.state.as_str(), retried.revision), ("failed", 2));
    assert_eq!(retried.source_hash, Some(watched.fingerprint()));
    assert_ne!(retried.source_hash, failed.source_hash);
    assert_eq!(watched.imported().await, None);

    // Changed again, with the refusal gone: the retry succeeds and brings in
    // everything the export holds now.
    watched.write_export(LISBON_SINTRA_AND_PORTO);
    watched.pass().await;
    let recovered = watched.ledger().await.unwrap();
    assert_eq!(
        (recovered.state.as_str(), recovered.revision),
        ("imported", 3)
    );
    assert_eq!(recovered.source_hash, Some(watched.fingerprint()));
    assert_eq!(
        watched.imported().await,
        texts(&[
            "Plan Lisbon",
            "Day 1: Alfama",
            "Add Sintra",
            "Day 2: Sintra"
        ])
    );
}

#[tokio::test]
async fn a_busy_profile_is_skipped_and_picked_up_on_the_next_tick() {
    let watched = Watched::new(LISBON).await;

    // A manual import or export holds the profile.
    assert!(watched.store.try_start(&watched.profile.id).await);
    watched.pass().await;
    assert!(watched.ledger().await.is_none());
    assert_eq!(watched.imported().await, None);
    assert_eq!(
        watched.remembered(),
        None,
        "a skipped tick must not mark the export as reconciled"
    );

    watched.store.finish(&watched.profile.id).await;
    watched.pass().await;
    assert_eq!(watched.ledger().await.unwrap().state, "imported");
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );
}

#[tokio::test]
async fn a_missing_folder_is_not_remembered_and_imports_when_it_returns() {
    let watched = Watched::new(LISBON).await;
    let export = fs::read(watched.conversations_file()).unwrap();
    fs::remove_dir_all(&watched.root).unwrap();

    watched.pass().await;
    assert!(watched.ledger().await.is_none());
    assert_eq!(watched.imported().await, None);
    assert_eq!(watched.remembered(), None);

    fs::create_dir_all(&watched.root).unwrap();
    fs::write(watched.conversations_file(), export).unwrap();
    watched.pass().await;
    assert_eq!(watched.ledger().await.unwrap().state, "imported");
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );
}

#[tokio::test]
async fn an_export_that_cannot_be_read_is_remembered_until_it_changes() {
    let watched = Watched::new(LISBON).await;
    // Recognisable as a ChatGPT export from its first bytes, cut off before it
    // closes, as an interrupted download leaves it.
    fs::write(
        watched.conversations_file(),
        r#"[{"mapping": {}, "current_node": "m0", "conversation_id": "wat"#,
    )
    .unwrap();

    watched.pass().await;
    assert!(watched.ledger().await.is_none(), "nothing could be read");
    assert_eq!(
        watched.remembered(),
        Some(watched.fingerprint()),
        "an export that parses to nothing is not parsed again every tick"
    );

    watched.write_export(LISBON);
    watched.pass().await;
    assert_eq!(watched.ledger().await.unwrap().state, "imported");
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );
}

#[tokio::test]
async fn an_export_with_thousands_of_attachments_is_still_imported() {
    let watched = Watched::new(LISBON).await;
    // A heavy account's export holds a file for every image it ever handled,
    // next to the conversations. More than the hash entry limit of them must
    // not stop the export being fingerprinted, or it is never imported at all.
    for index in 0..=MAX_HASH_ENTRIES {
        fs::write(watched.root.join(format!("file-{index:05}-photo.png")), b"").unwrap();
    }

    watched.pass().await;
    let item = watched
        .ledger()
        .await
        .expect("an export with many attachments is imported");
    assert_eq!(item.state, "imported");
    assert_eq!(item.source_hash, Some(watched.fingerprint()));
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );
    assert_eq!(watched.remembered(), Some(watched.fingerprint()));
}

#[test]
fn only_the_files_the_importer_reads_change_an_exports_fingerprint() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::write(root.join("conversations.json"), "[]").unwrap();
    let base = chat_export_fingerprint(root).unwrap();

    // Attachments and other files the importer never reads.
    for name in [
        "file-1-photo.png",
        "chat.txt",
        "export_manifest.json",
        "message_feedback.json",
        "shared_conversations.json",
        "conversations-final.json",
        "conversations-.json",
    ] {
        fs::write(root.join(name), "x").unwrap();
        assert_eq!(
            chat_export_fingerprint(root).unwrap(),
            base,
            "{name} is not read by the importer"
        );
    }
    fs::create_dir_all(root.join("dalle-generations")).unwrap();
    fs::write(root.join("dalle-generations/image.webp"), "x").unwrap();
    fs::create_dir_all(root.join("projects")).unwrap();
    fs::write(root.join("projects/notes.txt"), "x").unwrap();
    fs::create_dir_all(root.join("memories")).unwrap();
    fs::write(root.join("memories/readme.md"), "x").unwrap();
    assert_eq!(chat_export_fingerprint(root).unwrap(), base);

    // Everything the importer reads, one file at a time.
    let mut seen = vec![base];
    for path in [
        "conversations-000.json",
        "projects.json",
        "memories.json",
        "users.json",
        "user.json",
        "chat.html",
        "projects/p.json",
        "memories/m.json",
    ] {
        fs::write(root.join(path), "x").unwrap();
        let fingerprint = chat_export_fingerprint(root).unwrap();
        assert!(
            !seen.contains(&fingerprint),
            "{path} is read by the importer and must change the fingerprint"
        );
        seen.push(fingerprint);
    }
    // Its contents and its modification time count as well.
    fs::write(root.join("conversations.json"), "[{}]").unwrap();
    let rewritten = chat_export_fingerprint(root).unwrap();
    assert!(!seen.contains(&rewritten));
    set_modified_ahead(&root.join("conversations.json"), 120);
    assert_ne!(chat_export_fingerprint(root).unwrap(), rewritten);
}

/// Poll `future` once and report whether it is still waiting. The future makes
/// progress only while this runs, so a test decides exactly where it stops.
async fn poll_once<F: std::future::Future<Output = ()>>(
    future: &mut std::pin::Pin<&mut F>,
) -> std::task::Poll<()> {
    std::future::poll_fn(|cx| {
        std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx))
    })
    .await
}

/// How long a test waits for the tick, in real time, before it gives up.
const WAIT: Duration = Duration::from_secs(60);

#[tokio::test]
async fn a_change_made_while_an_import_runs_is_imported_on_the_next_tick() {
    let watched = Watched::new(LISBON).await;
    let tick = watched.pass();
    tokio::pin!(tick);

    // The tick takes the profile's busy marker just before it imports and gives
    // it back when the import is over. Step the tick by hand until it holds the
    // marker, then keep the marker locked from here: the tick can import, but it
    // cannot get past the point where it gives the marker back.
    let started = Instant::now();
    let marker = loop {
        assert!(poll_once(&mut tick).await.is_pending());
        if let Ok(active) = watched.store.active.clone().try_lock_owned() {
            if active.contains(&watched.profile.id) {
                break active;
            }
        }
        assert!(started.elapsed() < WAIT, "the tick never started importing");
        tokio::time::sleep(Duration::from_millis(1)).await;
    };

    // Step it until the import has stored the export it read.
    let started = Instant::now();
    loop {
        assert!(
            poll_once(&mut tick).await.is_pending(),
            "the tick cannot finish while the busy marker is held"
        );
        if watched.imported().await == texts(&["Plan Lisbon", "Day 1: Alfama"]) {
            break;
        }
        assert!(started.elapsed() < WAIT, "the import never stored the chat");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    // A newer export is unzipped over the folder while the tick is still
    // running, then the tick is allowed to finish.
    watched.write_export(LISBON_AND_SINTRA);
    drop(marker);
    tick.await;

    // The tick imported what it read, so it records that, not the newer export.
    let first = watched.ledger().await.unwrap();
    assert_eq!((first.state.as_str(), first.revision), ("imported", 1));
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama"])
    );

    // The next tick imports the message that arrived during the import.
    watched.pass().await;
    assert_eq!(
        watched.imported().await,
        texts(&["Plan Lisbon", "Day 1: Alfama", "Add Sintra"]),
        "a change made during an import must be imported on the next tick"
    );
    let second = watched.ledger().await.unwrap();
    assert_eq!((second.state.as_str(), second.revision), ("imported", 2));
    assert_eq!(second.source_hash, Some(watched.fingerprint()));
    assert_ne!(second.source_hash, first.source_hash);
}

// ---------------------------------------------------------------------------
// The worker itself
// ---------------------------------------------------------------------------

const WORKER_CHILD_ENV: &str = "RYU_CORE_AGENT_SYNC_WORKER_CHILD";

/// Whether this process is the isolated child that runs `test`. In any other
/// process it starts the child, waits for it and asserts that it passed, and
/// returns `false` so the caller has nothing left to do.
///
/// The worker reads the process-global ledger, which one process can set once,
/// so each test that starts it runs alone in a child with its own data
/// directory. The child also gets a home directory of its own with a Documents
/// folder inside it, which is where an imported project's folder is created.
///
/// `test` is spelled out at each call site, and a name that matches no test
/// makes libtest run nothing and exit 0, so the child's own report must say
/// that exactly one test ran and passed.
fn in_isolated_process(test: &str) -> bool {
    if std::env::var_os(WORKER_CHILD_ENV).is_some() {
        return true;
    }
    let data_dir = tempfile::tempdir().expect("a data directory for the child");
    let home = tempfile::tempdir().expect("a home directory for the child");
    let config = home.path().join(".config");
    fs::create_dir_all(&config).unwrap();
    fs::write(
        config.join("user-dirs.dirs"),
        format!(
            "XDG_DOCUMENTS_DIR=\"{}\"\n",
            home.path().join("Documents").display()
        ),
    )
    .unwrap();
    let output = std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args([
            "--exact",
            &format!("server::agent_sync::reconcile_tests::{test}"),
            "--nocapture",
        ])
        .env(WORKER_CHILD_ENV, "1")
        .env("RYU_PROFILE", "dev")
        .env("RYU_KEYCHAIN", "off")
        .env("RYU_DIR", data_dir.path())
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", &config)
        .env_remove("XDG_DOCUMENTS_DIR")
        .output()
        .expect("start the isolated worker test process");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated `{test}` failed: {}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("1 passed; 0 failed"),
        "isolated `{test}` ran no test: the child must report `1 passed; 0 failed`, got:\n{stdout}"
    );
    false
}

/// A child whose name matches no test exits 0 having run nothing, so the parent
/// must not read that as a pass.
#[test]
#[should_panic(expected = "ran no test")]
fn an_isolated_child_that_matches_no_test_is_a_failure() {
    in_isolated_process("no_such_agent_sync_worker_test");
}

/// A runtime whose clock stands still until the test moves it.
fn run_paused<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .expect("a paused runtime")
        .block_on(future)
}

/// Let the worker run for `real` time without moving the paused clock: the
/// runtime never idles here, so it never advances the clock by itself.
async fn settle(real: Duration) {
    let until = Instant::now() + real;
    while Instant::now() < until {
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Wait, in real time and without moving the paused clock, until `$condition`
/// holds.
macro_rules! until {
    ($what:expr, $condition:expr) => {{
        let started = Instant::now();
        while !$condition {
            assert!(started.elapsed() < WAIT, "timed out waiting for {}", $what);
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_millis(2));
        }
    }};
}

/// Give the freshly spawned worker its turn to start, so that its interval
/// begins at the current (paused) time.
async fn let_the_worker_start() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

/// A ChatGPT export folder named `name` under `parent`.
fn export_folder(parent: &Path, name: &str, conversations: Vec<Value>) -> PathBuf {
    let root = parent.join(name);
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("conversations.json"),
        Value::Array(conversations).to_string(),
    )
    .unwrap();
    root.canonicalize().unwrap()
}

async fn watch(store: &AgentSyncStore, id: &str, root: &Path, import_enabled: bool) {
    store
        .upsert_profile(ProfileInput {
            id: Some(id.to_owned()),
            provider: "chatgpt".to_owned(),
            root: root.to_string_lossy().to_string(),
            import_enabled,
            export_enabled: false,
            include_conversations: None,
        })
        .await
        .unwrap();
}

async fn imported_texts(state: &ServerState, conversation_id: &str) -> Option<Vec<String>> {
    let tenancy = crate::server::caller_tenancy(&None);
    let (conversation, _) = state
        .conversations
        .find_imported_conversation_with_generation(ORIGIN, conversation_id, &tenancy)
        .await
        .unwrap()?;
    let messages = state
        .conversations
        .get_messages(&conversation)
        .await
        .unwrap();
    Some(
        messages
            .into_iter()
            .map(|message| message.content)
            .collect(),
    )
}

#[test]
fn the_worker_ticks_every_thirty_seconds_and_imports_only_with_the_switch_on() {
    if !in_isolated_process(
        "the_worker_ticks_every_thirty_seconds_and_imports_only_with_the_switch_on",
    ) {
        return;
    }
    run_paused(async {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let store = AgentSyncStore::open_in_memory().unwrap();
        install_global(store.clone());

        // Two watched folders with an export each. The worker visits profiles by
        // provider and root, so `a-off` is handled before `z-on` in every tick:
        // once `z-on` is imported, the tick has already passed `a-off`.
        let off_root = export_folder(
            directory.path(),
            "a-off",
            vec![chatgpt_conversation("off-chat", None, LISBON)],
        );
        let on_root = export_folder(
            directory.path(),
            "z-on",
            vec![chatgpt_conversation("on-chat", None, LISBON)],
        );
        watch(&store, "worker-off", &off_root, false).await;
        watch(&store, "worker-on", &on_root, true).await;
        let ledger = |profile: &'static str| {
            let store = store.clone();
            async move {
                store
                    .item(profile, crate::import::kind::CONVERSATIONS, CHATS_ITEM)
                    .await
                    .unwrap()
            }
        };

        spawn_worker(state.clone());
        let_the_worker_start().await;

        // One millisecond short of the interval, nothing has run.
        tokio::time::advance(Duration::from_millis(29_999)).await;
        settle(Duration::from_millis(500)).await;
        assert!(ledger("worker-on").await.is_none());
        assert_eq!(imported_texts(&state, "on-chat").await, None);

        // At 30 seconds the first tick imports the profile whose Import switch
        // is on, and leaves the other alone.
        tokio::time::advance(Duration::from_millis(1)).await;
        until!(
            "the first tick to import the watched export",
            ledger("worker-on").await.is_some()
        );
        let first = ledger("worker-on").await.unwrap();
        assert_eq!((first.state.as_str(), first.revision), ("imported", 1));
        assert_eq!(
            imported_texts(&state, "on-chat").await,
            texts(&["Plan Lisbon", "Day 1: Alfama"])
        );
        assert!(
            ledger("worker-off").await.is_none(),
            "a profile whose Import switch is off is not imported"
        );
        assert_eq!(imported_texts(&state, "off-chat").await, None);

        // Turning the switch on takes effect at the next tick, which comes a full
        // interval after the first.
        watch(&store, "worker-off", &off_root, true).await;
        tokio::time::advance(Duration::from_millis(29_999)).await;
        settle(Duration::from_millis(500)).await;
        assert!(
            ledger("worker-off").await.is_none(),
            "the second tick comes 30 seconds after the first, not sooner"
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        until!(
            "the second tick to import the profile that was switched on",
            ledger("worker-off").await.is_some()
        );
        assert_eq!(
            imported_texts(&state, "off-chat").await,
            texts(&["Plan Lisbon", "Day 1: Alfama"])
        );
        // The profile that was already imported is not imported again.
        assert_eq!(ledger("worker-on").await.unwrap().revision, 1);
    });
}

/// Windows resolves the Documents folder through the system, not through the
/// child's home directory, so this would create its project folders in the real
/// one.
#[cfg(unix)]
#[test]
fn the_worker_imports_at_most_256_items_a_tick_and_continues_on_the_next() {
    const GROUPS: usize = 257;
    if !in_isolated_process("the_worker_imports_at_most_256_items_a_tick_and_continues_on_the_next")
    {
        return;
    }
    run_paused(async {
        let home = PathBuf::from(std::env::var_os("HOME").expect("the child's home"));
        let projects = home.join("Documents").join("Ryu");
        assert_eq!(
            crate::import::chat_exports::default_projects_base(),
            Some(projects.clone()),
            "the child must create project folders inside its own home"
        );

        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let store = AgentSyncStore::open_in_memory().unwrap();
        install_global(store.clone());

        // 257 chats, each in a project of its own, so the scan has 257 items and
        // every item creates a project folder when it is imported.
        let chat_ids: Vec<String> = (0..GROUPS)
            .map(|index| format!("project-chat-{index:04}"))
            .collect();
        let item_ids: Vec<String> = (0..GROUPS)
            .map(|index| format!("conversations/conversations.json#g-p-{index:04}x"))
            .collect();
        let conversations = (0..GROUPS)
            .map(|index| {
                chatgpt_conversation(&chat_ids[index], Some(&format!("g-p-{index:04}x")), LISBON)
            })
            .collect();
        let root = export_folder(directory.path(), "projects-export", conversations);
        watch(&store, "worker-projects", &root, true).await;

        let rows = || {
            let store = store.clone();
            async move {
                let mut rows: Vec<SyncItemStatus> = store
                    .items()
                    .await
                    .unwrap()
                    .into_iter()
                    .filter(|item| item.profile_id == "worker-projects")
                    .collect();
                rows.sort_by(|left, right| left.source_id.cmp(&right.source_id));
                rows
            }
        };
        let imported_chats = || {
            let state = state.clone();
            let chat_ids = chat_ids.clone();
            async move {
                let mut imported = 0;
                for id in &chat_ids {
                    imported += usize::from(imported_texts(&state, id).await.is_some());
                }
                imported
            }
        };
        let project_folders = || {
            fs::read_dir(&projects)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|e| e.path().is_dir())
                        .count()
                })
                .unwrap_or(0)
        };

        spawn_worker(state.clone());
        let_the_worker_start().await;
        tokio::time::advance(Duration::from_millis(29_999)).await;
        settle(Duration::from_millis(500)).await;
        assert!(
            rows().await.is_empty(),
            "nothing runs before the first tick"
        );

        // The first tick imports 256 of the 257 items and records each.
        tokio::time::advance(Duration::from_millis(1)).await;
        until!(
            "the first tick to import 256 items",
            rows().await.len() >= 256
        );
        settle(Duration::from_millis(1_000)).await;
        let after_first = rows().await;
        assert_eq!(after_first.len(), 256, "a tick imports at most 256 items");
        assert!(after_first
            .iter()
            .all(|row| row.state == "imported" && row.revision == 1));
        assert_eq!(
            after_first
                .iter()
                .map(|row| row.source_id.as_str())
                .collect::<Vec<_>>(),
            item_ids[..256]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            "the first 256 items, in scan order"
        );
        assert_eq!(imported_chats().await, 256);
        assert_eq!(project_folders(), 256);

        // Nothing more happens until the next tick.
        tokio::time::advance(Duration::from_millis(29_999)).await;
        settle(Duration::from_millis(1_000)).await;
        assert_eq!(rows().await.len(), 256);
        assert_eq!(imported_chats().await, 256);

        // The next tick continues with the one that was left, and imports
        // nothing a second time.
        tokio::time::advance(Duration::from_millis(1)).await;
        until!(
            "the second tick to import the last item",
            rows().await.len() >= 257
        );
        settle(Duration::from_millis(500)).await;
        let after_second = rows().await;
        assert_eq!(after_second.len(), 257);
        assert!(
            after_second
                .iter()
                .all(|row| row.state == "imported" && row.revision == 1),
            "the 256 items of the first tick are not imported again"
        );
        assert_eq!(imported_chats().await, 257);
        assert_eq!(project_folders(), 257);
    });
}
