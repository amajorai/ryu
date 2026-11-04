//! Exactly-once proactive openings and channel-session turn idempotency.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProactiveOpeningStatus {
    pub conversation_id: String,
    pub status: String,
}

/// The replayable result of one channel-session turn. The channel adapter uses
/// this when a provider send timed out after Core had already persisted the
/// assistant reply: the retry can deliver the same reply without running the
/// model again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelTurnReplay {
    pub reply: String,
    pub assistant_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub agent_id: Option<String>,
    pub fallback_warning: Option<String>,
    pub interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
}

/// The request-hash scheme a channel-turn row records: `ryu_tracing::hash_args`,
/// SHA-256 over the request's key-sorted bytes. Rows written before the column
/// existed carry NULL and may hold the legacy insertion-order digest.
pub(super) const CHANNEL_TURN_HASH_SCHEME: &str = "sorted-keys";

/// How long a pre-upgrade row may still match its legacy digest: the thirty
/// days a completed channel turn is retained. A retry that spans the upgrade
/// keeps replaying; once the window passes, only the current digest matches.
pub(super) const LEGACY_CHANNEL_TURN_HASH_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The digest a channel-turn row stored before request hashing became key-order
/// independent: SHA-256 hex of the request serialized in its own insertion
/// order (Core builds with `serde_json/preserve_order`). Only ever compared
/// with rows written before the upgrade.
pub fn legacy_channel_turn_request_hash(request: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(
        serde_json::to_vec(request).unwrap_or_default(),
    ))
}

/// Result of claiming a channel-session idempotency key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelTurnClaim {
    /// The caller owns the key and may run the turn.
    Claimed,
    /// Another request is currently running the same key.
    InFlight,
    /// Core already completed the key; return this exact result to the caller.
    Completed(ChannelTurnReplay),
}

