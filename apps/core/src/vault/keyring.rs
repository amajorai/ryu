//! Versioned vault data-encryption keys and the seal state.
//!
//! Vault values are not sealed with the Core master key directly. Each value
//! row records the `key_version` of the data-encryption key (DEK) that sealed
//! it. DEKs live in `vault_keyring`, wrapped by a *wrapping key*:
//!
//! * `auto` mode (default): the wrapping key is the Core master key
//!   ([`ryu_crypto::global_cipher`], keychain-backed), so the vault unseals
//!   itself at boot exactly as before;
//! * `shamir` mode: the wrapping key is a random root key that exists only in
//!   memory after an operator submits `threshold` key shares. The vault starts
//!   sealed and resolves nothing until then.
//!
//! Version `0` is the legacy scheme (values sealed with the master key itself).
//! It stays readable in `auto` mode so existing rows keep working until
//! `rewrap`; switching to `shamir` rewraps every row first, and version 0 is
//! never readable in `shamir` mode.
//!
//! Rotation adds a new DEK version and makes it active. Old versions stay in
//! the keyring so existing rows still decrypt; `rewrap` re-seals every row with
//! the active version.

use std::collections::BTreeMap;
use std::sync::RwLock;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::FieldCipher;
use serde::Serialize;

use super::shamir::{self, Share};
use super::{now_millis, random_bytes, VaultError};

/// Legacy key version: the master key itself.
pub const LEGACY_KEY_VERSION: u32 = 0;
const SEAL_CHECK_PLAINTEXT: &[u8] = b"ryu-vault-seal-check-v1";
const META_SEAL_MODE: &str = "seal_mode";
const META_SEAL_SHARES: &str = "seal_shares";
const META_SEAL_THRESHOLD: &str = "seal_threshold";
const META_SEAL_CHECK: &str = "seal_check";

/// How the keyring's wrapping key is obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SealMode {
    Auto,
    Shamir,
}

impl SealMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Shamir => "shamir",
        }
    }
}

/// Public seal status projection (no key material).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SealStatus {
    pub mode: SealMode,
    pub sealed: bool,
    pub shares: u8,
    pub threshold: u8,
    pub progress: u8,
    pub key_versions: Vec<u32>,
    pub active_key_version: u32,
}

struct State {
    mode: SealMode,
    sealed: bool,
    /// Unwrapped DEKs by version. Empty while sealed.
    keys: BTreeMap<u32, FieldCipher>,
    active: u32,
    /// The wrapping key in `shamir` mode while unsealed.
    root: Option<FieldCipher>,
    shares: u8,
    threshold: u8,
    pending: Vec<Share>,
}

/// The process-local keyring for one vault database.
pub struct Keyring {
    master: FieldCipher,
    state: RwLock<State>,
}

/// Create the keyring and meta tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_keyring (
             version    INTEGER PRIMARY KEY,
             nonce      BLOB NOT NULL,
             wrapped    BLOB NOT NULL,
             created_at INTEGER NOT NULL
         );",
    )
    .context("initializing vault keyring schema")
}

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM vault_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .context("reading vault_meta")
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO vault_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .context("writing vault_meta")?;
    Ok(())
}

fn key_from(bytes: &[u8]) -> Result<FieldCipher> {
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("vault key has the wrong length"))?;
    Ok(FieldCipher::new(&key))
}

fn load_wrapped(conn: &Connection) -> Result<Vec<(u32, Vec<u8>, Vec<u8>)>> {
    let mut stmt = conn
        .prepare("SELECT version, nonce, wrapped FROM vault_keyring ORDER BY version ASC")
        .context("preparing keyring query")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .context("querying keyring")?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.context("reading keyring row")?);
    }
    Ok(out)
}

fn unwrap_all(
    wrapper: &FieldCipher,
    wrapped: &[(u32, Vec<u8>, Vec<u8>)],
) -> Result<BTreeMap<u32, FieldCipher>> {
    let mut keys = BTreeMap::new();
    for (version, nonce, blob) in wrapped {
        let raw = wrapper
            .decrypt(nonce, blob)
            .with_context(|| format!("unwrapping vault key version {version}"))?;
        keys.insert(*version, key_from(&raw)?);
    }
    Ok(keys)
}

