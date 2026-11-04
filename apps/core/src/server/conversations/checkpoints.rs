//! Chat checkpoints and rewinding a conversation to a message.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// Which moment a chat checkpoint captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatCheckpointKind {
    /// Taken before the agent ran a user turn.
    Turn,
    /// Taken immediately before a rewind restored files, so it can be undone.
    PreRestore,
}

impl ChatCheckpointKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::PreRestore => "pre_restore",
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        if value == "pre_restore" {
            Self::PreRestore
        } else {
            Self::Turn
        }
    }
}

/// One `chat_checkpoints` row.
#[derive(Debug, Clone)]
pub struct ChatCheckpointRecord {
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub kind: ChatCheckpointKind,
    pub workspace: Option<String>,
    pub commit_id: Option<String>,
    pub skip_reason: Option<String>,
    pub created_at: i64,
}

/// The public projection of a chat checkpoint.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatCheckpoint {
    pub id: String,
    /// User message the checkpoint was taken before (`turn` checkpoints).
    pub message_id: Option<String>,
    pub kind: ChatCheckpointKind,
    /// Folder the snapshot covers; absent when the chat has no folder.
    pub workspace: Option<String>,
    /// Whether file contents were captured and can be restored.
    pub has_files: bool,
    /// Why files were not captured, when they were not.
    pub skip_reason: Option<String>,
    /// First characters of the user message.
    pub preview: Option<String>,
    /// RFC 3339 UTC.
    pub created_at: String,
}

