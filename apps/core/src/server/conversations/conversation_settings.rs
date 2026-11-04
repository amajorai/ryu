//! Per-conversation settings: pins, archive, linked pull requests, folder,
//! icon, visibility and collaborator access.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Whether a conversation's title is user-chosen (locked against auto-rename).
    /// Used by the auto-namer to skip conversations the user already renamed.
    pub async fn title_is_custom(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let custom: Option<i64> = conn
            .query_row(
                "SELECT title_custom FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading title_custom")?;
        Ok(custom.unwrap_or(0) != 0)
    }

    /// Pin or unpin a conversation (coordinator `set_thread_pinned`).
    pub async fn set_pinned(&self, conversation_id: &str, pinned: bool) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(pinned), now, conversation_id],
        )
        .context("setting pinned flag")?;
        Ok(())
    }

    /// Archive or unarchive a conversation (coordinator `set_thread_archived`).
    pub async fn set_archived(&self, conversation_id: &str, archived: bool) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(archived), now, conversation_id],
        )
        .context("setting archived flag")?;
        Ok(())
    }

    /// Link (or unlink) a GitHub pull request URL to a conversation. Linking is
    /// idempotent and keeps link order; at most [`MAX_LINKED_PULL_REQUESTS`]
    /// stay linked. Returns the resulting list, or `None` when the row is gone.
    pub async fn set_pull_request_linked(
        &self,
        conversation_id: &str,
        url: &str,
        linked: bool,
    ) -> Result<Option<Vec<String>>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let current: Option<String> = conn
            .query_row(
                "SELECT linked_pull_requests FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading linked pull requests")?;
        let Some(current) = current else {
            return Ok(None);
        };
        let mut urls = parse_participants_json(Some(&current));
        urls.retain(|existing| existing != url);
        if linked {
            if urls.len() >= MAX_LINKED_PULL_REQUESTS {
                anyhow::bail!("a chat can link at most {MAX_LINKED_PULL_REQUESTS} pull requests");
            }
            urls.push(url.to_owned());
        }
        conn.execute(
            "UPDATE conversations SET linked_pull_requests = ?1, updated_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&urls)?, now, conversation_id],
        )
        .context("setting linked pull requests")?;
        Ok(Some(urls))
    }

    /// Set or clear the workspace folder used to group a conversation.
    ///
    /// Clearing the value detaches the chat from its project without deleting
    /// either the conversation or the folder on disk.
    pub async fn set_folder_path(
        &self,
        conversation_id: &str,
        folder_path: Option<&str>,
    ) -> Result<bool> {
        let now = now_millis();
        let normalized = folder_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(normalize_folder_path);
        let conn = self.conn.lock().await;
        let updated = conn
            .execute(
                "UPDATE conversations SET folder_path = ?1, updated_at = ?2 WHERE id = ?3",
                params![normalized, now, conversation_id],
            )
            .context("setting conversation folder")?;
        Ok(updated > 0)
    }

    /// Set or clear a conversation's Notion-style glyph. `None` clears it.
    pub async fn set_icon(
        &self,
        conversation_id: &str,
        icon: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let now = now_millis();
        let icon_str = match icon {
            Some(v) => Some(serde_json::to_string(v).context("serializing conversation icon")?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE conversations SET icon = ?1, updated_at = ?2 WHERE id = ?3",
                params![icon_str, now, conversation_id],
            )
            .context("setting conversation icon")?;
        Ok(n > 0)
    }

    /// Set a conversation's sharing visibility. The HTTP layer owns the resource
    /// write gate; this store method keeps the column update atomic and explicit.
    pub async fn set_visibility(
        &self,
        conversation_id: &str,
        visibility: &str,
        team_id: Option<&str>,
        admin_authorized: bool,
    ) -> Result<bool> {
        if !matches!(visibility, "private" | "org" | "team") {
            anyhow::bail!(
                "unknown visibility {visibility:?}: expected \"private\", \"org\", or \"team\""
            );
        }
        if visibility == "team" && team_id.is_none() {
            anyhow::bail!("team visibility requires team_id");
        }
        let now = now_millis();
        let conn = self.conn.lock().await;
        if visibility == "private" {
            let current: Option<String> = conn
                .query_row(
                    "SELECT visibility FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading current conversation visibility")?;
            if matches!(current.as_deref(), Some("org" | "team")) && !admin_authorized {
                anyhow::bail!("only organization admins can make shared conversations private");
            }
        }
        let updated = conn
            .execute(
                "UPDATE conversations SET visibility = ?1, team_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![visibility, team_id, now, conversation_id],
            )
            .context("setting conversation visibility")?;
        Ok(updated > 0)
    }

    /// Replace a conversation's direct grants and general visibility atomically.
    pub async fn set_access(
        &self,
        conversation_id: &str,
        visibility: &str,
        team_id: Option<&str>,
        collaborators: &[ConversationCollaborator],
        manager_authorized: bool,
    ) -> Result<bool> {
        if !matches!(visibility, "private" | "org" | "team") {
            anyhow::bail!(
                "unknown visibility {visibility:?}: expected \"private\", \"org\", or \"team\""
            );
        }
        if visibility == "team" && team_id.is_none() {
            anyhow::bail!("team visibility requires team_id");
        }
        if collaborators.len() > 100 {
            anyhow::bail!("a conversation can have at most 100 collaborators");
        }
        let mut user_ids = std::collections::HashSet::new();
        for collaborator in collaborators {
            if collaborator.user_id.is_empty()
                || collaborator.user_id.len() > 256
                || collaborator.user_id.chars().any(char::is_control)
            {
                anyhow::bail!("collaborator user_id must be 1-256 printable characters");
            }
            if !matches!(collaborator.role.as_str(), "viewer" | "participant") {
                anyhow::bail!("collaborator role must be \"viewer\" or \"participant\"");
            }
            if !user_ids.insert(collaborator.user_id.as_str()) {
                anyhow::bail!("duplicate collaborator user_id");
            }
        }

        let now = now_millis();
        let mut conn = self.conn.lock().await;
        let transaction = conn
            .transaction()
            .context("starting conversation access update")?;
        if visibility == "private" {
            let current: Option<String> = transaction
                .query_row(
                    "SELECT visibility FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading current conversation visibility")?;
            if matches!(current.as_deref(), Some("org" | "team")) && !manager_authorized {
                anyhow::bail!(
                    "only owners and organization admins can make shared conversations private"
                );
            }
        }
        let updated = transaction
            .execute(
                "UPDATE conversations SET visibility = ?1, team_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![visibility, team_id, now, conversation_id],
            )
            .context("setting conversation access")?;
        if updated == 0 {
            return Ok(false);
        }
        transaction
            .execute(
                "DELETE FROM conversation_collaborators WHERE conversation_id = ?1",
                params![conversation_id],
            )
            .context("replacing conversation collaborators")?;
        for collaborator in collaborators {
            transaction
                .execute(
                    "INSERT INTO conversation_collaborators
                        (conversation_id, user_id, role, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![
                        conversation_id,
                        collaborator.user_id,
                        collaborator.role,
                        now
                    ],
                )
                .context("adding conversation collaborator")?;
        }
        transaction
            .commit()
            .context("committing conversation access update")?;
        Ok(true)
    }

    pub async fn list_collaborators(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationCollaborator>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT user_id, role FROM conversation_collaborators
             WHERE conversation_id = ?1 ORDER BY user_id",
        )?;
        let rows = statement.query_map(params![conversation_id], |row| {
            Ok(ConversationCollaborator {
                user_id: row.get(0)?,
                role: row.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing conversation collaborators")
    }
}
