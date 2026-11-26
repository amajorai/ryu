//! Reading every message's parts for a guard that must inspect all of them.

use super::*;

impl ConversationStore {
    /// Each message's role and parts, oldest first. Unlike
    /// [`Self::get_messages`], a stored `parts` value that cannot be decrypted
    /// or parsed is an error rather than a missing value, so a guard that must
    /// inspect every part (a private device read in the history) fails closed.
    pub(crate) async fn message_parts_strict(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<(String, Option<serde_json::Value>)>> {
        let raw: Vec<(String, Option<String>)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT role, parts FROM messages WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([conversation_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        raw.into_iter()
            .map(|(role, sealed)| {
                let parts = match sealed {
                    None => None,
                    Some(sealed) => {
                        let plain = self
                            .cipher
                            .open(&sealed)
                            .context("a message's parts cannot be decrypted")?;
                        Some(
                            serde_json::from_str(&plain)
                                .context("a message's parts cannot be parsed")?,
                        )
                    }
                };
                Ok((role, parts))
            })
            .collect()
    }

    /// Replace every stored `parts` value of a conversation with an
    /// undecryptable one, as a corrupt or foreign-key row would be.
    #[cfg(test)]
    pub(crate) async fn corrupt_parts_for_test(&self, conversation_id: &str) {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE messages SET parts = 'not-a-sealed-value' WHERE conversation_id = ?1",
            [conversation_id],
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unreadable_part_is_an_error_not_a_missing_value() {
        let store = ConversationStore::open_in_memory().unwrap();
        let parts = serde_json::json!([{ "type": "text", "text": "hi" }]);
        store
            .append_message_as_with_render_data(
                "conv-strict",
                "user",
                "hi",
                None,
                None,
                None,
                Tenancy::Unattributed,
                None,
                None,
                Some(&parts),
                None,
            )
            .await
            .unwrap();
        let read = store.message_parts_strict("conv-strict").await.unwrap();
        assert_eq!(read, vec![("user".to_owned(), Some(parts))]);

        store.corrupt_parts_for_test("conv-strict").await;
        // The lenient read degrades to no parts; the strict read refuses.
        let lenient = store.get_messages("conv-strict").await.unwrap();
        assert!(lenient[0].parts.is_none());
        assert!(store.message_parts_strict("conv-strict").await.is_err());
    }
}
