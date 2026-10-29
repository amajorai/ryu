//! Per-value content sealing for `experience.db` (encryption at rest, phase 2).
//!
//! Every connection turns on `secure_delete`, checks the store's recorded key,
//! seals legacy plaintext rows once (cursor migration, idempotent, resumable)
//! and scrubs the freed pages. Writes refuse when the store was sealed under a
//! key this process does not hold; reads skip and count rows that do not open.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::Result;
use rusqlite::Connection;
use ryu_crypto::content_sqlite::{self, states, ColumnPlan, StoreKeyState};
use ryu_crypto::{ContentCipher, ContentContext};

/// The registered store name (KDF input; never rename).
pub(crate) const STORE: &str = "experience.db";

#[derive(Clone)]
pub(crate) struct StoreSeal {
    cipher: ContentCipher,
    writable: bool,
    unreadable: Arc<AtomicU64>,
}

impl StoreSeal {
    /// Prepare `conn` for sealed use and migrate `plans` (see the module docs).
    pub(crate) fn prepare(
        conn: &mut Connection,
        db_path: Option<&Path>,
        cipher: ContentCipher,
        plans: &[ColumnPlan],
    ) -> Result<Self> {
        content_sqlite::enable_secure_delete(conn)?;
        let state = content_sqlite::check_store_key(conn, &cipher)?;
        let writable = state.writable();
        if writable {
            if state == StoreKeyState::Retired {
                content_sqlite::reset_items(conn, cipher.store(), plans)?;
            }
            let report = content_sqlite::migrate_columns(conn, &cipher, plans)?;
            // `migrate_columns` moves a retired store's key record itself, once every
            // item sealed with no unreadable value; never move it unconditionally.
            if let Some(path) = db_path {
                // A failed scrub stays owed (`vacuum_pending`) and is retried at
                // the next start; it never blocks the store from serving.
                if report.sealed > 0 {
                    let _ = content_sqlite::finish_store(conn, path, cipher.store());
                } else if content_sqlite::read_store_record(conn, cipher.store())?
                    .is_some_and(|record| record.state == states::VACUUM_PENDING)
                {
                    // Core's boot path: a store over `VACUUM_NOW_MAX_BYTES` only
                    // gets its freelist scrub here; the owner hands the
                    // `VACUUM` to the background worker (`defer_compaction`).
                    let _ = content_sqlite::run_pending_vacuum_gated(conn, path, cipher.store());
                }
            }
        }
        Ok(Self {
            cipher,
            writable,
            unreadable: Arc::new(AtomicU64::new(0)),
        })
    }

    pub(crate) fn seal(&self, plaintext: &str, context: &ContentContext) -> Result<String> {
        if !self.writable {
            return Err(content_sqlite::mismatch_error(self.cipher.store()));
        }
        self.cipher.seal_text(plaintext, context)
    }

    pub(crate) fn open(&self, stored: &str, context: &ContentContext) -> Result<String> {
        Ok(self.cipher.open_text(stored, context)?.value)
    }

    /// Call right after wrapping the store's connection: when the store still
    /// owes its compaction (too large for the boot path, see [`Self::prepare`]),
    /// hand it to the background compaction worker. The job runs under the
    /// store's connection lock, so requests wait for it instead of the boot.
    pub(crate) fn defer_compaction(
        &self,
        conn: &Arc<tokio::sync::Mutex<Connection>>,
        db_path: Option<&Path>,
    ) {
        let Some(path) = db_path else {
            return;
        };
        if !self.writable {
            return;
        }
        let store = self.cipher.store();
        let owed = conn
            .try_lock()
            .map(|conn| content_sqlite::compaction_owed(&conn, store).unwrap_or(false))
            .unwrap_or(false);
        if owed {
            content_sqlite::defer_compaction_with(store, path, conn, |owner, run| {
                run(&*owner.blocking_lock());
            });
        }
    }

    pub(crate) fn count_unreadable(&self, skipped: u64) {
        if skipped > 0 {
            self.unreadable.fetch_add(skipped, Ordering::Relaxed);
        }
    }

    pub(crate) fn unreadable(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }
}
