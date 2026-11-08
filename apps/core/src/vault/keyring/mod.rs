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
//! the active version, and a retired version that no row references any more is
//! pruned ([`hygiene`]). The scheduler rotates the active version when it is
//! older than the configured period. `ryu-core keys rotate` replaces the master
//! key and rewraps every DEK under it ([`rewrap_wrapping`]).

use std::collections::BTreeMap;
use std::sync::RwLock;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::FieldCipher;
use serde::Serialize;

use super::shamir::Share;
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
}

mod hygiene;
mod seal_modes;

pub(crate) use hygiene::{rewrap_wrapping, KekRewrap, PRUNE_GRACE_MILLIS};
pub(crate) use seal_modes::RootSource;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod sys_http_test;
