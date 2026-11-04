//! Message reactions and per-agent UI state.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// One saved generative-UI widget state (see
/// [`ConversationStore::set_agent_ui_state`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentUiState {
    pub tool_call_id: String,
    /// The desktop renderer's saved record; opaque to Core.
    pub state: serde_json::Value,
    /// Unix milliseconds of the last save.
    pub updated_at: i64,
}

/// Upper bound on saved generative-UI widget states per conversation, so the
/// state endpoint can't be used as an unbounded per-conversation write sink.
pub const MAX_AGENT_UI_STATES: i64 = 500;

impl ConversationStore {
    // ── Message reactions ─────────────────────────────────────────────────────
    //
    // Same shape as `feedback` above and for the same reason: a per-message datum
    // deliberately kept OUT of the `get_messages` SELECT (which has many non-UI
    // callers) and served instead by one bulk per-conversation read fetched
    // alongside the transcript. Unlike feedback, a reaction is per-*person*, so it
    // needs its own table rather than a column.
    //
    // Two deliberate policies, both visible in the code below:
    //   * **Reactions are per message VERSION.** `edit_user_message` mints a fresh
    //     uuid rather than mutating the row, so an edited message is a new row and
    //     starts with no reactions. That is honest — people reacted to different
    //     text — and needs no migration. `sibling_ids` is the only link if
    //     carry-forward is ever wanted.
    //   * **A message must be persisted before it can be reacted to.** Every write
    //     first proves the id exists *in this conversation* (`WHERE EXISTS` on
    //     `messages`). FK enforcement is off, so without that check any string
    //     would insert an orphan row. This is also why there is no
    //     `allow_latest_fallback` twin of the feedback retarget hack: a streaming
    //     reply still carrying its client-generated id simply 404s until it lands.