fn insert_wrapped(
    conn: &Connection,
    wrapper: &FieldCipher,
    version: u32,
    raw: &[u8],
) -> Result<()> {
    let (nonce, wrapped) = wrapper.encrypt(raw)?;
    conn.execute(
        "INSERT INTO vault_keyring (version, nonce, wrapped, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(version) DO UPDATE SET nonce = excluded.nonce, wrapped = excluded.wrapped",
        params![version, nonce, wrapped, now_millis()],
    )
    .context("writing vault keyring")?;
    Ok(())
}

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
    /// Load the keyring from `conn`. In `auto` mode this unwraps every DEK and
    /// creates version 1 on first use. In `shamir` mode the keyring starts
    /// sealed.
    pub fn load(conn: &Connection, master: FieldCipher) -> Result<Self> {
        init_schema(conn)?;
        let mode = match meta_get(conn, META_SEAL_MODE)?.as_deref() {
            None | Some("auto") => SealMode::Auto,
            Some("shamir") => SealMode::Shamir,
            Some(other) => bail!("unknown vault seal mode `{other}`"),
        };
        let shares = meta_get(conn, META_SEAL_SHARES)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let threshold = meta_get(conn, META_SEAL_THRESHOLD)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut state = State {
            mode,
            sealed: mode == SealMode::Shamir,
            keys: BTreeMap::new(),
            active: LEGACY_KEY_VERSION,
            root: None,
            shares,
            threshold,
            pending: Vec::new(),
        };
        if mode == SealMode::Auto {
            let mut wrapped = load_wrapped(conn)?;
            if wrapped.is_empty() {
                insert_wrapped(conn, &master, 1, &random_bytes(32))?;
                wrapped = load_wrapped(conn)?;
            }
            state.keys = unwrap_all(&master, &wrapped)?;
            state.active = state
                .keys
                .keys()
                .copied()
                .max()
                .unwrap_or(LEGACY_KEY_VERSION);
        } else {
            state.active = load_wrapped(conn)?
                .iter()
                .map(|(version, _, _)| *version)
                .max()
                .unwrap_or(LEGACY_KEY_VERSION);
        }
        Ok(Self {
            master,
            state: RwLock::new(state),
        })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, State> {
        self.state
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, State> {
        self.state
            .write()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// The master cipher (for non-value metadata such as the audit key).
    pub fn master(&self) -> &FieldCipher {
        &self.master
    }

    /// Whether the vault is sealed.
    pub fn is_sealed(&self) -> bool {
        self.read().sealed
    }

    /// The active key version.
    pub fn active_version(&self) -> u32 {
        self.read().active
    }

    /// Seal `plaintext` with the active DEK.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<(u32, Vec<u8>, Vec<u8>)> {
        let state = self.read();
        if state.sealed {
            return Err(VaultError::Sealed.into());
        }
        let cipher = state
            .keys
            .get(&state.active)
            .ok_or_else(|| anyhow!("active vault key is missing"))?;
        let (nonce, ciphertext) = cipher.encrypt(plaintext)?;
        Ok((state.active, nonce, ciphertext))
    }

    /// Open a row sealed with `version`.
    pub fn decrypt(&self, version: u32, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        let state = self.read();
        if state.sealed {
            return Err(VaultError::Sealed.into());
        }
        if version == LEGACY_KEY_VERSION {
            if state.mode != SealMode::Auto {
                bail!("legacy vault rows are not readable in shamir seal mode");
            }
            return self.master.decrypt(nonce, ciphertext);
        }
        let cipher = state
            .keys
            .get(&version)
            .ok_or_else(|| anyhow!("vault key version {version} is not in the keyring"))?;
        cipher.decrypt(nonce, ciphertext)
    }

    /// Add a new DEK version and make it active.
    pub fn rotate(&self, conn: &Connection) -> Result<u32> {
        let mut state = self.write();
        if state.sealed {
            return Err(VaultError::Sealed.into());
        }
        let wrapper = match state.mode {
            SealMode::Auto => self.master.clone(),
            SealMode::Shamir => state
                .root
                .clone()
                .ok_or_else(|| anyhow!("root key is not loaded"))?,
        };
        let next = state.keys.keys().copied().max().unwrap_or(0) + 1;
        let raw = random_bytes(32);
        insert_wrapped(conn, &wrapper, next, &raw)?;
        state.keys.insert(next, key_from(&raw)?);
        state.active = next;
        Ok(next)
    }

    /// Current seal status.
    pub fn status(&self) -> SealStatus {
        let state = self.read();
        SealStatus {
            mode: state.mode,
            sealed: state.sealed,
            shares: state.shares,
            threshold: state.threshold,
            progress: state.pending.len() as u8,
            key_versions: state.keys.keys().copied().collect(),
            active_key_version: state.active,
        }
    }

    /// Seal the vault in memory. In `auto` mode `unseal` restores it without
    /// shares; in `shamir` mode `threshold` shares are required.
    pub fn seal(&self) {
        let mut state = self.write();
        state.sealed = true;
        state.keys.clear();
        state.root = None;
        state.pending.clear();
    }

    /// Unseal an `auto`-mode vault from the master key.
    pub fn unseal_auto(&self, conn: &Connection) -> Result<SealStatus> {
        {
            let mut state = self.write();
            if state.mode != SealMode::Auto {
                bail!("this vault needs key shares to unseal");
            }
            let keys = unwrap_all(&self.master, &load_wrapped(conn)?)?;
            state.active = keys.keys().copied().max().unwrap_or(LEGACY_KEY_VERSION);
            state.keys = keys;
            state.sealed = false;
        }
        Ok(self.status())
    }

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
mod tests {
    use super::*;

    fn master() -> FieldCipher {
        FieldCipher::new(&[9u8; 32])
    }

    #[test]
    fn auto_mode_creates_a_key_and_round_trips() {
        let conn = Connection::open_in_memory().unwrap();
        let keyring = Keyring::load(&conn, master()).unwrap();
        assert_eq!(keyring.active_version(), 1);
        let (version, nonce, ct) = keyring.encrypt(b"hello").unwrap();
        assert_eq!(version, 1);
        assert_eq!(keyring.decrypt(version, &nonce, &ct).unwrap(), b"hello");

        // A reload unwraps the same key.
        let reloaded = Keyring::load(&conn, master()).unwrap();
        assert_eq!(reloaded.decrypt(version, &nonce, &ct).unwrap(), b"hello");
    }

    #[test]
    fn legacy_rows_decrypt_with_the_master_key_in_auto_mode() {
        let conn = Connection::open_in_memory().unwrap();
        let keyring = Keyring::load(&conn, master()).unwrap();
        let (nonce, ct) = master().encrypt(b"legacy").unwrap();
        assert_eq!(
            keyring.decrypt(LEGACY_KEY_VERSION, &nonce, &ct).unwrap(),
            b"legacy"
        );
    }

    #[test]
    fn rotation_keeps_old_versions_readable() {
        let conn = Connection::open_in_memory().unwrap();
        let keyring = Keyring::load(&conn, master()).unwrap();
        let (v1, n1, c1) = keyring.encrypt(b"one").unwrap();
        let v2 = keyring.rotate(&conn).unwrap();
        assert_eq!(v2, 2);
        let (v, _, _) = keyring.encrypt(b"two").unwrap();
        assert_eq!(v, 2);
        assert_eq!(keyring.decrypt(v1, &n1, &c1).unwrap(), b"one");
        assert_eq!(keyring.status().key_versions, vec![1, 2]);
    }

    #[test]
    fn shamir_mode_seals_on_reload_and_unseals_with_threshold_shares() {
        let conn = Connection::open_in_memory().unwrap();
        let keyring = Keyring::load(&conn, master()).unwrap();
        let (version, nonce, ct) = keyring.encrypt(b"guarded").unwrap();
        let shares = keyring.init_shamir(&conn, 5, 3).unwrap();
        assert_eq!(shares.len(), 5);

        let reloaded = Keyring::load(&conn, master()).unwrap();
        assert!(reloaded.is_sealed());
        assert!(reloaded.decrypt(version, &nonce, &ct).is_err());
        assert!(reloaded.encrypt(b"x").is_err());
        // Legacy reads are refused too.
        assert!(reloaded.decrypt(LEGACY_KEY_VERSION, &nonce, &ct).is_err());

        let status = reloaded.submit_share(&conn, &shares[0]).unwrap();
        assert_eq!(status.progress, 1);
        assert!(reloaded.submit_share(&conn, &shares[0]).is_err());
        reloaded.submit_share(&conn, &shares[3]).unwrap();
        let status = reloaded.submit_share(&conn, &shares[4]).unwrap();
        assert!(!status.sealed);
        assert_eq!(reloaded.decrypt(version, &nonce, &ct).unwrap(), b"guarded");

        // Rotation in shamir mode wraps with the root key.
        let v2 = reloaded.rotate(&conn).unwrap();
        reloaded.seal();
        let again = Keyring::load(&conn, master()).unwrap();
        for share in &shares[..3] {
            again.submit_share(&conn, share).unwrap();
        }
        assert_eq!(again.status().key_versions, vec![1, v2]);
    }

    #[test]
    fn shares_from_another_vault_do_not_unseal() {
        let conn_a = Connection::open_in_memory().unwrap();
        let conn_b = Connection::open_in_memory().unwrap();
        let a = Keyring::load(&conn_a, master()).unwrap();
        let b = Keyring::load(&conn_b, master()).unwrap();
        let _ = a.init_shamir(&conn_a, 3, 2).unwrap();
        let foreign = b.init_shamir(&conn_b, 3, 2).unwrap();
        let sealed = Keyring::load(&conn_a, master()).unwrap();
        sealed.submit_share(&conn_a, &foreign[0]).unwrap();
        assert!(sealed.submit_share(&conn_a, &foreign[1]).is_err());
        assert!(sealed.is_sealed());
        assert_eq!(
            sealed.status().progress,
            0,
            "a failed attempt resets progress"
        );
    }

    #[test]
    fn shamir_can_migrate_back_to_auto() {
        let conn = Connection::open_in_memory().unwrap();
        let keyring = Keyring::load(&conn, master()).unwrap();
        let (version, nonce, ct) = keyring.encrypt(b"v").unwrap();
        keyring.init_shamir(&conn, 3, 2).unwrap();
        keyring.migrate_to_auto(&conn).unwrap();
        let reloaded = Keyring::load(&conn, master()).unwrap();
        assert!(!reloaded.is_sealed());
        assert_eq!(reloaded.decrypt(version, &nonce, &ct).unwrap(), b"v");
    }

    #[test]
    fn manual_seal_in_auto_mode_unseals_from_the_master_key() {
        let conn = Connection::open_in_memory().unwrap();
        let keyring = Keyring::load(&conn, master()).unwrap();
        keyring.seal();
        assert!(keyring.encrypt(b"x").is_err());
        keyring.unseal_auto(&conn).unwrap();
        assert!(keyring.encrypt(b"x").is_ok());
    }
}
