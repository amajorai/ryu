//! The transcript window around one message.
//!
//! Search returns short snippets; this reads the surrounding turns so an agent
//! can check what was actually said (transcripts are the ground truth). It
//! applies **no tenancy filter**: callers resolve the message's conversation with
//! [`ConversationStore::message_conversation_id`], gate that id against the
//! caller's visible set, and only then read the window. It reads only the
//! window's payloads, however long the conversation is.

use std::collections::{HashSet, VecDeque};

use super::*;

/// A chronological slice of one conversation around a requested message.
#[derive(Debug, Clone)]
pub struct MessageWindow {
    pub conversation_id: String,
    pub conversation_title: Option<String>,
    /// Oldest first; the requested message is `messages[target_index]`.
    pub messages: Vec<StoredMessage>,
    pub target_index: usize,
    /// Whether older messages exist before the first returned one.
    pub has_earlier: bool,
    /// Whether newer messages exist after the last returned one.
    pub has_later: bool,
}

/// The part of a [`MessageWindow`] read from the transcript.
pub(super) struct WindowSlice {
    pub(super) messages: Vec<StoredMessage>,
    pub(super) target_index: usize,
    pub(super) has_earlier: bool,
    pub(super) has_later: bool,
}

impl ConversationStore {
    /// The conversation a message belongs to, or `None` when no such message
    /// exists. Reads one id; decrypts nothing.
    pub async fn message_conversation_id(&self, message_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT conversation_id FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("resolving a message's conversation")
    }

    /// Up to `before` messages before and `after` messages after `message_id`
    /// in `conversation_id`, plus the message itself. `None` when the message
    /// is not in that conversation.
    ///
    /// The window follows the thread the user sees: the selected branch of a
    /// branched conversation. A message on an unselected branch (an edited-away
    /// or regenerated-over version) is read with the ancestry that led to it and
    /// nothing after it, because no later turn on the selected thread followed it.
    ///
    /// Only the window's payloads are read and decrypted, never the whole
    /// transcript: a never-branched conversation pages backwards and forwards
    /// from the message ([`Self::flat_message_window`]); a branched one walks
    /// message ids (no payloads) down from the selected leaf to the message.
    pub async fn message_window(
        &self,
        conversation_id: &str,
        message_id: &str,
        before: usize,
        after: usize,
    ) -> Result<Option<MessageWindow>> {
        let leaf = {
            let conn = self.conn.lock().await;
            Self::active_leaf_locked(&conn, conversation_id)?
        };
        let slice = match leaf {
            None => {
                self.flat_message_window(conversation_id, message_id, before, after)
                    .await?
            }
            Some(leaf) => {
                let conn = self.conn.lock().await;
                self.branched_window_locked(
                    &conn,
                    conversation_id,
                    &leaf,
                    message_id,
                    before,
                    after,
                )?
            }
        };
        let Some(slice) = slice else {
            return Ok(None);
        };
        let titles = self
            .conversation_titles(&[conversation_id.to_owned()])
            .await?;
        Ok(Some(MessageWindow {
            conversation_id: conversation_id.to_owned(),
            conversation_title: titles.get(conversation_id).cloned(),
            messages: slice.messages,
            target_index: slice.target_index,
            has_earlier: slice.has_earlier,
            has_later: slice.has_later,
        }))
    }

    /// The window in a branched conversation whose selected leaf is `leaf`.
    fn branched_window_locked(
        &self,
        conn: &Connection,
        conversation_id: &str,
        leaf: &str,
        message_id: &str,
        before: usize,
        after: usize,
    ) -> Result<Option<WindowSlice>> {
        let (newer, on_thread) =
            Self::newer_thread_ids_locked(conn, conversation_id, leaf, message_id, after)?;
        let (mut messages, has_earlier) = self.active_message_page_locked(
            conn,
            conversation_id,
            message_id,
            None,
            before.saturating_add(1),
        )?;
        if messages.last().is_none_or(|m| m.id != message_id) {
            return Ok(None);
        }
        let target_index = messages.len() - 1;
        let has_later = on_thread && newer.len() > after;
        if on_thread {
            let later: Vec<String> = newer.into_iter().rev().take(after).collect();
            messages.extend(self.load_thread_messages_locked(conn, conversation_id, &later)?);
        }
        Ok(Some(WindowSlice {
            messages,
            target_index,
            has_earlier,
            has_later,
        }))
    }

    /// Walk the selected thread up from `leaf` (ids only) until `message_id`.
    /// Returns the at most `after + 1` thread ids nearest after it, newest
    /// first, and whether `message_id` is on the selected thread at all.
    fn newer_thread_ids_locked(
        conn: &Connection,
        conversation_id: &str,
        leaf: &str,
        message_id: &str,
        after: usize,
    ) -> Result<(VecDeque<String>, bool)> {
        let mut parent_query = conn.prepare_cached(
            "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        let keep = after.saturating_add(1);
        let mut newer = VecDeque::new();
        let mut visited = HashSet::new();
        let mut cursor = Some(leaf.to_owned());
        while let Some(id) = cursor {
            if !visited.insert(id.clone()) {
                break;
            }
            let parent: Option<Option<String>> = parent_query
                .query_row(params![id, conversation_id], |row| row.get(0))
                .optional()?;
            let Some(parent) = parent else {
                break;
            };
            if id == message_id {
                return Ok((newer, true));
            }
            newer.push_back(id);
            if newer.len() > keep {
                newer.pop_front();
            }
            cursor = parent;
        }
        Ok((VecDeque::new(), false))
    }
}

#[cfg(test)]
#[path = "message_window_tests.rs"]
mod tests;
