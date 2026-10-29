//! Shared sealing glue for Core's record stores (encryption at rest, phase 2):
//! `approvals.db`, `safe-actions.db`, `prompt-evals.db` and `agents.db`. It sits
//! next to the activity glue only because it has no better home inside Core;
//! the stores use it the same way the extracted `ryu-activity` crate does.
//!
//! [`StoreSeal::prepare`] turns on `secure_delete`, checks the store's recorded
//! key check value, seals legacy plaintext once (cursor migration: idempotent,
//! resumable, compare-and-swap) and scrubs the freed pages. A store sealed under
//! a key this process does not hold is left untouched and refuses writes. Reads
//! that list rows skip and count a value that does not open; a read by id
//! returns the error instead.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::Connection;
use ryu_crypto::content_sqlite::{self, states, ColumnPlan, StoreKeyState};
use ryu_crypto::{ContentCipher, ContentContext};

/// The content cipher of a Core store, after making sure the crypto host is
/// installed (idempotent). Fails closed without a key.
pub fn core_cipher(store: &str) -> Result<ContentCipher> {
    crate::crypto_host::install();
    ryu_crypto::content_cipher(store).with_context(|| format!("resolving the {store} content key"))
}

/// One store's sealing state. Cheap to clone.
#[derive(Clone)]
pub struct StoreSeal {
    cipher: ContentCipher,
    writable: bool,
    unreadable: Arc<AtomicU64>,
}

impl std::fmt::Debug for StoreSeal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreSeal")
            .field("store", &self.cipher.store())
            .field("writable", &self.writable)
            .finish_non_exhaustive()
    }
}

impl StoreSeal {
    /// Prepare `conn` (the store's only connection while this runs) and seal the
    /// legacy plaintext of `plans`. `db_path` is `None` for an in-memory store
    /// (nothing to scrub). Migration runs synchronously: these stores are small.
    pub fn prepare(
        conn: &mut Connection,
        db_path: Option<&Path>,
        cipher: ContentCipher,
        plans: &[ColumnPlan],
    ) -> Result<Self> {
        content_sqlite::enable_secure_delete(conn)?;
        let store = cipher.store().to_owned();
        let state = content_sqlite::check_store_key(conn, &cipher)?;
        let writable = state.writable();
        if !writable {
            tracing::error!(
                store = %store,
                "content store is sealed under a key this process does not hold; writes refused, \
                 data left untouched (run `ryu-core keys status`)"
            );
        } else {
            if state == StoreKeyState::Retired {
                content_sqlite::reset_items(conn, &store, plans)?;
            }
            let report = content_sqlite::migrate_columns(conn, &cipher, plans)?;
            // `migrate_columns` moves a retired store's key record itself, once every
            // item sealed with no unreadable value; never move it unconditionally.
            if report.sealed > 0 {
                tracing::info!(store = %store, sealed = report.sealed, "sealed legacy plaintext rows");
            }
            if let Some(path) = db_path {
                // A scrub that cannot finish stays owed (`vacuum_pending`) and is
                // retried at the next start; it never blocks the store.
                let scrub = if report.sealed > 0 {
                    content_sqlite::finish_store(conn, path, &store).map(|_| ())
                } else if content_sqlite::read_store_record(conn, &store)?
                    .is_some_and(|record| record.state == states::VACUUM_PENDING)
                {
                    // Core's boot path: a store over `VACUUM_NOW_MAX_BYTES` only
                    // gets its freelist scrub here; the owner hands the
                    // `VACUUM` to the background worker (`defer_compaction`).
                    content_sqlite::run_pending_vacuum_gated(conn, path, &store).map(|_| ())
                } else {
                    Ok(())
                };
                if let Err(error) = scrub {
                    tracing::warn!(store = %store, error = %error, "content store scrub deferred");
                }
            }
        }
        Ok(Self {
            cipher,
            writable,
            unreadable: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Scrub plaintext a store's own extra migration step freed (for a table
    /// whose key is not a single column, migrated outside `migrate_columns`).
    /// Failures stay owed (`vacuum_pending`) and are retried at the next start.
    pub fn finish(&self, conn: &Connection, db_path: Option<&Path>) {
        let Some(path) = db_path else {
            return;
        };
        let store = self.cipher.store();
        if let Err(error) = content_sqlite::finish_store(conn, path, store) {
            tracing::warn!(store = %store, error = %error, "content store scrub deferred");
        }
    }

    /// Seal one value. Refused when the store is sealed under another key.
    pub fn seal(&self, plaintext: &str, context: &ContentContext) -> Result<String> {
        if !self.writable {
            return Err(content_sqlite::mismatch_error(self.cipher.store()));
        }
        self.cipher.seal_text(plaintext, context)
    }

    /// Seal an optional value (`None` stays `None`).
    pub fn seal_opt(
        &self,
        plaintext: Option<&str>,
        context: &ContentContext,
    ) -> Result<Option<String>> {
        plaintext.map(|value| self.seal(value, context)).transpose()
    }

    /// Open one stored value (sealed or legacy plaintext).
    pub fn open(&self, stored: &str, context: &ContentContext) -> Result<String> {
        Ok(self
            .cipher
            .open_text(stored, context)
            .with_context(|| format!("opening a sealed {} value", self.cipher.store()))?
            .value)
    }

    /// The replacement for one stored value that is legacy plaintext or sealed
    /// under a retired key (`Some(resealed)`), or `None` when it is already
    /// sealed under the current key (or empty). Errors when it does not open.
    /// Custom migrations walk every row through this, not only rows without
    /// the envelope prefix, so a key adoption also reseals them.
    pub fn reseal_if_needed(
        &self,
        stored: &str,
        context: &ContentContext,
    ) -> Result<Option<String>> {
        let opened = self
            .cipher
            .open_text(stored, context)
            .with_context(|| format!("opening a sealed {} value", self.cipher.store()))?;
        if !opened.needs_reseal {
            return Ok(None);
        }
        self.seal(&opened.value, context).map(Some)
    }

    /// Open an optional stored value.
    pub fn open_opt(
        &self,
        stored: Option<&str>,
        context: &ContentContext,
    ) -> Result<Option<String>> {
        stored.map(|value| self.open(value, context)).transpose()
    }

    /// Record rows a list read skipped, logging at `warn` with the counts.
    pub fn count_unreadable(&self, skipped: u64) {
        if skipped == 0 {
            return;
        }
        let total = self.unreadable.fetch_add(skipped, Ordering::Relaxed) + skipped;
        tracing::warn!(
            store = %self.cipher.store(),
            skipped,
            total_unreadable = total,
            "skipped stored rows that do not open"
        );
    }

    /// Rows skipped by list reads since the store opened (logged at `warn` by
    /// `count_unreadable`; surfaced by the store's owner where it has a health or
    /// API surface).
    pub fn unreadable(&self) -> u64 {
        self.unreadable.load(Ordering::Relaxed)
    }

    /// False when the store is sealed under a key this process does not hold.
    pub fn writable(&self) -> bool {
        self.writable
    }

    /// Call right after wrapping the store's connection: when the store still
    /// owes its compaction (too large for the boot path, see [`Self::prepare`]),
    /// hand it to the background compaction worker. The job runs under the
    /// store's connection lock, so requests wait for it instead of the boot.
    pub fn defer_compaction(
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
}
