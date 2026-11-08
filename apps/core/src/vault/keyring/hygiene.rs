//! Keyring hygiene: when the active data key is due for rotation, which retired
//! data keys nothing references any more (and so can be deleted), and moving
//! every master-key-wrapped record onto a new master key for
//! `ryu-core keys rotate`.
//!
//! Pruning never touches the active version or the newest one, and keeps a
//! retired version for [`PRUNE_GRACE_MILLIS`] after its successor was created:
//! a value sealed just before a rotation may still be on its way to the
//! database with the old version.

use std::collections::BTreeSet;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::FieldCipher;

use super::{insert_wrapped, load_wrapped, meta_get, meta_set, Keyring, SealMode};
use super::{LEGACY_KEY_VERSION, META_SEAL_MODE};
use crate::vault::VaultError;

/// How long a retired data key outlives the creation of its successor.
pub const PRUNE_GRACE_MILLIS: i64 = 60 * 60 * 1000;

/// `vault_meta` entries sealed directly with the master key (the audit HMAC
/// key). A KEK rotation moves them with the data keys.
const MASTER_SEALED_META: &[&str] = &["audit_key"];

/// What [`rewrap_wrapping`] rewrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KekRewrap {
    /// Data keys moved onto the new master key. `0` in `shamir` mode, where
    /// the root key from the key shares wraps them instead.
    pub data_keys: usize,
    /// Whether the vault is in `shamir` seal mode.
    pub shamir: bool,
    /// Master-sealed `vault_meta` entries moved onto the new master key.
    pub meta_entries: usize,
}

impl Keyring {
    /// When the active data key was created (milliseconds), or `None` for the
    /// legacy master-key scheme.
    pub fn active_created_at(&self, conn: &Connection) -> Result<Option<i64>> {
        let active = self.active_version();
        if active == LEGACY_KEY_VERSION {
            return Ok(None);
        }
        conn.query_row(
            "SELECT created_at FROM vault_keyring WHERE version = ?1",
            params![active],
            |row| row.get(0),
        )
        .optional()
        .context("reading the active vault key")
    }

    /// Whether the unsealed vault's active data key is at least
    /// `period_millis` old. A non-positive period disables rotation.
    pub fn rotation_due(&self, conn: &Connection, now: i64, period_millis: i64) -> Result<bool> {
        if period_millis <= 0 || self.is_sealed() {
            return Ok(false);
        }
        Ok(self
            .active_created_at(conn)?
            .is_some_and(|created| now - created >= period_millis))
    }

    /// Retired versions that may be deleted: not active, not in `referenced`,
    /// and superseded by a version created at least `grace_millis` before
    /// `now`. Refuses while sealed.
    pub fn prunable_versions(
        &self,
        conn: &Connection,
        referenced: &BTreeSet<u32>,
        now: i64,
        grace_millis: i64,
    ) -> Result<Vec<u32>> {
        let active = {
            let state = self.read();
            if state.sealed {
                return Err(VaultError::Sealed.into());
            }
            state.active
        };
        let created = {
            let mut stmt =
                conn.prepare("SELECT version, created_at FROM vault_keyring ORDER BY version ASC")?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, u32>(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<(u32, i64)>>>()?
        };
        let mut prunable = Vec::new();
        for pair in created.windows(2) {
            let ((version, _), (_, successor_created)) = (pair[0], pair[1]);
            if version != active
                && !referenced.contains(&version)
                && now - successor_created >= grace_millis
            {
                prunable.push(version);
            }
        }
        Ok(prunable)
    }

    /// Delete `versions` from `vault_keyring` on `conn` (the caller's
    /// transaction). Call [`Self::forget_versions`] after it commits.
    pub fn delete_versions(&self, conn: &Connection, versions: &[u32]) -> Result<()> {
        let active = self.active_version();
        for version in versions {
            if *version == active {
                bail!("refusing to delete the active vault key");
            }
            conn.execute(
                "DELETE FROM vault_keyring WHERE version = ?1",
                params![version],
            )
            .context("deleting a retired vault key")?;
        }
        Ok(())
    }

    /// Drop deleted versions from memory.
    pub fn forget_versions(&self, versions: &[u32]) {
        let mut state = self.write();
        for version in versions {
            if *version != state.active {
                state.keys.remove(version);
            }
        }
    }
}

/// Move every record the master key wraps from `old` to `new` in one
/// transaction: the data keys (in `auto` mode) and the master-sealed
/// `vault_meta` entries. Each new wrapping is opened again before commit, and
/// any record `old` cannot open aborts the whole rewrap.
pub(crate) fn rewrap_wrapping(
    conn: &Connection,
    old: &FieldCipher,
    new: &FieldCipher,
) -> Result<KekRewrap> {
    super::init_schema(conn)?;
    let shamir = meta_get(conn, META_SEAL_MODE)?.as_deref() == Some(SealMode::Shamir.as_str());
    let tx = conn.unchecked_transaction()?;
    let mut data_keys = 0;
    if !shamir {
        for (version, nonce, wrapped) in load_wrapped(&tx)? {
            let raw = old
                .decrypt(&nonce, &wrapped)
                .with_context(|| format!("opening vault key version {version}"))?;
            insert_wrapped(&tx, new, version, &raw)?;
            data_keys += 1;
        }
        for (version, nonce, wrapped) in load_wrapped(&tx)? {
            new.decrypt(&nonce, &wrapped)
                .with_context(|| format!("checking rewrapped vault key version {version}"))?;
        }
    }
    let mut meta_entries = 0;
    for key in MASTER_SEALED_META {
        let Some(sealed) = meta_get(&tx, key)? else {
            continue;
        };
        let value = old
            .open(&sealed)
            .with_context(|| format!("opening vault metadata `{key}`"))?;
        let resealed = new.seal(&value)?;
        if new.open(&resealed)? != value {
            bail!("rewrapped vault metadata `{key}` does not open");
        }
        meta_set(&tx, key, &resealed)?;
        meta_entries += 1;
    }
    tx.commit()?;
    Ok(KekRewrap {
        data_keys,
        shamir,
        meta_entries,
    })
}

#[cfg(test)]
#[path = "hygiene_test.rs"]
mod tests;
