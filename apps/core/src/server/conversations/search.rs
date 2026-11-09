//! Search index reconciliation and message search (semantic and full-text).
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Remove index rows whose source message no longer exists (conversations
    /// deleted before deletes reached the indexes, or by an older build).
    /// Best-effort: a failure leaves the orphans for the next pass; search
    /// already drops hits that no longer resolve.
    pub(super) async fn sweep_index_orphans(
        &self,
        lexical: bool,
        indexed: &std::collections::HashSet<String>,
    ) {
        if indexed.is_empty() {
            return;
        }
        let existing: std::collections::HashSet<String> = {
            let conn = self.conn.lock().await;
            let ids = conn
                .prepare("SELECT id FROM messages")
                .and_then(|mut stmt| {
                    stmt.query_map([], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<_>>()
                });
            match ids {
                Ok(ids) => ids,
                Err(error) => {
                    tracing::warn!("search index orphan sweep skipped: {error:#}");
                    return;
                }
            }
        };
        let orphans: Vec<String> = indexed
            .iter()
            .filter(|id| !existing.contains(*id))
            .cloned()
            .collect();
        if orphans.is_empty() {
            return;
        }
        let result = if lexical {
            match self.message_fts.as_ref() {
                Some(index) => index.delete_messages(&orphans).await,
                None => Ok(0),
            }
        } else {
            match self.message_index.as_ref() {
                Some(index) => index.delete_messages(&orphans).await,
                None => Ok(0),
            }
        };
        match result {
            Ok(removed) => tracing::info!(lexical, removed, "search index: removed orphaned rows"),
            Err(error) => tracing::warn!("search index orphan sweep failed: {error:#}"),
        }
    }

    /// Reconcile once against index metadata, then consume only queued revisions.
    /// The caller holds that index's backfill mutex across awaits. Failed rows
    /// remain queued, but are attempted only once per pass; newer writes receive
    /// a new revision and cannot be acknowledged by an older in-flight request.
    pub(super) async fn reconcile_search_index(
        &self,
        lexical: bool,
        initialized: &mut bool,
    ) -> Result<()> {
        if !self.chat_memory_enabled() {
            return Ok(());
        }
        let kind = i64::from(lexical);
        if !*initialized {
            {
                let conn = self.conn.lock().await;
                conn.execute(
                    "INSERT OR IGNORE INTO message_search_pending(kind, message_id, dirty)
                     SELECT ?1, id, 0 FROM messages",
                    [kind],
                )?;
            }
            let indexed = if lexical {
                self.message_fts
                    .as_ref()
                    .expect("FTS wired")
                    .indexed_ids()
                    .await?
            } else {
                self.message_index
                    .as_ref()
                    .expect("semantic wired")
                    .indexed_ids()
                    .await?
            };
            self.sweep_index_orphans(lexical, &indexed).await;
            let conn = self.conn.lock().await;
            let transaction = conn.unchecked_transaction()?;
            {
                let mut delete = transaction.prepare_cached(
                    "DELETE FROM message_search_pending WHERE kind = ?1 AND message_id = ?2 AND dirty = 0",
                )?;
                for id in indexed {
                    delete.execute(params![kind, id])?;
                }
            }
            transaction.commit()?;
            *initialized = true;
        }
        let end: i64 = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM message_search_pending WHERE kind = ?1",
                [kind],
                |row| row.get(0),
            )?
        };
        let mut after = 0;
        let mut failures = 0;
        while after < end && self.chat_memory_enabled() {
            let pending = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare_cached(MESSAGE_SEARCH_BATCH_SQL)?;
                let rows = stmt.query_map(params![kind, after, end], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if pending.is_empty() {
                break;
            }
            for (revision, id, conversation, role, sealed, created, dirty, parts) in pending {
                if !self.chat_memory_enabled() {
                    return Ok(());
                }
                after = revision;
                // Append's best-effort worker may already have written this new
                // message. Check one indexed key, never reload all indexed IDs.
                // Updates (dirty = 2) must still replace any older embedding.
                if !lexical
                    && dirty == 1
                    && self
                        .message_index
                        .as_ref()
                        .expect("semantic wired")
                        .contains_message(&id)
                        .await?
                {
                    let conn = self.conn.lock().await;
                    conn.execute(
                        "DELETE FROM message_search_pending WHERE revision = ?1",
                        [revision],
                    )?;
                    continue;
                }
                let Some(content) = self.open_content_for_index(sealed) else {
                    // Never index placeholder text for a body that did not open.
                    let conn = self.conn.lock().await;
                    conn.execute(
                        "DELETE FROM message_search_pending WHERE revision = ?1",
                        [revision],
                    )?;
                    continue;
                };
                // The keyword index also holds the turn's redacted tool calls.
                let content = if lexical {
                    tool_part_index::keyword_index_text(content, &self.tool_text_for_index(parts))
                } else {
                    content
                };
                let result = if content.trim().is_empty() {
                    if lexical && dirty == 2 {
                        // Edited to empty: the old tokens must not stay searchable.
                        self.message_fts
                            .as_ref()
                            .expect("FTS wired")
                            .delete_messages(std::slice::from_ref(&id))
                            .await
                            .map(|_| ())
                    } else {
                        Ok(())
                    }
                } else if lexical {
                    self.message_fts
                        .as_ref()
                        .expect("FTS wired")
                        .index_message(&id, &conversation, &role, &content, created)
                        .await
                } else {
                    let index = self.message_index.as_ref().expect("semantic wired");
                    let embedder = index.embedder();
                    match embedder.embed(&content).await {
                        Ok(vector) if self.chat_memory_enabled() => {
                            index
                                .index_message(
                                    &id,
                                    &conversation,
                                    &role,
                                    &vector,
                                    embedder.model_id(),
                                    created,
                                )
                                .await
                        }
                        Ok(_) => return Ok(()),
                        Err(error) => Err(error),
                    }
                };
                match result {
                    Ok(()) => {
                        failures = 0;
                        let conn = self.conn.lock().await;
                        conn.execute(
                            "DELETE FROM message_search_pending WHERE revision = ?1",
                            [revision],
                        )?;
                    }
                    Err(error) => {
                        failures += 1;
                        tracing::warn!("message search backfill failed for {id}: {error:#}");
                        if !lexical && failures >= 3 {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Semantic search over past conversation messages (the `search_conversations`
    /// builtin tool). Returns `None` when no message index is wired.
    ///
    /// Performs a **lazy backfill** first: any stored message not yet in the index
    /// is decrypted and embedded so the feature returns hits for chats already on
    /// disk, not just future ones. A failed embed during backfill is non-fatal —
    /// that message is skipped this round (the next search retries it). Then runs a
    /// KNN over the index and re-reads + decrypts each hit's snippet from this db
    /// (the index stores only vectors + metadata, never message text). Hits whose
    /// message id no longer resolves (e.g. a deleted conversation orphaned its
    /// vector) are dropped.
    pub async fn search_messages(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Option<Vec<MessageSearchHit>>> {
        // Chat-message search is an explicit Memory opt-in. Guard the semantic
        // backfill as well as KNN so callers cannot materialize an index by
        // invoking the store directly instead of going through the HTTP/MCP
        // gates.
        if !self.chat_memory_enabled() {
            return Ok(None);
        }
        let Some(index) = self.message_index.clone() else {
            return Ok(None);
        };

        if index.embedder().is_local() {
            let mut initialized = self.semantic_backfill.lock().await;
            self.reconcile_search_index(false, &mut initialized).await?;
        } else if let Ok(mut initialized) = self.semantic_backfill.clone().try_lock_owned() {
            // One remote backfill owns the queue. Its bounded reads and network
            // calls run off the request path, including the first reconciliation.
            let store = self.clone();
            tokio::spawn(async move {
                if let Err(error) = store.reconcile_search_index(false, &mut initialized).await {
                    tracing::warn!("semantic backfill failed: {error:#}");
                }
            });
        }

        // ── KNN + snippet re-read ────────────────────────────────────────────
        let hits = index.search(query, limit, conversation_ids).await?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            let sealed: Option<String> = {
                let conn = self.conn.lock().await;
                conn.query_row(
                    "SELECT content FROM messages WHERE id = ?1",
                    [&hit.message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            };
            // Drop orphaned vectors (message deleted out from under the index).
            let Some(sealed) = sealed else { continue };
            out.push(MessageSearchHit {
                conversation_id: hit.conversation_id,
                message_id: hit.message_id,
                role: hit.role,
                content: self.open_content(sealed),
                created_at: hit.created_at,
                // vec0's default metric is L2 (Euclidean) distance. The embedder
                // L2-normalizes its vectors, so distance lies in [0, 2] (0 =
                // identical, 2 = opposite). Map it to a monotonic [0, 1] relevance
                // hint — this preserves ranking and gives a bounded score; it is a
                // relevance indicator, not an exact cosine value.
                score: (1.0 - hit.distance / 2.0).clamp(0.0, 1.0),
            });
        }
        Ok(Some(out))
    }

    /// Full-text (FTS5) search over past conversation messages — the lexical/keyword
    /// complement to [`search_messages`] (semantic KNN). Returns `None` when no FTS
    /// index is wired.
    ///
    /// Performs a **lazy backfill** first: any stored message not yet in the FTS
    /// index is decrypted and indexed so the feature returns hits for chats already
    /// on disk, not just future ones. Unlike the semantic backfill this is
    /// network-free (no embedder), so it runs INLINE (awaited) rather than spawned —
    /// a down embed sidecar can never affect it. Then runs the FTS MATCH and
    /// re-reads + decrypts each hit's snippet from this db (the FTS index stores only
    /// the tokenized inverted index + metadata, never message text). Hits whose
    /// message id no longer resolves (e.g. a deleted conversation orphaned its FTS
    /// row) are dropped.
    ///
    /// The index also holds each message's redacted tool-call text (see
    /// `tool_part_index`); a hit that matched only there carries that text in its
    /// snippet.
    pub async fn fts_search_messages(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Option<Vec<MessageSearchHit>>> {
        // Chat-message search is an explicit Memory opt-in. Guard the FTS
        // backfill as well as MATCH so a disabled feature never materializes a
        // lexical index merely because a caller asks for an exact search.
        if !self.chat_memory_enabled() {
            return Ok(None);
        }
        let Some(index) = self.message_fts.clone() else {
            return Ok(None);
        };

        {
            let mut initialized = self.fts_backfill.lock().await;
            self.reconcile_search_index(true, &mut initialized).await?;
        }

        // ── FTS MATCH + snippet re-read ──────────────────────────────────────
        let hits = index.search(query, limit, conversation_ids).await?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            let sealed: Option<(String, Option<String>)> = {
                let conn = self.conn.lock().await;
                conn.query_row(
                    "SELECT content, CASE WHEN length(parts) <= 8388608 THEN parts END
                     FROM messages WHERE id = ?1",
                    [&hit.message_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()?
            };
            // Drop orphaned rows (message deleted out from under the index).
            let Some((sealed, parts)) = sealed else {
                continue;
            };
            let content = self.open_content(sealed);
            out.push(MessageSearchHit {
                conversation_id: hit.conversation_id,
                message_id: hit.message_id,
                role: hit.role,
                content: self.keyword_snippet(query, content, parts),
                created_at: hit.created_at,
                score: hit.score,
            });
        }
        Ok(Some(out))
    }
}
