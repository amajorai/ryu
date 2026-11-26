//! The session tree of a thread: the root of the chain a thread sits in and
//! every session reachable from that root through `spawned_by_conversation_id`.
//!
//! The walk returns ids and parent links only. The route decides which rows
//! the caller may see, so nothing here reads a title or any other content.
//! A grandchild of `conversations`, so it uses the store's private connection
//! directly.

use std::collections::HashSet;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use super::super::ConversationStore;

/// A tree shows at most this many levels, the root included.
pub const MAX_TREE_LEVELS: usize = 8;
/// A tree shows at most this many threads, the root included.
pub const MAX_TREE_NODES: usize = 500;
/// How far up the walk looks for the root before it stops where it is.
const MAX_ROOT_HOPS: usize = 64;

/// One thread of a tree and the thread that spawned it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadTreeLink {
    pub id: String,
    /// `None` for the root.
    pub parent_id: Option<String>,
    /// 0 for the root, 1 for the sessions it spawned, and so on.
    pub level: usize,
}

/// A tree in breadth-first order, so a parent always comes before its children.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadTreeLinks {
    pub links: Vec<ThreadTreeLink>,
    /// The level or node cap cut the tree short.
    pub truncated: bool,
}

/// The thread that spawned `id`. The outer `None` means the row is missing.
fn spawning_parent(conn: &Connection, id: &str) -> rusqlite::Result<Option<Option<String>>> {
    conn.query_row(
        "SELECT spawned_by_conversation_id FROM conversations WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
}

/// The top of the chain `thread_id` sits in, or `None` when the thread does
/// not exist. A missing parent row, a cycle and the hop limit all end the walk
/// at the last thread that exists.
fn tree_root_locked(conn: &Connection, thread_id: &str) -> rusqlite::Result<Option<String>> {
    let Some(mut parent) = spawning_parent(conn, thread_id)? else {
        return Ok(None);
    };
    let mut current = thread_id.to_owned();
    let mut seen = HashSet::from([current.clone()]);
    for _ in 0..MAX_ROOT_HOPS {
        let Some(next) = parent.filter(|id| !id.is_empty()) else {
            break;
        };
        if seen.contains(&next) {
            break;
        }
        let Some(grandparent) = spawning_parent(conn, &next)? else {
            break;
        };
        seen.insert(next.clone());
        current = next;
        parent = grandparent;
    }
    Ok(Some(current))
}

/// The sessions `parent_id` spawned, newest activity first. `limit` bounds the
/// read; one row more than the caller can take is enough to know it was cut.
fn spawned_ids(conn: &Connection, parent_id: &str, limit: usize) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM conversations WHERE spawned_by_conversation_id = ?1
          ORDER BY updated_at DESC, id LIMIT ?2",
    )?;
    let ids = stmt
        .query_map(params![parent_id, limit as i64], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Walk the whole tree `thread_id` sits in, top down, level by level. A thread
/// already in the tree is never added twice, so a cycle ends the walk.
pub(super) fn thread_tree_locked(
    conn: &Connection,
    thread_id: &str,
    max_levels: usize,
    max_nodes: usize,
) -> rusqlite::Result<Option<ThreadTreeLinks>> {
    let Some(root) = tree_root_locked(conn, thread_id)? else {
        return Ok(None);
    };
    let mut tree = ThreadTreeLinks::default();
    let mut seen = HashSet::from([root.clone()]);
    tree.links.push(ThreadTreeLink {
        id: root,
        parent_id: None,
        level: 0,
    });
    // Index of the first link of the level being expanded.
    let mut start = 0;
    while start < tree.links.len() {
        let end = tree.links.len();
        for index in start..end {
            let (parent_id, level) = (tree.links[index].id.clone(), tree.links[index].level);
            let room = max_nodes.saturating_sub(tree.links.len());
            // One more than fits, so a cut is noticed. Ids already in the tree
            // (a cycle) are skipped below, hence the extra `seen` allowance.
            let children = spawned_ids(conn, &parent_id, room + seen.len() + 1)?;
            for child in children {
                if seen.contains(&child) {
                    continue;
                }
                if level + 1 >= max_levels || tree.links.len() >= max_nodes {
                    tree.truncated = true;
                    break;
                }
                seen.insert(child.clone());
                tree.links.push(ThreadTreeLink {
                    id: child,
                    parent_id: Some(parent_id.clone()),
                    level: level + 1,
                });
            }
            if tree.links.len() >= max_nodes && tree.truncated {
                return Ok(Some(tree));
            }
        }
        start = end;
    }
    Ok(Some(tree))
}

impl ConversationStore {
    /// The tree `thread_id` sits in: its root and every session below it, at
    /// most [`MAX_TREE_LEVELS`] levels and [`MAX_TREE_NODES`] threads. `None`
    /// when the thread does not exist.
    pub async fn thread_tree(&self, thread_id: &str) -> Result<Option<ThreadTreeLinks>> {
        let conn = self.conn.lock().await;
        Ok(thread_tree_locked(
            &conn,
            thread_id,
            MAX_TREE_LEVELS,
            MAX_TREE_NODES,
        )?)
    }
}

#[cfg(test)]
#[path = "conversations_hierarchy_tree_tests.rs"]
mod tests;
