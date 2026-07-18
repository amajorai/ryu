//! SQLite-backed persistence for self-host inboxes (`~/.ryu/mail.db`).
//!
//! Tracer copy of `apps/core/src/mail/store.rs` — verbatim except it resolves its
//! data dir via the inlined `crate::paths::ryu_dir` (same path Core used), so the
//! sidecar OWNS the store and Core no longer opens it. Attachment bytes live on
//! the filesystem under `~/.ryu/mail-blobs/`, keyed by sha256.

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{AttachmentMeta, EmailMessage, Inbox, InboxProvider};

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("mail.db")
}

fn blobs_dir() -> PathBuf {
    crate::paths::ryu_dir().join("mail-blobs")
}

/// SQLite-backed inbox store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct MailStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<EmailMessage>,
}

/// A raw attachment to persist (bytes hashed + written to a blob file).
pub struct RawAttachment {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl MailStore {
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        std::fs::create_dir_all(blobs_dir()).ok();
        let conn = Connection::open(&path)
            .with_context(|| format!("opening mail db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let (tx, _rx) = broadcast::channel(128);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS inboxes (
                 id             TEXT PRIMARY KEY,
                 name           TEXT NOT NULL,
                 address        TEXT NOT NULL,
                 provider       TEXT NOT NULL,
                 inbound_secret TEXT NOT NULL,
                 created_at     TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
                 id                  TEXT PRIMARY KEY,
                 inbox_id            TEXT NOT NULL,
                 direction           TEXT NOT NULL,
                 message_id          TEXT NOT NULL,
                 in_reply_to         TEXT,
                 from_addr           TEXT NOT NULL,
                 to_addrs            TEXT NOT NULL,
                 cc_addrs            TEXT NOT NULL,
                 subject             TEXT NOT NULL,
                 text                TEXT,
                 html                TEXT,
                 provider_message_id TEXT,
                 created_at          TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_messages_inbox
                 ON messages(inbox_id, created_at DESC);
             CREATE TABLE IF NOT EXISTS attachments (
                 id           TEXT PRIMARY KEY,
                 message_id   TEXT NOT NULL,
                 filename     TEXT NOT NULL,
                 content_type TEXT NOT NULL,
                 size         INTEGER NOT NULL,
                 blob_path    TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_attachments_message
                 ON attachments(message_id);",
        )
        .context("initializing mail schema")?;
        Ok(())
    }

    /// Subscribe to freshly-stored messages (SSE fan-out).
    ///
    /// NOTE (tracer): the mail contract surface (`api::public_routes` +
    /// `protected_routes`) has no SSE endpoint, so this broadcast channel compiles
    /// but is inert in the sidecar. The live-mail fan-out lived outside
    /// `mail/api.rs` in Core and is out of scope for the tracer.
    #[allow(dead_code)]
    pub fn subscribe(&self) -> broadcast::Receiver<EmailMessage> {
        self.tx.subscribe()
    }

    // ── Inboxes ─────────────────────────────────────────────────────────────

    pub async fn create_inbox(
        &self,
        name: &str,
        address: &str,
        provider: InboxProvider,
    ) -> Result<Inbox> {
        let inbox = Inbox {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            address: address.to_string(),
            provider,
            inbound_secret: uuid::Uuid::new_v4().simple().to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO inboxes (id, name, address, provider, inbound_secret, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                inbox.id,
                inbox.name,
                inbox.address,
                inbox.provider.as_str(),
                inbox.inbound_secret,
                inbox.created_at,
            ],
        )
        .context("inserting inbox")?;
        Ok(inbox)
    }

    pub async fn list_inboxes(&self) -> Result<Vec<Inbox>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, name, address, provider, inbound_secret, created_at
             FROM inboxes ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Inbox {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    address: r.get(2)?,
                    provider: InboxProvider::from_str(&r.get::<_, String>(3)?),
                    inbound_secret: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub async fn get_inbox(&self, id: &str) -> Result<Option<Inbox>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, name, address, provider, inbound_secret, created_at
                 FROM inboxes WHERE id = ?1",
                params![id],
                |r| {
                    Ok(Inbox {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        address: r.get(2)?,
                        provider: InboxProvider::from_str(&r.get::<_, String>(3)?),
                        inbound_secret: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub async fn rename_inbox(&self, id: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE inboxes SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        Ok(())
    }

    /// Rotate the inbound HMAC secret; returns the new value.
    pub async fn rotate_secret(&self, id: &str) -> Result<String> {
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE inboxes SET inbound_secret = ?2 WHERE id = ?1",
            params![id, secret],
        )?;
        Ok(secret)
    }

    pub async fn delete_inbox(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM inboxes WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM messages WHERE inbox_id = ?1", params![id])?;
        Ok(())
    }

    // ── Messages ────────────────────────────────────────────────────────────

    /// Persist a message + its attachment blobs, broadcast it, return the stored
    /// row (with attachment metadata).
    pub async fn insert_message(
        &self,
        mut msg: EmailMessage,
        attachments: Vec<RawAttachment>,
    ) -> Result<EmailMessage> {
        // Write blobs first (outside the DB lock) so a big attachment does not
        // hold the connection.
        let mut metas: Vec<(AttachmentMeta, String)> = Vec::new();
        let dir = blobs_dir();
        std::fs::create_dir_all(&dir).ok();
        for att in attachments {
            let mut hasher = Sha256::new();
            hasher.update(&att.bytes);
            let hash = format!("{:x}", hasher.finalize());
            let rel = hash.clone();
            let path = dir.join(&rel);
            if !path.exists() {
                std::fs::write(&path, &att.bytes)
                    .with_context(|| format!("writing blob {}", path.display()))?;
            }
            metas.push((
                AttachmentMeta {
                    id: uuid::Uuid::new_v4().to_string(),
                    filename: att.filename,
                    content_type: att.content_type,
                    size: att.bytes.len() as u64,
                },
                rel,
            ));
        }

        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO messages (id, inbox_id, direction, message_id, in_reply_to,
                 from_addr, to_addrs, cc_addrs, subject, text, html,
                 provider_message_id, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                msg.id,
                msg.inbox_id,
                msg.direction,
                msg.message_id,
                msg.in_reply_to,
                msg.from_addr,
                serde_json::to_string(&msg.to_addrs).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&msg.cc_addrs).unwrap_or_else(|_| "[]".into()),
                msg.subject,
                msg.text,
                msg.html,
                msg.provider_message_id,
                msg.created_at,
            ],
        )
        .context("inserting message")?;
        for (meta, rel) in &metas {
            conn.execute(
                "INSERT INTO attachments (id, message_id, filename, content_type, size, blob_path)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![meta.id, msg.id, meta.filename, meta.content_type, meta.size as i64, rel],
            )
            .context("inserting attachment")?;
        }
        drop(conn);

        msg.attachments = metas.into_iter().map(|(m, _)| m).collect();
        let _ = self.tx.send(msg.clone());
        Ok(msg)
    }

    pub async fn list_messages(&self, inbox_id: &str, limit: u32) -> Result<Vec<EmailMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, inbox_id, direction, message_id, in_reply_to, from_addr,
                 to_addrs, cc_addrs, subject, text, html, provider_message_id, created_at
             FROM messages WHERE inbox_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![inbox_id, limit], row_to_message)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut out = Vec::with_capacity(rows.len());
        for mut m in rows {
            m.attachments = load_attachments(&conn, &m.id)?;
            out.push(m);
        }
        Ok(out)
    }

