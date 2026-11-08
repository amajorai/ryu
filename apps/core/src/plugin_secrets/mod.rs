//! Encrypted-at-rest secret stores for plugin BYOK and user-managed vault values.
//!
//! # Why this exists
//!
//! A plugin declares a bring-your-own-key credential in its manifest as an
//! `env:` token inside `secret_headers`, e.g.
//!
//! ```json
//! "secret_headers": { "Authorization": "Bearer env:RYU_TAVILY_API_KEY" }
//! ```
//!
//! Until this module existed that token had exactly ONE source: the Core
//! process environment. So switching the `web.search` capability from `exa` to
//! `tavily` — a one-click swap in the UI — silently produced an unauthenticated
//! tool, because there was no way to *set* `RYU_TAVILY_API_KEY` short of editing
//! a shell profile and restarting Core. Settings fields could not fill the gap:
//! they persist to PREFERENCES (plaintext KV), not to process env, and there was
//! no write-only masked control to render.
//!
//! This store is the second source. [`crate::tool_exec`]'s `env:` resolver falls
//! back to it under the SAME variable name for the CALLING plugin, so **no
//! manifest changes anything**: every BYOK plugin that already ships an `env:`
//! token — `exa`, `tavily`, and any third-party one — becomes UI-configurable at
//! once. The paired UI control is
//! [`ryu_kernel_contracts::SettingsFieldType::Secret`].
//!
//! # Shape
//!
//! Rows are keyed `(plugin_id, key)` and encrypted with the shared
//! [`ryu_crypto`] master key, mirroring [`ryu_memory`]: `nonce` + `ciphertext`
//! BLOB columns, with only non-sensitive metadata (`plugin_id`, `key`,
//! `updated_at`) in plaintext so the "which keys are set" listing can be
//! answered in SQL without ever touching the cipher. There is deliberately no
//! bulk "read every secret" API — [`PluginSecretStore::list_keys`] returns key
//! names and timestamps only, and it is the ONLY thing the REST surface exposes.
//!
//! # Scoped vault values
//!
//! The original `(plugin_id, key)` table remains the compatibility store for
//! manifest-declared `env:` values. The same encrypted database also carries
//! user-managed values keyed by an explicit scope (`user`, `node`, `team`, or
//! `org`) and an optional MCP binding. A reference such as `secret:GITHUB_TOKEN`
//! is resolved only at a governed tool-dispatch boundary; it is never expanded
//! into a chat prompt, transcript, tool schema, or REST response.
//!
//! Resolution is deterministic and fail-closed:
//!
//! ```text
//! user > node > project > team > org
//! ```
//!
//! Project values live only in the control plane and resolve through it for
//! a run whose project is known ([`SecretResolutionContext::project_id`]).
//!
//! At each scope, an exact MCP binding wins over an unbound value. Shared team
//! and organization values require a server-derived user context; a node bearer
//! without that context can use only node-local values. This keeps a client-
//! supplied `user_id` from becoming a secret authorization principal.
//!
//! # Placement
//!
//! Core-tier, next to [`crate::plugin_storage`] (this is what a plugin *runs
//! with*, not what it is *allowed* to do — the allow/deny half is the
//! `may_read_env_secret` namespace gate in `tool_exec`). It lives in
//! `apps/core` rather than a primitive crate because it is small and has no
//! second consumer yet; extract it the day one appears.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::FieldCipher;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub mod kv;
pub mod kv_meta;
pub mod migrate;
mod scope;
#[cfg(test)]
mod tests;

pub use scope::*;

pub use kv::{
    Generator, KvFolder, KvFolderReplace, KvFolderState, SecretCoords, SecretMetadata,
    SecretMetadataPatch, SecretStatus, VersionSource, WriteOptions, WriteRequest,
};

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// SQLite-backed, encrypted-at-rest `(plugin_id, key) -> secret` store.
/// Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct PluginSecretStore {
    pub(crate) conn: Arc<Mutex<Connection>>,
    pub(crate) keyring: Arc<crate::vault::keyring::Keyring>,
    pub(crate) audit_key: Arc<Vec<u8>>,
    /// Audit rows appended inside a still-open transaction. Their device
    /// fan-out and vault event wait until [`Self::flush_audit`] confirms the
    /// row was committed, so a rolled-back write never reaches a device or a
    /// subscriber.
    pending_audit: Arc<std::sync::Mutex<Vec<(crate::vault::audit::AuditRow, String)>>>,
}

