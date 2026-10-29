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
//! user > node > team > org
//! ```
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

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_channel_contracts::credential_scope::{CredentialLevel, LADDER};
use ryu_crypto::FieldCipher;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub mod kv;
pub mod kv_meta;
pub mod migrate;

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

/// Whether `key` is a legal secret name: a C-identifier-shaped token, exactly the
/// alphabet a POSIX environment variable may use (`[A-Za-z_][A-Za-z0-9_]*`).
///
/// Delegates to the kernel contract's [`ryu_kernel_contracts::is_env_var_name`] so
/// the REST write path and the manifest validator cannot disagree: a `secret`
/// field the loader accepted must be a key this store will take, or the author
/// ships a field that only fails once a user presses Save.
///
/// The `env:` fallback looks this name up verbatim, so anything that could not be
/// an env var could never be read back — storing it would be a silent no-op the
/// user reads as "saved". The same rule keeps the value safe as a URL path segment
/// (no `/`, no `..`, no `%`).
pub fn is_valid_secret_key(key: &str) -> bool {
    ryu_kernel_contracts::is_env_var_name(key)
}

/// Maximum length of a user-managed vault name. Names intentionally share the
/// environment-variable grammar so the same reference can be used by MCP
/// headers and stdio environments without a second escaping rule.
pub const MAX_VAULT_SECRET_NAME_LEN: usize = 128;

/// Maximum plaintext value accepted by the user-managed vault. This bounds the
/// amount of secret material Core holds in memory during one write and prevents
/// an accidental paste from becoming an unbounded request body.
pub const MAX_VAULT_SECRET_VALUE_LEN: usize = 64 * 1024;

/// Maximum length of an opaque scope or MCP id stored alongside a secret.
pub const MAX_VAULT_SCOPE_ID_LEN: usize = 256;

/// Ownership scope for a user-managed vault value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretScope {
    /// Only the verified user who owns the value may resolve it.
    User,
    /// Every governed execution on one exact node may resolve it.
    Node,
    /// Members of one verified team may resolve it.
    Team,
    /// Members of one verified organization may resolve it.
    Org,
}

impl SecretScope {
    /// Stable wire/storage spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Node => "node",
            Self::Team => "team",
            Self::Org => "org",
        }
    }

    /// Parse a persisted or request value. Unknown values fail closed rather
    /// than being guessed into a broader scope.
    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "user" => Some(Self::User),
            "node" => Some(Self::Node),
            "team" => Some(Self::Team),
            "org" | "organization" => Some(Self::Org),
            _ => None,
        }
    }

    /// The vault scope for a contract level. The vault has no project level,
    /// so `project` is skipped; the match is exhaustive so a new contract
    /// level forces an explicit decision here.
    pub const fn from_credential_level(level: CredentialLevel) -> Option<Self> {
        match level {
            CredentialLevel::User => Some(Self::User),
            CredentialLevel::Node => Some(Self::Node),
            CredentialLevel::Project => None,
            CredentialLevel::Team => Some(Self::Team),
            CredentialLevel::Org => Some(Self::Org),
        }
    }

    /// Vault resolution precedence, most specific first, derived from the
    /// contract [`LADDER`] restricted to the levels the vault stores.
    pub fn precedence() -> impl Iterator<Item = Self> {
        LADDER.into_iter().filter_map(Self::from_credential_level)
    }
}

/// Optional consumer binding for a vault value. An absent binding is usable by
/// any supported MCP consumer in the caller's scope; an MCP binding narrows the
/// value to one exact server/plugin identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretBinding {
    /// The only runtime consumer kind currently supported.
    pub kind: SecretBindingKind,
    /// Stable MCP server or owning plugin id, never a display label.
    pub id: String,
}

/// Supported consumer binding kinds. Skills remain instruction text and do not
/// receive secret values; a skill can use a tool whose MCP binding resolves one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretBindingKind {
    Mcp,
}

impl SecretBinding {
    /// Validate a binding before it is persisted or used in a lookup.
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() || !is_valid_scope_id(&self.id) {
            bail!("MCP binding id is empty or invalid");
        }
        Ok(())
    }

    fn storage_parts(&self) -> (&'static str, &str) {
        match self.kind {
            SecretBindingKind::Mcp => ("mcp", self.id.as_str()),
        }
    }
}

