//! Sealed-at-rest account vault for Pi provider + ACP agent credentials.
//!
//! # Why this exists
//!
//! Provider logins and ACP-agent sign-ins used to store exactly ONE credential
//! per provider / agent, as plaintext inside the managed Pi's `auth.json` /
//! `models.json` (`0600`, but unsealed — Pi reads those files directly on every
//! spawn, so they had to stay in Pi's native shape). That made two things
//! impossible:
//!
//! - **Multiple accounts.** ChatGPT account A and account B could not coexist:
//!   the second login overwrote the first.
//! - **The system-locker guarantee every other secret gets.** Plugin secrets,
//!   the identity vault, memory and conversations all seal their values with
//!   [`ryu_crypto::global_cipher`] — the master key whose custody ladder is env
//!   → OS keychain → `~/.ryu/master.key`. The Pi credentials were the outlier,
//!   and BYOK api-keys were the most visible case.
//!
//! This module is that missing layer: a master-key-sealed vault where each
//! account's credential lives, keyed by a *scope* (one Pi provider slot, or one
//! ACP agent's spawn command). The managed Pi's `auth.json` / `models.json` stay
//! the *active-account materialization* so Pi's reading path never changes, but
//! an API key is materialized only as a `${RYU_PI_KEY_…}` reference whose value
//! reaches Pi in its spawn environment (see [`super::secret_env`]); only OAuth
//! logins Pi refreshes itself are still copied out in plaintext. Existing readers
//! ([`super::auth_has_key`], [`super::refresh_oauth`], …) resolve references and
//! keep working against the active credential.
//!
//! # Shape
//!
//! Rows are keyed `(scope, account_id)` with the credential sealed via
//! `global_cipher()` (`nonce` + `ciphertext` BLOB columns, like the plugin-secret
//! store). Only non-sensitive metadata — `scope`, `account_id`, `label`,
//! `kind`, `is_active`, `gateway_active`, and timestamps — is stored in plaintext,
//! so the "which
//! accounts exist" listing is answered in SQL without ever touching the cipher.
//! [`AccountInfo`] deliberately carries no credential, and the REST surface only
//! ever exposes that shape. The self-active and Gateway-active markers are
//! independent: choosing an account for a personal turn must not silently replace
//! the account a shared Gateway uses.
//!
//! The store is **synchronous** (a `std::sync::Mutex`, like the `auth.json`
//! file ops around it) rather than async: it is called from sync `pi_config`
//! functions (`set_auth_key`, `persist_oauth_refresh`, …) whose callers are
//! already async HTTP handlers, and the per-call work is a single cheap SQL
//! statement. Mirroring the file layer keeps the sync/async seam exactly where
//! it already is.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::{global_cipher, FieldCipher};
use serde_json::Value;

/// Scope prefix for a Pi provider slot. The remainder is the provider's
/// `auth.json` key (built-in, e.g. `anthropic`) or its `models.json` id
/// (custom). Both are the exact slot Pi reads the active credential from.
pub const SCOPE_PROVIDER: &str = "provider:";
/// Scope prefix for an ACP agent. The remainder is the agent's spawn command —
/// not secret (it is the command Core runs), just a stable key.
pub const SCOPE_ACP: &str = "acp:";

/// The `pi_accounts.kind` values.
pub const KIND_API_KEY: &str = "api_key";
pub const KIND_OAUTH: &str = "oauth";
/// An account whose credential Ryu cannot read back (a third-party ACP agent
/// that owns its own auth). Switching one re-runs the agent's own login.
pub const KIND_OPAQUE: &str = "opaque";

/// The scope key for a Pi provider's credential slot. For a built-in provider
/// this is its `auth_key`; for a custom provider it is its `models.json` id —
/// whichever string Pi's `auth.json` / `models.json` is keyed by.
pub fn provider_scope(auth_key: &str) -> String {
    format!("{SCOPE_PROVIDER}{auth_key}")
}

/// The scope key for one ACP agent, keyed by its spawn command.
pub fn acp_scope(spawn_cmd: &str) -> String {
    format!("{SCOPE_ACP}{spawn_cmd}")
}

/// Whether a scope string names a Pi provider slot.
pub fn is_provider_scope(scope: &str) -> bool {
    scope.starts_with(SCOPE_PROVIDER)
}

/// Whether a scope string names an ACP agent.
pub fn is_acp_scope(scope: &str) -> bool {
    scope.starts_with(SCOPE_ACP)
}

/// Strip the scope prefix to recover the key the scope was built from (an
/// `auth.json` key, a `models.json` provider id, or an ACP spawn command).
pub fn scope_key(scope: &str) -> &str {
    scope
        .strip_prefix(SCOPE_PROVIDER)
        .or_else(|| scope.strip_prefix(SCOPE_ACP))
        .unwrap_or(scope)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One entry in the "which accounts exist" listing. Carries NO credential — by
/// construction, not by omission at the call site.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub account_id: String,
    /// Human-friendly display name (an email when the login exposed one, else a
    /// provider label or "Account N").
    pub label: String,
    /// One of [`KIND_API_KEY`] / [`KIND_OAUTH`] / [`KIND_OPAQUE`].
    pub kind: String,
    /// Whether this is the account Pi will actually use this turn.
    pub active: bool,
    /// Whether this is the account selected for the shared Gateway.
    pub gateway_active: bool,
    /// Epoch millis of the last write.
    pub updated_at: i64,
    /// The current credential generation cannot safely refresh again.
    #[serde(default)]
    pub needs_reauth: bool,
}

/// Redacted refresh failures; unknown delivery must never replay a rotating token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshFailure {
    Uncertain,
    Revoked,
    Transient,
}

