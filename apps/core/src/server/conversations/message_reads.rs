//! Reading message history: content sealing helpers, usage metadata pages,
//! learning projections, feedback and turn lookups.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Decrypt a stored `content` value, degrading gracefully: a row that fails
    /// to decrypt (corrupt/wrong-key) is replaced with a marker rather than
    /// failing the whole conversation load. Legacy plaintext passes through.
    pub(super) fn open_content(&self, stored: String) -> String {
        #[cfg(test)]
        self.content_reads.fetch_add(1, Ordering::Relaxed);
        self.cipher.open(&stored).unwrap_or_else(|e| {
            tracing::warn!("could not decrypt message content: {e}");
            "[unable to decrypt message]".to_owned()
        })
    }

    /// Seal an optional field (e.g. a conversation title) for storage. `None`
    /// stays `None` so SQL `COALESCE`/null semantics are preserved.
    pub(super) fn seal_opt(&self, value: Option<&str>) -> Result<Option<String>> {
        value.map(|v| self.cipher.seal(v)).transpose()
    }

    /// Decrypt an optional stored field, with the same graceful degradation as
    /// [`Self::open_content`]. Legacy plaintext passes through.
    pub(super) fn open_opt(&self, stored: Option<String>) -> Option<String> {
        stored.map(|s| {
            self.cipher.open(&s).unwrap_or_else(|e| {
                tracing::warn!("could not decrypt conversation title: {e}");
                "[unable to decrypt]".to_owned()
            })
        })
    }

    /// Decrypt + parse an optional stored `parts` column into a JSON value (the AI
    /// SDK `parts` array). A row that fails to decrypt or parse (corrupt / wrong
    /// key / legacy garbage) degrades to `None` so the client falls back to a text
    /// part from `content` — never failing the whole conversation load.
    pub(super) fn open_parts(&self, stored: Option<String>) -> Option<serde_json::Value> {
        let sealed = stored?;
        let plaintext = self.cipher.open(&sealed).ok()?;
        serde_json::from_str(&plaintext).ok()
    }

    /// Page assistant usage parts without selecting or decrypting message content.
    /// Return only explicitly allowlisted usage metadata; text/tool parts never leave this method.
    pub(crate) async fn usage_metadata_page(
        &self,
        after_rowid: i64,
        limit: usize,
    ) -> Result<
        Vec<(
            i64,
            String,
            String,
            Option<String>,
            i64,
            Vec<serde_json::Value>,
        )>,
    > {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT rowid,id,conversation_id,agent_id,created_at,
                    CASE WHEN length(parts)<=8388608 THEN parts ELSE NULL END
             FROM messages WHERE rowid>?1 AND role='assistant' AND parts IS NOT NULL AND interrupted=0
             ORDER BY rowid LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![after_rowid.max(0), limit.clamp(1, 10001) as i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )?;
        let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(conn);
        Ok(raw
            .into_iter()
            .map(|(rowid, id, conversation, agent, created, parts)| {
                let metadata = self
                    .open_parts(parts)
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|part| {
                        if !matches!(
                            part.get("type").and_then(serde_json::Value::as_str),
                            Some(
                                "data-acp-usage"
                                    | "data-ryu-usage"
                                    | "data-ryu-usage-stats"
                                    | "data-ryu-stats"
                            )
                        ) {
                            return None;
                        }
                        let data = part.get("data")?.as_object()?;
                        let mut safe = serde_json::Map::new();
                        if let Some(kind) = part.get("type") {
                            safe.insert("usagePartType".to_owned(), kind.clone());
                        }
                        for key in [
                            "done",
                            "promptTokens",
                            "completionTokens",
                            "cachedReadTokens",
                            "cachedWriteTokens",
                            "cacheReadTokens",
                            "cacheWriteTokens",
                            "cachedOutputTokens",
                            "thoughtTokens",
                            "reasoningTokens",
                            "totalTokens",
                            "observedAt",
                            "historyEventId",
                            "historySourceId",
                            "historySessionId",
                            "historyAccountId",
                            "historyProviderId",
                            "historyModelId",
                            "providerId",
                            "modelId",
                            "provider",
                            "model",
                        ] {
                            if let Some(value) = data
                                .get(key)
                                .filter(|v| v.is_number() || v.is_boolean() || v.is_string())
                            {
                                safe.insert(key.to_owned(), value.clone());
                            }
                        }
                        Some(serde_json::Value::Object(safe))
                    })
                    .collect();
                (rowid, id, conversation, agent, created, metadata)
            })
            .collect())
    }

    /// Fetch all messages of a conversation in chronological order.
    pub async fn get_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        // The raw sealed `parts` blob is carried on `StoredMessage.parts` as a
        // JSON string temporarily, then decrypted + parsed below (outside the DB
        // lock, like `content`/`title`).
        let rows = stmt.query_map([conversation_id], |row| {
            let sealed_parts: Option<String> = row.get(10)?;
            let sealed_metadata: Option<String> = row.get(13)?;
            Ok((
                StoredMessage {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    agent_id: row.get(3)?,
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
                    created_at: row.get(4)?,
                },
                sealed_parts,
                sealed_metadata,
            ))
        })?;
        let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        // Release the store mutex before decrypting: a long conversation's
        // content + parts can be megabytes, and every other chat's reads and
        // streaming checkpoints queue on this lock.
        drop(stmt);
        drop(conn);
        let out = raw
            .into_iter()
            .map(|(mut msg, sealed_parts, sealed_metadata)| {
                msg.content = self.open_content(std::mem::take(&mut msg.content));
                msg.parts = self.open_parts(sealed_parts);
                msg.metadata = self.open_parts(sealed_metadata);
                msg
            })
            .collect();
        Ok(out)
    }

    /// Read only the plaintext user/assistant projection allowed into learning.
    /// This query deliberately does not select or decrypt `parts`,
    /// `author_user_id`, or `author_name`, and has no read path to the identity
    /// vault or other encrypted-field stores.
    pub async fn get_learning_messages(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<LearningMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok(LearningMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut message = row?;
            message.content = self.open_content(message.content);
            out.push(message);
        }
        Ok(out)
    }

    /// Set (or clear) the thumbs feedback on a message. `rating` is `"up"` /
    /// `"down"` to set, or `None` to clear. Scoped by `conversation_id` so a stray
    /// id can't rate another conversation's message. Returns `true` when a row was
    /// updated (i.e. the message exists in this conversation).
    pub async fn set_message_feedback(
        &self,
        conversation_id: &str,
        message_id: &str,
        rating: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE messages SET feedback = ?3
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id, rating],
            )
            .context("setting message feedback")?;
        Ok(n > 0)
    }

    /// The rated messages of a conversation as `(message_id, rating)` pairs
    /// (`rating` is `"up"` / `"down"`). Un-rated messages are omitted, so the map
    /// is small even for long threads. Drives the persisted thumbs state on reload.
    pub async fn list_feedback(&self, conversation_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, feedback FROM messages
             WHERE conversation_id = ?1 AND feedback IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// The decrypted `(user_prompt, assistant_reply, agent_id)` for the turn that
    /// the given assistant message closes: the assistant text plus the *nearest
    /// preceding user message* in chronological order. `None` when the id is not an
    /// assistant message or has no user message before it. Used to seed the
    /// learning reward + RAG memory sinks from a thumbs vote.
    ///
    /// Note the pairing walks back to the nearest user message regardless of any
    /// intervening assistant rows, so it resolves correctly for a regenerated /
    /// edited sibling (`[user, asstV1, asstV2]` — voting `asstV2` still maps to
    /// `user`) and for council/team turns with several consecutive assistant
    /// replies (each maps to the same preceding user turn).
    pub async fn get_turn_for_assistant_message(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<(String, String, Option<String>)>> {
        let messages = self.get_messages(conversation_id).await?;
        let Some(idx) = messages
            .iter()
            .position(|m| m.id == message_id && m.role == "assistant")
        else {
            return Ok(None);
        };
        // Nearest preceding user message (skip intervening assistant siblings).
        for user in messages[..idx].iter().rev() {
            if user.role == "user" {
                let asst = &messages[idx];
                return Ok(Some((
                    user.content.clone(),
                    asst.content.clone(),
                    asst.agent_id.clone(),
                )));
            }
        }
        Ok(None)
    }

    /// The id of a conversation's most recent assistant message, if any. A
    /// freshly-streamed reply is rendered under a client-generated id that never
    /// reached the DB (Core assigns its own uuid at persist time), so a thumbs vote
    /// on the just-produced reply can't match by id until the thread is reloaded.
    /// The feedback handler falls back to this newest assistant row when the client
    /// flags the vote as the latest turn — resolving that common live case.
    pub async fn latest_assistant_message_id(
        &self,
        conversation_id: &str,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM messages
                 WHERE conversation_id = ?1 AND role = 'assistant'
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT 1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading latest assistant message")?;
        Ok(id)
    }

    /// The decrypted text of a conversation's earliest user message, if any.
    /// Used by the auto-namer to seed a concise title from what the user first
    /// asked. Returns `None` for conversations with no user turn yet.
    pub async fn get_first_user_message(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let sealed: Option<String> = conn
            .query_row(
                "SELECT content FROM messages
                 WHERE conversation_id = ?1 AND role = 'user'
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT 1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading first user message")?;
        Ok(sealed.map(|s| self.open_content(s)))
    }
}