impl ConversationStore {
    /// Atomically claim a proactive opening. A completed key is permanent so a
    /// retry after a lost response cannot send a second greeting. A stale running
    /// claim is reclaimed after fifteen minutes, which lets a process killed
    /// during model startup recover without requiring a manual database repair.
    pub async fn claim_proactive_opening(
        &self,
        idempotency_key: &str,
        conversation_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let stale_before = now_millis() - 15 * 60 * 1000;
        conn.execute(
            "DELETE FROM proactive_openings
             WHERE idempotency_key = ?1 AND status = 'running' AND created_at < ?2",
            params![idempotency_key, stale_before],
        )?;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO proactive_openings
             (idempotency_key, conversation_id, status, created_at)
             VALUES (?1, ?2, 'running', ?3)",
            params![idempotency_key, conversation_id, now_millis()],
        )?;
        Ok(inserted == 1)
    }

    /// Durable state and conversation binding of a proactive opening claim.
    pub async fn proactive_opening_status(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<ProactiveOpeningStatus>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT conversation_id, status
             FROM proactive_openings
             WHERE idempotency_key = ?1",
            params![idempotency_key],
            |row| {
                Ok(ProactiveOpeningStatus {
                    conversation_id: row.get(0)?,
                    status: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Mark a proactive opening complete only after its assistant message is
    /// durable. The update is deliberately idempotent.
    pub async fn complete_proactive_opening(&self, idempotency_key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE proactive_openings
             SET status = 'completed', completed_at = ?2
             WHERE idempotency_key = ?1",
            params![idempotency_key, now_millis()],
        )?;
        Ok(())
    }

    /// Release a failed opening so a readiness retry can try again.
    pub async fn release_proactive_opening(&self, idempotency_key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM proactive_openings WHERE idempotency_key = ?1 AND status = 'running'",
            params![idempotency_key],
        )?;
        Ok(())
    }

    /// Atomically claim one channel-session turn. Completed results are retained
    /// for thirty days so a provider redelivery after a Gateway restart replays
    /// the exact Core reply rather than appending another user/assistant pair.
    /// A live processing claim returns `InFlight`; a stale one is reclaimed so a
    /// Core process that died mid-turn does not wedge that provider message.
    pub async fn claim_channel_turn(
        &self,
        idempotency_key: &str,
        conversation_id: &str,
        request_hash: &str,
    ) -> Result<ChannelTurnClaim> {
        self.claim_channel_turn_with_legacy(idempotency_key, conversation_id, request_hash, None)
            .await
    }

    /// [`Self::claim_channel_turn`] for the request itself: hashes it with
    /// `ryu_tracing::hash_args` and also accepts a row written before the
    /// upgrade whose stored digest is the legacy insertion-order one, inside
    /// [`LEGACY_CHANNEL_TURN_HASH_WINDOW_MS`]. Without this, a provider retry
    /// that spans the upgrade fails closed as a reused key.
    // The channel-session route still passes its digest to `claim_channel_turn`;
    // switching it to this entry point is a change in `server/mod.rs`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn claim_channel_turn_for_request(
        &self,
        idempotency_key: &str,
        conversation_id: &str,
        request: &serde_json::Value,
    ) -> Result<ChannelTurnClaim> {
        let request_hash = ryu_tracing::hash_args(request);
        let legacy_hash = legacy_channel_turn_request_hash(request);
        self.claim_channel_turn_with_legacy(
            idempotency_key,
            conversation_id,
            &request_hash,
            Some(&legacy_hash),
        )
        .await
    }

    pub(super) async fn claim_channel_turn_with_legacy(
        &self,
        idempotency_key: &str,
        conversation_id: &str,
        request_hash: &str,
        legacy_request_hash: Option<&str>,
    ) -> Result<ChannelTurnClaim> {
        let key = idempotency_key.trim();
        if key.is_empty() || key.len() > 500 {
            anyhow::bail!("channel turn idempotency key must be 1..=500 bytes");
        }
        let now = now_millis();
        let stale_before = now - 15 * 60 * 1000;
        let retention_before = now - 30 * 24 * 60 * 60 * 1000;
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM channel_turn_idempotency
             WHERE status = 'completed' AND updated_at < ?1",
            params![retention_before],
        )?;

        let existing: Option<(
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            Option<String>,
            i64,
        )> = conn
            .query_row(
                "SELECT conversation_id, request_hash, reply, assistant_message_id,
                        assistant_message_ids, agent_id, fallback_warning,
                        interactive_markup, updated_at, hash_scheme, created_at
                 FROM channel_turn_idempotency
                 WHERE idempotency_key = ?1",
                params![key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .optional()?;

        if let Some((
            existing_conversation_id,
            existing_hash,
            sealed_reply,
            assistant_message_id,
            assistant_message_ids,
            agent_id,
            fallback_warning,
            sealed_interactive_markup,
            updated_at,
            hash_scheme,
            created_at,
        )) = existing
        {
            // A NULL scheme marks a row written before request hashing sorted
            // object keys; inside the window its legacy digest still matches.
            let legacy_match = hash_scheme.is_none()
                && created_at >= now - LEGACY_CHANNEL_TURN_HASH_WINDOW_MS
                && legacy_request_hash == Some(existing_hash.as_str());
            if existing_conversation_id != conversation_id
                || (existing_hash != request_hash && !legacy_match)
            {
                anyhow::bail!("channel turn idempotency key was reused for a different request");
            }
            if sealed_reply.is_some() {
                let reply = sealed_reply
                    .map(|sealed| self.cipher.open(&sealed))
                    .transpose()?
                    .unwrap_or_default();
                let assistant_message_ids =
                    serde_json::from_str(&assistant_message_ids).unwrap_or_default();
                let interactive_markup = sealed_interactive_markup
                    .map(|sealed| self.cipher.open(&sealed))
                    .transpose()?
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?;
                return Ok(ChannelTurnClaim::Completed(ChannelTurnReplay {
                    reply,
                    assistant_message_id,
                    assistant_message_ids,
                    agent_id,
                    fallback_warning: fallback_warning
                        .map(|sealed| self.cipher.open(&sealed))
                        .transpose()?,
                    interactive_markup,
                }));
            }
            if updated_at >= stale_before {
                return Ok(ChannelTurnClaim::InFlight);
            }
            conn.execute(
                "UPDATE channel_turn_idempotency
                 SET status = 'processing', updated_at = ?2,
                     request_hash = ?3, hash_scheme = ?4
                 WHERE idempotency_key = ?1",
                params![key, now, request_hash, CHANNEL_TURN_HASH_SCHEME],
            )?;
            return Ok(ChannelTurnClaim::Claimed);
        }

        conn.execute(
            "INSERT INTO channel_turn_idempotency
             (idempotency_key, conversation_id, request_hash, hash_scheme, status,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?5, 'processing', ?4, ?4)",
            params![
                key,
                conversation_id,
                request_hash,
                now,
                CHANNEL_TURN_HASH_SCHEME
            ],
        )?;
        Ok(ChannelTurnClaim::Claimed)
    }

    /// Persist the complete channel-session result after the conversation rows
    /// are durable. The update is idempotent and refuses to overwrite a result
    /// that a concurrent retry already completed.
    pub async fn complete_channel_turn(
        &self,
        idempotency_key: &str,
        result: &ChannelTurnReplay,
    ) -> Result<()> {
        let sealed_reply = self.cipher.seal(&result.reply)?;
        let sealed_fallback_warning = result
            .fallback_warning
            .as_deref()
            .map(|warning| self.cipher.seal(warning))
            .transpose()?;
        let assistant_message_ids = serde_json::to_string(&result.assistant_message_ids)?;
        let sealed_interactive_markup = result
            .interactive_markup
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .map(|json| self.cipher.seal(&json))
            .transpose()?;
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE channel_turn_idempotency
             SET status = 'completed', reply = ?2, assistant_message_id = ?3,
                 assistant_message_ids = ?4, agent_id = ?5, fallback_warning = ?6,
                 interactive_markup = ?7, updated_at = ?8
             WHERE idempotency_key = ?1 AND status = 'processing'",
            params![
                idempotency_key.trim(),
                sealed_reply,
                result.assistant_message_id,
                assistant_message_ids,
                result.agent_id,
                sealed_fallback_warning,
                sealed_interactive_markup,
                now_millis(),
            ],
        )?;
        if updated == 0 {
            let status: Option<String> = conn
                .query_row(
                    "SELECT status FROM channel_turn_idempotency WHERE idempotency_key = ?1",
                    params![idempotency_key.trim()],
                    |row| row.get(0),
                )
                .optional()?;
            if status.as_deref() != Some("completed") {
                anyhow::bail!("channel turn idempotency claim disappeared before completion");
            }
        }
        Ok(())
    }

    /// Release a channel-session claim when validation or the model path fails
    /// before a replayable result exists. A later provider retry can then make a
    /// fresh claim instead of receiving a permanent in-flight response.
    pub async fn release_channel_turn(&self, idempotency_key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM channel_turn_idempotency
             WHERE idempotency_key = ?1 AND status = 'processing'",
            params![idempotency_key.trim()],
        )?;
        Ok(())
    }
}
