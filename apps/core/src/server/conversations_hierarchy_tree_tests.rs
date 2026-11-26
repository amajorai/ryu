//! Unit tests for the session tree walk (`conversations_hierarchy_tree.rs`).

use super::super::super::{ConversationStore, Tenancy};
use super::*;

/// A store with one session row per id.
async fn store_with(ids: &[&str]) -> ConversationStore {
    let store = ConversationStore::open_in_memory().unwrap();
    for id in ids {
        store
            .ensure_conversation(id, None, None, Tenancy::Unattributed)
            .await
            .unwrap();
    }
    store
}

async fn spawn(store: &ConversationStore, parent: &str, child: &str) {
    store.mark_spawned_by(child, parent, None).await.unwrap();
}

async fn walk(
    store: &ConversationStore,
    id: &str,
    max_levels: usize,
    max_nodes: usize,
) -> Option<ThreadTreeLinks> {
    let conn = store.conn.lock().await;
    thread_tree_locked(&conn, id, max_levels, max_nodes).unwrap()
}

fn shape(tree: &ThreadTreeLinks) -> Vec<(String, Option<String>, usize)> {
    let mut rows: Vec<_> = tree
        .links
        .iter()
        .map(|link| (link.id.clone(), link.parent_id.clone(), link.level))
        .collect();
    rows.sort();
    rows
}

fn row(id: &str, parent: Option<&str>, level: usize) -> (String, Option<String>, usize) {
    (id.to_owned(), parent.map(str::to_owned), level)
}

#[tokio::test]
async fn a_missing_thread_has_no_tree() {
    let store = store_with(&["root"]).await;
    assert!(store.thread_tree("nope").await.unwrap().is_none());
}

#[tokio::test]
async fn a_thread_alone_is_its_own_root() {
    let store = store_with(&["root"]).await;
    let tree = store.thread_tree("root").await.unwrap().unwrap();
    assert_eq!(shape(&tree), vec![row("root", None, 0)]);
    assert!(!tree.truncated);
}

#[tokio::test]
async fn the_tree_is_the_same_from_every_thread_in_it() {
    let store = store_with(&["root", "a", "b", "a1", "a2", "a1x", "other"]).await;
    spawn(&store, "root", "a").await;
    spawn(&store, "root", "b").await;
    spawn(&store, "a", "a1").await;
    spawn(&store, "a", "a2").await;
    spawn(&store, "a1", "a1x").await;
    let expected = vec![
        row("a", Some("root"), 1),
        row("a1", Some("a"), 2),
        row("a1x", Some("a1"), 3),
        row("a2", Some("a"), 2),
        row("b", Some("root"), 1),
        row("root", None, 0),
    ];
    for start in ["root", "a", "b", "a1", "a2", "a1x"] {
        let tree = store.thread_tree(start).await.unwrap().unwrap();
        assert_eq!(shape(&tree), expected, "from {start}");
        assert!(!tree.truncated, "from {start}");
        // Breadth first: a parent always comes before its children.
        for (index, link) in tree.links.iter().enumerate() {
            if let Some(parent) = &link.parent_id {
                let at = tree.links.iter().position(|other| &other.id == parent);
                assert!(at.is_some_and(|at| at < index), "{} from {start}", link.id);
            }
        }
    }
    // A thread outside the chain is not part of it.
    let other = store.thread_tree("other").await.unwrap().unwrap();
    assert_eq!(shape(&other), vec![row("other", None, 0)]);
}

#[tokio::test]
async fn the_level_cap_cuts_the_tree_and_says_so() {
    let store = store_with(&["l0", "l1", "l2", "l3"]).await;
    spawn(&store, "l0", "l1").await;
    spawn(&store, "l1", "l2").await;
    spawn(&store, "l2", "l3").await;
    let whole = walk(&store, "l0", 4, 100).await.unwrap();
    assert_eq!(whole.links.len(), 4);
    assert!(!whole.truncated);
    let cut = walk(&store, "l0", 3, 100).await.unwrap();
    assert_eq!(
        shape(&cut),
        vec![
            row("l0", None, 0),
            row("l1", Some("l0"), 1),
            row("l2", Some("l1"), 2),
        ]
    );
    assert!(cut.truncated);
}

#[tokio::test]
async fn the_node_cap_cuts_the_tree_and_says_so() {
    let store = store_with(&["root", "s1", "s2", "s3", "s4"]).await;
    for child in ["s1", "s2", "s3", "s4"] {
        spawn(&store, "root", child).await;
    }
    let whole = walk(&store, "root", 8, 5).await.unwrap();
    assert_eq!(whole.links.len(), 5);
    assert!(!whole.truncated);
    let cut = walk(&store, "root", 8, 3).await.unwrap();
    assert_eq!(cut.links.len(), 3);
    assert_eq!(cut.links[0].id, "root");
    assert!(cut.truncated);
}

#[tokio::test]
async fn a_cycle_ends_the_walk() {
    let store = store_with(&["a", "b", "c"]).await;
    // a and b name each other as the spawning thread; c hangs below b.
    spawn(&store, "b", "a").await;
    spawn(&store, "a", "b").await;
    spawn(&store, "b", "c").await;
    for start in ["a", "b", "c"] {
        let tree = store.thread_tree(start).await.unwrap().unwrap();
        let mut ids: Vec<_> = tree.links.iter().map(|link| link.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["a", "b", "c"], "from {start}");
        assert_eq!(
            tree.links
                .iter()
                .filter(|link| link.parent_id.is_none())
                .count(),
            1,
            "from {start}"
        );
        assert!(!tree.truncated, "from {start}");
    }
}

#[tokio::test]
async fn a_parent_that_no_longer_exists_ends_the_walk_up() {
    let store = store_with(&["child", "grandchild"]).await;
    spawn(&store, "gone", "child").await;
    spawn(&store, "child", "grandchild").await;
    let tree = store.thread_tree("grandchild").await.unwrap().unwrap();
    assert_eq!(
        shape(&tree),
        vec![row("child", None, 0), row("grandchild", Some("child"), 1)]
    );
}
