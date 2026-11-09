//! Bounded reads around one message of a never-branched conversation.
//!
//! The reverse pager ([`ConversationStore::get_conversation_message_page`])
//! only walks backwards from a cursor. A transcript window also needs the turns
//! *after* its anchor, so this adds the forward direction over the same ordering
//! key, `(created_at, rowid)` on `idx_messages_conversation`: one bounded query
//! backwards from the anchor and one bounded query forwards from it. Nothing
//! outside the window is read or decrypted.

use super::message_window::WindowSlice;
use super::*;

/// A message row whose payload is still sealed: the message (content sealed),
/// then its sealed `parts` and `metadata`.
type SealedRow = (StoredMessage, Option<String>, Option<String>);

const ROW_COLUMNS: &str = "id, role, content, agent_id, created_at, author_user_id, author_name, \
                           source, widget_instance_id, origin_server, parts, parent_message_id, \
                           interrupted, metadata";

fn sealed_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SealedRow> {
    Ok((
        StoredMessage {
            id: row.get(0)?,
            role: row.get(1)?,
            content: row.get(2)?,
            agent_id: row.get(3)?,
            created_at: row.get(4)?,
            author_user_id: row.get(5)?,
            author_name: row.get(6)?,
            source: row.get(7)?,
            widget_instance_id: row.get(8)?,
            origin_server: row.get(9)?,
            parts: None,
            metadata: None,
            parent_message_id: row.get(11)?,
            interrupted: row.get::<_, i64>(12)? != 0,
            sibling_index: 0,
            sibling_count: 1,
            sibling_ids: Vec::new(),
        },
        row.get(10)?,
        row.get(13)?,
    ))
}

/// Which way a page reads from the anchor's position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PageDirection {
    /// Rows strictly before the anchor, nearest (newest) first.
    Older,
    /// The anchor itself and the rows after it, oldest first.
    FromAnchor,
}

impl ConversationStore {
    /// The anchor's position in the pager's ordering key, or `None` when the
    /// message is not in `conversation_id`.
    pub(super) fn message_position_locked(
        conn: &Connection,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<(i64, i64)>> {
        conn.query_row(
            "SELECT created_at, rowid FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![message_id, conversation_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .context("locating a message in its conversation")
    }

    /// At most `limit` sealed rows on one side of `position`. Reads no
    /// payload beyond those rows and decrypts nothing.
    pub(super) fn flat_page_locked(
        conn: &Connection,
        conversation_id: &str,
        position: (i64, i64),
        direction: PageDirection,
        limit: usize,
    ) -> Result<Vec<SealedRow>> {
        let (range, order) = match direction {
            PageDirection::Older => (
                "(created_at < ?2 OR (created_at = ?2 AND rowid < ?3))",
                "created_at DESC, rowid DESC",
            ),
            PageDirection::FromAnchor => (
                "(created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))",
                "created_at ASC, rowid ASC",
            ),
        };
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW_COLUMNS} FROM messages
             WHERE conversation_id = ?1 AND {range}
             ORDER BY {order}
             LIMIT ?4"
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = stmt.query_map(
            params![conversation_id, position.0, position.1, limit],
            sealed_row,
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading a message page")
    }

    fn open_sealed_rows(&self, rows: Vec<SealedRow>) -> Vec<StoredMessage> {
        rows.into_iter()
            .map(|(mut message, parts, metadata)| {
                message.content = self.open_content(std::mem::take(&mut message.content));
                message.parts = self.open_parts(parts);
                message.metadata = self.open_parts(metadata);
                message
            })
            .collect()
    }

    /// Up to `before` messages before and `after` messages after `message_id`
    /// in a never-branched conversation, plus the message itself, read with two
    /// bounded queries. `None` when the message is not in that conversation.
    pub(super) async fn flat_message_window(
        &self,
        conversation_id: &str,
        message_id: &str,
        before: usize,
        after: usize,
    ) -> Result<Option<WindowSlice>> {
        let conn = self.conn.lock().await;
        let Some(position) = Self::message_position_locked(&conn, conversation_id, message_id)?
        else {
            return Ok(None);
        };
        // One extra row on each side answers "is there more?" without a count.
        let older = Self::flat_page_locked(
            &conn,
            conversation_id,
            position,
            PageDirection::Older,
            before.saturating_add(1),
        )?;
        let from_anchor = Self::flat_page_locked(
            &conn,
            conversation_id,
            position,
            PageDirection::FromAnchor,
            after.saturating_add(2),
        )?;
        // Decrypt after releasing the store mutex, like the reverse pager.
        drop(conn);
        let has_earlier = older.len() > before;
        let has_later = from_anchor.len() > after.saturating_add(1);
        let mut messages = self.open_sealed_rows(older.into_iter().take(before).collect());
        messages.reverse();
        let target_index = messages.len();
        messages.extend(
            self.open_sealed_rows(
                from_anchor
                    .into_iter()
                    .take(after.saturating_add(1))
                    .collect(),
            ),
        );
        if messages
            .get(target_index)
            .is_none_or(|m| m.id != message_id)
        {
            return Ok(None);
        }
        Ok(Some(WindowSlice {
            messages,
            target_index,
            has_earlier,
            has_later,
        }))
    }
}

#[cfg(test)]
#[path = "message_window_flat_tests.rs"]
mod tests;