    pub async fn get_message(&self, id: &str) -> Result<Option<EmailMessage>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, inbox_id, direction, message_id, in_reply_to, from_addr,
                     to_addrs, cc_addrs, subject, text, html, provider_message_id, created_at
                 FROM messages WHERE id = ?1",
                params![id],
                row_to_message,
            )
            .optional()?;
        match row {
            Some(mut m) => {
                m.attachments = load_attachments(&conn, &m.id)?;
                Ok(Some(m))
            }
            None => Ok(None),
        }
    }

    /// Resolve an attachment's metadata + absolute blob path (for the download
    /// route). Returns `None` if the attachment id is unknown.
    pub async fn attachment_path(
        &self,
        att_id: &str,
    ) -> Result<Option<(AttachmentMeta, PathBuf)>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, filename, content_type, size, blob_path
                 FROM attachments WHERE id = ?1",
                params![att_id],
                |r| {
                    Ok((
                        AttachmentMeta {
                            id: r.get(0)?,
                            filename: r.get(1)?,
                            content_type: r.get(2)?,
                            size: r.get::<_, i64>(3)? as u64,
                        },
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(meta, rel)| (meta, blobs_dir().join(rel))))
    }
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<EmailMessage> {
    let to_json: String = r.get(6)?;
    let cc_json: String = r.get(7)?;
    Ok(EmailMessage {
        id: r.get(0)?,
        inbox_id: r.get(1)?,
        direction: r.get(2)?,
        message_id: r.get(3)?,
        in_reply_to: r.get(4)?,
        from_addr: r.get(5)?,
        to_addrs: serde_json::from_str(&to_json).unwrap_or_default(),
        cc_addrs: serde_json::from_str(&cc_json).unwrap_or_default(),
        subject: r.get(8)?,
        text: r.get(9)?,
        html: r.get(10)?,
        provider_message_id: r.get(11)?,
        attachments: Vec::new(),
        created_at: r.get(12)?,
    })
}

fn load_attachments(conn: &Connection, message_id: &str) -> Result<Vec<AttachmentMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, content_type, size FROM attachments WHERE message_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![message_id], |r| {
            Ok(AttachmentMeta {
                id: r.get(0)?,
                filename: r.get(1)?,
                content_type: r.get(2)?,
                size: r.get::<_, i64>(3)? as u64,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
