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
use ryu_crypto::FieldCipher;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

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
}

/// Server-derived context used to resolve `secret:NAME`. The fields are built
/// from the current node and the owning chat conversation, never from the
/// model-authored arguments or the legacy client-supplied Composio selector.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecretResolutionContext {
    pub user_id: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub node_id: String,
    /// Exact MCP/server/plugin aliases accepted for this dispatch. A value
    /// bound to any one of them is still narrower than an unbound value.
    pub mcp_ids: Vec<String>,
}

impl SecretResolutionContext {
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
    conn: Arc<Mutex<Connection>>,
    cipher: FieldCipher,
}

impl PluginSecretStore {
    /// Open (or create) the store at a specific path, encrypting with the shared
    /// [`ryu_crypto`] master key. Fails closed if the key cannot be resolved —
    /// an ephemeral key would write rows that die on the next restart.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening plugin-secrets db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::global_cipher()?,
        })
    }

    /// In-memory store with an ephemeral key, for tests. Never touches the real
    /// keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory plugin-secrets db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: FieldCipher::new(&[0x37; 32]),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS plugin_secrets (
                 plugin_id  TEXT NOT NULL,
                 key        TEXT NOT NULL,
                 nonce      BLOB NOT NULL,
                 ciphertext BLOB NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (plugin_id, key)
             );
             CREATE TABLE IF NOT EXISTS vault_secrets (
                 scope        TEXT NOT NULL,
                 scope_id     TEXT NOT NULL,
                 binding_kind TEXT NOT NULL DEFAULT '',
                 binding_id   TEXT NOT NULL DEFAULT '',
                 name         TEXT NOT NULL,
                 nonce        BLOB NOT NULL,
                 ciphertext   BLOB NOT NULL,
                 updated_at   INTEGER NOT NULL,
                 PRIMARY KEY (scope, scope_id, binding_kind, binding_id, name)
             );
             CREATE INDEX IF NOT EXISTS idx_vault_secrets_scope
                 ON vault_secrets(scope, scope_id, updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_vault_secrets_name
                 ON vault_secrets(name, updated_at DESC);
             ",
        )
        .context("initializing plugin-secrets schema")?;
        // Additive columns, when this table eventually needs one, go through the
        // in-repo `PRAGMA table_info` + `ALTER TABLE` migration idiom (see
        // `ryu_memory::MemoryStore::add_column_if_missing`). None yet, so the
        // helper is not written out here.
        Ok(())
    }

    /// Read and decrypt one secret. `Ok(None)` when unset.
    ///
    /// A row that fails to decrypt (master key rotated / db copied between
    /// machines) is treated as UNSET rather than as an error: the caller is the
    /// header resolver, whose "absent" path omits the header and lets the tool
    /// surface its own auth error. Turning a stale row into a hard failure would
    /// take the whole tool call down over a credential the user can simply re-enter.
    pub async fn get(&self, plugin_id: &str, key: &str) -> Result<Option<String>> {
        let row: Option<(Vec<u8>, Vec<u8>)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT nonce, ciphertext FROM plugin_secrets WHERE plugin_id = ?1 AND key = ?2",
                params![plugin_id, key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("reading plugin_secrets")?
        };
        let Some((nonce, ciphertext)) = row else {
            return Ok(None);
        };
        match self.cipher.decrypt(&nonce, &ciphertext) {
            Ok(plain) => Ok(Some(String::from_utf8_lossy(&plain).into_owned())),
            Err(e) => {
                tracing::warn!(
                    "plugin secret '{key}' for '{plugin_id}' could not be decrypted \
                     (master key changed?); treating it as unset: {e:#}"
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
        let (nonce, ciphertext) = self.cipher.encrypt(value.as_bytes())?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO plugin_secrets (plugin_id, key, nonce, ciphertext, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(plugin_id, key) DO UPDATE SET
                 nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext,
                 updated_at = excluded.updated_at",
            params![plugin_id, key, nonce, ciphertext, now_millis()],
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

    /// Read and decrypt one user-managed vault value using the supplied
    /// server-derived context. The first matching candidate wins according to
    /// `user > node > team > org`; within each scope an exact MCP binding wins
    /// over an unbound value. No caller-supplied identity is accepted here.
    pub async fn resolve_vault_secret(
        &self,
        name: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        if !is_valid_vault_secret_name(name) {
            bail!("invalid vault secret name");
        }

        let mut scopes: Vec<(SecretScope, String)> = Vec::new();
        if let Some(user_id) = context
            .user_id
            .as_deref()
            .filter(|value| is_valid_scope_id(value))
        {
            scopes.push((SecretScope::User, user_id.to_owned()));
        }
        if is_valid_scope_id(&context.node_id) {
            scopes.push((SecretScope::Node, context.node_id.clone()));
        }
        // A shared value is never resolved without a server-derived user. This
        // prevents a raw node bearer or an agent-less background job from
        // turning an org/team name into a shared-secret read.
        if context.user_id.is_some() {
            if let Some(team_id) = context
                .team_id
                .as_deref()
                .filter(|value| is_valid_scope_id(value))
            {
                scopes.push((SecretScope::Team, team_id.to_owned()));
            }
            if let Some(org_id) = context
                .org_id
                .as_deref()
                .filter(|value| is_valid_scope_id(value))
            {
                scopes.push((SecretScope::Org, org_id.to_owned()));
            }
        }

        for (scope, scope_id) in scopes {
            for mcp_id in &context.mcp_ids {
                if !is_valid_scope_id(mcp_id) {
                    continue;
                }
                let binding = SecretBinding {
                    kind: SecretBindingKind::Mcp,
                    id: mcp_id.clone(),
                };
                if let Some(value) = self
                    .get_vault_value(scope, &scope_id, Some(&binding), name)
                    .await?
                {
                    return Ok(Some(value));
                }
            }
            if let Some(value) = self.get_vault_value(scope, &scope_id, None, name).await? {
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    /// Resolve `secret:NAME` tokens inside a server-side MCP header or
    /// environment template. Literal text is preserved exactly. If any secret
    /// reference is unavailable, the whole template is absent so a caller never
    /// accidentally sends the literal reference upstream.
    pub async fn resolve_vault_template(
        &self,
        template: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        let mut out = String::with_capacity(template.len());
        let mut cursor = 0;
        let mut saw_reference = false;

        while cursor < template.len() {
            let rest = &template[cursor..];
            let whitespace_len = rest
                .chars()
                .take_while(|character| character.is_whitespace())
                .map(char::len_utf8)
                .sum::<usize>();
            if whitespace_len > 0 {
                out.push_str(&rest[..whitespace_len]);
                cursor += whitespace_len;
                continue;
            }

            let word_len = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let word = &rest[..word_len];
            cursor += word_len;
            let Some(name) = word.strip_prefix("secret:") else {
                out.push_str(word);
                continue;
            };
            saw_reference = true;
            let value = self.resolve_vault_secret(name, context).await?;
            let Some(value) = value else {
                return Ok(None);
            };
            out.push_str(&value);
        }

        if saw_reference {
            Ok(Some(out))
        } else {
            Ok(Some(template.to_owned()))
        }
    }

    /// Store (or replace) one user-managed vault value. Empty/whitespace-only
    /// values clear the row, matching the plugin BYOK store's write-only UI
    /// semantics.
    pub async fn set_vault_secret(
        &self,
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
        value: &str,
    ) -> Result<Option<VaultSecretInfo>> {
        if !is_valid_vault_secret_name(name) {
            bail!("invalid vault secret name");
        }
        if !is_valid_scope_id(scope_id) {
            bail!("invalid vault secret scope id");
        }
        if let Some(binding) = binding {
            binding.validate()?;
        }
        if value.len() > MAX_VAULT_SECRET_VALUE_LEN {
            bail!("vault secret value exceeds the maximum allowed size");
        }
        if value.trim().is_empty() {
            self.delete_vault_secret(scope, scope_id, binding, name)
                .await?;
            return Ok(None);
        } else {
            let (nonce, ciphertext) = self.cipher.encrypt(value.as_bytes())?;
            let (binding_kind, binding_id) = binding
                .map(SecretBinding::storage_parts)
                .unwrap_or(("", ""));
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO vault_secrets
                    (scope, scope_id, binding_kind, binding_id, name, nonce, ciphertext, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(scope, scope_id, binding_kind, binding_id, name) DO UPDATE SET
                    nonce = excluded.nonce,
                    ciphertext = excluded.ciphertext,
                    updated_at = excluded.updated_at",
                params![
                    scope.as_str(),
                    scope_id.trim(),
                    binding_kind,
                    binding_id,
                    name,
                    nonce,
                    ciphertext,
                    now_millis(),
                ],
            )
            .context("writing vault_secrets")?;
        }

        // The row is read back as metadata only. This keeps the response shape
        // identical for both a set and a clear and never echoes the value.
        self.vault_secret_info(scope, scope_id, binding, name)
            .await
            .and_then(|info| {
                info.ok_or_else(|| anyhow::anyhow!("vault secret write did not persist"))
            })
            .map(Some)
    }

    /// Delete one user-managed value. Idempotent and metadata-free.
    pub async fn delete_vault_secret(
        &self,
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
    ) -> Result<()> {
        if !is_valid_vault_secret_name(name) {
            bail!("invalid vault secret name");
        }
        if !is_valid_scope_id(scope_id) {
            bail!("invalid vault secret scope id");
        }
        if let Some(binding) = binding {
            binding.validate()?;
        }
        let (binding_kind, binding_id) = binding
            .map(SecretBinding::storage_parts)
            .unwrap_or(("", ""));
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM vault_secrets
             WHERE scope = ?1 AND scope_id = ?2 AND binding_kind = ?3
               AND binding_id = ?4 AND name = ?5",
            params![
                scope.as_str(),
                scope_id.trim(),
                binding_kind,
                binding_id,
                name,
            ],
        )
        .context("deleting vault_secrets")?;
        Ok(())
    }

    /// List every user-managed value's metadata. Callers must filter this
    /// projection through their authorization context before returning it.
    /// Ciphertext columns are not selected, so this method cannot leak a value.
    pub async fn list_vault_secrets(&self) -> Result<Vec<VaultSecretInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT scope, scope_id, binding_kind, binding_id, name, updated_at
                 FROM vault_secrets
                 ORDER BY updated_at DESC, scope ASC, scope_id ASC, name ASC",
            )
            .context("preparing vault_secrets listing")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .context("querying vault_secrets listing")?;
        let mut out = Vec::new();
        for row in rows {
            let (scope, scope_id, binding_kind, binding_id, name, updated_at) =
                row.context("reading vault_secrets metadata")?;
            let Some(scope) = SecretScope::from_str(&scope) else {
                // Unknown future scopes are not exposed by an older binary.
                continue;
            };
            let binding = match binding_kind.as_str() {
                "" => None,
                "mcp" if is_valid_scope_id(&binding_id) => Some(SecretBinding {
                    kind: SecretBindingKind::Mcp,
                    id: binding_id,
                }),
                _ => continue,
            };
            out.push(VaultSecretInfo {
                name,
                scope,
                scope_id,
                binding,
                updated_at,
            });
        }
        Ok(out)
    }

    async fn vault_secret_info(
        &self,
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
    ) -> Result<Option<VaultSecretInfo>> {
        let (binding_kind, binding_id) = binding
            .map(SecretBinding::storage_parts)
            .unwrap_or(("", ""));
        let conn = self.conn.lock().await;
        let updated_at = conn
            .query_row(
                "SELECT updated_at FROM vault_secrets
                 WHERE scope = ?1 AND scope_id = ?2 AND binding_kind = ?3
                   AND binding_id = ?4 AND name = ?5",
                params![
                    scope.as_str(),
                    scope_id.trim(),
                    binding_kind,
                    binding_id,
                    name
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("reading vault secret metadata")?;
        Ok(updated_at.map(|updated_at| VaultSecretInfo {
            name: name.to_owned(),
            scope,
            scope_id: scope_id.trim().to_owned(),
            binding: binding.cloned(),
            updated_at,
        }))
    }

    async fn get_vault_value(
        &self,
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
    ) -> Result<Option<String>> {
        let (binding_kind, binding_id) = binding
            .map(SecretBinding::storage_parts)
            .unwrap_or(("", ""));
        let row: Option<(Vec<u8>, Vec<u8>)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT nonce, ciphertext FROM vault_secrets
                 WHERE scope = ?1 AND scope_id = ?2 AND binding_kind = ?3
                   AND binding_id = ?4 AND name = ?5",
                params![scope.as_str(), scope_id, binding_kind, binding_id, name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("reading vault_secrets")?
        };
        let Some((nonce, ciphertext)) = row else {
            return Ok(None);
        };
        match self.cipher.decrypt(&nonce, &ciphertext) {
            Ok(plain) => Ok(Some(String::from_utf8_lossy(&plain).into_owned())),
            Err(error) => {
                tracing::warn!(
                    scope = scope.as_str(),
                    name,
                    "vault secret could not be decrypted; treating it as unset: {error:#}"
                );
                Ok(None)
            }
        }
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
    crate::paths::ryu_dir().join("plugin-secrets.db")
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
            node_id: "node-1".to_owned(),
            mcp_ids: vec!["github".to_owned()],
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