/// Metadata returned by the vault listing. It deliberately contains no value,
/// nonce, ciphertext, or length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultSecretInfo {
    pub name: String,
    pub scope: SecretScope,
    pub scope_id: String,
    pub binding: Option<SecretBinding>,
    pub updated_at: i64,
    /// Environment slug (`default` for pre-environment values).
    pub environment: String,
    /// Normalized folder path (`/` for the root).
    pub path: String,
    /// Current version number (1-based).
    pub version: i64,
    pub metadata: kv::SecretMetadata,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    /// Epoch millis of the last value change (rotation clock).
    pub rotated_at: i64,
    /// Epoch millis of a soft delete; `None` while live.
    pub deleted_at: Option<i64>,
    /// Metadata check-and-set counter; bumped on every metadata change.
    pub metadata_version: i64,
}

/// Server-derived context used to resolve `secret:NAME`. The fields are built
/// from the current node and the owning chat conversation, never from the
/// model-authored arguments or the legacy client-supplied Composio selector.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecretResolutionContext {
    pub user_id: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub team_authority: Option<VerifiedTeamSecretScope>,
    pub node_id: String,
    /// Exact MCP/server/plugin aliases accepted for this dispatch. A value
    /// bound to any one of them is still narrower than an unbound value.
    pub mcp_ids: Vec<String>,
    /// Environment for unqualified references; `None` uses the node's active
    /// environment ([`crate::vault::active_environment`]).
    pub environment: Option<String>,
    /// Owning conversation, recorded on audit rows for correlation only.
    pub conversation_id: Option<String>,
    /// The verified owner's organization role names (`member`, `viewer`, …),
    /// so `role:<name>` policies apply at dispatch as they do in management.
    pub roles: Vec<String>,
    /// A bound node could not verify the owner's current principal (control
    /// plane unreachable, timeout, refusal, or no complete team list). Their
    /// role and team policy subjects are then unknown, so resolution fails
    /// closed instead of evaluating policies without the `role:`/`team:`
    /// denies that bind them.
    pub principal_unverified: bool,
    /// Policy subjects a human broker session recorded when it was minted
    /// (`user:<id>`, `role:<name>`, `team:<id>`). Their `role:`/`team:`
    /// entries apply only when the recorded `user:` subject is this
    /// context's user, the same subjects card substitution evaluates.
    pub minted_subjects: Vec<String>,
}

/// Team credential authority built only from a verified, current membership.
/// Sharing metadata alone cannot construct this witness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedTeamSecretScope {
    user_id: String,
    org_id: String,
    /// Teams whose Team-scope values this context may resolve. On a team node
    /// the control plane narrows these to the node's own team.
    team_ids: Vec<String>,
    /// Every team the owner holds in the org, for `team:<id>` policy
    /// subjects. Never narrowed: a deny bound to any of them applies.
    policy_team_ids: Vec<String>,
}

impl VerifiedTeamSecretScope {
    pub fn from_verified_caller(caller: &crate::identity_verify::VerifiedCaller) -> Option<Self> {
        let org_id = caller.org_id.as_ref()?;
        let team_ids: Vec<String> = caller
            .teams
            .iter()
            .filter(|team| &team.org_id == org_id)
            .map(|team| team.id.clone())
            .collect();
        Some(Self {
            user_id: caller.user_id.clone(),
            org_id: org_id.clone(),
            policy_team_ids: team_ids.clone(),
            team_ids,
        })
    }

    /// Replace the policy teams with the owner's complete team list in the
    /// org, as the control plane reports it alongside a narrowed principal.
    /// Candidate Team scopes stay limited to the verified `team_ids`.
    #[must_use]
    pub fn with_policy_team_ids(mut self, policy_team_ids: Vec<String>) -> Self {
        let mut ids = policy_team_ids;
        ids.extend(self.team_ids.iter().cloned());
        ids.retain(|id| is_valid_scope_id(id));
        ids.sort();
        ids.dedup();
        self.policy_team_ids = ids;
        self
    }

    fn allows(&self, context: &SecretResolutionContext, team_id: &str) -> bool {
        context.user_id.as_deref() == Some(self.user_id.as_str())
            && context.org_id.as_deref() == Some(self.org_id.as_str())
            && self.team_ids.iter().any(|id| id == team_id)
    }

