//! The HTTP handlers, called as the router calls them, with a verified person:
//! the chat route, the retry, the change list and the rewind of a checkpoint,
//! and the write of the member folder list.

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::{Extension, Json};

use super::*;
use crate::server::chat_checkpoints::{
    capture_turn, chat_checkpoint_changes, restore_chat_checkpoint,
};

fn as_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The status and the body text of `POST /api/chat/stream` sent by `caller`.
async fn post_turn(
    caller: Option<VerifiedCaller>,
    request: ChatStreamRequest,
) -> (StatusCode, String) {
    let response = crate::server::run_chat_stream_request(
        State(state()),
        axum::http::HeaderMap::new(),
        Extension(caller),
        Extension(crate::server::VerifiedUserJwt(None)),
        None,
        request,
        axum::body::Bytes::new(),
    )
    .await;
    let status = response.status();
    (status, body_text(response).await)
}

/// A 403 from the chat route must leave nothing behind for the conversation.
async fn assert_route_refused(
    caller: Option<VerifiedCaller>,
    folders: serde_json::Value,
    what: &str,
) {
    let store = state().conversations.clone();
    let id = conversation("conv-route");
    let (status, body) = post_turn(caller, turn(&id, folders)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
    assert!(body.contains(FOLDER_UNAVAILABLE_MESSAGE), "{what}: {body}");
    assert!(
        store.get_access_meta(&id).await.expect("meta").is_none(),
        "{what}: the conversation is not claimed"
    );
    assert_eq!(checkpoint_count(&store, &id).await, 0, "{what}");
    assert_eq!(stored_folders(&store, &id).await, (None, None), "{what}");
}

#[tokio::test]
async fn the_chat_route_answers_403_before_anything_is_recorded() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let inside = as_text(allowed.path());
    let out = as_text(outside.path());
    on_shared_node(&[allowed.path()], async {
        for (what, caller, folders) in [
            ("a member, cwd outside", member(), json!({ "cwd": out })),
            (
                "a member, an extra folder outside",
                member(),
                json!({ "cwd": inside, "workspace_folders": [inside, out] }),
            ),
            (
                "a member, worktree_path outside",
                member(),
                json!({ "cwd": inside, "worktree_path": out }),
            ),
            // Nobody is exempt on a shared node: the list binds the people who keep it.
            (
                "the organization owner, cwd outside",
                person("owner-of-org", OrgRole::Owner),
                json!({ "cwd": out }),
            ),
            (
                "an organization admin, cwd outside",
                person("admin-1", OrgRole::Admin),
                json!({ "cwd": out }),
            ),
        ] {
            assert_route_refused(caller, folders, what).await;
        }
    })
    .await;
}

#[tokio::test]
async fn the_chat_route_refuses_every_folder_while_no_list_is_set() {
    let folder = tempfile::tempdir().expect("folder");
    let folders = json!({ "cwd": as_text(folder.path()) });
    on_shared_node(&[], assert_route_refused(member(), folders, "no list")).await;
}

/// `POST /api/chat/retry/{id}` as the member who owns the conversation.
async fn retry(id: &str) -> (StatusCode, String) {
    let body = serde_json::from_value(json!({ "reason": "network_reconnect" })).expect("body");
    let response = crate::server::chat_retry(
        State(state()),
        Extension(member()),
        Extension(None::<String>),
        AxumPath(id.to_owned()),
        Json(body),
    )
    .await;
    let status = response.status();
    (status, body_text(response).await)
}

#[tokio::test]
async fn a_retry_is_refused_when_a_stored_folder_is_outside_the_list() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let inside = as_text(allowed.path());
    let out = as_text(outside.path());
    let store = state().conversations.clone();
    for (what, folder, worktree) in [
        ("the stored folder", out.as_str(), None),
        ("the stored worktree", inside.as_str(), Some(out.as_str())),
    ] {
        let id = conversation("conv-retry");
        owned_conversation(&store, &id).await;
        store
            .set_run_metadata(&id, Some(folder), None, worktree)
            .await
            .expect("stored folders");
        store.set_run_status(&id, "failed").await.expect("status");
        let (status, body) = on_shared_node(&[allowed.path()], retry(&id)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
        assert!(body.contains(FOLDER_UNAVAILABLE_MESSAGE), "{what}: {body}");
        let summary = store.get_run_summary(&id).await.unwrap().expect("summary");
        assert_eq!(
            summary.run_status.as_deref(),
            Some("failed"),
            "{what}: the retry claimed nothing"
        );
    }
}

/// A conversation of the member with one checkpoint taken in `folder`, then two
/// edits "by the agent". Returns the conversation id and the checkpoint id.
async fn checkpoint_in(folder: &Path) -> (String, String) {
    let store = state().conversations.clone();
    std::fs::write(folder.join("a.txt"), b"before").expect("file");
    let id = conversation("conv-checkpoint");
    let message = owned_conversation(&store, &id).await;
    capture_turn(&store, &id, &message, Some(folder.to_path_buf())).await;
    let rows = store.list_chat_checkpoints(&id, 10).await.expect("rows");
    assert_eq!(rows.len(), 1);
    assert!(rows[0].has_files, "{:?}", rows[0]);
    std::fs::write(folder.join("a.txt"), b"after").expect("edit");
    std::fs::write(folder.join("new.txt"), b"new").expect("new file");
    (id, rows[0].id.clone())
}

