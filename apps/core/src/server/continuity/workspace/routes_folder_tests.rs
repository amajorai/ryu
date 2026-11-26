//! The folder a thread hands off (inspect and export) on a shared node. It is the
//! folder stored on the conversation row, so it is checked when it is used.

use std::path::Path;

use serde_json::json;

use super::*;
use crate::server::chat_checkpoints::turn_folders::{parse_member_roots, with_test_member_roots};
use crate::server::conversations::{ConversationStore, ConversationSummary};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

fn shared_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn roots(dirs: &[&Path]) -> Vec<PathBuf> {
    let value = serde_json::Value::Array(
        dirs.iter()
            .map(|dir| json!({ "path": dir.to_string_lossy() }))
            .collect(),
    )
    .to_string();
    let roots = parse_member_roots(&value);
    assert_eq!(roots.len(), dirs.len(), "usable member folders: {value}");
    roots
}

/// The run summary of a conversation whose row stores `folder` and `worktree`.
async fn summary(
    store: &ConversationStore,
    folder: &Path,
    worktree: Option<&Path>,
) -> ConversationSummary {
    let id = format!("conv-handoff-{}", uuid::Uuid::new_v4());
    store
        .append_message(&id, "user", "hand it off", None, None, None)
        .await
        .expect("row");
    let worktree = worktree.map(|path| path.to_string_lossy().into_owned());
    store
        .set_run_metadata(
            &id,
            Some(&folder.to_string_lossy()),
            None,
            worktree.as_deref(),
        )
        .await
        .expect("stored folders");
    store
        .get_run_summary(&id)
        .await
        .expect("summary")
        .expect("row")
}

/// The stored folder string as a path, the form `thread_folder` returns.
fn stored(summary: &ConversationSummary) -> Option<PathBuf> {
    summary.folder_path.as_deref().map(PathBuf::from)
}

#[tokio::test]
async fn a_stored_folder_outside_the_list_is_not_handed_off_on_a_shared_node() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let store = ConversationStore::open_in_memory().expect("store");
    let outside_row = summary(&store, outside.path(), None).await;
    let inside_row = summary(&store, allowed.path(), None).await;
    let mixed_row = summary(&store, allowed.path(), Some(outside.path())).await;

    let judged = with_test_node_binding(
        true,
        Some(shared_node()),
        with_test_member_roots(roots(&[allowed.path()]), async {
            (
                thread_folder(&outside_row).map_err(|response| response.status()),
                thread_folder(&inside_row).ok(),
                thread_folder(&mixed_row).ok(),
            )
        }),
    )
    .await;
    assert_eq!(judged.0, Err(StatusCode::UNPROCESSABLE_ENTITY));
    assert_eq!(judged.1, stored(&inside_row));
    assert_eq!(
        judged.2,
        stored(&mixed_row),
        "the worktree outside is skipped, the folder inside is used"
    );

    // Fail closed: with no list no stored folder is handed off.
    let unlisted = with_test_node_binding(
        true,
        Some(shared_node()),
        with_test_member_roots(Vec::new(), async { thread_folder(&inside_row).is_err() }),
    )
    .await;
    assert!(unlisted);
}

#[tokio::test]
async fn a_personal_node_hands_off_any_stored_folder() {
    let folder = tempfile::tempdir().expect("folder");
    let store = ConversationStore::open_in_memory().expect("store");
    let row = summary(&store, folder.path(), None).await;
    let handed = with_test_node_binding(
        false,
        None,
        with_test_member_roots(Vec::new(), async { thread_folder(&row).ok() }),
    )
    .await;
    assert_eq!(handed, stored(&row));
    assert!(handed.is_some());
}
