//! Appending messages as a caller and saving temporary conversation
//! snapshots.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Append a message and bump the conversation's `updated_at`. Returns the new
    /// message id. **Creates the conversation if it does not exist yet** — which is
    /// why it takes a [`Tenancy`]: an append that mints a row on an org-bound node
    /// must stamp its owner or the row is born invisible to everybody.
    ///
    /// Callers writing into a row that already exists pass [`Tenancy::Unattributed`];
    /// the choke point's COALESCE preserves the owner already stamped (this is the
    /// property `append_does_not_wipe_a_claimed_owner` asserts).
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<String> {
        self.append_message_as_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
        )
        .await
    }

    /// Append a message with provenance resolved by a server-side verification
    /// boundary. The provenance is written together with the ordinary message
    /// row so the existing conversation reload endpoint can render it.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as_with_provenance(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        provenance: Option<&MessageProvenance>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
            provenance,
            None,
            None,
            None,
            None,
        )
        .await
    }

    /// Append a message and correlate its live event with the concrete client
    /// that submitted the HTTP mutation. The id is event metadata only and is not
    /// persisted or used for authorization.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as_with_realtime_origin(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        provenance: Option<&MessageProvenance>,
        client_id: Option<&str>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
            provenance,
            client_id,
            None,
            None,
            None,
        )
        .await
    }

    /// Persist a submitted UI message and its display data atomically. Metadata is
    /// client supplied; verified identity/provenance remain separate columns.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as_with_render_data(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        provenance: Option<&MessageProvenance>,
        client_id: Option<&str>,
        parts: Option<&serde_json::Value>,
        metadata: Option<&serde_json::Value>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
            provenance,
            client_id,
            parts,
            metadata,
            None,
        )
        .await
    }

    /// Persist a complete temporary-chat snapshot in one transaction.
    ///
    /// Temporary turns intentionally never create rows while they are running,
    /// so the desktop needs one explicit promotion boundary when the user picks
    /// "Save chat". The transaction keeps a failed promotion from leaving a
    /// half-transcript behind. Core generates message ids, seals both text and
    /// structured parts, and then performs the same best-effort search indexing
    /// and realtime fan-out as a normal append.
    pub async fn save_temporary_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        folder_path: Option<&str>,
        messages: &[TemporaryConversationMessage],
        tenancy: Tenancy,
    ) -> Result<ConversationSummary> {
        if messages.is_empty() {
            anyhow::bail!("a temporary chat must contain at least one message");
        }
        if messages
            .iter()
            .any(|message| !matches!(message.role.as_str(), "user" | "assistant"))
        {
            anyhow::bail!("temporary chat messages must be user or assistant turns");
        }

        let now = now_millis();
        let created_at = messages
            .iter()
            .map(|message| message.created_at)
            .min()
            .unwrap_or(now);
        let updated_at = messages
            .iter()
            .map(|message| message.created_at)
            .max()
            .unwrap_or(now)
            .max(now);
        let normalized_folder = folder_path.map(normalize_folder_path);
        let title = messages
            .iter()
            .find(|message| message.role == "user")
            .and_then(|message| derive_title(&message.content));
        let sealed_title = self.seal_opt(title.as_deref())?;
        let index = self.message_index.clone();
        let index_enabled = self.chat_memory_enabled();
        let realtime = self.realtime.clone();
        let mut persisted = Vec::with_capacity(messages.len());

        {
            let mut conn = self.conn.lock().await;
            let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists: Option<String> = transaction
                .query_row(
                    "SELECT id FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_some() {
                anyhow::bail!("conversation already exists");
            }
            insert_conversation_row(
                &transaction,
                conversation_id,
                now,
                &tenancy,
                &ConvRow {
                    title: sealed_title.as_deref(),
                    agent_id,
                    created_at: Some(created_at),
                    updated_at: Some(updated_at),
                    folder_path: normalized_folder.as_deref(),
                    ..ConvRow::default()
                },
                Touch::Keep,
                ConversationConflict::Ignore,
            )?;
            if let Some(derived_title) = title.as_deref() {
                Self::push_title_history_locked(
                    &transaction,
                    &self.cipher,
                    conversation_id,
                    derived_title,
                    "derived",
                    created_at,
                )?;
            }

            for message in messages {
                let message_id = uuid::Uuid::new_v4().to_string();
                let sealed_content = self.cipher.seal(&message.content)?;
                let sealed_parts = message
                    .parts
                    .as_ref()
                    .filter(|parts| !parts.is_null())
                    .map(|parts| {
                        serde_json::to_string(parts)
                            .context("serializing temporary chat message parts")
                            .and_then(|json| self.cipher.seal(&json))
                    })
                    .transpose()?;
                let sealed_metadata = message
                    .metadata
                    .as_ref()
                    .filter(|value| value.is_object())
                    .map(|value| self.cipher.seal(&value.to_string()))
                    .transpose()?;
                transaction
                    .execute(
                        "INSERT INTO messages
                            (id, conversation_id, role, content, agent_id, author_user_id,
                             parts, created_at, metadata)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            message_id,
                            conversation_id,
                            message.role,
                            sealed_content,
                            message.agent_id,
                            message.author_user_id,
                            sealed_parts,
                            message.created_at,
                            sealed_metadata,
                        ],
                    )
                    .context("inserting temporary chat message")?;
                persisted.push((
                    message_id,
                    message.role.clone(),
                    message.content.clone(),
                    message.agent_id.clone(),
                    message.author_user_id.clone(),
                    message.created_at,
                ));
            }
            transaction.commit()?;
        }

        if index_enabled {
            if let Some(index) = index {
                for (message_id, role, content, _, _, created_at) in persisted.clone() {
                    if content.trim().is_empty() {
                        continue;
                    }
                    let index = index.clone();
                    let message_id = message_id.clone();
                    let conversation_id = conversation_id.to_owned();
                    let role = role.clone();
                    let content = content.clone();
                    tokio::spawn(async move {
                        let embedder = index.embedder();
                        match embedder.embed(&content).await {
                            Ok(vector) => {
                                if let Err(error) = index
                                    .index_message(
                                        &message_id,
                                        &conversation_id,
                                        &role,
                                        &vector,
                                        embedder.model_id(),
                                        created_at,
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        "message-index write failed for {message_id}: {error:#}"
                                    );
                                }
                            }
                            Err(error) => tracing::warn!(
                                "message-index embed failed for {message_id} (sidecar down?): {error:#}"
                            ),
                        }
                    });
                }
            }
        }

        if let Some(realtime) = realtime {
            for (message_id, role, content, message_agent_id, author_user_id, created_at) in
                persisted
            {
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
                            "author_user_id": author_user_id,
                            "created_at": created_at,
                            "agent_id": message_agent_id,
                        }
                    }),
                );
            }
        }

        self.run_summary(conversation_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("saved temporary conversation disappeared"))
    }
}
