//! Seal-mode transitions: Shamir shares, root replacement and rekey, and the
//! way back to `auto`.

use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection};
use ryu_crypto::FieldCipher;

use super::{
    insert_wrapped, key_from, load_wrapped, meta_get, meta_set, unwrap_all, Keyring, SealMode,
    SealStatus, LEGACY_KEY_VERSION, META_SEAL_CHECK, META_SEAL_MODE, META_SEAL_SHARES,
    META_SEAL_THRESHOLD, SEAL_CHECK_PLAINTEXT,
};
use crate::vault::shamir::{self, Share};
use crate::vault::{random_bytes, VaultError};

/// Where [`Keyring::replace_root`] finds the key that currently wraps the DEKs.
pub(crate) enum RootSource<'a> {
    /// `auto` mode: the Core master key.
    Master,
    /// `shamir` mode, unsealed: the in-memory root key.
    Loaded,
    /// `shamir` mode: a root reconstructed from a quorum of shares.
    Combined(&'a [u8]),
}

/// Whether `root` opens the stored seal check value.
fn verify_root(conn: &Connection, root: &FieldCipher) -> Result<()> {
    let check =
        meta_get(conn, META_SEAL_CHECK)?.ok_or_else(|| anyhow!("seal check value is missing"))?;
    match root.open(&check) {
        Ok(value) if value.as_bytes() == SEAL_CHECK_PLAINTEXT => Ok(()),
        _ => bail!("the submitted key shares do not unseal this vault"),
    }
}

impl Keyring {
    /// Submit one key share. Returns the status; once `threshold` distinct
    /// shares are in, the root key is reconstructed, verified, and the vault
    /// unseals. A wrong combination resets progress.
    pub fn submit_share(&self, conn: &Connection, encoded: &str) -> Result<SealStatus> {
        let share = Share::decode(encoded)?;
        {
            let mut state = self.write();
            if state.mode != SealMode::Shamir {
                bail!("this vault is not in shamir seal mode");
            }
            if !state.sealed {
                drop(state);
                return Ok(self.status());
            }
            if state.pending.iter().any(|existing| existing.x == share.x) {
                bail!("this key share was already submitted");
            }
            state.pending.push(share);
            if state.pending.len() < state.threshold as usize {
                drop(state);
                return Ok(self.status());
            }
            let pending = std::mem::take(&mut state.pending);
            let root_raw = shamir::combine(&pending)?;
            let root = key_from(&root_raw)?;
            let check = meta_get(conn, META_SEAL_CHECK)?
                .ok_or_else(|| anyhow!("seal check value is missing"))?;
            match root.open(&check) {
                Ok(value) if value.as_bytes() == SEAL_CHECK_PLAINTEXT => {}
                _ => bail!("the submitted key shares do not unseal this vault"),
            }
            let keys = unwrap_all(&root, &load_wrapped(conn)?)?;
            state.active = keys.keys().copied().max().unwrap_or(LEGACY_KEY_VERSION);
            state.keys = keys;
            state.root = Some(root);
            state.sealed = false;
        }
        Ok(self.status())
    }

    /// Switch an unsealed `auto` vault to `shamir`: generate a root key, wrap
    /// every DEK with it, and return the encoded shares exactly once. The
    /// caller must rewrap legacy version-0 rows before calling this.
    pub fn init_shamir(&self, conn: &Connection, shares: u8, threshold: u8) -> Result<Vec<String>> {
        self.replace_root(
            conn,
            RootSource::Master,
            &random_bytes(32),
            shares,
            threshold,
            &[],
        )
    }

