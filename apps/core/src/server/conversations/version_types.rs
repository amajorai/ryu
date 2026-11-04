//! Sync links and the version-tree ancestry used when synced or resumed rows
//! join a branched conversation.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// Where a replayed message sits in its source's version tree, as the source
/// described it. Read by [`ConversationStore::link_synced_messages`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncParent {
    /// The source sent no tree position: an older peer, or a never-branched
    /// source whose rows are flat. The row continues the receiver's thread.
    Unknown,
    /// The source's row is a genuine root of its version tree (a first turn, or
    /// an edited first turn).
    Root,
    /// The source's row was produced in reply to this message.
    Message(String),
}

/// One replayed message and its source tree position, in payload order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncLink {
    pub id: String,
    pub parent: SyncParent,
}

/// Union-find over the version tree while [`ConversationStore::link_synced_messages`]
/// links one replay, so a relayed payload cannot store a parent loop. Each
/// visited row's parent is read once and path-compressed, which keeps repeated
/// walks over a long thread near-linear.
#[derive(Default)]
pub(super) struct VersionAncestry {
    pub(super) up: std::collections::HashMap<String, Option<String>>,
}

impl VersionAncestry {
    /// The root of `id`'s tree, or `None` when its ancestor chain loops.
    pub(super) fn root(
        &mut self,
        parent_of: &mut rusqlite::CachedStatement<'_>,
        conversation_id: &str,
        id: &str,
    ) -> Result<Option<String>> {
        let mut path = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut current = id.to_owned();
        loop {
            if !seen.insert(current.clone()) {
                return Ok(None);
            }
            let next = if let Some(next) = self.up.get(&current) {
                next.clone()
            } else {
                let next = parent_of
                    .query_row(params![current, conversation_id], |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .optional()
                    .context("walking synced ancestry")?
                    .flatten();
                self.up.insert(current.clone(), next.clone());
                next
            };
            let Some(next) = next else {
                break;
            };
            path.push(std::mem::replace(&mut current, next));
        }
        for node in path {
            self.up.insert(node, Some(current.clone()));
        }
        Ok(Some(current))
    }

    /// Whether parenting `child` (a root of its own tree) on `parent` keeps the
    /// tree acyclic: `parent` must not descend from `child`.
    pub(super) fn extends_tree(
        &mut self,
        parent_of: &mut rusqlite::CachedStatement<'_>,
        conversation_id: &str,
        parent: &str,
        child: &str,
    ) -> Result<bool> {
        let parent_root = self.root(parent_of, conversation_id, parent)?;
        let child_root = self.root(parent_of, conversation_id, child)?;
        Ok(parent_root.is_some() && parent_root != child_root)
    }

    /// Record a link the caller just wrote.
    pub(super) fn link(&mut self, child: &str, parent: &str) {
        self.up.insert(child.to_owned(), Some(parent.to_owned()));
    }
}

/// The result of [`ConversationStore::rewind_to_message`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewoundTurn {
    /// The new active leaf; `None` when the first turn was rewound.
    pub active_leaf_message_id: Option<String>,
    /// The rewound user message's text, for the composer.
    pub text: String,
}