    /// Every verified team of the context's owner, as policy subjects. Like
    /// management's caller subjects, this is independent of the single team
    /// the conversation or node requests as a candidate scope, so a
    /// `team:<id>`-bound deny applies to every member at dispatch.
    fn policy_team_ids(&self, context: &SecretResolutionContext) -> &[String] {
        if context.user_id.as_deref() == Some(self.user_id.as_str())
            && context.org_id.as_deref() == Some(self.org_id.as_str())
        {
            &self.policy_team_ids
        } else {
            &[]
        }
    }
}
impl SecretResolutionContext {
    /// Apply the owner's current principal to a bound node's dispatch
    /// context: `Some((caller, policy_team_ids))` when the control plane
    /// verified the owner and reported every team they hold in the org,
    /// `None` when the lookup failed or the team list is incomplete. A
    /// missing principal or team list leaves the owner's `role:`/`team:`
    /// policy subjects unknown, so the context fails closed
    /// ([`Self::principal_unverified`]).
    pub fn apply_owner_principal(
        &mut self,
        principal: Option<(&crate::identity_verify::VerifiedCaller, Option<Vec<String>>)>,
    ) {
        let verified = principal.and_then(|(caller, policy_team_ids)| {
            let authority = VerifiedTeamSecretScope::from_verified_caller(caller)?
                .with_policy_team_ids(policy_team_ids?);
            Some((authority, caller.role.label().to_owned()))
        });
        match verified {
            Some((authority, role)) => {
                self.team_authority = Some(authority);
                self.roles = vec![role];
                self.principal_unverified = false;
            }
            None => {
                self.team_authority = None;
                self.roles = Vec::new();
                self.principal_unverified = true;
            }
        }
    }

    /// Build a node-only context for a caller that has no user principal.
    pub fn node_only(node_id: impl Into<String>, mcp_ids: Vec<String>) -> Self {
        Self {
            node_id: node_id.into(),
            mcp_ids,
            ..Self::default()
        }
    }
}

/// Whether a vault name follows the bounded env-compatible grammar.
pub fn is_valid_vault_secret_name(name: &str) -> bool {
    name.len() <= MAX_VAULT_SECRET_NAME_LEN && is_valid_secret_key(name)
}

/// Whether an opaque scope id or MCP binding id is safe bounded metadata.
pub fn is_valid_scope_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_VAULT_SCOPE_ID_LEN
        && trimmed
            .chars()
            .all(|ch| !ch.is_control() && !ch.is_whitespace())
}

