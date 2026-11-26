//! Turns sent through `route_chat_stream`, the path every turn takes whoever
//! built it: the HTTP route, a retry, auto-resume, the threads tool, a team
//! member, a voice session. None of these requests carries a caller.

use super::*;

/// What a refused turn must leave behind: the refusal, no checkpoint, no stored folder.
async fn assert_refused(store: &ConversationStore, request: ChatStreamRequest, what: &str) {
    let id = request.conversation_id.clone().expect("conversation id");
    let body = body_text(send(store, request).await).await;
    assert!(
        body.contains(FOLDER_UNAVAILABLE_MESSAGE),
        "{what}: the turn must be refused for its folder, got: {body}"
    );
    assert_eq!(
        checkpoint_count(store, &id).await,
        0,
        "{what}: no checkpoint"
    );
    assert_eq!(
        stored_folders(store, &id).await,
        (None, None),
        "{what}: nothing stored on the conversation"
    );
}

fn as_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn a_turn_with_no_caller_cannot_take_a_folder_outside_the_list() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("a.txt"), b"not for members").expect("file");
    let store = ConversationStore::open_in_memory().expect("store");
    let inside = as_text(allowed.path());
    let out = as_text(outside.path());
    on_shared_node(&[allowed.path()], async {
        for (what, folders) in [
            ("cwd outside", json!({ "cwd": out })),
            (
                "an extra folder outside",
                json!({ "cwd": inside, "workspace_folders": [inside, out] }),
            ),
            (
                "worktree_path outside",
                json!({ "cwd": inside, "worktree_path": out }),
            ),
        ] {
            let id = conversation("conv-outside");
            assert_refused(&store, turn(&id, folders), what).await;
        }
    })
    .await;
}

/// Auto-resume and retry rebuild the turn from the folders stored on the row.
/// The request they build is refused like any other when a stored folder is
/// outside the list.
#[tokio::test]
async fn a_rerun_built_from_stored_folders_outside_the_list_is_refused() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let store = ConversationStore::open_in_memory().expect("store");
    let id = conversation("conv-rerun");
    store
        .append_message(&id, "user", "carry on", None, None, None)
        .await
        .expect("user turn");
    let out = as_text(outside.path());
    store
        .set_run_metadata(&id, Some(&out), None, None)
        .await
        .expect("stored folder");
    store
        .set_run_status(&id, "interrupted")
        .await
        .expect("status");
    let summary = store.get_run_summary(&id).await.unwrap().expect("summary");
    let stored = summary.folder_path.clone();
    let messages = store.get_active_messages(&id).await.expect("messages");
    let request = crate::server::rerun_request_from_history(&id, summary, messages);
    assert_eq!(request.cwd, stored, "the rerun carries the stored folder");

    on_shared_node(&[allowed.path()], async {
        let body = body_text(send(&store, request).await).await;
        assert!(body.contains(FOLDER_UNAVAILABLE_MESSAGE), "got: {body}");
    })
    .await;
    assert_eq!(checkpoint_count(&store, &id).await, 0);
    let after = store.get_run_summary(&id).await.unwrap().expect("summary");
    assert_eq!(
        after.run_status.as_deref(),
        Some("interrupted"),
        "the refused rerun never became a running turn"
    );
}

/// With isolation Core checks out the whole repository that holds the folder,
/// so the repository root must be a member folder too.
#[tokio::test]
async fn isolation_is_refused_when_the_repository_root_is_outside_the_list() {
    let repo = tempfile::tempdir().expect("repo");
    let init = std::process::Command::new("git")
        .arg("init")
        .arg("-q")
        .arg(repo.path())
        .status()
        .expect("git runs");
    assert!(init.success(), "git init");
    let allowed = repo.path().join("allowed");
    let project = allowed.join("project");
    std::fs::create_dir_all(&project).expect("project");
    let store = ConversationStore::open_in_memory().expect("store");
    on_shared_node(&[allowed.as_path()], async {
        let id = conversation("conv-isolation");
        let folders = json!({ "cwd": as_text(&project), "worktree_isolation": true });
        assert_refused(&store, turn(&id, folders), "repository root above the list").await;
    })
    .await;
    assert!(
        !repo.path().join(".ryu-worktrees").exists(),
        "no managed worktree"
    );
}

/// A link inside a member folder that points outside. Runs on Windows through a
/// directory junction and elsewhere through a symbolic link; never skipped.
#[tokio::test]
async fn a_linked_folder_that_points_outside_the_list_is_refused() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("a.txt"), b"not for members").expect("file");
    let link = allowed.path().join("link");
    link_dir(&link, outside.path());
    let store = ConversationStore::open_in_memory().expect("store");
    on_shared_node(&[allowed.path()], async {
        let id = conversation("conv-link");
        let folders = json!({ "cwd": as_text(&link) });
        assert_refused(&store, turn(&id, folders), "a link that leaves the list").await;
        let id = conversation("conv-link-extra");
        let folders = json!({
            "cwd": as_text(allowed.path()),
            "workspace_folders": [as_text(&link)],
        });
        assert_refused(&store, turn(&id, folders), "an extra folder through a link").await;
    })
    .await;
}

