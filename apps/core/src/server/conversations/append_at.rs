//! The timestamped append path every message write funnels through, and
//! in-place message content updates.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// [`Self::append_message_as`], but with an explicit `created_at` (epoch
    /// millis) instead of "now".
    ///
    /// Exists for IMPORT, which is a restore rather than a new exchange: the
    /// agent's own transcript records when each turn happened, and stamping the
    /// import time instead made a three-week-old thread land as if it had just
    /// occurred — wrong in the row, wrong in the chat's date separators, and wrong
    /// for anything that orders on it. `None` means "now", which is what every
    /// live-chat caller wants and why that stays the default.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_at(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        created_at: Option<i64>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            created_at,
            None,
            None,
            None,
            None,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn append_imported_message_at(
        &self,
        conversation_id: &str,
        generation: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        tenancy: Tenancy,
        created_at: Option<i64>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            None,
            None,
            tenancy,
            created_at,
            None,
            None,
            None,
            None,
            Some(generation),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn append_message_at_with_provenance(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        created_at: Option<i64>,
        provenance: Option<&MessageProvenance>,
        client_id: Option<&str>,
        parts: Option<&serde_json::Value>,
        metadata: Option<&serde_json::Value>,
        expected_generation: Option<&str>,
    ) -> Result<String> {
        let sealed_parts = parts
            .filter(|value| value.is_array())
            .map(|value| self.cipher.seal(&value.to_string()))
            .transpose()?;
        let sealed_metadata = metadata
            .filter(|value| value.is_object())
            .map(|value| self.cipher.seal(&value.to_string()))
            .transpose()?;
        let now = created_at.unwrap_or_else(now_millis);
        let message_id = uuid::Uuid::new_v4().to_string();

        let guard = self.conn.lock().await;
        // One transaction for the whole append: the row upsert, title history,
        // message insert and leaf advance commit together with a single WAL sync
        // instead of one per statement, and a failure leaves no partial append.
        let conn = guard
            .unchecked_transaction()
            .context("starting message append")?;
        if let Some(expected) = expected_generation {
            anyhow::ensure!(
                crate::server::conversation_lifecycle::generation(&conn, conversation_id)?
                    .as_deref()
                    == Some(expected),
                "conversation changed during import"
            );
        }
        // Index the message body for semantic search — best-effort, fail-open.
        // We spawn BEFORE taking the DB lock and embed the *plaintext* (pre-seal)
        // in the spawned task, so the network embed never holds the conversation
        // mutex and a down embed sidecar can never block or slow the chat write.
        if self.chat_memory_enabled() {
            if let Some(index) = self.message_index.clone() {
                if !content.trim().is_empty() {
                    let index_msg_id = message_id.clone();
                    let index_conv_id = conversation_id.to_owned();
                    let index_role = role.to_owned();
                    let index_content = content.to_owned();
                    tokio::spawn(async move {
                        let embedder = index.embedder();
                        match embedder.embed(&index_content).await {
                            Ok(vec) => {
                                if let Err(e) = index
                                    .index_message(
                                        &index_msg_id,
                                        &index_conv_id,
                                        &index_role,
                                        &vec,
                                        embedder.model_id(),
                                        now,
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        "message-index write failed for {index_msg_id}: {e:#}"
                                    );
                                }
                            }
                            Err(e) => tracing::warn!(
                                "message-index embed failed for {index_msg_id} (sidecar down?): {e:#}"
                            ),
                        }
                    });
                }
            }
        }

        // Derive a first-pass title from the first user message (sealed at rest).
        // Only applied when the conversation has no title yet (COALESCE in upsert).
        let derived = if role == "user" {
            derive_title(content)
        } else {
            None
        };
        let title = derived
            .as_deref()
            .map(|t| self.seal_opt(Some(t)))
            .transpose()?
            .flatten();
        // Was this conversation untitled before this append? Used to record the
        // derived title in history exactly once.
        let had_title: bool = conn
            .query_row(
                "SELECT title IS NOT NULL FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(false);
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow {
                title: title.as_deref(),
                agent_id,
                ..ConvRow::default()
            },
            Touch::Set,
        )?;
        if let (Some(derived_title), false) = (derived.as_deref(), had_title) {
            if role == "user" {
                let _ = Self::push_title_history_locked(
                    &conn,
                    &self.cipher,
                    conversation_id,
                    derived_title,
                    "derived",
                    now,
                );
            }
        }
        // Version-tree linkage: if this conversation has been branched (its
        // `active_leaf_message_id` is set), attach the new turn beneath the
        // current leaf and advance the leaf to this message. Conversations that
        // have never been edited/regenerated carry a NULL leaf, so `parent` stays
        // NULL and the append is byte-identical to the pre-tree behavior. This is
        // what makes flat chat (including council/team/group multi-reply) untouched
        // until the user actually edits.
        let parent_message_id: Option<String> = conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("reading active leaf on append")?
            .flatten();
        let sealed = self.cipher.seal(content)?;
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, agent_id, author_user_id, author_name, source, widget_instance_id, origin_server, parent_message_id, created_at, parts, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                message_id,
                conversation_id,
                role,
                sealed,
                agent_id,
                author_user_id,
                author_name,
                provenance.map(|p| p.source.as_str()),
                provenance.map(|p| p.widget_instance_id.as_str()),
                provenance.map(|p| p.origin_server.as_str()),
                parent_message_id,
                now,
                sealed_parts,
                sealed_metadata
            ],
        )
        .context("inserting message")?;
        // Advance the leaf so the next turn chains beneath this one. Only matters
        // once branching is engaged (NULL leaf stays NULL: the UPDATE below sets it
        // to this id only when it was already non-NULL).
        if parent_message_id.is_some() {
            conn.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
                params![message_id, conversation_id],
            )
            .context("advancing active leaf on append")?;
        }

        // Release the conversation DB lock before fanning out — the publish is a
        // non-blocking broadcast send on a different mutex, but there is no reason
        // to hold the conn lock across it.
        conn.commit().context("committing message append")?;
        drop(guard);

        // NOTE: the title written above is only the placeholder cut from the raw
        // message. The LLM rename is NOT fired from here any more — it belongs to
        // the `@ryu/chat-title` turn-hook plugin (`post_assistant_turn`), which
        // owns the cadence (first reply + every N turns), the enable toggle, and
        // the model choice. Core used to ALSO enqueue a background titler on the
        // first user turn; that path resolved its model as "the `auto-title-model`
        // pref, else an active *local* engine", so on a cloud-only node it silently
        // did nothing while the plugin (which falls back through the node default)
        // worked — the "chats stay called New Chat until the 5th turn" report. One
        // titler now, and it is the configurable one.

        // Room-keyed realtime fan-out (Phase 1): make this turn appear live for
        // every other viewer of the conversation. We publish the *plaintext*
        // `content` (the same value `GET /api/conversations/:id` returns after
        // decrypting the sealed column) — never the sealed blob — and reuse `now`
        // (the exact `created_at` written to the row) so the live frame matches the
        // persisted/GET shape.
        //
        // This is the first adopter of the typed named-event contract
        // (`broadcast_event`, the Rivet-style `broadcast(event, payload)`): the turn
        // rides the Events channel as a `conversation.message` envelope. It stays
        // wire-compatible — the WS gateway's `frame_to_message` unwraps the envelope
        // back to `{"channel":"events","data":<this INNER value>}`, byte-for-byte
        // what raw `publish_event` produced — so `data` still carries the
        // self-describing `"type":"message"` shape existing clients key off; do not
        // pre-wrap with "channel". No-op when realtime is unwired (tests/CLI) or the
        // room has no members.
        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.message",
                serde_json::json!({
                    "type": "message",
                    "conversation_id": conversation_id,
                    "message": {
                        "id": message_id,
                        "role": role,
                        "content": content,
                        "parts": parts,
                        "metadata": metadata,
                        "author_user_id": author_user_id,
                        "client_id": client_id,
                        "author_name": author_name,
                        "source": provenance.map(|p| p.source.as_str()),
                        "widget_instance_id": provenance.map(|p| p.widget_instance_id.as_str()),
                        "origin_server": provenance.map(|p| p.origin_server.as_str()),
                        "created_at": now,
                        "agent_id": agent_id,
                    }
                }),
            );
        }
        Ok(message_id)
    }

    /// Update the content of an existing message (by id) in place, re-sealing
    /// the new content at rest.  Used for incremental persistence of ACP
    /// streaming replies: the assistant message row is created early (possibly
    /// with partial text) and updated as more text arrives, so the content
    /// survives a client disconnect.
    pub async fn update_message_content(&self, message_id: &str, content: &str) -> Result<()> {
        let sealed = self.cipher.seal(content)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2",
            params![sealed, message_id],
        )
        .context("updating message content")?;
        Ok(())
    }

    /// Store the structured render `parts` (a serialized AI SDK UIMessage `parts`
    /// array) for an existing message, sealed at rest like `content`. Written once
    /// at turn end (after the close-out frames, so terminal tool states are
    /// captured) by the streaming loop so a reloaded conversation re-renders its
    /// tool rows + cowork context. Best-effort: a failure here never fails the turn
    /// (the flat `content` text is still persisted independently).
    pub async fn update_message_parts(&self, message_id: &str, parts_json: &str) -> Result<()> {
        let sealed = self.cipher.seal(parts_json)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE messages SET parts = ?1 WHERE id = ?2",
            params![sealed, message_id],
        )
        .context("updating message parts")?;
        Ok(())
    }
}