impl std::fmt::Display for RefreshFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Uncertain => "OAuth refresh delivery is uncertain; sign in again",
            Self::Revoked => "OAuth credential was revoked; sign in again",
            Self::Transient => "OAuth refresh is temporarily unavailable; try again later",
        })
    }
}

impl std::error::Error for RefreshFailure {}

/// SQLite-backed, sealed-at-rest `(scope, account_id) -> credential` store.
/// Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct AccountVault {
    conn: Arc<std::sync::Mutex<Connection>>,
    cipher: FieldCipher,
}

impl AccountVault {
    /// Open (or create) the vault at a specific path, sealing with the shared
    /// [`ryu_crypto`] master key. Fails closed if the key cannot be resolved —
    /// an ephemeral key would write rows that die on the next restart.
    pub fn open(path: PathBuf) -> Result<Self> {
        Self::open_with_cipher(path, global_cipher()?)
    }

    fn open_with_cipher(path: PathBuf, cipher: FieldCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening pi-accounts db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(std::sync::Mutex::new(conn)),
            cipher,
        })
    }

    /// In-memory vault with an ephemeral key, for tests. Never touches the real
    /// keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory pi-accounts db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(std::sync::Mutex::new(conn)),
            cipher: FieldCipher::new(&[0x37; 32]),
        })
    }

    #[cfg(test)]
    pub(super) fn open_test(path: PathBuf) -> Result<Self> {
        Self::open_with_cipher(path, FieldCipher::new(&[0x37; 32]))
    }

    #[cfg(test)]
    pub(super) fn reject_writes_for_test(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("pi-accounts mutex")
            .execute_batch("PRAGMA query_only = ON")
            .context("making the test vault read-only")
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS pi_accounts (
                 scope      TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 label      TEXT NOT NULL,
                 kind       TEXT NOT NULL,
                 nonce      BLOB,
                 ciphertext BLOB,
                 is_active  INTEGER NOT NULL DEFAULT 0,
                 gateway_active INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (scope, account_id)
             );
             CREATE INDEX IF NOT EXISTS idx_pi_accounts_scope
                 ON pi_accounts(scope);
             CREATE TABLE IF NOT EXISTS pi_oauth_refresh_intents (
                 scope TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 revision BLOB NOT NULL,
                 state TEXT NOT NULL,
                 retry_at INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY(scope, account_id)
             );",
        )
        .context("initializing pi-accounts schema")?;
        // Existing vaults predate independent Gateway selection. Add the column
        // in place and seed it from the old active account exactly once, so an
        // upgrade preserves the account the user was already using.
        let has_gateway_active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('pi_accounts')
                 WHERE name = 'gateway_active'",
                [],
                |row| row.get(0),
            )
            .context("checking pi_accounts gateway_active column")?;
        if has_gateway_active == 0 {
            conn.execute(
                "ALTER TABLE pi_accounts ADD COLUMN gateway_active INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .context("adding pi_accounts gateway_active column")?;
        }
        conn.execute(
            "UPDATE pi_accounts SET gateway_active = 0
             WHERE kind <> 'api_key' AND gateway_active = 1",
            [],
        )
        .context("clearing unsupported Gateway-active accounts")?;
        conn.execute(
            "UPDATE pi_accounts AS candidate
             SET gateway_active = 1
             WHERE candidate.is_active = 1
               AND candidate.kind = 'api_key'
               AND NOT EXISTS (
                   SELECT 1 FROM pi_accounts AS selected
                   WHERE selected.scope = candidate.scope
                     AND selected.gateway_active = 1
               )",
            [],
        )
        .context("seeding pi_accounts gateway active rows")?;
        Ok(())
    }
}

// The rest of the vault's methods, split by responsibility to keep each file
// short. Every child sees this module's private items through `use super::*`.
mod limit;
mod queries;
mod refresh;
mod writes;

pub use limit::ensure_provider_has_room;

fn default_db_path() -> PathBuf {
    crate::paths::secret_path("pi-accounts.db")
}

/// Open (or create) the vault at the default path (`~/.ryu/pi-accounts.db`).
pub fn open_default() -> Result<AccountVault> {
    AccountVault::open(default_db_path())
}

// ── Process-global handle (set in `main.rs`, like the plugin-secret store) ─────

static GLOBAL: OnceLock<AccountVault> = OnceLock::new();

/// Publish the process-global account vault. Idempotent (first set wins).
pub fn set_global(vault: AccountVault) {
    let _ = GLOBAL.set(vault);
}

#[cfg(test)]
thread_local! {
    /// A per-thread vault for unit tests ([`with_test_vault`]); production code
    /// only ever sees [`GLOBAL`].
    static TEST_GLOBAL: std::cell::Cell<Option<&'static AccountVault>> =
        const { std::cell::Cell::new(None) };
}

/// The process-global account vault, if it has been published.
pub fn global() -> Option<&'static AccountVault> {
    #[cfg(test)]
    if let Some(vault) = TEST_GLOBAL.with(std::cell::Cell::get) {
        return Some(vault);
    }
    GLOBAL.get()
}

/// Run `f` with a fresh in-memory vault published as [`global`] for the calling
/// thread only, so tests that store keys exercise the sealed path without
/// sharing one process-wide vault.
#[cfg(test)]
pub(crate) fn with_test_vault<T>(f: impl FnOnce(&'static AccountVault) -> T) -> T {
    struct Restore(Option<&'static AccountVault>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_GLOBAL.with(|slot| slot.set(self.0));
        }
    }
    let vault: &'static AccountVault = Box::leak(Box::new(
        AccountVault::in_memory().expect("in-memory test vault"),
    ));
    let _restore = Restore(TEST_GLOBAL.with(|slot| slot.replace(Some(vault))));
    f(vault)
}

#[cfg(test)]
mod tests;