/// Fail closed: no list, an empty list, or a list of entries that may not be
/// listed allows no folder at all.
#[tokio::test]
async fn with_no_usable_list_no_folder_is_allowed() {
    let folder = tempfile::tempdir().expect("folder");
    let store = ConversationStore::open_in_memory().expect("store");
    let home = dirs::home_dir().expect("home");
    let root = home.ancestors().last().expect("root").to_path_buf();
    let unusable = json!([
        { "path": root },
        { "path": home },
        { "path": "relative/projects" },
        { "path": folder.path(), "writable": true },
        folder.path(),
    ])
    .to_string();
    for (what, value) in [
        ("no list", String::new()),
        ("an empty list", "[]".to_owned()),
        ("a value that is not an array", "{}".to_owned()),
        ("only entries that may not be listed", unusable),
    ] {
        let roots = parse_member_roots(&value);
        assert!(roots.is_empty(), "{what}: {value}");
        let id = conversation("conv-no-list");
        let request = turn(&id, json!({ "cwd": as_text(folder.path()) }));
        with_test_node_binding(
            true,
            Some(node(NodeScope::Org)),
            with_test_member_roots(roots, assert_refused(&store, request, what)),
        )
        .await;
    }
}

/// A folder that does not resolve on the node is treated as absent: the turn
/// runs with no folder and the string is never stored.
#[tokio::test]
async fn a_folder_that_does_not_resolve_is_cleared_and_never_stored() {
    let allowed = tempfile::tempdir().expect("allowed");
    let missing = as_text(&allowed.path().join("not-here"));
    let folders = json!({
        "cwd": missing,
        "workspace_folders": [missing],
        "worktree_path": missing,
    });
    let store = ConversationStore::open_in_memory().expect("store");
    let id = conversation("conv-missing");
    on_shared_node(&[allowed.path()], async {
        // The field is cleared before anything derives a project id from it.
        let mut request = turn(&id, folders.clone());
        assert_eq!(bound_request(&mut request), Ok(()));
        assert_eq!(
            (
                request.cwd,
                request.workspace_folders,
                request.worktree_path
            ),
            (None, Vec::new(), None)
        );
        let body = body_text(send(&store, turn(&id, folders)).await).await;
        assert!(!body.contains(FOLDER_UNAVAILABLE_MESSAGE), "not a refusal");
    })
    .await;
    assert_eq!(stored_folders(&store, &id).await, (None, None));
    let rows = store.list_chat_checkpoints(&id, 10).await.expect("rows");
    assert!(rows.iter().all(|row| !row.has_files), "no folder snapshot");
}

/// A turn in a listed folder runs as before: the folder is stored in its
/// resolved form and the checkpoint is taken.
#[tokio::test]
async fn a_turn_inside_a_listed_folder_is_admitted_and_checkpointed() {
    let allowed = tempfile::tempdir().expect("allowed");
    let project = allowed.path().join("project");
    std::fs::create_dir_all(&project).expect("project");
    std::fs::write(project.join("a.txt"), b"before").expect("file");
    let store = ConversationStore::open_in_memory().expect("store");
    let id = conversation("conv-inside");
    on_shared_node(&[allowed.path()], async {
        let request = turn(&id, json!({ "cwd": as_text(&project) }));
        drop(send(&store, request).await);
    })
    .await;
    let rows = store.list_chat_checkpoints(&id, 10).await.expect("rows");
    assert_eq!(rows.len(), 1, "one checkpoint for the admitted turn");
    assert!(rows[0].has_files, "{:?}", rows[0]);
    let (folder, _) = stored_folders(&store, &id).await;
    assert_eq!(
        folder.as_deref().map(Path::new),
        Some(Path::new(&real(&project)))
    );
}

/// The personal node is untouched: any folder, listed or not, with the list
/// empty, whether the node is unbound or registered to its owner.
#[tokio::test]
async fn a_personal_node_runs_a_turn_in_any_folder() {
    for (managed, registered) in [(false, None), (true, Some(node(NodeScope::Personal)))] {
        let folder = tempfile::tempdir().expect("folder");
        std::fs::write(folder.path().join("a.txt"), b"before").expect("file");
        let store = ConversationStore::open_in_memory().expect("store");
        let id = conversation("conv-personal");
        let request = turn(&id, json!({ "cwd": as_text(folder.path()) }));
        with_test_node_binding(
            managed,
            registered,
            with_test_member_roots(Vec::new(), async {
                drop(send(&store, request).await);
            }),
        )
        .await;
        let rows = store.list_chat_checkpoints(&id, 10).await.expect("rows");
        assert_eq!(rows.len(), 1, "managed {managed}: one checkpoint");
        assert!(rows[0].has_files, "{:?}", rows[0]);
        assert!(stored_folders(&store, &id).await.0.is_some());
    }
}

/// A turn that names a cloud environment never reaches a snapshot or a stored
/// folder with the desktop folder it still carries, and the route's early check
/// leaves it to the cloud branch.
#[tokio::test]
async fn a_cloud_turn_never_uses_the_folder_it_carries() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let store = ConversationStore::open_in_memory().expect("store");
    let id = conversation("conv-cloud");
    let folders = json!({ "cwd": as_text(outside.path()), "cloudEnvironmentId": "env-1" });
    on_shared_node(&[allowed.path()], async {
        let mut early = turn(&id, folders.clone());
        assert_eq!(bound_request_before_claim(&mut early).await, Ok(()));
        assert_eq!(early.cwd, Some(as_text(outside.path())), "left as sent");
        drop(send(&store, turn(&id, folders)).await);
    })
    .await;
    assert_eq!(checkpoint_count(&store, &id).await, 0);
    assert_eq!(stored_folders(&store, &id).await, (None, None));
}

/// An app send stays refused on a shared node, as before this change.
#[tokio::test]
async fn an_app_send_stays_refused_on_a_shared_node() {
    use crate::server::host_chat::submit::refuse_shared_node;
    assert!(on_shared_node(&[], async { refuse_shared_node().is_err() }).await);
    assert!(with_test_node_binding(false, None, async { refuse_shared_node().is_ok() }).await);
}
