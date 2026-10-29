//! Per-value content sealing for `collab.db` (encryption at rest, phase 2).
//!
//! * `doc_updates.bytes`: `RYU-CB01`, bound to `(doc_id, seq)`;
//! * `doc_snapshots.snapshot`: `RYU-CB01`, bound to `(doc_id, epoch)`;
//! * `doc_snapshots.materialized_source`: `encb:v1:`, bound to `(doc_id, epoch)`.
//!
//! `epoch` is the document epoch the snapshot row was written under, kept next
//! to it in `doc_snapshots.seal_epoch` (a reset advances the epoch and deletes
//! the row, so it is constant for a row's lifetime). State vectors, sequence
//! numbers, epochs and seed claims are metadata and stay clear.
//!
//! Legacy plaintext rows keep opening (reads accept both forms). They are sealed
//! by compaction (which rewrites the snapshot and prunes the log) and by a
//! background pass started when the store opens: a composite-cursor walk of
//! `doc_updates` plus [`content_sqlite::migrate_columns`] over the snapshot
//! columns, compare-and-swap updates, then the freed pages are scrubbed.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use ryu_crypto::content_sqlite::{self, states, ColumnPlan, KeyKind, StoreKeyState};
use ryu_crypto::{ContentCipher, ContentContext};

/// The registered store name (KDF input; never rename).
pub const STORE: &str = "collab.db";

const UPDATES_PURPOSE: &str = "doc_updates.bytes";
const SNAPSHOT_PURPOSE: &str = "doc_snapshots.snapshot";
const SOURCE_PURPOSE: &str = "doc_snapshots.materialized_source";

/// Rows per `doc_updates` migration batch (one write transaction each).
const UPDATES_BATCH: i64 = 500;

pub(crate) fn update_context(doc_id: &str, seq: i64) -> ContentContext {
    ContentContext::new(UPDATES_PURPOSE)
        .with("doc_id", doc_id)
        .with("seq", seq.to_string())
}

pub(crate) fn snapshot_context(doc_id: &str, epoch: &str) -> ContentContext {
    ContentContext::new(SNAPSHOT_PURPOSE)
        .with("doc_id", doc_id)
        .with("epoch", epoch)
}

pub(crate) fn source_context(doc_id: &str, epoch: &str) -> ContentContext {
    ContentContext::new(SOURCE_PURPOSE)
        .with("doc_id", doc_id)
        .with("epoch", epoch)
}

/// The snapshot-table columns handled by [`content_sqlite::migrate_columns`].
pub(crate) fn snapshot_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![
        ColumnPlan::blob("doc_snapshots", "snapshot", "doc_id", KeyKind::Text)?
            .with_context(&["seal_epoch"], |row| {
                snapshot_context(&row.key(), &row.text("seal_epoch"))
            })?,
        ColumnPlan::text(
            "doc_snapshots",
            "materialized_source",
            "doc_id",
            KeyKind::Text,
        )?
        .with_context(&["seal_epoch"], |row| {
            source_context(&row.key(), &row.text("seal_epoch"))
        })?,
    ])
}

/// What one migration pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Values sealed by this pass.
    pub sealed: u64,
    /// Values that did not open (left untouched).
    pub unreadable: u64,
}

