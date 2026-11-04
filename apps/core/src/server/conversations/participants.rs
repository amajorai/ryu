//! Multi-agent participants, tenancy claims and access metadata.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Add an agent as a participant in a conversation. Idempotent — adding an
    /// agent that is already in the list is a no-op. Creates the conversation row
    /// if it does not yet exist.
    pub async fn add_participant(
        &self,
        conversation_id: &str,
        agent_id: &str,
        tenancy: Tenancy,
    ) -> Result<Vec<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        // Ensure the conversation row exists — through the choke point, so a council
        // chat created by adding its first participant is born owned.
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow {
                participants: Some("[]"),
                ..ConvRow::default()
            },
            Touch::Keep,
        )
        .context("ensuring conversation for add_participant")?;
        // Load current participants.
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut participants = parse_participants_json(participants_json.as_deref());
        if !participants.iter().any(|p| p == agent_id) {
            participants.push(agent_id.to_owned());
            let new_json = serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_owned());
            conn.execute(
                "UPDATE conversations SET participants = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, new_json, now],
            )
            .context("updating participants in add_participant")?;
        }
        Ok(participants)
    }

    /// Remove an agent from a conversation's participant list. Idempotent — if
    /// the agent is not present the list is returned unchanged.
    pub async fn remove_participant(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<Vec<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut participants = parse_participants_json(participants_json.as_deref());
        let before_len = participants.len();
        participants.retain(|p| p != agent_id);
        if participants.len() != before_len {
            let new_json = serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_owned());
            conn.execute(
                "UPDATE conversations SET participants = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, new_json, now],
            )
            .context("updating participants in remove_participant")?;
        }
        Ok(participants)
    }

    /// Return the current participant list for a conversation.
    pub async fn get_participants(&self, conversation_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(parse_participants_json(participants_json.as_deref()))
    }

    /// Stamp the verified human owner (and the node's org) onto a conversation,
    /// creating the row if this is a brand-new chat. **This is the write that makes
    /// the per-resource ACL non-vacuous** — before it existed every row was created
    /// with NULL tenancy, which `resource_access` reads as "the untenanted local
    /// row" and grants to everyone.
    ///
    /// **First-writer-wins**: `COALESCE(existing, new)` means a row that already has
    /// an owner is NEVER re-tenanted, so a second caller racing on the same id (or a
    /// deliberate re-POST with someone else's conversation id) can never STEAL a
    /// conversation. The loser is simply denied by the ACL on their next request.
    ///
    /// Safe to front-run the lazy upserts in [`Self::ensure_conversation`] /
    /// [`Self::append_message`]: their `ON CONFLICT` clauses touch only
    /// `agent_id` / `title` / `updated_at`, never the tenancy columns, so the owner
    /// stamped here survives the first message landing.
    pub async fn claim_tenancy(
        &self,
        conversation_id: &str,
        owner_user_id: &str,
        org_id: Option<&str>,
    ) -> Result<()> {
        let now = now_millis();
        let tenancy = Tenancy::Owned {
            user_id: owner_user_id.to_owned(),
            org_id: org_id.map(str::to_owned),
        };
        let conn = self.conn.lock().await;
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow::default(),
            Touch::Keep,
        )
        .context("claiming conversation tenancy")
    }

    /// The conversation a session hangs off, so a session-keyed route can be gated
    /// on its PARENT conversation's tenancy (sessions carry no tenancy of their own).
    /// `Ok(None)` when the session id is unknown.
    pub async fn conversation_id_for_session(&self, session_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT conversation_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("resolving session's conversation")?;
        Ok(id)
    }

    /// The conversation a `/btw` side entry (or subagent child run) hangs off — the
    /// session-lookup's twin, for gating the btw routes on the parent's tenancy.
    pub async fn conversation_id_for_btw(&self, btw_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT conversation_id FROM btw_entries WHERE id = ?1",
                params![btw_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("resolving btw entry's conversation")?;
        Ok(id)
    }

    /// Load the tenancy quartet (owner / org / visibility / team) for a
    /// conversation, for the realtime WS gateway's access decision. Returns
    /// `Ok(None)` when the conversation row does not exist (an as-yet-uncreated
    /// chat — conversations are upserted lazily on the first message). These
    /// columns are plaintext (only `title` and message `content` are sealed at
    /// rest), so a raw `SELECT` compares correctly against a verified caller's id.
    pub async fn get_access_meta(
        &self,
        conversation_id: &str,
    ) -> Result<Option<crate::identity_verify::ResourceTenancy>> {
        Ok(self
            .get_access_meta_with_generation(conversation_id)
            .await?
            .map(|(meta, _)| meta))
    }

    pub async fn get_access_meta_with_generation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<(crate::identity_verify::ResourceTenancy, String)>> {
        let connection = self.conn.lock().await;
        let conn = connection
            .unchecked_transaction()
            .context("reading conversation identity snapshot")?;
        let meta = conn
            .query_row(
                "SELECT owner_user_id, org_id, visibility, team_id
                 FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| {
                    Ok(crate::identity_verify::ResourceTenancy {
                        owner_user_id: row.get(0)?,
                        org_id: row.get(1)?,
                        // NOT NULL DEFAULT 'private' in the schema, so always present.
                        visibility: row.get(2)?,
                        team_id: row.get(3)?,
                        collaborators: Vec::new(),
                    })
                },
            )
            .optional()
            .context("reading conversation access metadata")?;
        let Some(mut meta) = meta else {
            return Ok(None);
        };
        let mut statement = conn.prepare(
            "SELECT user_id, role FROM conversation_collaborators
             WHERE conversation_id = ?1 ORDER BY user_id",
        )?;
        let rows = statement.query_map(params![conversation_id], |row| {
            let role: String = row.get(1)?;
            let access = if role == "participant" {
                crate::identity_verify::Access::Write
            } else {
                crate::identity_verify::Access::Read
            };
            Ok(crate::identity_verify::ResourceCollaborator {
                user_id: row.get(0)?,
                access,
            })
        })?;
        meta.collaborators = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading conversation collaborators")?;
        let generation = crate::server::conversation_lifecycle::generation(&conn, conversation_id)?
            .context("conversation generation missing")?;
        Ok(Some((meta, generation)))
    }

    /// Whether a conversation was created by a registered channel bot. This is
    /// intentionally separate from the public tenancy quartet: the machine
    /// ingress gate uses it to allow the node-token channel writer to continue
    /// its own org-shared room, while human reads still go through the normal
    /// organization visibility ACL.
    pub async fn is_channel_conversation(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM conversations
                 WHERE id = ?1 AND channel_id IS NOT NULL",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("checking channel conversation metadata")?;
        Ok(found.is_some())
    }
}
