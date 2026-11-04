//! Per-user read receipts and their live events.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Return the durable per-person read markers for a conversation. The join
    /// back to `messages` is intentional: older databases did not enable foreign
    /// keys, so an orphaned marker must never surface as a receipt for a message
    /// that no longer exists.
    pub async fn list_read_receipts(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<MessageReadReceipt>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT receipt.message_id, receipt.user_id, receipt.read_at
             FROM message_read_receipts AS receipt
             INNER JOIN messages AS message
               ON message.id = receipt.message_id
              AND message.conversation_id = receipt.conversation_id
             WHERE receipt.conversation_id = ?1
             ORDER BY receipt.read_at ASC, receipt.rowid ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| {
            let read_at: i64 = row.get(2)?;
            Ok(MessageReadReceipt {
                message_id: row.get(0)?,
                user_id: row.get(1)?,
                read_at: millis_to_rfc3339(read_at),
                user_name: None,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Mark a bounded set of messages read for one verified human. The composite
    /// key makes the operation idempotent across tabs, retries, and reconnects;
    /// only the first insert fans a receipt event out to the room.
    pub async fn mark_messages_read(
        &self,
        conversation_id: &str,
        message_ids: &[String],
        user_id: &str,
        user_name: Option<&str>,
    ) -> Result<Vec<MessageReadReceipt>> {
        let read_at_ms = now_millis();
        let read_at = millis_to_rfc3339(read_at_ms);
        let inserted_ids = {
            let conn = self.conn.lock().await;
            let mut inserted = Vec::new();
            for message_id in message_ids {
                if !message_in_conversation(&conn, conversation_id, message_id)? {
                    continue;
                }
                let count = conn
                    .execute(
                        "INSERT OR IGNORE INTO message_read_receipts
                             (message_id, conversation_id, user_id, read_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![message_id, conversation_id, user_id, read_at_ms],
                    )
                    .context("marking message read")?;
                if count > 0 {
                    inserted.push(message_id.clone());
                }
            }
            inserted
        };

        let receipts = inserted_ids
            .into_iter()
            .map(|message_id| MessageReadReceipt {
                message_id,
                user_id: user_id.to_owned(),
                read_at: read_at.clone(),
                user_name: user_name.map(str::to_owned),
            })
            .collect::<Vec<_>>();
        for receipt in &receipts {
            self.broadcast_read_receipt(conversation_id, receipt);
        }
        Ok(receipts)
    }

    /// Broadcast one newly-created receipt without holding the conversation DB
    /// lock. `readAt` and the optional display name are presentation metadata;
    /// the durable source of truth remains the table above.
    pub(super) fn broadcast_read_receipt(
        &self,
        conversation_id: &str,
        receipt: &MessageReadReceipt,
    ) {
        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.readReceipt",
                serde_json::json!({
                    "type": "readReceipt",
                    "conversationId": conversation_id,
                    "messageId": receipt.message_id,
                    "userId": receipt.user_id,
                    "readAt": receipt.read_at,
                    "userName": receipt.user_name,
                }),
            );
        }
    }
}