impl ChatCheckpoint {
    pub fn from_record(record: ChatCheckpointRecord, preview: Option<String>) -> Self {
        Self {
            id: record.id,
            message_id: record.message_id,
            kind: record.kind,
            workspace: record.workspace,
            has_files: record.commit_id.is_some(),
            skip_reason: record.skip_reason,
            preview,
            created_at: chrono::DateTime::from_timestamp_millis(record.created_at)
                .unwrap_or_default()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

pub(super) fn chat_checkpoint_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ChatCheckpointRecord> {
    Ok(ChatCheckpointRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        message_id: row.get(2)?,
        kind: ChatCheckpointKind::parse(&row.get::<_, String>(3)?),
        workspace: row.get(4)?,
        commit_id: row.get(5)?,
        skip_reason: row.get(6)?,
        created_at: row.get(7)?,
    })
}

impl ConversationStore {
    /// Record one chat checkpoint row. A `turn` checkpoint is keyed by its user
    /// message: the first capture wins, so a regenerate of the same turn keeps the
    /// state from before the turn first ran. Returns whether a row was written.
    pub async fn record_chat_checkpoint(&self, checkpoint: &ChatCheckpointRecord) -> Result<bool> {
        let conn = self.conn.lock().await;
        let written = conn
            .execute(
                "INSERT OR IGNORE INTO chat_checkpoints
                     (id, conversation_id, message_id, kind, workspace, commit_id, skip_reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    checkpoint.id,
                    checkpoint.conversation_id,
                    checkpoint.message_id,
                    checkpoint.kind.as_str(),
                    checkpoint.workspace,
                    checkpoint.commit_id,
                    checkpoint.skip_reason,
                    checkpoint.created_at,
                ],
            )
            .context("recording chat checkpoint")?;
        Ok(written == 1)
    }

    /// Folders of every conversation with a turn running right now
    /// (`run_status = 'running'`; boot reconciliation clears crashed runs).
    /// A rewind refuses to restore a folder another live turn is editing.
    pub async fn running_run_folders(&self) -> Result<Vec<(String, Vec<String>)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, folder_path, worktree_path FROM conversations
             WHERE run_status = 'running'",
        )?;
        let rows = stmt.query_map([], |row| {
            let folders = [row.get::<_, Option<String>>(1)?, row.get(2)?]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            Ok((row.get::<_, String>(0)?, folders))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing running run folders")
    }

    /// Whether a `turn` checkpoint already exists for this user message.
    pub async fn has_turn_checkpoint(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let found = conn
            .query_row(
                "SELECT 1 FROM chat_checkpoints
                 WHERE conversation_id = ?1 AND message_id = ?2 AND kind = 'turn'",
                params![conversation_id, message_id],
                |_| Ok(()),
            )
            .optional()
            .context("checking turn checkpoint")?;
        Ok(found.is_some())
    }

    /// Checkpoints of one conversation, newest first, each with a short preview
    /// of the user message it was taken before.
    pub async fn list_chat_checkpoints(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<ChatCheckpoint>> {
        let rows: Vec<(ChatCheckpointRecord, Option<String>)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT c.id, c.conversation_id, c.message_id, c.kind, c.workspace,
                        c.commit_id, c.skip_reason, c.created_at, m.content
                 FROM chat_checkpoints c
                 LEFT JOIN messages m ON m.id = c.message_id AND m.conversation_id = c.conversation_id
                 WHERE c.conversation_id = ?1
                 ORDER BY c.created_at DESC, c.rowid DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(
                params![conversation_id, i64::try_from(limit).unwrap_or(i64::MAX)],
                |row| {
                    Ok((
                        chat_checkpoint_from_row(row)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("listing chat checkpoints")?
        };
        Ok(rows
            .into_iter()
            .map(|(record, content)| {
                let preview = content.map(|stored| {
                    let text = self.open_content(stored);
                    let trimmed = text.trim();
                    let mut preview: String = trimmed.chars().take(160).collect();
                    if preview.len() < trimmed.len() {
                        preview.push('…');
                    }
                    preview
                });
                ChatCheckpoint::from_record(record, preview)
            })
            .collect())
    }

    /// One checkpoint of a conversation.
    pub async fn get_chat_checkpoint(
        &self,
        conversation_id: &str,
        checkpoint_id: &str,
    ) -> Result<Option<ChatCheckpointRecord>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, conversation_id, message_id, kind, workspace, commit_id, skip_reason, created_at
             FROM chat_checkpoints WHERE conversation_id = ?1 AND id = ?2",
            params![conversation_id, checkpoint_id],
            chat_checkpoint_from_row,
        )
        .optional()
        .context("reading chat checkpoint")
    }

    /// The active leaf when it is a user message. A version-tree edit or
    /// regenerate re-runs that turn without appending a new user row, so this is
    /// the turn a checkpoint belongs to.
    pub async fn active_leaf_user_message(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT m.id FROM conversations c
             JOIN messages m ON m.id = c.active_leaf_message_id AND m.conversation_id = c.id
             WHERE c.id = ?1 AND m.role = 'user'",
            params![conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("reading active user leaf")
    }

    /// Rewind the active thread to just before a user message: the active leaf
    /// moves to that message's parent, so the message and everything after it
    /// leave the active thread without being deleted (they stay reachable as a
    /// version). Returns `None` when the message is absent or not a user turn,
    /// otherwise the rewound message's text and the new leaf. The leaf is `None`
    /// for the first user turn: a version tree cannot point at an empty thread,
    /// so the caller resends that turn as an edit, which creates its root-level
    /// sibling.
    pub async fn rewind_to_message(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<RewoundTurn>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        let row: Option<(String, Option<String>, String)> = conn
            .query_row(
                "SELECT role, parent_message_id, content FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .context("loading message to rewind")?;
        let Some((role, parent, content)) = row else {
            return Ok(None);
        };
        if role != "user" {
            return Ok(None);
        }
        if let Some(parent_id) = parent.as_deref() {
            conn.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![parent_id, now, conversation_id],
            )
            .context("pointing leaf at rewind parent")?;
        }
        drop(conn);
        Ok(Some(RewoundTurn {
            active_leaf_message_id: parent,
            text: self.open_content(content),
        }))
    }
}
