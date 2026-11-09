//! Working-memory persistence: reading, writing, and deleting the encrypted
//! per-`(owner, scope, id)` documents, and applying one write to a document.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_kernel_contracts::ResourceKey;
use serde_json::{Map, Value};

use super::history::{delete_history, delete_thread_history, record_snapshot, Snapshot};
use super::validate::{merge_patch, validate_schema_spec, validate_value};
use super::{
    invalid, normalize_id, WorkingMemory, WorkingMemoryError, WorkingMemoryMode,
    WorkingMemoryScope, WorkingMemoryWrite, WorkingPayload, MAX_WORKING_MEMORY_BYTES,
    MAX_WORKING_MEMORY_SPEC_BYTES,
};
use crate::{memory_user_from_key, now_millis, MemoryStore};

impl MemoryStore {
    /// Read the caller's working memory for `(scope, id)`, or `None` when it has
    /// never been written.
    pub async fn get_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<Option<WorkingMemory>> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let conn = self.conn.lock().await;
        self.read_working(&conn, owner, scope, id)
    }

    /// The caller's working-memory documents in `scope`, most recently updated
    /// first, at most `limit` of them. Only the caller's own partition is read,
    /// so another user's scratchpads never appear.
    pub async fn list_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        limit: usize,
    ) -> Result<Vec<WorkingMemory>> {
        let owner = memory_user_from_key(key);
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let conn = self.conn.lock().await;
        let ids = {
            let mut stmt = conn
                .prepare(
                    "SELECT scope_id FROM memory_working
                      WHERE owner_user_id = ?1 AND scope = ?2
                      ORDER BY updated_at DESC, scope_id
                      LIMIT ?3",
                )
                .context("listing working memory")?;
            let rows = stmt.query_map(params![owner, scope.as_str(), limit], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .context("listing working memory")?
        };
        let mut docs = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(doc) = self.read_working(&conn, owner, scope, &id)? {
                docs.push(doc);
            }
        }
        Ok(docs)
    }

    fn read_working(
        &self,
        conn: &Connection,
        owner: &str,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<Option<WorkingMemory>> {
        type Row = (String, Vec<u8>, Vec<u8>, i64, i64, i64);
        let row: Option<Row> = conn
            .query_row(
                "SELECT mode, nonce, ciphertext, version, created_at, updated_at
                   FROM memory_working
                  WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3",
                params![owner, scope.as_str(), id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .context("reading working memory")?;
        let Some((mode, nonce, ciphertext, version, created_at, updated_at)) = row else {
            return Ok(None);
        };
        let plain = self.decrypt(&nonce, &ciphertext)?;
        let payload: WorkingPayload =
            serde_json::from_slice(&plain).context("decoding working memory payload")?;
        Ok(Some(WorkingMemory {
            scope,
            id: id.to_owned(),
            mode: WorkingMemoryMode::from_db(&mode),
            content: payload.content,
            data: payload.data,
            template: payload.template,
            schema: payload.schema,
            version,
            created_at,
            updated_at,
        }))
    }

    /// Create or update the caller's working memory for `(scope, id)`.
    ///
    /// Template mode replaces `content`; schema mode merge-patches `data` (or
    /// replaces it with `replace: true`) and validates the result against the
    /// stored or supplied schema. Errors carrying [`WorkingMemoryError`] are
    /// caller errors (map them to 400 / 409); anything else is a storage fault.
    ///
    /// The upsert and its history snapshot commit in one transaction.
    pub async fn put_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
        write: WorkingMemoryWrite,
    ) -> Result<WorkingMemory> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction()
            .context("starting working memory write")?;
        let existing = self.read_working(&tx, owner, scope, id)?;
        let current_version = existing.as_ref().map_or(0, |doc| doc.version);
        if let Some(expected) = write.expected_version {
            if expected != current_version {
                return Err(anyhow::Error::new(WorkingMemoryError::Conflict {
                    current: current_version,
                }));
            }
        }
        let next = apply_write(existing.as_ref(), write)?;
        let encoded = serde_json::to_vec(&next.payload).context("encoding working memory")?;
        let (nonce, ciphertext) = self.encrypt(&encoded)?;
        let now = now_millis();
        let created_at = existing.as_ref().map_or(now, |doc| doc.created_at);
        let version = current_version + 1;
        tx.execute(
            "INSERT INTO memory_working
                 (owner_user_id, scope, scope_id, mode, nonce, ciphertext, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(owner_user_id, scope, scope_id) DO UPDATE SET
                 mode = excluded.mode,
                 nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext,
                 version = excluded.version,
                 updated_at = excluded.updated_at",
            params![
                owner,
                scope.as_str(),
                id,
                next.mode.as_str(),
                nonce,
                ciphertext,
                version,
                created_at,
                now
            ],
        )
        .context("writing working memory")?;
        record_snapshot(
            &tx,
            &Snapshot {
                owner,
                scope,
                id,
                version,
                mode: next.mode,
                nonce: &nonce,
                ciphertext: &ciphertext,
                created_at,
                updated_at: now,
            },
        )?;
        tx.commit().context("committing working memory write")?;
        Ok(WorkingMemory {
            scope,
            id: id.to_owned(),
            mode: next.mode,
            content: next.payload.content,
            data: next.payload.data,
            template: next.payload.template,
            schema: next.payload.schema,
            version,
            created_at,
            updated_at: now,
        })
    }

    /// Delete the caller's working memory for `(scope, id)` and its history.
    /// Returns whether a document existed.
    pub async fn delete_working_memory(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<bool> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction()
            .context("starting working memory delete")?;
        let removed = tx
            .execute(
                "DELETE FROM memory_working
                  WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3",
                params![owner, scope.as_str(), id],
            )
            .context("deleting working memory")?;
        delete_history(&tx, owner, scope, id)?;
        tx.commit().context("committing working memory delete")?;
        Ok(removed > 0)
    }

    /// Delete every thread-scoped working memory for `thread_id`, across owners.
    /// Called when a conversation is deleted so its scratchpad (and its
    /// history) does not outlive it.
    pub async fn delete_thread_working_memory(&self, thread_id: &str) -> Result<usize> {
        let thread_id = thread_id.trim();
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction()
            .context("starting thread working memory delete")?;
        let removed = tx
            .execute(
                "DELETE FROM memory_working WHERE scope = 'thread' AND scope_id = ?1",
                params![thread_id],
            )
            .context("deleting thread working memory")?;
        delete_thread_history(&tx, thread_id)?;
        tx.commit()
            .context("committing thread working memory delete")?;
        Ok(removed)
    }
}

struct NextDocument {
    mode: WorkingMemoryMode,
    payload: WorkingPayload,
}

fn apply_write(
    existing: Option<&WorkingMemory>,
    write: WorkingMemoryWrite,
) -> Result<NextDocument> {
    let mode = write.mode.unwrap_or_else(|| match existing {
        Some(doc) => doc.mode,
        None if write.data.is_some() || write.schema.is_some() => WorkingMemoryMode::Schema,
        None => WorkingMemoryMode::Template,
    });
    if let Some(template) = &write.template {
        if template.len() > MAX_WORKING_MEMORY_SPEC_BYTES {
            return Err(invalid(format!(
                "working memory template exceeds {MAX_WORKING_MEMORY_SPEC_BYTES} bytes"
            )));
        }
    }
    if let Some(schema) = &write.schema {
        validate_schema_spec(schema).map_err(|error| invalid(error.to_string()))?;
    }
    // A mode switch starts the document over: template Markdown is not a valid
    // schema object and vice versa.
    let same_mode = existing.filter(|doc| doc.mode == mode);
    let payload = match mode {
        WorkingMemoryMode::Template => {
            if write.data.is_some() {
                return Err(invalid(
                    "template-mode working memory takes `content`, not `data`",
                ));
            }
            let template = write
                .template
                .or_else(|| same_mode.and_then(|doc| doc.template.clone()));
            let content = match write.content {
                Some(content) => Some(content),
                None => same_mode.and_then(|doc| doc.content.clone()),
            };
            if let Some(content) = &content {
                if content.len() > MAX_WORKING_MEMORY_BYTES {
                    return Err(invalid(format!(
                        "working memory exceeds {MAX_WORKING_MEMORY_BYTES} bytes"
                    )));
                }
            }
            WorkingPayload {
                content,
                data: None,
                template,
                schema: None,
            }
        }
        WorkingMemoryMode::Schema => {
            if write.content.is_some() {
                return Err(invalid(
                    "schema-mode working memory takes `data`, not `content`",
                ));
            }
            let schema = write
                .schema
                .or_else(|| same_mode.and_then(|doc| doc.schema.clone()));
            let base = same_mode
                .and_then(|doc| doc.data.clone())
                .unwrap_or_else(|| Value::Object(Map::new()));
            let data = match write.data {
                Some(patch) if write.replace => patch,
                Some(patch) => {
                    if !patch.is_object() {
                        return Err(invalid(
                            "a working memory merge patch must be a JSON object",
                        ));
                    }
                    merge_patch(base, patch, 0)?
                }
                None => base,
            };
            if !data.is_object() {
                return Err(invalid("schema-mode working memory must be a JSON object"));
            }
            let encoded_len = serde_json::to_vec(&data).map_or(usize::MAX, |bytes| bytes.len());
            if encoded_len > MAX_WORKING_MEMORY_BYTES {
                return Err(invalid(format!(
                    "working memory exceeds {MAX_WORKING_MEMORY_BYTES} bytes"
                )));
            }
            if let Some(schema) = &schema {
                let mut errors = Vec::new();
                validate_value(&data, schema, "$", 0, &mut errors);
                if !errors.is_empty() {
                    return Err(invalid(format!(
                        "working memory does not match its schema: {}",
                        errors.join("; ")
                    )));
                }
            }
            WorkingPayload {
                content: None,
                data: Some(data),
                template: None,
                schema,
            }
        }
    };
    Ok(NextDocument { mode, payload })
}
