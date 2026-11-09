//! Opening the keyword index: schema creation, row-format and key-check
//! rebuilds, and removal of a plaintext index written by an older build.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::BlindIndex;

use super::{MessageFtsIndex, DOC_FORMAT, KEY_CHECK_INPUT};

impl MessageFtsIndex {
    pub(super) fn init_schema(conn: &Connection) -> Result<()> {
        // Deleted rows are zeroed, not left in free pages.
        ryu_crypto::content_sqlite::enable_secure_delete(conn)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .context("initializing fts_meta")?;
        // An index written in an earlier row format is dropped and rebuilt
        // lazily: the first stored token lists followed the alphabetical order
        // of the underlying words (a vocabulary ordering), and the contentless
        // one that followed could only tombstone a deleted row, leaving its
        // postings in the segment b-tree.
        let format: Option<String> = conn
            .query_row(
                "SELECT value FROM fts_meta WHERE key = 'doc_format'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let rebuilt = format.as_deref() != Some(DOC_FORMAT);
        let had_table = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = 'message_terms'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if rebuilt {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS message_terms;
                 DROP TABLE IF EXISTS fts_messages;",
            )
            .context("dropping the message_terms table of an older row format")?;
            tx.execute(
                "INSERT INTO fts_meta (key, value) VALUES ('doc_format', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![DOC_FORMAT],
            )?;
            tx.commit()?;
        }
        // `message_id` is a plain TEXT column, NOT a foreign key: `messages` lives
        // in a separate database file (`conversations.db`). Rows are removed with
        // their conversation (`delete_conversation`). `terms` is the row's
        // de-duplicated token list sorted by token value: exactly what the
        // inverted index already maps (token -> rowids), kept so a delete can
        // remove the row's postings.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS fts_messages (
                 rowid           INTEGER PRIMARY KEY,
                 message_id      TEXT UNIQUE NOT NULL,
                 conversation_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 terms           TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_fts_messages_conversation
                 ON fts_messages(conversation_id);",
        )
        .context("initializing fts_messages schema")?;
        // Keyed term tokens are 32 lowercase hex characters, so the `ascii`
        // tokenizer keeps each one whole; `detail=none` stores no positions
        // (phrase and NEAR queries are meaningless over sorted tokens anyway).
        // External content (`fts_messages.terms`) lets FTS5 secure-delete read a
        // deleted row's tokens and remove its postings at delete time, instead
        // of a contentless tombstone that leaves them until a merge.
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS message_terms
                 USING fts5(terms, content='fts_messages', content_rowid='rowid',
                            detail=none, tokenize='ascii');",
        )
        .context("initializing message_terms FTS5 table (is FTS5 compiled in?)")?;
        if rebuilt || !had_table {
            conn.execute(
                "INSERT INTO message_terms (message_terms, rank) VALUES ('secure-delete', 1)",
                [],
            )
            .context("enabling FTS5 secure-delete on message_terms")?;
        }
        if had_table && rebuilt {
            tracing::info!(
                "message keyword index: rebuilt in the current row format; it is refilled \
                 from the sealed messages on the next search"
            );
            // secure_delete zeroed the dropped pages; fold the WAL back so the
            // old rows do not linger in it.
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(())
    }

    /// Record the key check token on first use; when the recorded one differs
    /// (the master key changed), the tokens are useless: empty the index so it
    /// is rebuilt lazily under the current key.
    pub(super) fn check_key(conn: &Connection, terms: &BlindIndex) -> Result<()> {
        let current = terms.term_token(KEY_CHECK_INPUT);
        let recorded: Option<String> = conn
            .query_row(
                "SELECT value FROM fts_meta WHERE key = 'key_check'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if recorded.as_deref() == Some(current.as_str()) {
            return Ok(());
        }
        if recorded.is_some() {
            tracing::warn!(
                "message keyword index was built under a different key; clearing it for a \
                 rebuild"
            );
        }
        let tx = conn.unchecked_transaction()?;
        // `delete-all` drops every segment (a row DELETE would leave the old
        // key's postings behind in a contentless index).
        tx.execute(
            "INSERT INTO message_terms (message_terms) VALUES ('delete-all')",
            [],
        )?;
        tx.execute("DELETE FROM fts_messages", [])?;
        tx.execute(
            "INSERT INTO fts_meta (key, value) VALUES ('key_check', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![current],
        )?;
        tx.commit()?;
        if recorded.is_some() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(())
    }
}

/// Whether the file at `path` holds the plaintext `message_fts` table an older
/// build wrote.
pub(super) fn is_legacy_plaintext_index(path: &Path) -> Result<bool> {
    let conn = Connection::open(path)
        .with_context(|| format!("inspecting message-fts db {}", path.display()))?;
    let legacy: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = 'message_fts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(legacy.is_some())
}

/// Delete a database file and its WAL/SHM side files.
pub(super) fn remove_db_files(path: &Path) -> Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let candidate = PathBuf::from(name);
        match std::fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("removing {}", candidate.display()));
            }
        }
    }
    Ok(())
}