async fn changes(id: &str, checkpoint: &str) -> (StatusCode, String) {
    let response = chat_checkpoint_changes(
        State(state()),
        Extension(member()),
        AxumPath((id.to_owned(), checkpoint.to_owned())),
    )
    .await;
    let status = response.status();
    (status, body_text(response).await)
}

async fn restore_code(id: &str, checkpoint: &str) -> (StatusCode, String) {
    let body = serde_json::from_value(json!({ "mode": "code" })).expect("body");
    let response = restore_chat_checkpoint(
        State(state()),
        Extension(member()),
        AxumPath((id.to_owned(), checkpoint.to_owned())),
        Json(body),
    )
    .await;
    let status = response.status();
    (status, body_text(response).await)
}

#[tokio::test]
async fn changes_and_rewind_are_refused_for_a_checkpoint_outside_the_list() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let (id, checkpoint) = checkpoint_in(outside.path()).await;
    on_shared_node(&[allowed.path()], async {
        let (status, body) = changes(&id, &checkpoint).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "changes: {body}");
        assert!(body.contains("folder_not_allowed"), "changes: {body}");
        let (status, body) = restore_code(&id, &checkpoint).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "restore: {body}");
        assert!(body.contains("folder_not_allowed"), "restore: {body}");
    })
    .await;
    // The folder is untouched and no undo checkpoint was written.
    assert_eq!(
        std::fs::read(outside.path().join("a.txt")).unwrap(),
        b"after"
    );
    assert!(outside.path().join("new.txt").exists());
    let store = state().conversations.clone();
    assert_eq!(checkpoint_count(&store, &id).await, 1);
}

#[tokio::test]
async fn changes_and_rewind_work_for_a_checkpoint_in_a_listed_folder() {
    let allowed = tempfile::tempdir().expect("allowed");
    let (id, checkpoint) = checkpoint_in(allowed.path()).await;
    on_shared_node(&[allowed.path()], async {
        let (status, body) = changes(&id, &checkpoint).await;
        assert_eq!(status, StatusCode::OK, "changes: {body}");
        let (status, body) = restore_code(&id, &checkpoint).await;
        assert_eq!(status, StatusCode::OK, "restore: {body}");
    })
    .await;
    assert_eq!(
        std::fs::read(allowed.path().join("a.txt")).unwrap(),
        b"before"
    );
    assert!(!allowed.path().join("new.txt").exists());
}

/// `PUT /api/preferences/member-workspace-roots` as `caller`.
async fn put_list(caller: Option<VerifiedCaller>, value: &str) -> StatusCode {
    crate::server::set_preference(
        State(state()),
        AxumPath(MEMBER_WORKSPACE_ROOTS_PREF_KEY.to_owned()),
        Extension(caller),
        Json(crate::server::SetPreferenceBody {
            value: value.to_owned(),
        }),
    )
    .await
    .status()
}

/// A person needs `nodes.manage` to write the list. The node credential with no
/// person is the machine's operator and may write. This test reads the list the
/// process holds, not a per-task one, and leaves it empty.
#[tokio::test]
async fn only_a_node_manager_or_the_operator_writes_the_member_folders() {
    let folder = tempfile::tempdir().expect("folder");
    let value = list_value(&[folder.path()]);
    let preferences = state().preferences.clone();
    let stored = || async {
        preferences
            .get(MEMBER_WORKSPACE_ROOTS_PREF_KEY)
            .await
            .expect("read")
    };
    let before = stored().await;
    with_test_node_binding(true, Some(node(NodeScope::Org)), async {
        for caller in [member(), person("viewer-1", OrgRole::Viewer)] {
            assert_eq!(put_list(caller, &value).await, StatusCode::FORBIDDEN);
        }
        assert_eq!(stored().await, before, "a refused write stores nothing");
        assert!(!stored_folder_allowed(folder.path()), "and loads nothing");

        let admin = person("admin-1", OrgRole::Admin);
        assert_eq!(put_list(admin, &value).await, StatusCode::OK);
        assert_eq!(stored().await.as_deref(), Some(value.as_str()));
        assert!(
            stored_folder_allowed(folder.path()),
            "the write loads the list at once"
        );

        assert_eq!(put_list(None, "[]").await, StatusCode::OK);
        assert!(
            !stored_folder_allowed(folder.path()),
            "the operator emptied it"
        );
    })
    .await;
}

/// The generic preference routes stay owner-only in the route policy, so a
/// member's credential does not reach the handler above at all.
#[test]
fn the_preference_routes_stay_owner_only() {
    let path = format!("/api/preferences/{MEMBER_WORKSPACE_ROOTS_PREF_KEY}");
    for method in [axum::http::Method::GET, axum::http::Method::PUT] {
        assert!(
            matches!(
                crate::server::route_policy(&method, &path),
                crate::authorization::RoutePolicy::OwnerOnly
            ),
            "{method} {path}"
        );
    }
}
