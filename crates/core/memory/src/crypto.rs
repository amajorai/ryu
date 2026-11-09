//! Encryption at rest: the field-cipher helpers, the encrypted payload codec,
//! and the SQL row -> decrypted entry mapping.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    detect_sensitive_topics, LongTermEntry, MemoryCategory, MemoryLifecycle, MemoryProvenance,
    MemoryScope, MemoryStore, SensitiveTopic,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemoryPayload {
    content: String,
    #[serde(default)]
    when_to_use: Option<String>,
    #[serde(default)]
    provenance: MemoryProvenance,
    #[serde(default)]
    sensitive_topics: Vec<SensitiveTopic>,
}

/// Serialize sensitive content, source references, and sensitive-topic metadata
/// to JSON for encryption.
pub(crate) fn encode_payload(
    content: &str,
    when_to_use: Option<&str>,
    provenance: &MemoryProvenance,
    sensitive_topics: &[SensitiveTopic],
) -> Vec<u8> {
    serde_json::to_vec(&MemoryPayload {
        content: content.to_owned(),
        when_to_use: when_to_use.map(str::to_owned),
        provenance: provenance.clone(),
        sensitive_topics: sensitive_topics.to_vec(),
    })
    .unwrap_or_else(|_| content.as_bytes().to_vec())
}

/// Decode a decrypted payload back into `(content, when_to_use)`. Falls back to
/// treating the whole plaintext as `content` for legacy rows that stored the raw
/// string (pre-JSON payloads).
pub(crate) fn decode_payload(plain: &[u8]) -> MemoryPayload {
    let text = String::from_utf8_lossy(plain).into_owned();
    if let Ok(mut payload) = serde_json::from_str::<MemoryPayload>(&text) {
        if payload.sensitive_topics.is_empty() {
            // Legacy payloads had no classification. Re-run the local guard when
            // they are read so a pre-toggle health/religion fact is not widened
            // into recall merely because it predates the field.
            payload.sensitive_topics = detect_sensitive_topics(&payload.content);
        }
        return payload;
    }
    MemoryPayload {
        content: text,
        when_to_use: None,
        provenance: MemoryProvenance::default(),
        sensitive_topics: detect_sensitive_topics(&String::from_utf8_lossy(plain)),
    }
}

pub(crate) fn encode_tags(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

pub(crate) fn decode_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

impl MemoryStore {
    pub(crate) fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        self.cipher.encrypt(plaintext)
    }

    pub(crate) fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        self.cipher.decrypt(nonce, ciphertext)
    }

    /// Raw encrypted+metadata row as read from SQL, before decryption.
    pub(crate) fn collect_rows(
        stmt: &mut rusqlite::Statement<'_>,
        params: impl rusqlite::Params,
    ) -> Result<Vec<EncryptedRow>> {
        let mapped = stmt.query_map(params, |row| {
            Ok(EncryptedRow {
                id: row.get(0)?,
                nonce: row.get(1)?,
                ciphertext: row.get(2)?,
                created_at: row.get(3)?,
                scope: row.get(4)?,
                scope_id: row.get(5)?,
                category: row.get(6)?,
                importance: row.get(7)?,
                tags: row.get(8)?,
                author_agent_id: row.get(9)?,
                updated_at: row.get(10)?,
                owner_user_id: row.get(11)?,
                lifecycle: row.get(12)?,
                supersedes_id: row.get(13)?,
                recall_count: row.get(14)?,
                last_recalled_at: row.get(15)?,
            })
        })?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row?);
        }
        Ok(out)
    }

    /// Decrypt a batch of rows, skipping any that fail to decrypt.
    pub(crate) fn decrypt_rows(&self, rows: Vec<EncryptedRow>) -> Vec<LongTermEntry> {
        let mut out = Vec::new();
        for r in rows {
            match self.decrypt(&r.nonce, &r.ciphertext) {
                Ok(plain) => {
                    let payload = decode_payload(&plain);
                    out.push(LongTermEntry {
                        id: r.id,
                        content: payload.content,
                        scope: MemoryScope::from_str(&r.scope),
                        scope_id: r.scope_id,
                        category: MemoryCategory::from_str(&r.category),
                        importance: r.importance,
                        when_to_use: payload.when_to_use,
                        tags: decode_tags(&r.tags),
                        author_agent_id: r.author_agent_id,
                        owner_user_id: r.owner_user_id,
                        provenance: payload.provenance,
                        sensitive_topics: payload.sensitive_topics,
                        lifecycle: MemoryLifecycle::from_str(&r.lifecycle),
                        supersedes_id: r.supersedes_id,
                        recall_count: r.recall_count.unwrap_or(0),
                        last_recalled_at: r.last_recalled_at,
                        created_at: r.created_at,
                        updated_at: if r.updated_at == 0 {
                            r.created_at
                        } else {
                            r.updated_at
                        },
                    });
                }
                Err(e) => tracing::warn!("skipping undecryptable memory entry {}: {e}", r.id),
            }
        }
        out
    }
}

/// An encrypted row + its plaintext metadata, straight from SQL.
pub(crate) struct EncryptedRow {
    id: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    created_at: i64,
    scope: String,
    scope_id: Option<String>,
    category: String,
    importance: i32,
    tags: String,
    author_agent_id: Option<String>,
    updated_at: i64,
    owner_user_id: Option<String>,
    lifecycle: String,
    supersedes_id: Option<String>,
    recall_count: Option<i64>,
    last_recalled_at: Option<i64>,
}