/// One entry in the "which secrets are set" listing. Carries NO value — by
/// construction, not by omission at the call site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretKeyInfo {
    /// The variable name, e.g. `RYU_TAVILY_API_KEY`.
    pub key: String,
    /// Epoch millis of the last write.
    pub updated_at: i64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn set_get_delete_round_trips() {
        let s = PluginSecretStore::in_memory().unwrap();
        assert_eq!(s.get("exa", "RYU_EXA_API_KEY").await.unwrap(), None);

        s.set("exa", "RYU_EXA_API_KEY", "sk-exa-1").await.unwrap();
        assert_eq!(
            s.get("exa", "RYU_EXA_API_KEY").await.unwrap().as_deref(),
            Some("sk-exa-1")
        );

        // Upsert replaces.
        s.set("exa", "RYU_EXA_API_KEY", "sk-exa-2").await.unwrap();
        assert_eq!(
            s.get("exa", "RYU_EXA_API_KEY").await.unwrap().as_deref(),
            Some("sk-exa-2")
        );

        s.delete("exa", "RYU_EXA_API_KEY").await.unwrap();
        assert_eq!(s.get("exa", "RYU_EXA_API_KEY").await.unwrap(), None);
        // Deleting an absent key is a no-op, not an error.
        s.delete("exa", "RYU_EXA_API_KEY").await.unwrap();
    }

    #[tokio::test]
    async fn delete_plugin_removes_only_the_requested_plugin() {
        let s = PluginSecretStore::in_memory().unwrap();
        s.set("exa", "RYU_EXA_API_KEY", "sk-exa").await.unwrap();
        s.set("tavily", "RYU_TAVILY_API_KEY", "sk-tavily")
            .await
            .unwrap();

        assert_eq!(s.delete_plugin("exa").await.unwrap(), 1);
        assert!(s.list_keys("exa").await.unwrap().is_empty());
        assert_eq!(s.list_keys("tavily").await.unwrap().len(), 1);
    }

    /// The point of the store: the plaintext must not survive the write. Asserted
    /// against the raw BLOB column, not the API, so a future "store it plainly for
    /// speed" refactor fails here.
    #[tokio::test]
    async fn the_value_is_encrypted_at_rest() {
        let s = PluginSecretStore::in_memory().unwrap();
        let secret = "sk-tavily-super-secret";
        s.set("tavily", "RYU_TAVILY_API_KEY", secret).await.unwrap();

        let raw: Vec<u8> = {
            let conn = s.conn.lock().await;
            conn.query_row(
                "SELECT ciphertext FROM plugin_secrets WHERE plugin_id = 'tavily'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_ne!(raw.as_slice(), secret.as_bytes());
        assert!(
            !String::from_utf8_lossy(&raw).contains("tavily-super"),
            "the plaintext must not be recoverable from the stored column"
        );
    }

    /// Rows are keyed by plugin: one plugin's key name never resolves to another's
    /// value. (The read-side namespace gate in `tool_exec` is the second layer.)
    #[tokio::test]
    async fn secrets_are_isolated_per_plugin() {
        let s = PluginSecretStore::in_memory().unwrap();
        s.set("exa", "RYU_SHARED_NAME", "exa-value").await.unwrap();
        s.set("tavily", "RYU_SHARED_NAME", "tavily-value")
            .await
            .unwrap();

        assert_eq!(
            s.get("exa", "RYU_SHARED_NAME").await.unwrap().as_deref(),
            Some("exa-value")
        );
        assert_eq!(
            s.get("tavily", "RYU_SHARED_NAME").await.unwrap().as_deref(),
            Some("tavily-value")
        );
        assert_eq!(s.get("other", "RYU_SHARED_NAME").await.unwrap(), None);
    }

    /// An empty (or whitespace-only) value CLEARS the secret rather than storing a
    /// blank one — an empty secret would read as "set" in the UI while the `env:`
    /// resolver treats it as absent.
    #[tokio::test]
    async fn an_empty_value_deletes_rather_than_storing_a_blank_secret() {
        let s = PluginSecretStore::in_memory().unwrap();
        s.set("exa", "RYU_EXA_API_KEY", "sk-exa").await.unwrap();

        s.set("exa", "RYU_EXA_API_KEY", "   ").await.unwrap();
        assert_eq!(s.get("exa", "RYU_EXA_API_KEY").await.unwrap(), None);
        assert!(
            s.list_keys("exa").await.unwrap().is_empty(),
            "a cleared secret must not linger in the listing as 'set'"
        );
    }

    #[tokio::test]
    async fn list_keys_reports_names_and_timestamps_only() {
        let s = PluginSecretStore::in_memory().unwrap();
        s.set("exa", "RYU_EXA_API_KEY", "sk-exa").await.unwrap();
        s.set("exa", "RYU_EXA_BASE", "https://x").await.unwrap();

        let keys = s.list_keys("exa").await.unwrap();
        assert_eq!(keys.len(), 2);
        let names: Vec<&str> = keys.iter().map(|k| k.key.as_str()).collect();
        assert!(names.contains(&"RYU_EXA_API_KEY"));
        assert!(names.contains(&"RYU_EXA_BASE"));
        assert!(
            keys.iter().all(|k| k.updated_at > 0),
            "each entry carries a write timestamp"
        );
        // Another plugin's listing is unaffected.
        assert!(s.list_keys("tavily").await.unwrap().is_empty());
    }

    #[test]
    fn secret_key_names_are_env_var_shaped() {
        for ok in ["RYU_EXA_API_KEY", "_private", "A1", "a_b_c"] {
            assert!(is_valid_secret_key(ok), "'{ok}' should be accepted");
        }
        for bad in [
            "",
            "1LEADING_DIGIT",
            "has-dash",
            "has space",
            "has/slash",
            "..",
            "unicodé",
        ] {
            assert!(!is_valid_secret_key(bad), "'{bad}' should be rejected");
        }
        assert!(!is_valid_secret_key(
            &"A".repeat(ryu_kernel_contracts::MAX_SECRET_KEY_LEN + 1)
        ));
    }

    #[tokio::test]
    async fn scoped_vault_values_are_encrypted_and_listed_without_values() {
        let store = PluginSecretStore::in_memory().unwrap();
        let binding = SecretBinding {
            kind: SecretBindingKind::Mcp,
            id: "github".to_owned(),
        };
        let info = store
            .set_vault_secret(
                SecretScope::Org,
                "org-1",
                Some(&binding),
                "GITHUB_TOKEN",
                "ghp-do-not-leak",
            )
            .await
            .unwrap()
            .expect("non-empty writes return metadata");
        assert_eq!(info.scope, SecretScope::Org);
        assert_eq!(info.binding, Some(binding.clone()));

        let raw: Vec<u8> = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT ciphertext FROM vault_secrets WHERE name = 'GITHUB_TOKEN'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert!(!String::from_utf8_lossy(&raw).contains("ghp-do-not-leak"));

        let listed = store.list_vault_secrets().await.unwrap();
        assert_eq!(listed, vec![info]);
    }

    #[tokio::test]
    async fn scoped_vault_resolution_uses_specific_scope_then_binding() {
        let store = PluginSecretStore::in_memory().unwrap();
        let github = SecretBinding {
            kind: SecretBindingKind::Mcp,
            id: "github".to_owned(),
        };
        store
            .set_vault_secret(SecretScope::Org, "org-1", None, "API_TOKEN", "org-default")
            .await
            .unwrap();
        store
            .set_vault_secret(
                SecretScope::Team,
                "team-1",
                None,
                "API_TOKEN",
                "team-default",
            )
            .await
            .unwrap();
        store
            .set_vault_secret(
                SecretScope::Node,
                "node-1",
                None,
                "API_TOKEN",
                "node-default",
            )
            .await
            .unwrap();
        store
            .set_vault_secret(
                SecretScope::User,
                "user-1",
                None,
                "API_TOKEN",
                "user-default",
            )
            .await
            .unwrap();
        store
            .set_vault_secret(
                SecretScope::Node,
                "node-1",
                Some(&github),
                "API_TOKEN",
                "github-node",
            )
            .await
            .unwrap();

        let context = SecretResolutionContext {
            user_id: Some("user-1".to_owned()),
            org_id: Some("org-1".to_owned()),
            team_id: Some("team-1".to_owned()),
            team_authority: None,
            node_id: "node-1".to_owned(),
            mcp_ids: vec!["github".to_owned()],
            ..Default::default()
        };
        // User scope outranks node scope, even when the node has an exact MCP
        // binding. This makes a user's explicit override predictable.
        assert_eq!(
            store
                .resolve_vault_secret("API_TOKEN", &context)
                .await
                .unwrap()
                .as_deref(),
            Some("user-default")
        );

        store
            .delete_vault_secret(SecretScope::User, "user-1", None, "API_TOKEN")
            .await
            .unwrap();
        assert_eq!(
            store
                .resolve_vault_secret("API_TOKEN", &context)
                .await
                .unwrap()
                .as_deref(),
            Some("github-node")
        );
    }

    #[tokio::test]
    async fn shared_scopes_are_not_read_without_a_verified_user_context() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .set_vault_secret(SecretScope::Org, "org-1", None, "API_TOKEN", "org-secret")
            .await
            .unwrap();
        let context = SecretResolutionContext::node_only("node-1", Vec::new());
        assert_eq!(
            store
                .resolve_vault_secret("API_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn team_secrets_require_current_membership_bound_to_user_and_org() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .set_vault_secret(
                SecretScope::Team,
                "target-team",
                None,
                "TEAM_TOKEN",
                "team-secret",
            )
            .await
            .unwrap();
        let mut context = SecretResolutionContext {
            user_id: Some("owner".into()),
            org_id: Some("org-1".into()),
            team_id: Some("target-team".into()),
            node_id: "node-1".into(),
            ..SecretResolutionContext::default()
        };
        // Previously forged sharing metadata is not an authorization witness.
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
        let mut caller = crate::identity_verify::VerifiedCaller {
            user_id: "owner".into(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".into()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        };
        context.team_authority = VerifiedTeamSecretScope::from_verified_caller(&caller);
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
        caller.teams.push(crate::identity_verify::TeamMembership {
            id: "target-team".into(),
            org_id: "other-org".into(),
            role: "member".into(),
        });
        context.team_authority = VerifiedTeamSecretScope::from_verified_caller(&caller);
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
        caller.teams[0].org_id = "org-1".into();
        context.team_authority = VerifiedTeamSecretScope::from_verified_caller(&caller);
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap()
                .as_deref(),
            Some("team-secret")
        );
        context.user_id = Some("different-user".into());
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
        context.user_id = Some("owner".into());
        context.org_id = Some("other-org".into());
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
        context.org_id = Some("org-1".into());
        // An unavailable/revoked authority still permits existing node secrets.
        context.team_authority = None;
        store
            .set_vault_secret(
                SecretScope::Node,
                "node-1",
                None,
                "TEAM_TOKEN",
                "node-secret",
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .resolve_vault_secret("TEAM_TOKEN", &context)
                .await
                .unwrap()
                .as_deref(),
            Some("node-secret")
        );
    }

    #[tokio::test]
    async fn vault_templates_preserve_literals_and_drop_unresolved_references() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .set_vault_secret(
                SecretScope::Node,
                "node-1",
                None,
                "GITHUB_TOKEN",
                "ghs-value",
            )
            .await
            .unwrap();
        let context = SecretResolutionContext::node_only("node-1", vec!["github".to_owned()]);
        assert_eq!(
            store
                .resolve_vault_template("Bearer secret:GITHUB_TOKEN", &context)
                .await
                .unwrap()
                .as_deref(),
            Some("Bearer ghs-value")
        );
        assert_eq!(
            store
                .resolve_vault_template("Bearer secret:MISSING_TOKEN", &context)
                .await
                .unwrap(),
            None
        );
    }
}
