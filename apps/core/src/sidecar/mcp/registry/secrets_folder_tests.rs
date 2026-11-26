//! The command tools' workspace root on a shared node. The root comes from the
//! folder stored on the host conversation, and anyone who may write a thread row
//! can store any folder string there, so the stored folder is checked when used.

use std::path::Path;

use serde_json::json;

use super::*;
use crate::server::conversations::ConversationStore;
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
    let roots = turn_folders::parse_member_roots(&value);
    assert_eq!(roots.len(), dirs.len(), "usable member folders: {value}");
    roots
}

/// A conversation whose row stores `folder` and `worktree`.
async fn row(store: &ConversationStore, folder: &Path, worktree: Option<&Path>) -> String {
    let id = format!("conv-root-{}", uuid::Uuid::new_v4());
    store
        .append_message(&id, "user", "run it", None, None, None)
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
    id
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).expect("canonical")
}

#[tokio::test]
async fn a_stored_folder_outside_the_list_is_no_command_root_on_a_shared_node() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let store = ConversationStore::open_in_memory().expect("store");
    let registry = McpRegistry::empty().with_conversations(store.clone());
    let outside_row = row(&store, outside.path(), None).await;
    let inside_row = row(&store, allowed.path(), None).await;
    let mixed_row = row(&store, allowed.path(), Some(outside.path())).await;

    let listed = turn_folders::with_test_member_roots(roots(&[allowed.path()]), async {
        (
            registry.command_workspace_root(Some(&outside_row)).await,
            registry.command_workspace_root(Some(&inside_row)).await,
            registry.command_workspace_root(Some(&mixed_row)).await,
            registry.command_workspace_root(None).await,
        )
    });
    let (outside_root, inside_root, mixed_root, no_conversation) =
        with_test_node_binding(true, Some(shared_node()), listed).await;
    assert_eq!(outside_root, None, "a stored folder outside the list");
    assert_eq!(inside_root, Some(canonical(allowed.path())));
    assert_eq!(
        mixed_root,
        Some(canonical(allowed.path())),
        "the worktree outside is skipped, the folder inside is used"
    );
    assert_eq!(no_conversation, None);

    // Fail closed: with no list nothing is a root, and a managed node that is
    // not registered yet never falls back to Core's own directory.
    let unlisted = turn_folders::with_test_member_roots(Vec::new(), async {
        (
            registry.command_workspace_root(Some(&inside_row)).await,
            registry.command_workspace_root(None).await,
        )
    });
    assert_eq!(
        with_test_node_binding(true, None, unlisted).await,
        (None, None)
    );
}

#[tokio::test]
async fn a_personal_node_keeps_its_command_root() {
    let folder = tempfile::tempdir().expect("folder");
    let store = ConversationStore::open_in_memory().expect("store");
    let registry = McpRegistry::empty().with_conversations(store.clone());
    let id = row(&store, folder.path(), None).await;
    let root = with_test_node_binding(
        false,
        None,
        turn_folders::with_test_member_roots(Vec::new(), async {
            registry.command_workspace_root(Some(&id)).await
        }),
    )
    .await;
    assert_eq!(root, Some(canonical(folder.path())));
}