    /// Re-key the wrapping root: unwrap every DEK with the current wrapper
    /// (`source`), wrap it with `new_root_raw`, split the new root into
    /// `shares`/`threshold`, and write `extra_meta` in the same transaction.
    /// Moves an `auto` vault to `shamir`. Returns the encoded new shares.
    ///
    /// `RootSource::Combined` carries a root reconstructed from existing
    /// shares; it must open the stored seal check, so a wrong quorum never
    /// rewrites the keyring. The in-memory state adopts the new root only when
    /// the vault is unsealed; a sealed vault stays sealed.
    pub(crate) fn replace_root(
        &self,
        conn: &Connection,
        source: RootSource<'_>,
        new_root_raw: &[u8],
        shares: u8,
        threshold: u8,
        extra_meta: &[(&str, &str)],
    ) -> Result<Vec<String>> {
        let mut state = self.write();
        let wrapper = match source {
            RootSource::Master => {
                if state.sealed {
                    return Err(VaultError::Sealed.into());
                }
                if state.mode != SealMode::Auto {
                    bail!("the vault is already in shamir seal mode");
                }
                self.master.clone()
            }
            RootSource::Loaded => {
                if state.sealed {
                    return Err(VaultError::Sealed.into());
                }
                if state.mode != SealMode::Shamir {
                    bail!("the vault is not in shamir seal mode");
                }
                state
                    .root
                    .clone()
                    .ok_or_else(|| anyhow!("root key is not loaded"))?
            }
            RootSource::Combined(raw) => {
                if state.mode != SealMode::Shamir {
                    bail!("the vault is not in shamir seal mode");
                }
                let root = key_from(raw)?;
                verify_root(conn, &root)?;
                root
            }
        };
        let parts = shamir::split(new_root_raw, shares, threshold)?;
        let root = key_from(new_root_raw)?;
        let check = root.seal(std::str::from_utf8(SEAL_CHECK_PLAINTEXT)?)?;
        let tx = conn.unchecked_transaction()?;
        for (version, nonce, wrapped) in load_wrapped(&tx)? {
            let raw = wrapper.decrypt(&nonce, &wrapped)?;
            insert_wrapped(&tx, &root, version, &raw)?;
        }
        meta_set(&tx, META_SEAL_MODE, SealMode::Shamir.as_str())?;
        meta_set(&tx, META_SEAL_SHARES, &shares.to_string())?;
        meta_set(&tx, META_SEAL_THRESHOLD, &threshold.to_string())?;
        meta_set(&tx, META_SEAL_CHECK, &check)?;
        for (key, value) in extra_meta {
            meta_set(&tx, key, value)?;
        }
        tx.commit()?;
        state.mode = SealMode::Shamir;
        state.shares = shares;
        state.threshold = threshold;
        state.pending.clear();
        if !state.sealed {
            state.root = Some(root);
        }
        Ok(parts.iter().map(Share::encode).collect())
    }

    /// Unseal a `shamir` vault from an already reconstructed root key (an
    /// auto-unseal seal provider, or a combined recovery quorum). The root
    /// must open the stored seal check.
    pub(crate) fn unseal_with_root(
        &self,
        conn: &Connection,
        root_raw: &[u8],
    ) -> Result<SealStatus> {
        {
            let mut state = self.write();
            if state.mode != SealMode::Shamir {
                bail!("this vault is not in shamir seal mode");
            }
            if !state.sealed {
                drop(state);
                return Ok(self.status());
            }
            let root = key_from(root_raw)?;
            verify_root(conn, &root)?;
            let keys = unwrap_all(&root, &load_wrapped(conn)?)?;
            state.active = keys.keys().copied().max().unwrap_or(LEGACY_KEY_VERSION);
            state.keys = keys;
            state.root = Some(root);
            state.pending.clear();
            state.sealed = false;
        }
        Ok(self.status())
    }

    /// Switch an unsealed `shamir` vault back to `auto` (master-key wrapping).
    pub fn migrate_to_auto(&self, conn: &Connection) -> Result<()> {
        let mut state = self.write();
        if state.sealed {
            return Err(VaultError::Sealed.into());
        }
        if state.mode != SealMode::Shamir {
            bail!("the vault is already in auto seal mode");
        }
        let root = state
            .root
            .clone()
            .ok_or_else(|| anyhow!("root key is not loaded"))?;
        let tx = conn.unchecked_transaction()?;
        for (version, nonce, wrapped) in load_wrapped(&tx)? {
            let raw = root.decrypt(&nonce, &wrapped)?;
            insert_wrapped(&tx, &self.master, version, &raw)?;
        }
        meta_set(&tx, META_SEAL_MODE, SealMode::Auto.as_str())?;
        tx.execute(
            "DELETE FROM vault_meta WHERE key IN (?1, ?2, ?3)",
            params![META_SEAL_SHARES, META_SEAL_THRESHOLD, META_SEAL_CHECK],
        )?;
        // An auto-unseal provider wraps the shamir root, which no longer exists.
        tx.execute("DELETE FROM vault_meta WHERE key LIKE 'seal_provider%'", [])?;
        tx.commit()?;
        state.mode = SealMode::Auto;
        state.root = None;
        state.shares = 0;
        state.threshold = 0;
        Ok(())
    }
}

#[cfg(test)]
#[path = "seal_modes_test.rs"]
mod tests;