    /// Add `emoji` from `user_id` to a message. Scoped by `conversation_id` so a
    /// stray id can't react into another conversation, and gated on the message
    /// actually existing (see the module note above). Idempotent: reacting twice
    /// with the same emoji keeps one row. Returns `false` when the message is not
    /// in this conversation (→ 404 at the route) and `true` otherwise; a repeat of
    /// an existing reaction returns `true` but does not fan out.
    pub async fn add_reaction(
        &self,
        conversation_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
    ) -> Result<bool> {
        let now = now_millis();
        let inserted = {
            let conn = self.conn.lock().await;
            if !message_in_conversation(&conn, conversation_id, message_id)? {
                return Ok(false);
            }
            conn.execute(
                "INSERT OR IGNORE INTO message_reactions
                     (message_id, conversation_id, user_id, emoji, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![message_id, conversation_id, user_id, emoji, now],
            )
            .context("adding message reaction")?
        };
        if inserted > 0 {
            self.broadcast_reaction(conversation_id, message_id, user_id, emoji, "add");
        }
        Ok(true)
    }

    /// Remove `emoji` by `user_id` from a message. Same scoping and the same
    /// message-exists gate as [`ConversationStore::add_reaction`]. Returns `false`
    /// when the message is not in this conversation; removing a reaction that was
    /// never placed is a success (`true`) but does not fan out.
    pub async fn remove_reaction(
        &self,
        conversation_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
    ) -> Result<bool> {
        let removed = {
            let conn = self.conn.lock().await;
            if !message_in_conversation(&conn, conversation_id, message_id)? {
                return Ok(false);
            }
            conn.execute(
                "DELETE FROM message_reactions
                 WHERE message_id = ?1 AND conversation_id = ?2
                   AND user_id = ?3 AND emoji = ?4",
                params![message_id, conversation_id, user_id, emoji],
            )
            .context("removing message reaction")?
        };
        if removed > 0 {
            self.broadcast_reaction(conversation_id, message_id, user_id, emoji, "remove");
        }
        Ok(true)
    }

    /// Every reaction bucket of a conversation, aggregated. `viewer_user_id` is the
    /// caller whose own reactions light up (`reacted_by_me`) — it is resolved in the
    /// same GROUP BY, never a second query. Ordered by first-placed so the chip row
    /// does not reshuffle between reloads.
    pub async fn list_reactions(
        &self,
        conversation_id: &str,
        viewer_user_id: &str,
    ) -> Result<Vec<MessageReaction>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT r.message_id,
                    r.emoji,
                    COUNT(*)                                            AS count,
                    MAX(CASE WHEN r.user_id = ?2 THEN 1 ELSE 0 END)     AS mine,
                    MIN(r.created_at)                                   AS first_at
             FROM message_reactions r
             JOIN messages m
               ON m.id = r.message_id
              AND m.conversation_id = r.conversation_id
             WHERE r.conversation_id = ?1
             GROUP BY r.message_id, r.emoji
             ORDER BY first_at ASC, emoji ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, viewer_user_id], |row| {
            Ok(MessageReaction {
                message_id: row.get(0)?,
                emoji: row.get(1)?,
                count: row.get(2)?,
                reacted_by_me: row.get::<_, i64>(3)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// The id of the most recently persisted user message in a conversation.
    ///
    /// An agent's turn always starts after its triggering user message has been
    /// appended, so this is the message an agent means when it reacts "to what
    /// the user just said" without naming an id it was never shown.
    pub async fn latest_user_message_id(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id FROM messages
             WHERE conversation_id = ?1 AND role = 'user'
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("reading latest user message id")
    }

    /// Agent-authored emojis on the conversation's latest user message, oldest
    /// first. A channel turn mirrors these onto the provider message that
    /// started it, so the bot's reaction shows on Telegram/Slack/Discord the same
    /// way it shows in the desktop transcript.
    pub async fn agent_reactions_on_latest_user_message(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<String>> {
        let Some(message_id) = self.latest_user_message_id(conversation_id).await? else {
            return Ok(Vec::new());
        };
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT emoji FROM message_reactions
             WHERE conversation_id = ?1 AND message_id = ?2 AND user_id LIKE 'agent:%'
             ORDER BY created_at ASC, emoji ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, message_id], |row| row.get(0))?;
        let mut out: Vec<String> = Vec::new();
        for row in rows {
            let emoji: String = row?;
            if !out.contains(&emoji) {
                out.push(emoji);
            }
        }
        Ok(out)
    }

    /// Save the interactive state of one generative-UI widget (`ui.render`) so a
    /// checklist, form or calculator reopens the way the user left it.
    ///
    /// Keyed by the tool call id rather than the message id: the tool call id is
    /// stable from the first streamed frame, while a still-streaming reply's
    /// message id is client-generated until the turn lands. The value is opaque
    /// JSON owned by the desktop renderer and sealed like message bodies, since it
    /// holds whatever the user typed. Returns `false` (→ 409 at the route) when
    /// the conversation already holds [`MAX_AGENT_UI_STATES`] widgets and this
    /// call would add a new one; updating an existing widget always succeeds.
    pub async fn set_agent_ui_state(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        state_json: &str,
    ) -> Result<bool> {
        let sealed = self.cipher.seal(state_json)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM agent_ui_state WHERE conversation_id = ?1 AND tool_call_id = ?2",
                params![conversation_id, tool_call_id],
                |_| Ok(()),
            )
            .optional()
            .context("reading agent ui state")?
            .is_some();
        if !exists {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_ui_state WHERE conversation_id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .context("counting agent ui state")?;
            if count >= MAX_AGENT_UI_STATES {
                return Ok(false);
            }
        }
        conn.execute(
            "INSERT INTO agent_ui_state (conversation_id, tool_call_id, state, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conversation_id, tool_call_id)
             DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
            params![conversation_id, tool_call_id, sealed, now],
        )
        .context("saving agent ui state")?;
        Ok(true)
    }

    /// Every saved generative-UI widget state in a conversation, oldest update
    /// first. A row that no longer decrypts or parses is skipped (the widget falls
    /// back to its spec's initial state) rather than failing the whole read.
    pub async fn list_agent_ui_states(&self, conversation_id: &str) -> Result<Vec<AgentUiState>> {
        let rows: Vec<(String, String, i64)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT tool_call_id, state, updated_at FROM agent_ui_state
                 WHERE conversation_id = ?1 ORDER BY updated_at ASC",
            )?;
            let mapped = stmt.query_map(params![conversation_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            mapped.collect::<std::result::Result<_, _>>()?
        };
        Ok(rows
            .into_iter()
            .filter_map(|(tool_call_id, sealed, updated_at)| {
                let plaintext = self.cipher.open(&sealed).ok()?;
                let state = serde_json::from_str(&plaintext).ok()?;
                Some(AgentUiState {
                    tool_call_id,
                    state,
                    updated_at,
                })
            })
            .collect())
    }

    /// Room-keyed realtime fan-out for a reaction, mirroring the
    /// `conversation.message` publish in `append_message`: a self-describing
    /// `"type": "reaction"` payload on the typed named-event contract. The DB lock
    /// is already released by every caller. Do NOT pre-wrap with `"channel"` —
    /// `frame_to_message` in the WS gateway does that. No-op when realtime is
    /// unwired (tests/CLI) or the room has no members.
    pub(super) fn broadcast_reaction(
        &self,
        conversation_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
        op: &str,
    ) {
        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.reaction",
                serde_json::json!({
                    "type": "reaction",
                    "conversation_id": conversation_id,
                    "message_id": message_id,
                    "emoji": emoji,
                    "user_id": user_id,
                    "op": op,
                }),
            );
        }
    }
}
