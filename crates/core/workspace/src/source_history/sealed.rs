//! The sealed SQLite history store.

use super::*;

pub(super) struct SealedHistory {
    pub(super) conn: Connection,
    pub(super) cipher: ContentCipher,
    pub(super) blind: BlindIndex,
    pub(super) writable: bool,
    pub(super) retention: Retention,
}

/// A row as stored.
pub(super) struct StoredRow {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) created_at: i64,
    pub(super) label: Option<String>,
    pub(super) content: Vec<u8>,
    pub(super) content_bi: String,
}

pub(super) fn label_context(id: &str, path: &str) -> ContentContext {
    ContentContext::new("versions.label")
        .with("id", id)
        .with("path", path)
}

pub(super) fn content_context(id: &str, path: &str) -> ContentContext {
    ContentContext::new("versions.content")
        .with("id", id)
        .with("path", path)
}

impl SealedHistory {
    pub(super) fn open(conn: Connection, retention: Retention) -> std::io::Result<Self> {
        let cipher = ryu_crypto::content_cipher(SOURCE_HISTORY_STORE)
            .map_err(|error| io_error(format!("no key for source history: {error:#}")))?;
        let blind = ryu_crypto::blind_index(SOURCE_HISTORY_STORE, "content")
            .map_err(|error| io_error(format!("no key for source history: {error:#}")))?;
        Self::with_keys(conn, cipher, blind, retention)
    }

    pub(super) fn with_keys(
        conn: Connection,
        cipher: ContentCipher,
        blind: BlindIndex,
        retention: Retention,
    ) -> std::io::Result<Self> {
        let state = ryu_crypto::content_sqlite::check_store_key(&conn, &cipher)
            .map_err(|error| io_error(format!("{error:#}")))?;
        Ok(Self {
            conn,
            cipher,
            blind,
            writable: state.writable(),
            retention,
        })
    }

