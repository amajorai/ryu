//! SQLite helpers for the key states (feature `sqlite`).

use anyhow::{bail, Result};

use super::{PluginKeys, StoreSeal};

/// The store-level state of a sealed SQLite store: checks (and on first use
/// records) the key check value and reader format with a key; without a key a
/// recorded store is unhealthy and a never-sealed one runs in compat mode.
pub fn sqlite_store_seal(
    keys: &PluginKeys,
    conn: &rusqlite::Connection,
    store: &str,
) -> Result<StoreSeal> {
    use crate::content_sqlite::{check_store_key, read_store_record, StoreKeyState};
    match keys.content_cipher(store) {
        Some(cipher) => Ok(match check_store_key(conn, &cipher)? {
            StoreKeyState::Mismatch { .. } => StoreSeal::mismatch(store),
            _ => StoreSeal::Sealing(cipher),
        }),
        None => {
            let recorded = read_store_record(conn, store)?;
            Ok(keys.store_state(store, recorded.and_then(|r| r.kcv).as_deref(), false))
        }
    }
}

/// Call inside every write transaction (`BEGIN IMMEDIATE`) of a SQLite store:
/// a compat-mode process (no key) refuses to write once another process
/// sealed the store (recorded its key check value) after this one opened it,
/// so no plaintext is written into a sealed store. A no-op when sealing.
pub fn ensure_compat_write(
    seal: &StoreSeal,
    conn: &rusqlite::Connection,
    store: &str,
) -> Result<()> {
    if !matches!(seal, StoreSeal::Compat) {
        return seal.ensure_writable();
    }
    let recorded = crate::content_sqlite::read_store_record(conn, store)?;
    if recorded.and_then(|record| record.kcv).is_some() {
        bail!(
            "{store} was sealed by the app's sidecar after this process opened it; this \
             process holds no key, so the write is refused (it goes through the running app)"
        );
    }
    Ok(())
}

/// Before a migration: put back to `pending` every finished TEXT item whose
/// column still holds a value that is not an `encb:v1:` envelope (written in
/// plaintext by a keyless process after the item was finished), so the
/// migration walks it again. Returns how many items were reopened.
pub fn reopen_plaintext_items(
    conn: &rusqlite::Connection,
    store: &str,
    plans: &[crate::content_sqlite::ColumnPlan],
) -> Result<usize> {
    use crate::content_sqlite::{item_state, reset_items, states};
    let mut reopened = 0;
    for plan in plans {
        let item = plan.item();
        if item_state(conn, store, &item)?.as_deref() != Some(states::SEALED) {
            continue;
        }
        let Some((table, column)) = item.split_once('.') else {
            continue;
        };
        let sql = format!(
            "SELECT 1 FROM \"{table}\" WHERE \"{column}\" IS NOT NULL AND \"{column}\" != ''
             AND (typeof(\"{column}\") != 'text' OR substr(\"{column}\", 1, 8) != 'encb:v1:')
             LIMIT 1"
        );
        let found: Option<i64> = {
            use rusqlite::OptionalExtension as _;
            conn.query_row(&sql, [], |row| row.get(0)).optional()?
        };
        if found.is_some() {
            tracing::warn!(store = %store, item = %item, "plaintext found in a sealed column; sealing it again");
            reset_items(conn, store, std::slice::from_ref(plan))?;
            reopened += 1;
        }
    }
    Ok(reopened)
}
