//! `GET /api/hierarchy/threads/:id/tree`: the whole nest a thread sits in.
//!
//! The store walks ids and parent links ([`ConversationStore::thread_tree`]);
//! this handler passes every row through the same read check as the sessions
//! route. A row the caller may not read is left out, and its visible
//! descendants are attached to the nearest visible ancestor, in `parent_id` and
//! in the row's own `spawned_by_conversation_id`, so a hidden thread shows
//! through neither a title nor an id nor a level number.
//!
//! [`ConversationStore::thread_tree`]: super::super::conversations::ConversationStore::thread_tree

use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::json;

use super::{internal, require_read, Caller};
use crate::server::{json_error, ServerState};

/// For every thread of the tree, the visible thread its children hang under:
/// the thread itself when the caller may read it, else whatever its own parent
/// resolved to.
#[derive(Default)]
struct Anchors(HashMap<String, Option<String>>);

impl Anchors {
    /// The visible ancestor a thread with this parent is attached to.
    fn of_parent(&self, parent_id: Option<&str>) -> Option<String> {
        parent_id.and_then(|parent| self.0.get(parent).cloned().flatten())
    }

    fn shown(&mut self, id: &str) {
        self.0.insert(id.to_owned(), Some(id.to_owned()));
    }

    fn hidden(&mut self, id: &str, anchor: Option<String>) {
        self.0.insert(id.to_owned(), anchor);
    }
}

pub(super) async fn thread_tree(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_read(&state, &caller, &id).await {
        return response;
    }
    let tree = match state.conversations.thread_tree(&id).await {
        Ok(Some(tree)) => tree,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("conversation '{id}' not found"),
            )
        }
        Err(error) => return internal(error),
    };
    let mut anchors = Anchors::default();
    let mut nodes = Vec::with_capacity(tree.links.len());
    // Breadth first, so a parent's anchor is known before its children ask.
    for link in &tree.links {
        let anchor = anchors.of_parent(link.parent_id.as_deref());
        if require_read(&state, &caller, &link.id).await.is_err() {
            anchors.hidden(&link.id, anchor);
            continue;
        }
        match state.conversations.get_summary(&link.id).await {
            Ok(Some(mut summary)) => {
                anchors.shown(&link.id);
                // The row's own parent link must not name a thread the caller
                // cannot read. It carries the visible parent instead.
                if summary.hierarchy.spawned_by_conversation_id != anchor {
                    summary.hierarchy.spawned_by_conversation_id = anchor.clone();
                    summary.hierarchy.spawned_by_message_id = None;
                }
                nodes.push(json!({ "parent_id": anchor, "conversation": summary }));
            }
            // Deleted between the walk and this read.
            Ok(None) => anchors.hidden(&link.id, anchor),
            Err(error) => return internal(error),
        }
    }
    Json(json!({ "nodes": nodes, "truncated": tree.truncated })).into_response()
}

#[cfg(test)]
#[path = "hierarchy_tree_runtime_test.rs"]
mod tests;