    pub(super) fn require_writable(&self) -> std::io::Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(io_error(
                "source history was sealed under a different key; writes are refused \
                 (run `ryu-core keys status`)",
            ))
        }
    }

    pub(super) fn seal_row(
        &self,
        id: &str,
        path: &str,
        label: &str,
        content: &str,
    ) -> std::io::Result<(String, Vec<u8>, String)> {
        let compressed = zstd::bulk::compress(content.as_bytes(), ZSTD_LEVEL)?;
        let sealed_content = self
            .cipher
            .seal_bytes(&compressed, &content_context(id, path))
            .map_err(|error| io_error(format!("sealing a source version: {error:#}")))?;
        let sealed_label = self
            .cipher
            .seal_text(label, &label_context(id, path))
            .map_err(|error| io_error(format!("sealing a source label: {error:#}")))?;
        Ok((sealed_label, sealed_content, self.blind.token(content)))
    }

    pub(super) fn insert(
        &self,
        id: &str,
        path: &str,
        created_at: i64,
        label: &str,
        content: &str,
    ) -> std::io::Result<bool> {
        let (sealed_label, sealed_content, token) = self.seal_row(id, path, label, content)?;
        let inserted = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO versions (id, path, created_at, label, content, content_bi)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, path, created_at, sealed_label, sealed_content, token],
            )
            .map_err(sql_error)?;
        Ok(inserted > 0)
    }

    pub(super) fn open_content(&self, row: &StoredRow) -> std::io::Result<String> {
        let opened = self
            .cipher
            .open_bytes(&row.content, &content_context(&row.id, &row.path))
            .map_err(|error| {
                io_error(format!(
                    "source version {} does not open: {error:#}",
                    row.id
                ))
            })?;
        let plain = zstd::stream::decode_all(opened.value.as_slice())?;
        String::from_utf8(plain)
            .map_err(|error| io_error(format!("source version is not UTF-8: {error}")))
    }

    pub(super) fn open_label(&self, row: &StoredRow) -> std::io::Result<Option<String>> {
        row.label
            .as_deref()
            .map(|stored| {
                self.cipher
                    .open_text(stored, &label_context(&row.id, &row.path))
                    .map(|opened| opened.value)
                    .map_err(|error| {
                        io_error(format!("source label {} does not open: {error:#}", row.id))
                    })
            })
            .transpose()
    }

    pub(super) fn rows(
        &self,
        sql: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> std::io::Result<Vec<StoredRow>> {
        let mut statement = self.conn.prepare(sql).map_err(sql_error)?;
        let rows = statement
            .query_map(args, |row| {
                Ok(StoredRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    created_at: row.get(2)?,
                    label: row.get(3)?,
                    content: row.get(4)?,
                    content_bi: row.get(5)?,
                })
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        Ok(rows)
    }

    pub(super) fn latest(&self, path: &str) -> std::io::Result<Option<StoredRow>> {
        Ok(self
            .rows(
                "SELECT id, path, created_at, label, content, content_bi FROM versions
                 WHERE path = ?1 ORDER BY created_at DESC, seq DESC LIMIT 1",
                &[&path],
            )?
            .into_iter()
            .next())
    }

    pub(super) fn version(&self, row: &StoredRow) -> std::io::Result<SourceHistoryVersion> {
        Ok(SourceHistoryVersion {
            created_at: row.created_at,
            id: row.id.clone(),
            label: self.open_label(row)?,
        })
    }

    pub(super) fn checkpoint(
        &self,
        path: &str,
        content: &str,
        label: Option<&str>,
    ) -> std::io::Result<SourceHistoryVersion> {
        self.require_writable()?;
        let has_label = label.is_some_and(|value| !value.trim().is_empty());
        if !has_label {
            if let Some(latest) = self.latest(path)? {
                if latest.content_bi == self.blind.token(content)
                    && self.open_content(&latest)? == content
                {
                    return self.version(&latest);
                }
            }
        }
        let id = new_version_id();
        let created_at = now_ms();
        let subject = commit_subject(label);
        self.insert(&id, path, created_at, &subject, content)?;
        self.prune(path)?;
        Ok(SourceHistoryVersion {
            created_at,
            id,
            label: Some(subject),
        })
    }

    pub(super) fn import(
        &self,
        path: &str,
        id: Option<&str>,
        created_at: i64,
        label: Option<&str>,
        content: &str,
    ) -> std::io::Result<SourceHistoryVersion> {
        self.require_writable()?;
        let id = id
            .map(|value| value.replace('-', "").to_ascii_lowercase())
            .filter(|value| validate_version_id(value).is_ok())
            .unwrap_or_else(new_version_id);
        let subject = commit_subject(label);
        self.insert(&id, path, created_at, &subject, content)?;
        // Verify whatever row now holds `(id, path)`: the one just written, or
        // an earlier import of the same version.
        let rows = self.rows(
            "SELECT id, path, created_at, label, content, content_bi FROM versions
             WHERE id = ?1 AND path = ?2",
            &[&id, &path],
        )?;
        let row = rows
            .first()
            .ok_or_else(|| io_error(format!("imported version {id} is missing")))?;
        if self.open_content(row)? != content {
            return Err(io_error(format!(
                "imported version {id} does not match its source"
            )));
        }
        let version = self.version(row)?;
        self.prune(path)?;
        Ok(version)
    }

    pub(super) fn list(
        &self,
        path: &str,
        limit: usize,
    ) -> std::io::Result<Vec<SourceHistoryVersion>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = self.rows(
            "SELECT id, path, created_at, label, X'' AS content, content_bi FROM versions
             WHERE path = ?1 ORDER BY created_at DESC, seq DESC LIMIT ?2",
            &[&path, &limit],
        )?;
        let mut versions = Vec::with_capacity(rows.len());
        let mut unreadable = 0usize;
        for row in &rows {
            match self.version(row) {
                Ok(version) => versions.push(version),
                Err(_) => unreadable += 1,
            }
        }
        if unreadable > 0 {
            tracing::warn!(
                path,
                unreadable,
                "source history skipped versions whose label does not open"
            );
        }
        Ok(versions)
    }

    pub(super) fn read(&self, path: &str, version_id: &str) -> std::io::Result<Option<String>> {
        let prefix = format!("{}%", version_id.to_ascii_lowercase());
        let rows = self.rows(
            "SELECT id, path, created_at, label, content, content_bi FROM versions
             WHERE path = ?1 AND id LIKE ?2 LIMIT 2",
            &[&path, &prefix],
        )?;
        match rows.as_slice() {
            [row] => self.open_content(row).map(Some),
            // Missing, or an ambiguous prefix (Git refuses those too).
            _ => Ok(None),
        }
    }

    /// Apply the retention policy to one path. Deletes run under
    /// `secure_delete`, so pruned ciphertext is zeroed in place.
    pub(super) fn prune(&self, path: &str) -> std::io::Result<()> {
        let cutoff = now_ms().saturating_sub(self.retention.max_age_days.saturating_mul(DAY_MS));
        let keep_newest = i64::try_from(self.retention.keep_newest).unwrap_or(i64::MAX);
        let keep_after_age = i64::try_from(self.retention.keep_after_age).unwrap_or(i64::MAX);
        self.conn
            .execute(
                "DELETE FROM versions WHERE seq IN (
                    SELECT seq FROM (
                        SELECT seq, created_at,
                               ROW_NUMBER() OVER (ORDER BY created_at DESC, seq DESC) AS rank
                        FROM versions WHERE path = ?1
                    )
                    WHERE rank > ?2 OR (rank > ?3 AND created_at < ?4)
                )",
                params![path, keep_newest, keep_after_age, cutoff],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub(super) fn prune_all(&self) -> std::io::Result<()> {
        let mut statement = self
            .conn
            .prepare("SELECT DISTINCT path FROM versions")
            .map_err(sql_error)?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        drop(statement);
        for path in paths {
            self.prune(&path)?;
        }
        Ok(())
    }

    /// Import the commits reachable from `head` and not from `since` (oldest
    /// first). Idempotent: rows already present are kept as they are. Returns
    /// what was expected, for [`Self::verify`].
    pub(super) fn import_commits(
        &self,
        git: &GitHistory<'_>,
        since: Option<&str>,
        head: &str,
    ) -> std::io::Result<Vec<ImportedVersion>> {
        self.require_writable()?;
        let commits = git.commits(since, head)?;
        let mut imported = Vec::new();
        let transaction = self.conn.unchecked_transaction().map_err(sql_error)?;
        for commit in commits {
            for path in &commit.paths {
                if validate_relative_path(path).is_err() {
                    continue;
                }
                let Some(content) = git.read_for_import(path, &commit.id)? else {
                    // Deleted at this commit: nothing to keep.
                    continue;
                };
                self.insert(
                    &commit.id,
                    path,
                    commit.created_at,
                    &commit.subject,
                    &content,
                )?;
                imported.push(ImportedVersion {
                    id: commit.id.clone(),
                    path: path.clone(),
                    digest: ryu_crypto::sha256_hex(content.as_bytes()),
                });
            }
        }
        transaction.commit().map_err(sql_error)?;
        Ok(imported)
    }

    /// Every imported version is present and opens to the bytes Git held.
    pub(super) fn verify(&self, imported: &[ImportedVersion]) -> std::io::Result<()> {
        for expected in imported {
            let rows = self.rows(
                "SELECT id, path, created_at, label, content, content_bi FROM versions
                 WHERE id = ?1 AND path = ?2",
                &[&expected.id, &expected.path],
            )?;
            let row = rows
                .first()
                .ok_or_else(|| io_error(format!("imported version {} is missing", expected.id)))?;
            let content = self.open_content(row)?;
            self.open_label(row)?;
            if ryu_crypto::sha256_hex(content.as_bytes()) != expected.digest {
                return Err(io_error(format!(
                    "imported version {} does not match the Git history",
                    expected.id
                )));
            }
        }
        Ok(())
    }
}

pub(super) struct ImportedVersion {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) digest: String,
}