/// Seal every legacy `doc_updates.bytes` value (every value when `walk_all`,
/// after a key rotation). Cursor batches over `(doc_id, seq)`, compare-and-swap
/// updates; idempotent and resumable. A row compaction pruned meanwhile is
/// simply gone.
fn migrate_updates(
    conn: &mut Connection,
    cipher: &ContentCipher,
    walk_all: bool,
) -> Result<MigrationReport> {
    let mut report = MigrationReport::default();
    // The magic is only a candidate filter (BLOB compared with a BLOB literal):
    // every candidate is opened and only values whose open reports
    // `needs_reseal` are sealed, so nothing is sealed twice.
    let filter = if walk_all {
        ""
    } else {
        "AND substr(bytes, 1, 8) IS NOT X'5259552D43423031'"
    };
    let select = format!(
        "SELECT doc_id, seq, bytes FROM doc_updates
         WHERE (doc_id, seq) > (?1, ?2) {filter}
         ORDER BY doc_id, seq LIMIT {UPDATES_BATCH}"
    );
    let mut cursor: (String, i64) = (String::new(), i64::MIN);
    let mut scrub_marked = false;
    loop {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let batch: Vec<(String, i64, Vec<u8>)> = {
            let mut statement = tx.prepare(&select)?;
            let rows = statement.query_map(params![cursor.0, cursor.1], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (doc_id, seq, bytes) in &batch {
            let context = update_context(doc_id, *seq);
            let opened = match cipher.open_bytes(bytes, &context) {
                Ok(opened) => opened,
                Err(error) if ryu_crypto::content::is_content_seal_error(&error) => {
                    report.unreadable += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if !opened.needs_reseal {
                continue;
            }
            let sealed = match cipher.seal_bytes(&opened.value, &context) {
                Ok(sealed) => sealed,
                Err(error) if ryu_crypto::content::is_content_seal_error(&error) => {
                    // Plaintext that starts with a Ryu magic cannot be sealed.
                    report.unreadable += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if !scrub_marked {
                mark_scrub_owed(&tx)?;
                scrub_marked = true;
            }
            report.sealed += tx.execute(
                "UPDATE doc_updates SET bytes = ?3 WHERE doc_id = ?1 AND seq = ?2 AND bytes IS ?4",
                params![doc_id, seq, sealed, bytes],
            )? as u64;
        }
        if let Some((doc_id, seq, _)) = batch.last() {
            cursor = (doc_id.clone(), *seq);
        }
        tx.commit()?;
        if (batch.len() as i64) < UPDATES_BATCH {
            break;
        }
    }
    Ok(report)
}

/// Record the scrub debt before the first cell is rewritten, so a crash before
/// `finish_store` leaves it owed (`vacuum_pending`).
fn mark_scrub_owed(conn: &Connection) -> Result<()> {
    conn.execute(
        &format!(
            "UPDATE {} SET state = ?3 WHERE store = ?1 AND item = ?2",
            content_sqlite::STATE_TABLE
        ),
        params![STORE, content_sqlite::STORE_ITEM, states::VACUUM_PENDING],
    )?;
    Ok(())
}

/// One full migration pass on its own connection (see the module docs).
/// `key_state` is what the store's open found.
///
/// `inline_vacuum` false (the background pass of a serving store) never runs
/// `VACUUM` next to request traffic: the freed pages are zeroed now and the
/// compaction is left `vacuum_pending` for the next start, before the store
/// serves requests.
pub(crate) fn migrate(
    conn: &mut Connection,
    db_path: Option<&Path>,
    cipher: &ContentCipher,
    key_state: &StoreKeyState,
    inline_vacuum: bool,
) -> Result<MigrationReport> {
    content_sqlite::enable_secure_delete(conn)?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    let retired = *key_state == StoreKeyState::Retired;
    let plans = snapshot_plans()?;
    if retired {
        content_sqlite::reset_items(conn, STORE, &plans)?;
    }
    let mut report = migrate_updates(conn, cipher, retired).context("sealing collab updates")?;
    let columns = content_sqlite::migrate_columns(conn, cipher, &plans)
        .context("sealing collab snapshots")?;
    report.sealed += columns.sealed;
    report.unreadable += columns.unreadable;
    if report.unreadable > 0 {
        tracing::warn!(
            store = STORE,
            unreadable = report.unreadable,
            "collab: values that do not open were left untouched"
        );
    }
    if let Some(path) = db_path {
        if report.sealed > 0 {
            let mut policy = content_sqlite::VacuumPolicy::default();
            if !inline_vacuum {
                policy.vacuum_now_max_bytes = 0;
            }
            content_sqlite::finish_store_with(conn, path, STORE, &policy)
                .context("scrubbing plaintext freed by the collab migration")?;
        }
    }
    Ok(report)
}
