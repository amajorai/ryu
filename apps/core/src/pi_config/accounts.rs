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
//! ACP agent's spawn command). It is additive — the managed Pi's `auth.json` /
//! `models.json` stay the *active-account materialization* ([`materialize`]) so
//! Pi's reading path never changes, and existing readers
//! ([`super::auth_has_key`], [`super::refresh_oauth`], …) keep working against
//! the active credential exactly as before.
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
}

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
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening pi-accounts db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(std::sync::Mutex::new(conn)),
            cipher: global_cipher()?,
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
                 ON pi_accounts(scope);",
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

    /// List a scope's accounts, active first then newest write first. **Names,
    /// kinds and timestamps only** — the ciphertext columns are not selected.
    pub fn list(&self, scope: &str) -> Result<Vec<AccountInfo>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let mut stmt = conn
            .prepare(
                "SELECT account_id, label, kind, is_active, gateway_active, updated_at
				 FROM pi_accounts WHERE scope = ?1
				 ORDER BY is_active DESC, gateway_active DESC, updated_at DESC, account_id ASC",
            )
            .context("preparing pi_accounts list query")?;
        let rows = stmt
            .query_map(params![scope], |row| {
                Ok(AccountInfo {
                    account_id: row.get(0)?,
                    label: row.get(1)?,
                    kind: row.get(2)?,
                    active: row.get::<_, i64>(3)? != 0,
                    gateway_active: row.get::<_, i64>(4)? != 0,
                    updated_at: row.get(5)?,
                })
            })
            .context("querying pi_accounts")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading pi_accounts row")?);
        }
        Ok(out)
    }

    /// Every scope that has at least one account, for materialization sweeps.
    pub fn scopes(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let mut stmt = conn
            .prepare("SELECT DISTINCT scope FROM pi_accounts")
            .context("preparing pi_accounts scope query")?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .context("querying pi_accounts scopes")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading pi_accounts scope")?);
        }
        Ok(out)
    }

    /// How many accounts a scope holds (the picker's badge / configured hint).
    pub fn count(&self, scope: &str) -> Result<usize> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pi_accounts WHERE scope = ?1",
                params![scope],
                |row| row.get(0),
            )
            .context("counting pi_accounts")?;
        Ok(n as usize)
    }

    /// The active account's credential for a scope, decrypted. `Ok(None)` when
    /// the scope has no active account, or when its active account is opaque
    /// (holds no readable credential).
    pub fn active_credential(&self, scope: &str) -> Result<Option<(String, Value)>> {
        let row: Option<(String, Option<Vec<u8>>, Option<Vec<u8>>)> = {
            let conn = self.conn.lock().expect("pi-accounts mutex");
            conn.query_row(
                "SELECT account_id, nonce, ciphertext FROM pi_accounts
                 WHERE scope = ?1 AND is_active = 1",
                params![scope],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("reading active pi_account")?
        };
        let Some((account_id, Some(nonce), Some(ciphertext))) = row else {
            return Ok(None);
        };
        let plain = self.cipher.decrypt(&nonce, &ciphertext)?;
        Ok(Some((account_id, serde_json::from_slice(&plain)?)))
    }

    /// The Gateway-selected account's credential for a scope, decrypted. This is
    /// separate from [`active_credential`]: a personal account switch must not
    /// replace the account a shared Gateway uses.
    pub fn gateway_credential(&self, scope: &str) -> Result<Option<(String, Value)>> {
        let row: Option<(String, Option<Vec<u8>>, Option<Vec<u8>>)> = {
            let conn = self.conn.lock().expect("pi-accounts mutex");
            conn.query_row(
                "SELECT account_id, nonce, ciphertext FROM pi_accounts
				 WHERE scope = ?1 AND gateway_active = 1",
                params![scope],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("reading Gateway-active pi_account")?
        };
        let Some((account_id, Some(nonce), Some(ciphertext))) = row else {
            return Ok(None);
        };
        let plain = self.cipher.decrypt(&nonce, &ciphertext)?;
        Ok(Some((account_id, serde_json::from_slice(&plain)?)))
    }

    /// The active account's info (id/label/kind) without touching the cipher.
    pub fn active_info(&self, scope: &str) -> Result<Option<AccountInfo>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let row: Option<AccountInfo> = conn
            .query_row(
                "SELECT account_id, label, kind, is_active, gateway_active, updated_at
				 FROM pi_accounts WHERE scope = ?1 AND is_active = 1",
                params![scope],
                |row| {
                    Ok(AccountInfo {
                        account_id: row.get(0)?,
                        label: row.get(1)?,
                        kind: row.get(2)?,
                        active: row.get::<_, i64>(3)? != 0,
                        gateway_active: row.get::<_, i64>(4)? != 0,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .context("reading active pi_account info")?;
        Ok(row)
    }

    /// The Gateway-selected account's info without touching the cipher.
    pub fn gateway_active_info(&self, scope: &str) -> Result<Option<AccountInfo>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let row: Option<AccountInfo> = conn
            .query_row(
                "SELECT account_id, label, kind, is_active, gateway_active, updated_at
				 FROM pi_accounts WHERE scope = ?1 AND gateway_active = 1",
                params![scope],
                |row| {
                    Ok(AccountInfo {
                        account_id: row.get(0)?,
                        label: row.get(1)?,
                        kind: row.get(2)?,
                        active: row.get::<_, i64>(3)? != 0,
                        gateway_active: row.get::<_, i64>(4)? != 0,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .context("reading Gateway-active pi_account info")?;
        Ok(row)
    }

    /// Read one account's credential by id, decrypted. `Ok(None)` when absent or
    /// when the account is opaque (holds no readable credential).
    pub fn credential(&self, scope: &str, account_id: &str) -> Result<Option<Value>> {
        let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>)> = {
            let conn = self.conn.lock().expect("pi-accounts mutex");
            conn.query_row(
                "SELECT nonce, ciphertext FROM pi_accounts
                 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("reading pi_account")?
        };
        let Some((Some(nonce), Some(ciphertext))) = row else {
            return Ok(None);
        };
        let plain = self.cipher.decrypt(&nonce, &ciphertext)?;
        Ok(Some(serde_json::from_slice(&plain)?))
    }

    /// Insert or replace an account in `scope` and make it the active one. The
    /// credential is sealed before it touches disk; pass `None` for an opaque
    /// account whose value Ryu cannot read back.
    pub fn upsert(
        &self,
        scope: &str,
        account_id: &str,
        label: &str,
        kind: &str,
        credential: Option<Value>,
    ) -> Result<()> {
        let sealed = credential
            .map(|v| serde_json::to_vec(&v).context("serializing pi account credential"))
            .transpose()?
            .map(|bytes| self.cipher.encrypt(&bytes))
            .transpose()?;
        let now = now_millis();
        let conn = self.conn.lock().expect("pi-accounts mutex");
        conn.execute(
            "INSERT INTO pi_accounts
				(scope, account_id, label, kind, nonce, ciphertext, is_active,
				 gateway_active, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?7)
             ON CONFLICT(scope, account_id) DO UPDATE SET
                 label = excluded.label,
                 kind = excluded.kind,
                 nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext,
                 is_active = 1,
                 updated_at = excluded.updated_at",
            params![
                scope,
                account_id,
                label,
                kind,
                sealed.as_ref().map(|(n, _)| n.as_slice()),
                sealed.as_ref().map(|(_, c)| c.as_slice()),
                now,
            ],
        )
        .context("writing pi_accounts (upsert)")?;
        // Exactly one active row per scope.
        conn.execute(
            "UPDATE pi_accounts SET is_active = 0
             WHERE scope = ?1 AND account_id <> ?2 AND is_active = 1",
            params![scope, account_id],
        )
        .context("clearing prior active pi_account")?;
        // The first account for a scope is also the Gateway default. Later logins
        // become personal-active only, leaving an operator's shared Gateway choice
        // untouched.
        conn.execute(
            "UPDATE pi_accounts SET gateway_active = 1
			 WHERE scope = ?1 AND account_id = ?2
			   AND kind = 'api_key'
			   AND NOT EXISTS (
				   SELECT 1 FROM pi_accounts
				   WHERE scope = ?1 AND gateway_active = 1
			   )",
            params![scope, account_id],
        )
        .context("seeding Gateway-active pi_account")?;
        Ok(())
    }

    /// Whether any account in `scope` currently holds exactly `credential`.
    /// Used to avoid stacking a duplicate account on a re-login that rotated
    /// nothing (the pi-ai `pi_terminal_login` hint answers success without
    /// writing a new credential).
    pub fn has_credential(&self, scope: &str, credential: &Value) -> Result<bool> {
        let accounts = self.list(scope)?;
        for info in accounts {
            if let Some(existing) = self.credential(scope, &info.account_id)? {
                if &existing == credential {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// The newest account in `scope` with a given label, if any. Used to refresh
    /// an opaque ACP sign-in instead of stacking duplicates.
    pub fn find_by_label(&self, scope: &str, label: &str) -> Result<Option<AccountInfo>> {
        let accounts = self.list(scope)?;
        Ok(accounts.into_iter().find(|a| a.label == label))
    }

    /// Mark `account_id` as the active account for `scope`. Returns `false` when
    /// no such account exists.
    pub fn set_active(&self, scope: &str, account_id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let n = conn
            .execute(
                "UPDATE pi_accounts SET is_active = 1, updated_at = ?3
                 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id, now_millis()],
            )
            .context("activating pi_account")?;
        if n == 0 {
            return Ok(false);
        }
        conn.execute(
            "UPDATE pi_accounts SET is_active = 0
             WHERE scope = ?1 AND account_id <> ?2 AND is_active = 1",
            params![scope, account_id],
        )
        .context("clearing prior active pi_account")?;
        Ok(true)
    }

    /// Mark `account_id` as the Gateway-active account for `scope`. Returns
    /// `false` when no such account exists.
    pub fn set_gateway_active(&self, scope: &str, account_id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let n = conn
            .execute(
                "UPDATE pi_accounts SET gateway_active = 1, updated_at = ?3
				 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id, now_millis()],
            )
            .context("activating Gateway pi_account")?;
        if n == 0 {
            return Ok(false);
        }
        conn.execute(
            "UPDATE pi_accounts SET gateway_active = 0
			 WHERE scope = ?1 AND account_id <> ?2 AND gateway_active = 1",
            params![scope, account_id],
        )
        .context("clearing prior Gateway-active pi_account")?;
        Ok(true)
    }

    /// Remove an account. Returns `true` if a row was removed.
    pub fn remove(&self, scope: &str, account_id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let was_gateway_active: bool = conn
            .query_row(
                "SELECT gateway_active FROM pi_accounts
				 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
                |row| Ok(row.get::<_, i64>(0)? != 0),
            )
            .optional()
            .context("checking Gateway-active pi_account before deletion")?
            .unwrap_or(false);
        let removed = conn
            .execute(
                "DELETE FROM pi_accounts WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
            )
            .context("deleting pi_account")?;
        if removed > 0 && was_gateway_active {
            conn.execute(
                "UPDATE pi_accounts SET gateway_active = 1
				 WHERE scope = ?1 AND account_id = (
					 SELECT account_id FROM pi_accounts
					 WHERE scope = ?1
					 ORDER BY is_active DESC, updated_at DESC, account_id ASC
					 LIMIT 1
				 )",
                params![scope],
            )
            .context("promoting replacement Gateway pi_account")?;
        }
        Ok(removed > 0)
    }
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("pi-accounts.db")
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

/// The process-global account vault, if it has been published.
pub fn global() -> Option<&'static AccountVault> {
    GLOBAL.get()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upsert_list_active_and_switch_round_trip() {
        let v = AccountVault::in_memory().unwrap();
        let scope = provider_scope("anthropic");
        assert!(v.list(&scope).unwrap().is_empty());

        v.upsert(
            &scope,
            "acct-1",
            "ada@x.io",
            KIND_OAUTH,
            Some(json!({ "type": "oauth", "access": "t1" })),
        )
        .unwrap();
        v.upsert(
            &scope,
            "acct-2",
            "bob@x.io",
            KIND_OAUTH,
            Some(json!({ "type": "oauth", "access": "t2" })),
        )
        .unwrap();

        let accounts = v.list(&scope).unwrap();
        assert_eq!(accounts.len(), 2);
        // The newest upsert is active; its label carries no credential.
        let active = accounts
            .iter()
            .find(|a| a.active)
            .expect("an active account");
        assert_eq!(active.account_id, "acct-2");
        assert!(
            accounts.iter().all(|a| !a.label.contains("t2")),
            "labels must never leak a credential"
        );

        // Switching flips the active row and preserves both credentials.
        assert!(v.set_active(&scope, "acct-1").unwrap());
        let (id, cred) = v.active_credential(&scope).unwrap().unwrap();
        assert_eq!(id, "acct-1");
        assert_eq!(cred["access"], "t1");
        assert!(!v.set_active(&scope, "nope").unwrap());
    }

    #[test]
    fn gateway_selection_is_independent_and_api_key_only() {
        let v = AccountVault::in_memory().unwrap();
        let scope = provider_scope("openrouter");

        v.upsert(
            &scope,
            "oauth",
            "subscription",
            KIND_OAUTH,
            Some(json!({ "type": "oauth", "access": "oauth-token" })),
        )
        .unwrap();
        assert!(v.gateway_credential(&scope).unwrap().is_none());

        v.upsert(
            &scope,
            "key-a",
            "Team key",
            KIND_API_KEY,
            Some(json!({ "type": "api_key", "key": "sk-team" })),
        )
        .unwrap();
        v.upsert(
            &scope,
            "key-b",
            "Lab key",
            KIND_API_KEY,
            Some(json!({ "type": "api_key", "key": "sk-lab" })),
        )
        .unwrap();

        let accounts = v.list(&scope).unwrap();
        assert!(accounts.iter().any(|a| a.active && a.account_id == "key-b"));
        assert!(accounts
            .iter()
            .any(|a| a.gateway_active && a.account_id == "key-a"));
        assert!(v.set_gateway_active(&scope, "key-b").unwrap());
        let (id, credential) = v.gateway_credential(&scope).unwrap().unwrap();
        assert_eq!(id, "key-b");
        assert_eq!(credential["key"], "sk-lab");
        assert!(v
            .list(&scope)
            .unwrap()
            .iter()
            .any(|a| a.active && a.account_id == "key-b"));
    }

    #[test]
    fn scopes_are_isolated() {
        let v = AccountVault::in_memory().unwrap();
        v.upsert(
            &provider_scope("anthropic"),
            "a",
            "claude",
            KIND_OAUTH,
            Some(json!({ "access": "claude-tok" })),
        )
        .unwrap();
        v.upsert(
            &acp_scope("npx claude-code-acp"),
            "a",
            "opaque",
            KIND_OPAQUE,
            None,
        )
        .unwrap();

        assert_eq!(v.count(&provider_scope("anthropic")).unwrap(), 1);
        assert_eq!(
            v.count(&provider_scope("openai-codex")).unwrap(),
            0,
            "a sibling provider's scope is untouched"
        );
        assert_eq!(v.count(&acp_scope("npx claude-code-acp")).unwrap(), 1);
        // The ACP scope holds an opaque account with no readable credential.
        assert!(v
            .active_credential(&acp_scope("npx claude-code-acp"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn the_credential_is_encrypted_at_rest() {
        let v = AccountVault::in_memory().unwrap();
        let scope = provider_scope("anthropic");
        let secret = "sk-oauth-secret";
        v.upsert(
            &scope,
            "a",
            "ada@x.io",
            KIND_OAUTH,
            Some(json!({ "access": secret })),
        )
        .unwrap();

        let raw: Vec<u8> = {
            let conn = v.conn.lock().unwrap();
            conn.query_row(
                "SELECT ciphertext FROM pi_accounts WHERE scope = ?1",
                params![scope],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert!(
            !String::from_utf8_lossy(&raw).contains(secret),
            "the plaintext must not be recoverable from the stored column"
        );
    }

    #[test]
    fn remove_drops_only_that_account() {
        let v = AccountVault::in_memory().unwrap();
        let scope = provider_scope("openai-codex");
        v.upsert(&scope, "a", "A", KIND_OAUTH, Some(json!({ "access": "x" })))
            .unwrap();
        v.upsert(&scope, "b", "B", KIND_OAUTH, Some(json!({ "access": "y" })))
            .unwrap();
        assert!(v.remove(&scope, "a").unwrap());
        assert!(!v.remove(&scope, "a").unwrap(), "removing twice is a no-op");

        let accounts = v.list(&scope).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "b");
        assert_eq!(v.count(&scope).unwrap(), 1);
    }

    #[test]
    fn scope_helpers_shape_the_keys() {
        assert_eq!(provider_scope("anthropic"), "provider:anthropic");
        assert_eq!(
            acp_scope("PI_CODING_AGENT_DIR=x pi-acp"),
            "acp:PI_CODING_AGENT_DIR=x pi-acp"
        );
        assert!(is_provider_scope("provider:anthropic"));
        assert!(is_acp_scope("acp:npx pi"));
        assert!(!is_provider_scope("acp:npx pi"));
        assert!(!is_acp_scope("provider:anthropic"));
        assert_eq!(scope_key("provider:anthropic"), "anthropic");
        assert_eq!(scope_key("acp:npx pi"), "npx pi");
    }
}