impl PluginSecretStore {
    /// Open (or create) the store at a specific path, wrapping the vault
    /// keyring with the shared [`ryu_crypto`] master key. Fails closed if the
    /// key cannot be resolved: an ephemeral key would write rows that die on
    /// the next restart. A schema upgrade first copies the database to
    /// `<path>.v<old>.bak` so an operator can roll back.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening plugin-secrets db {}", path.display()))?;
        migrate::backup_before_upgrade(&conn, &path)?;
        // Seal card metadata an older build kept in plaintext before the store
        // serves anything, then scrub the freed pages and drop pre-upgrade
        // backups that still hold it (the sealed copy is committed first). The
        // seal records the scrub debt before rewriting anything, so a crash
        // after its commit, or deleted legacy rows left in free pages, are
        // still scrubbed at this or the next open.
        let sealed = crate::vault::items::cards::seal_legacy_card_rows(&conn)?;
        let owed = crate::vault::items::cards::card_scrub_owed(&conn)?;
        if sealed > 0 {
            if let Err(error) = ryu_crypto::content_sqlite::finish_store(
                &conn,
                &path,
                crate::vault::items::cards::CARD_STORE,
            ) {
                tracing::warn!(%error, "vault card metadata scrub deferred");
            }
        } else if owed {
            // Core's boot path: a store over `VACUUM_NOW_MAX_BYTES` only gets
            // its freelist scrub here; its `VACUUM` is deferred below.
            if let Err(error) = ryu_crypto::content_sqlite::run_pending_vacuum_gated(
                &conn,
                &path,
                crate::vault::items::cards::CARD_STORE,
            ) {
                tracing::warn!(%error, "vault card metadata scrub deferred");
            }
        }
        if sealed > 0 || owed {
            crate::vault::items::cards::remove_plaintext_card_backups(&path);
        }
        let compaction_owed = ryu_crypto::content_sqlite::compaction_owed(
            &conn,
            crate::vault::items::cards::CARD_STORE,
        )
        .unwrap_or(false);
        let store = Self::from_connection(conn, ryu_crypto::global_cipher()?)?;
        if compaction_owed {
            // Too large to compact while Core boots: the background worker
            // runs it later under this store's connection lock.
            ryu_crypto::content_sqlite::defer_compaction_with(
                crate::vault::items::cards::CARD_STORE,
                &path,
                &store.conn,
                |owner, run| run(&*owner.blocking_lock()),
            );
        }
        Ok(store)
    }

    /// In-memory store with an ephemeral key, for tests. Never touches the real
    /// keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory plugin-secrets db")?;
        Self::from_connection(conn, FieldCipher::new(&[0x37; 32]))
    }

    /// Build a store over an open connection: migrate the schema, load the
    /// keyring, and load (or create) the audit key.
    pub(crate) fn from_connection(conn: Connection, master: FieldCipher) -> Result<Self> {
        migrate::migrate(&conn)?;
        let keyring = crate::vault::keyring::Keyring::load(&conn, master)?;
        let audit_key = crate::vault::audit::load_or_create_key(&conn, keyring.master())?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            keyring: Arc::new(keyring),
            audit_key: Arc::new(audit_key),
            pending_audit: Arc::default(),
        })
    }

    /// Append one audit row while already holding the connection, fan it out
    /// to the enabled audit devices, and publish its vault event.
    ///
    /// Returns whether the operation may proceed. That is always `true`
    /// unless `RYU_VAULT_AUDIT_FAIL_CLOSED` is set, in which case it is `true`
    /// only when the chain append succeeded and at least one enabled
    /// synchronous device (file or syslog) accepted the row. Callers that
    /// hand out secret material (reveal, export, backup, runtime resolution,
    /// transit decrypt/sign/HMAC/datakey, TOTP codes, PKI issue, lease issue,
    /// snapshot export, unwrap, cubbyhole reads, vault and identity tokens)
    /// must honor `false`.
    ///
    /// Inside an open transaction the row is appended to the chain but its
    /// device fan-out and event are deferred until the caller commits and
    /// calls [`Self::flush_audit`]; such writes return `true` once the append
    /// succeeded, so a path that hands out a value must audit after its
    /// commit instead, on the autocommit connection.
    pub(crate) fn audit_locked(
        &self,
        conn: &Connection,
        entry: &crate::vault::audit::AuditEntry,
    ) -> bool {
        let fail_closed = crate::vault::audit_devices::fail_closed();
        let in_transaction = !conn.is_autocommit();
        if !in_transaction {
            self.flush_audit(conn);
        }
        match crate::vault::audit::append_row(conn, &self.audit_key, entry) {
            Ok(appended) if in_transaction => {
                if let Ok(mut pending) = self.pending_audit.lock() {
                    pending.push(appended);
                }
                true
            }
            Ok((row, chain_hmac)) => {
                let outcome =
                    crate::vault::audit_devices::dispatch(conn, &self.audit_key, &row, &chain_hmac);
                crate::vault::events::publish_row(&row);
                let permitted = crate::vault::audit_devices::permits(outcome, fail_closed);
                if !permitted {
                    tracing::warn!(
                        action = %row.action,
                        "fail-closed vault audit: no audit device accepted row {}",
                        row.seq
                    );
                }
                permitted
            }
            Err(error) => {
                // Without fail-closed mode the audit log is evidence, not the
                // authorization gate; a write failure is surfaced in logs and
                // never blocks the operation that already passed its checks.
                tracing::warn!("vault audit append failed: {error:#}");
                !fail_closed
            }
        }
    }

    /// Fan out audit rows that were appended inside a transaction, once that
    /// transaction has ended. A row is delivered only if the chain still holds
    /// it with the same link, so rows from a rolled-back transaction are
    /// dropped instead of reaching devices and subscribers. A no-op while a
    /// transaction is still open.
    pub(crate) fn flush_audit(&self, conn: &Connection) {
        if !conn.is_autocommit() {
            return;
        }
        let pending = match self.pending_audit.lock() {
            Ok(mut pending) if !pending.is_empty() => std::mem::take(&mut *pending),
            _ => return,
        };
        for (row, chain_hmac) in pending {
            let committed = conn
                .query_row(
                    "SELECT hmac FROM vault_audit WHERE seq = ?1",
                    rusqlite::params![row.seq],
                    |stored| stored.get::<_, String>(0),
                )
                .map(|stored| stored == chain_hmac)
                .unwrap_or(false);
            if committed {
                crate::vault::audit_devices::dispatch(conn, &self.audit_key, &row, &chain_hmac);
                crate::vault::events::publish_row(&row);
            }
        }
    }

    /// Append one audit row. See [`Self::audit_locked`] for the return value.
    pub async fn audit(&self, entry: &crate::vault::audit::AuditEntry) -> bool {
        let conn = self.conn.lock().await;
        self.audit_locked(&conn, entry)
    }

    /// Decrypt a row sealed with `key_version`, mapping a sealed vault to the
    /// typed error so callers can return `vault_sealed`.
    pub(crate) fn open_row(
        &self,
        key_version: u32,
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>> {
        self.keyring.decrypt(key_version, nonce, ciphertext)
    }

    /// Seal `plaintext` with the active data key.
    pub(crate) fn seal_row(&self, plaintext: &[u8]) -> Result<(u32, Vec<u8>, Vec<u8>)> {
        self.keyring.encrypt(plaintext)
    }

    /// Read and decrypt one secret. `Ok(None)` when unset.
    ///
    /// A row that fails to decrypt (master key rotated / db copied between
    /// machines / vault sealed) is treated as UNSET rather than as an error:
    /// the caller is the header resolver, whose "absent" path omits the header
    /// and lets the tool surface its own auth error. Turning a stale row into a
    /// hard failure would take the whole tool call down over a credential the
    /// user can simply re-enter.
    pub async fn get(&self, plugin_id: &str, key: &str) -> Result<Option<String>> {
        let row: Option<(u32, Vec<u8>, Vec<u8>)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT key_version, nonce, ciphertext FROM plugin_secrets
                 WHERE plugin_id = ?1 AND key = ?2",
                params![plugin_id, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("reading plugin_secrets")?
        };
        let Some((key_version, nonce, ciphertext)) = row else {
            return Ok(None);
        };
        match self.open_row(key_version, &nonce, &ciphertext) {
            Ok(plain) => Ok(Some(String::from_utf8_lossy(&plain).into_owned())),
            Err(e) => {
                tracing::warn!(
                    "plugin secret '{key}' for '{plugin_id}' could not be decrypted \
                     (master key changed or vault sealed?); treating it as unset: {e:#}"
                );
                Ok(None)
            }
        }
    }

    /// Store (or replace) a secret. The value is encrypted before it touches disk.
    ///
    /// An empty/whitespace-only value is a DELETE, not an empty secret: the `env:`
    /// resolver already treats an empty string as absent, so storing one would
    /// leave a row the UI reports as "set" and the resolver ignores.
    pub async fn set(&self, plugin_id: &str, key: &str, value: &str) -> Result<()> {
        if value.trim().is_empty() {
            return self.delete(plugin_id, key).await;
        }
        let (key_version, nonce, ciphertext) = self.seal_row(value.as_bytes())?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO plugin_secrets (plugin_id, key, nonce, ciphertext, updated_at, key_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(plugin_id, key) DO UPDATE SET
                 nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext,
                 updated_at = excluded.updated_at,
                 key_version = excluded.key_version",
            params![plugin_id, key, nonce, ciphertext, now_millis(), key_version],
        )
        .context("writing plugin_secrets")?;
        Ok(())
    }

    /// Delete a secret (no-op if absent).
    pub async fn delete(&self, plugin_id: &str, key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM plugin_secrets WHERE plugin_id = ?1 AND key = ?2",
            params![plugin_id, key],
        )
        .context("deleting plugin_secrets")?;
        Ok(())
    }

    /// Delete every secret owned by one plugin. Secret values are never loaded
    /// into memory for this operation; SQLite removes the encrypted rows in
    /// place and returns the affected-row count for cleanup reporting.
    pub async fn delete_plugin(&self, plugin_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM plugin_secrets WHERE plugin_id = ?1",
            params![plugin_id],
        )?)
    }

    /// Which secrets a plugin has set, newest write first. **Names and timestamps
    /// only** — the ciphertext columns are not even selected, so no code path from
    /// this function can leak a value.
    pub async fn list_keys(&self, plugin_id: &str) -> Result<Vec<SecretKeyInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT key, updated_at FROM plugin_secrets WHERE plugin_id = ?1
                 ORDER BY updated_at DESC, key ASC",
            )
            .context("preparing plugin_secrets keys query")?;
        let rows = stmt
            .query_map(params![plugin_id], |row| {
                Ok(SecretKeyInfo {
                    key: row.get(0)?,
                    updated_at: row.get(1)?,
                })
            })
            .context("querying plugin_secrets keys")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading plugin_secrets key row")?);
        }
        Ok(out)
    }

    /// The raw stored ciphertext for a row, for tests that must prove a response
    /// body leaks neither the plaintext NOR the encrypted form. Not part of the
    /// production API — there is deliberately no way to reach the bytes otherwise.
    #[cfg(test)]
    pub async fn raw_ciphertext_for_test(&self, plugin_id: &str, key: &str) -> Option<Vec<u8>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT ciphertext FROM plugin_secrets WHERE plugin_id = ?1 AND key = ?2",
            params![plugin_id, key],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .ok()
        .flatten()
    }
}

fn default_db_path() -> PathBuf {
    crate::paths::secret_path("plugin-secrets.db")
}

/// Open (or create) the store at the default path (`~/.ryu/plugin-secrets.db`).
pub fn open_default() -> Result<PluginSecretStore> {
    PluginSecretStore::open(default_db_path())
}

// ── Process-global handle (set in `main.rs`, like `plugin_storage::global`) ────

static GLOBAL: OnceLock<PluginSecretStore> = OnceLock::new();

/// Publish the process-global secret store. Idempotent (first set wins).
pub fn set_global(store: PluginSecretStore) {
    let _ = GLOBAL.set(store);
}

/// The process-global secret store, if it has been published.
///
/// A global rather than a threaded parameter because the primary reader,
/// `tool_exec::resolve_secret_token`, is a free async fn several layers below any
/// `ServerState` — exactly the situation [`crate::plugin_storage::global`] and
/// [`crate::identity::global`] already solve this way.
pub fn global() -> Option<&'static PluginSecretStore> {
    GLOBAL.get()
}
