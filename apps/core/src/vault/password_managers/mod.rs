//! Password-manager credentials: 1Password and Bitwarden Secrets Manager
//! references resolved at use time, with per-consumer human approval.
//!
//! An **account** is a connection to one provider:
//!
//! * `1password-connect`: a 1Password Connect server URL and access token;
//! * `1password-service-account`: a service-account token for the `op` CLI;
//! * `bitwarden-sm`: a Bitwarden Secrets Manager access token for the `bws`
//!   CLI, with an optional self-hosted server URL.
//!
//! The token is sealed with the vault keyring in `vault_pm_accounts` (listed in
//! [`crate::vault::ENCRYPTED_TABLES`]) and never returned. A CLI binary is
//! resolved to an absolute path when the account is added (operator override
//! [`ENV_OP_BIN`] / [`ENV_BWS_BIN`], else `PATH`); request input never names a
//! program. An account is `connected` or `reconnect_required` (the provider
//! rejected its token on a test or a use; replacing the token reconnects it).
//!
//! A **reference** names one value ([`PmRef`]):
//!
//! ```text
//! op://[<account>@]<vault>/<item>[/<section>]/<field>
//! bws://[<account>@]<secret-uuid>
//! ```
//!
//! The account qualifier is needed only when more than one account of that
//! family (1Password or Bitwarden) exists. Vault, item, section, and field
//! segments are 1-128 characters of letters, digits, space, `.`, `_`, and `-`
//! (use the 1Password id for any other title).
//!
//! **Approval.** Nothing resolves without a grant for the exact (consumer
//! subject, account, reference). The first use by a consumer files a broker
//! credential-use proposal ([`crate::vault::broker::proposals::CredentialUse`])
//! and answers *pending* without contacting the provider. A human with `admin`
//! on [`account_key`] approves it once (one use within a day) or for `1h`,
//! `24h`, or `30d` (the default); grants are listed and revocable. A consumer
//! subject names its channel, so an approval for one channel never covers
//! another ([`broker_subject`], [`read_subject`], [`runtime_subject`]):
//!
//! * `broker:<minter>`: broker sessions minted by `user:<id>`,
//!   `machine:<id>`, or `operator`;
//! * `read:<principal>`: the explicit read API for `user:<id>` or `operator`;
//! * `runtime:<mcp>:<owner>`: a `secret:op://…` template of one MCP server or
//!   plugin running for `user:<id>` or `node:<id>`.
//!
//! Before any grant is consulted, the consumer's policies must allow `use` on
//! [`account_key`]: a machine identity's own grants (no baseline), or deny
//! rules for the user, team, and role subjects behind a user-minted broker
//! session or a runtime template.
//!
//! **Values** are fetched per use and never cached, written to SQLite, or
//! logged. Every resolution is audited with the provider, account, reference,
//! and subject (never the value); under fail-closed auditing a resolution
//! whose audit row no device accepted is refused and its value dropped.

pub mod providers;

#[cfg(test)]
pub(crate) mod tests;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::broker::proposals::{self, CredentialUse, Proposal, ProposalStatus};
use super::external::net;
use super::policy::{Capability, CapabilitySet, Policy};
use super::{is_valid_environment, now_millis, VaultError};
use crate::plugin_secrets::{
    PluginSecretStore, SecretResolutionContext, MAX_VAULT_SECRET_VALUE_LEN,
};
use providers::{FailureKind, ProviderFailure};

/// Policy-key prefix: `admin` on `sys/password-managers/<account>` manages the
/// account, approves its uses, and revokes its grants; `read` lets a human
/// read a reference through the explicit API (after approval); `use` lets a
/// machine-minted broker session use it (after approval).
pub const SYS_PASSWORD_MANAGERS: &str = "sys/password-managers";
/// Operator override for the `op` binary (absolute path).
pub const ENV_OP_BIN: &str = "RYU_VAULT_PM_OP_BIN";
/// Operator override for the `bws` binary (absolute path).
pub const ENV_BWS_BIN: &str = "RYU_VAULT_PM_BWS_BIN";
const MAX_TOKEN_LEN: usize = 8 * 1024;
const MAX_ADDRESS_LEN: usize = 512;
const MAX_REF_LEN: usize = 600;
const MAX_SEGMENT_LEN: usize = 128;
/// How long an approve-once grant stays usable.
pub const ONCE_WINDOW_MILLIS: i64 = 24 * 3600 * 1000;
/// Revoked, used, and expired grants are kept this long for the listing.
const GRANT_RETENTION_MILLIS: i64 = 30 * 24 * 3600 * 1000;

/// Policy key for one account.
pub fn account_key(name: &str) -> String {
    format!("{SYS_PASSWORD_MANAGERS}/{name}")
}

// ── Values in memory ──────────────────────────────────────────────────────

/// Overwrite `bytes` with zeros in a way the optimizer keeps.
pub(crate) fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: `byte` is a valid, aligned, exclusive reference.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// Zero a string's bytes (NUL is valid UTF-8) and clear it.
pub(crate) fn wipe_string(text: &mut String) {
    // SAFETY: zero bytes keep the buffer valid UTF-8.
    wipe(unsafe { text.as_bytes_mut() });
    text.clear();
}

/// A credential or token held only in memory and zeroed on drop.
pub struct Secret {
    bytes: Vec<u8>,
}

impl Secret {
    pub fn new(text: String) -> Self {
        Self {
            bytes: text.into_bytes(),
        }
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// The value as text (empty when it is not UTF-8).
    pub fn expose(&self) -> &str {
        std::str::from_utf8(&self.bytes).unwrap_or_default()
    }

    pub fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }

    /// The value as an owned string, for a caller that must hand it on.
    pub fn into_string(self) -> Option<String> {
        let bytes = self.into_bytes();
        match String::from_utf8(bytes) {
            Ok(text) => Some(text),
            Err(error) => {
                let mut bytes = error.into_bytes();
                wipe(&mut bytes);
                None
            }
        }
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.bytes);
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────

/// The password-manager product an account connects to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "1password-connect")]
    OnePasswordConnect,
    #[serde(rename = "1password-service-account")]
    OnePasswordServiceAccount,
    #[serde(rename = "bitwarden-sm")]
    BitwardenSm,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnePasswordConnect => "1password-connect",
            Self::OnePasswordServiceAccount => "1password-service-account",
            Self::BitwardenSm => "bitwarden-sm",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "1password-connect" => Some(Self::OnePasswordConnect),
            "1password-service-account" => Some(Self::OnePasswordServiceAccount),
            "bitwarden-sm" => Some(Self::BitwardenSm),
            _ => None,
        }
    }

    /// The reference scheme this provider resolves.
    pub fn scheme(self) -> PmScheme {
        match self {
            Self::BitwardenSm => PmScheme::Bws,
            _ => PmScheme::Op,
        }
    }
}

/// Whether the provider accepts the account's token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountState {
    Connected,
    ReconnectRequired,
}

/// An account (never its token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub name: String,
    pub provider: ProviderKind,
    /// Connect server URL, or a Bitwarden self-hosted server URL.
    pub address: Option<String>,
    /// Resolved CLI binary for CLI providers.
    pub binary_path: Option<String>,
    pub state: AccountState,
    pub last_error: Option<String>,
    pub last_checked_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Request to add an account.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub name: String,
    pub provider: ProviderKind,
    #[serde(default)]
    pub address: Option<String>,
    /// Refused: the CLI location is operator configuration, never request
    /// input.
    #[serde(default)]
    pub binary: Option<String>,
    pub token: String,
}

impl std::fmt::Debug for AccountInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountInput")
            .field("name", &self.name)
            .field("provider", &self.provider)
            .field("address", &self.address)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl Drop for AccountInput {
    fn drop(&mut self) {
        wipe_string(&mut self.token);
    }
}

// ── References ────────────────────────────────────────────────────────────

/// Reference scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PmScheme {
    /// `op://` (1Password).
    Op,
    /// `bws://` (Bitwarden Secrets Manager).
    Bws,
}

impl PmScheme {
    fn prefix(self) -> &'static str {
        match self {
            Self::Op => "op://",
            Self::Bws => "bws://",
        }
    }

    fn family(self) -> &'static str {
        match self {
            Self::Op => "1Password",
            Self::Bws => "Bitwarden Secrets Manager",
        }
    }
}

/// A parsed password-manager reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PmRef {
    pub scheme: PmScheme,
    /// Account name when qualified (`op://work@vault/item/field`).
    pub account: Option<String>,
    /// `vault, item, [section,] field` for `op://`, `uuid` for `bws://`.
    pub segments: Vec<String>,
}

fn is_valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_SEGMENT_LEN
        && segment != "."
        && segment != ".."
        && !segment.starts_with(' ')
        && !segment.ends_with(' ')
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'))
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether `text` has a password-manager scheme (it may still be invalid).
pub fn has_pm_scheme(text: &str) -> bool {
    text.starts_with("op://") || text.starts_with("bws://")
}

impl PmRef {
    /// Parse `op://[acct@]vault/item[/section]/field` or
    /// `bws://[acct@]<uuid>`.
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > MAX_REF_LEN {
            return None;
        }
        let (scheme, rest) = if let Some(rest) = text.strip_prefix("op://") {
            (PmScheme::Op, rest)
        } else {
            (PmScheme::Bws, text.strip_prefix("bws://")?)
        };
        let (account, rest) = match rest.split_once('@') {
            Some((account, rest)) => {
                if !is_valid_account_name(account) {
                    return None;
                }
                (Some(account.to_owned()), rest)
            }
            None => (None, rest),
        };
        let segments: Vec<String> = rest.split('/').map(str::to_owned).collect();
        let valid = match scheme {
            PmScheme::Op => {
                (3..=4).contains(&segments.len()) && segments.iter().all(|s| is_valid_segment(s))
            }
            PmScheme::Bws => segments.len() == 1 && is_uuid(&segments[0]),
        };
        valid.then_some(Self {
            scheme,
            account,
            segments,
        })
    }

    /// The reference as the provider understands it (no account qualifier).
    pub fn provider_ref(&self) -> String {
        match self.scheme {
            PmScheme::Op => format!("op://{}", self.segments.join("/")),
            PmScheme::Bws => self.segments.join("/"),
        }
    }

    /// The reference qualified with `account` (the grant and approval key).
    pub fn qualified(&self, account: &str) -> String {
        format!(
            "{}{account}@{}",
            self.scheme.prefix(),
            self.segments.join("/")
        )
    }

    /// `(vault, item, section, field)` for an `op://` reference.
    pub fn op_parts(&self) -> Option<(&str, &str, Option<&str>, &str)> {
        if self.scheme != PmScheme::Op {
            return None;
        }
        match self.segments.as_slice() {
            [vault, item, field] => Some((vault.as_str(), item.as_str(), None, field.as_str())),
            [vault, item, section, field] => Some((
                vault.as_str(),
                item.as_str(),
                Some(section.as_str()),
                field.as_str(),
            )),
            _ => None,
        }
    }
}

/// Account names: `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_valid_account_name(name: &str) -> bool {
    super::transit::is_valid_key_name(name)
}

// ── Grants ────────────────────────────────────────────────────────────────

/// How long an approval lasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum GrantMode {
    /// One use within [`ONCE_WINDOW_MILLIS`].
    #[serde(rename = "once")]
    Once,
    #[serde(rename = "1h")]
    Hour,
    #[serde(rename = "24h")]
    Day,
    /// The default: 30 days.
    #[default]
    #[serde(rename = "30d")]
    Month,
}

impl GrantMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Hour => "1h",
            Self::Day => "24h",
            Self::Month => "30d",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "once" => Some(Self::Once),
            "1h" => Some(Self::Hour),
            "24h" => Some(Self::Day),
            "30d" => Some(Self::Month),
            _ => None,
        }
    }

    fn lifetime_millis(self) -> i64 {
        match self {
            Self::Once | Self::Day => ONCE_WINDOW_MILLIS,
            Self::Hour => 3600 * 1000,
            Self::Month => 30 * 24 * 3600 * 1000,
        }
    }
}

/// A recorded approval for one consumer, account, and reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRecord {
    pub id: String,
    pub subject: String,
    pub account_id: String,
    pub account: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub mode: GrantMode,
    /// Remaining uses of an approve-once grant (`None`: until it expires).
    pub uses_remaining: Option<i64>,
    pub expires_at: i64,
    pub granted_by: String,
    pub proposal_id: Option<String>,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
}

/// Consumer subject for broker sessions minted by `minted_by`.
pub fn broker_subject(minted_by: &str) -> String {
    format!("broker:{minted_by}")
}

/// Consumer subject for the explicit read API called by `principal`.
pub fn read_subject(principal: &str) -> String {
    format!("read:{principal}")
}

/// Consumer subject for a runtime template of MCP server or plugin `mcp_id`
/// running for `owner` (`user:<id>` or `node:<id>`). `None` when the id is
/// unusable (empty, too long, whitespace, or `:`, which would make the
/// subject ambiguous).
pub fn runtime_subject(mcp_id: &str, owner: &str) -> Option<String> {
    (crate::plugin_secrets::is_valid_scope_id(mcp_id)
        && mcp_id.trim() == mcp_id
        && !mcp_id.contains(':'))
    .then(|| format!("runtime:{mcp_id}:{owner}"))
}

/// A consumer subject in words, for approval requests.
pub fn describe_subject(subject: &str) -> String {
    if let Some(minter) = subject.strip_prefix("broker:") {
        return format!("A broker session minted by {minter}");
    }
    if let Some(principal) = subject.strip_prefix("read:") {
        return format!("{principal} (explicit read)");
    }
    if let Some((mcp, owner)) = subject
        .strip_prefix("runtime:")
        .and_then(|rest| rest.split_once(':'))
    {
        return format!("MCP server or plugin `{mcp}` running for {owner}");
    }
    subject.to_owned()
}

/// Who is using a reference, for grant lookup and the approval request.
#[derive(Debug, Clone)]
pub struct Consumer {
    /// The channel-scoped grant subject (see [`broker_subject`],
    /// [`read_subject`], [`runtime_subject`]).
    pub subject: String,
    /// Who filed the request and may poll it (a broker session, or the
    /// subject itself).
    pub requested_by: String,
    /// The environment the request is filed in.
    pub environment: String,
    /// For a machine-minted broker session: the machine's policies, which
    /// must grant `use` on [`account_key`] (no baseline).
    pub machine_policies: Option<Vec<Policy>>,
    /// Policy subjects (`user:<id>`, `team:<id>`, `role:<name>`) whose rules
    /// apply to `use` on [`account_key`] over a `use` baseline, so explicit
    /// denies hold. Empty: no user policies apply (the operator, a node-owned
    /// template, or a route that checked its caller already).
    pub policy_subjects: Vec<String>,
}

/// The result of one resolution.
#[derive(Debug)]
pub enum PmOutcome {
    Value(Secret),
    /// No grant yet: the approval request (filed now or earlier). The provider
    /// was not contacted.
    Pending(Proposal),
}

// ── Schema and rows ───────────────────────────────────────────────────────

/// Create the password-manager tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_pm_accounts (
             id              TEXT PRIMARY KEY,
             name            TEXT NOT NULL UNIQUE,
             provider        TEXT NOT NULL,
             address         TEXT,
             binary_path     TEXT,
             state           TEXT NOT NULL DEFAULT 'connected',
             last_error      TEXT,
             last_checked_at INTEGER,
             nonce           BLOB NOT NULL,
             ciphertext      BLOB NOT NULL,
             key_version     INTEGER NOT NULL DEFAULT 0,
             created_at      INTEGER NOT NULL,
             updated_at      INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_pm_grants (
             id             TEXT PRIMARY KEY,
             subject        TEXT NOT NULL,
             account_id     TEXT NOT NULL,
             reference      TEXT NOT NULL,
             mode           TEXT NOT NULL,
             uses_remaining INTEGER,
             expires_at     INTEGER NOT NULL,
             granted_by     TEXT NOT NULL,
             proposal_id    TEXT,
             created_at     INTEGER NOT NULL,
             revoked_at     INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_vault_pm_grants_lookup
             ON vault_pm_grants (subject, account_id, reference);",
    )
    .context("initializing password-manager schema")
}

const ACCOUNT_COLUMNS: &str = "id, name, provider, address, binary_path, state, last_error,
    last_checked_at, created_at, updated_at";

fn account_from_row(row: &Row<'_>) -> rusqlite::Result<Option<AccountRecord>> {
    let Some(provider) = ProviderKind::parse(&row.get::<_, String>(2)?) else {
        return Ok(None);
    };
    let state: String = row.get(5)?;
    Ok(Some(AccountRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        provider,
        address: row.get(3)?,
        binary_path: row.get(4)?,
        state: if state == "reconnect_required" {
            AccountState::ReconnectRequired
        } else {
            AccountState::Connected
        },
        last_error: row.get(6)?,
        last_checked_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    }))
}

fn accounts_locked(conn: &Connection) -> Result<Vec<AccountRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM vault_pm_accounts ORDER BY name"
    ))?;
    let rows = stmt.query_map([], account_from_row)?;
    Ok(rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect())
}

fn account_locked(conn: &Connection, id: &str) -> Result<AccountRecord> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLUMNS} FROM vault_pm_accounts WHERE id = ?1"),
        params![id],
        account_from_row,
    )
    .optional()?
    .flatten()
    .ok_or_else(|| VaultError::NotFound(format!("password-manager account `{id}`")).into())
}

const GRANT_COLUMNS: &str = "g.id, g.subject, g.account_id, COALESCE(a.name, ''), g.reference,
    g.mode, g.uses_remaining, g.expires_at, g.granted_by, g.proposal_id, g.created_at,
    g.revoked_at";

fn grant_from_row(row: &Row<'_>) -> rusqlite::Result<GrantRecord> {
    let mode: String = row.get(5)?;
    Ok(GrantRecord {
        id: row.get(0)?,
        subject: row.get(1)?,
        account_id: row.get(2)?,
        account: row.get(3)?,
        reference: row.get(4)?,
        mode: GrantMode::parse(&mode).unwrap_or(GrantMode::Once),
        uses_remaining: row.get(6)?,
        expires_at: row.get(7)?,
        granted_by: row.get(8)?,
        proposal_id: row.get(9)?,
        created_at: row.get(10)?,
        revoked_at: row.get(11)?,
    })
}

fn grant_locked(conn: &Connection, id: &str) -> Result<GrantRecord> {
    conn.query_row(
        &format!(
            "SELECT {GRANT_COLUMNS} FROM vault_pm_grants g
             LEFT JOIN vault_pm_accounts a ON a.id = g.account_id WHERE g.id = ?1"
        ),
        params![id],
        grant_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("password-manager grant `{id}`")).into())
}

/// Delete grants whose usefulness ended more than the retention window ago.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    let cutoff = now - GRANT_RETENTION_MILLIS;
    Ok(conn.execute(
        "DELETE FROM vault_pm_grants
         WHERE expires_at <= ?1 OR (revoked_at IS NOT NULL AND revoked_at <= ?1)
            OR (uses_remaining = 0 AND created_at <= ?1)",
        params![cutoff],
    )?)
}

// ── Validation ────────────────────────────────────────────────────────────

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn validate_token(token: &str) -> Result<()> {
    if token.trim().is_empty() {
        return Err(invalid("`token` is required"));
    }
    if token.len() > MAX_TOKEN_LEN || token.chars().any(char::is_control) {
        return Err(invalid("`token` is invalid"));
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    /// Per-test CLI binary, so tests never mutate the shared process
    /// environment or depend on what `PATH` holds.
    static BINARY_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Use `path` as the CLI binary for accounts added on this test thread.
#[cfg(test)]
pub(crate) fn set_binary_for_test(path: Option<PathBuf>) {
    BINARY_OVERRIDE.with(|cell| *cell.borrow_mut() = path);
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn search_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_owned()]
    } else {
        vec![name.to_owned()]
    };
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)).collect::<Vec<_>>())
        .find(|candidate| is_executable_file(candidate))
}

/// The absolute CLI path for a CLI provider, resolved now.
fn resolve_binary(provider: ProviderKind) -> Result<Option<String>> {
    let (name, env) = match provider {
        ProviderKind::OnePasswordConnect => return Ok(None),
        ProviderKind::OnePasswordServiceAccount => ("op", ENV_OP_BIN),
        ProviderKind::BitwardenSm => ("bws", ENV_BWS_BIN),
    };
    #[cfg(test)]
    let overridden = BINARY_OVERRIDE.with(|cell| cell.borrow().clone());
    #[cfg(not(test))]
    let overridden: Option<PathBuf> = None;
    let configured = overridden.or_else(|| {
        std::env::var_os(env)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    });
    let candidate = match configured {
        Some(path) if !path.is_absolute() => {
            return Err(invalid(format!("{env} must be an absolute path")))
        }
        Some(path) => path,
        None => search_path(name).ok_or_else(|| {
            invalid(format!(
                "the `{name}` CLI was not found on the Core host's PATH; install it or set {env}"
            ))
        })?,
    };
    if !is_executable_file(&candidate) {
        return Err(invalid(format!(
            "the configured `{name}` CLI is not an executable file"
        )));
    }
    let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
    Ok(Some(resolved.display().to_string()))
}

fn validate_account(input: &AccountInput) -> Result<AccountRecord> {
    if !is_valid_account_name(&input.name) {
        return Err(invalid("invalid account name"));
    }
    validate_token(&input.token)?;
    if input
        .binary
        .as_deref()
        .is_some_and(|b| !b.trim().is_empty())
    {
        return Err(invalid(format!(
            "`binary` is not accepted; set {ENV_OP_BIN} or {ENV_BWS_BIN} on the Core host instead"
        )));
    }
    let address = input
        .address
        .as_deref()
        .map(str::trim)
        .filter(|address| !address.is_empty());
    let address = match (input.provider, address) {
        (ProviderKind::OnePasswordConnect, None) => {
            return Err(invalid(
                "1password-connect accounts need the Connect server `address`",
            ))
        }
        (ProviderKind::OnePasswordServiceAccount, Some(_)) => {
            return Err(invalid(
                "1password-service-account accounts take no `address`",
            ))
        }
        (_, Some(address)) => {
            if address.len() > MAX_ADDRESS_LEN {
                return Err(invalid("address is too long"));
            }
            let url = net::validate_address(address, net::Egress::from_env())
                .map_err(|error| invalid(error.to_string()))?;
            Some(url.as_str().trim_end_matches('/').to_owned())
        }
        (_, None) => None,
    };
    let binary_path = resolve_binary(input.provider)?;
    let now = now_millis();
    Ok(AccountRecord {
        id: format!("pma_{}", uuid::Uuid::new_v4().simple()),
        name: input.name.clone(),
        provider: input.provider,
        address,
        binary_path,
        state: AccountState::Connected,
        last_error: None,
        last_checked_at: None,
        created_at: now,
        updated_at: now,
    })
}

/// Pick the account a reference names: the qualified one, or the only
/// account of the reference's family.
fn select_account(conn: &Connection, reference: &PmRef) -> Result<AccountRecord> {
    let family: Vec<AccountRecord> = accounts_locked(conn)?
        .into_iter()
        .filter(|account| account.provider.scheme() == reference.scheme)
        .collect();
    if let Some(name) = &reference.account {
        return family
            .into_iter()
            .find(|account| &account.name == name)
            .ok_or_else(|| {
                VaultError::NotFound(format!(
                    "no {} account named `{name}`",
                    reference.scheme.family()
                ))
                .into()
            });
    }
    let mut family = family.into_iter();
    match (family.next(), family.next()) {
        (Some(account), None) => Ok(account),
        (None, _) => Err(VaultError::NotFound(format!(
            "no {} account is connected",
            reference.scheme.family()
        ))
        .into()),
        (Some(_), Some(_)) => Err(invalid(format!(
            "several {} accounts exist; qualify the reference as {}<account>@…",
            reference.scheme.family(),
            reference.scheme.prefix()
        ))),
    }
}

fn short(text: &str) -> String {
    let mut text = text.to_owned();
    text.truncate(300);
    text
}

/// Record the outcome of a provider call on the account.
fn record_check(conn: &Connection, id: &str, result: Result<(), &ProviderFailure>) -> Result<()> {
    let now = now_millis();
    match result {
        Ok(()) => conn.execute(
            "UPDATE vault_pm_accounts SET state = 'connected', last_error = NULL,
                 last_checked_at = ?1 WHERE id = ?2",
            params![now, id],
        )?,
        Err(failure) => conn.execute(
            "UPDATE vault_pm_accounts
             SET state = CASE WHEN ?1 THEN 'reconnect_required' ELSE state END,
                 last_error = ?2, last_checked_at = ?3 WHERE id = ?4",
            params![
                failure.kind == FailureKind::Auth,
                short(&failure.message),
                now,
                id
            ],
        )?,
    };
    Ok(())
}

/// A grant usable now, consuming one use of an approve-once grant. Returns
/// the grant and whether a use was consumed.
fn take_grant(
    conn: &Connection,
    subject: &str,
    account_id: &str,
    reference: &str,
    now: i64,
) -> Result<Option<(GrantRecord, bool)>> {
    let grant = conn
        .query_row(
            &format!(
                "SELECT {GRANT_COLUMNS} FROM vault_pm_grants g
                 LEFT JOIN vault_pm_accounts a ON a.id = g.account_id
                 WHERE g.subject = ?1 AND g.account_id = ?2 AND g.reference = ?3
                   AND g.revoked_at IS NULL AND g.expires_at > ?4
                   AND (g.uses_remaining IS NULL OR g.uses_remaining > 0)
                 ORDER BY (g.uses_remaining IS NULL) DESC, g.expires_at DESC LIMIT 1"
            ),
            params![subject, account_id, reference, now],
            grant_from_row,
        )
        .optional()?;
    let Some(grant) = grant else {
        return Ok(None);
    };
    if grant.uses_remaining.is_none() {
        return Ok(Some((grant, false)));
    }
    let consumed = conn.execute(
        "UPDATE vault_pm_grants SET uses_remaining = uses_remaining - 1
         WHERE id = ?1 AND uses_remaining > 0 AND revoked_at IS NULL",
        params![grant.id],
    )?;
    Ok((consumed == 1).then_some((grant, true)))
}

/// Give back a use consumed for a resolution that released nothing.
fn restore_grant(conn: &Connection, grant: &GrantRecord, consumed: bool) {
    if !consumed {
        return;
    }
    if let Err(error) = conn.execute(
        "UPDATE vault_pm_grants SET uses_remaining = uses_remaining + 1 WHERE id = ?1",
        params![grant.id],
    ) {
        tracing::warn!("restoring a password-manager grant failed: {error:#}");
    }
}

fn failure_outcome(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Auth => "reconnect_required",
        FailureKind::NotFound => "not_found",
        FailureKind::Unavailable => "error",
    }
}

impl PluginSecretStore {
    // ── Accounts ──────────────────────────────────────────────────────────

    /// Add an account; the token is sealed with the keyring.
    pub async fn pm_account_create(
        &self,
        input: AccountInput,
        actor: &AuditActor,
    ) -> Result<AccountRecord> {
        let record = validate_account(&input)?;
        let (key_version, nonce, ciphertext) = self.seal_row(input.token.as_bytes())?;
        drop(input);
        let conn = self.conn.lock().await;
        let exists = conn
            .query_row(
                "SELECT 1 FROM vault_pm_accounts WHERE name = ?1",
                params![record.name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            return Err(VaultError::Conflict(format!(
                "password-manager account `{}` exists",
                record.name
            ))
            .into());
        }
        conn.execute(
            "INSERT INTO vault_pm_accounts
                (id, name, provider, address, binary_path, state, nonce, ciphertext,
                 key_version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'connected', ?6, ?7, ?8, ?9, ?9)",
            params![
                record.id,
                record.name,
                record.provider.as_str(),
                record.address,
                record.binary_path,
                nonce,
                ciphertext,
                key_version,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.account.create", "ok").details(json!({
                "account": record.name, "provider": record.provider.as_str(),
            })),
        );
        Ok(record)
    }

    /// Every account (no tokens).
    pub async fn pm_account_list(&self) -> Result<Vec<AccountRecord>> {
        let conn = self.conn.lock().await;
        accounts_locked(&conn)
    }

    /// One account (no token).
    pub async fn pm_account(&self, id: &str) -> Result<AccountRecord> {
        let conn = self.conn.lock().await;
        account_locked(&conn, id)
    }

    /// The account a reference resolves through.
    pub async fn pm_account_for_ref(&self, reference: &PmRef) -> Result<AccountRecord> {
        let conn = self.conn.lock().await;
        select_account(&conn, reference)
    }

    /// Replace an account's token (reconnect).
    pub async fn pm_account_set_token(
        &self,
        id: &str,
        mut token: String,
        actor: &AuditActor,
    ) -> Result<AccountRecord> {
        let checked = validate_token(&token);
        let sealed = checked.and_then(|()| self.seal_row(token.as_bytes()));
        wipe_string(&mut token);
        let (key_version, nonce, ciphertext) = sealed?;
        let conn = self.conn.lock().await;
        let record = account_locked(&conn, id)?;
        conn.execute(
            "UPDATE vault_pm_accounts
             SET nonce = ?1, ciphertext = ?2, key_version = ?3, state = 'connected',
                 last_error = NULL, updated_at = ?4
             WHERE id = ?5",
            params![nonce, ciphertext, key_version, now_millis(), id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.account.reconnect", "ok")
                .details(json!({ "account": record.name })),
        );
        account_locked(&conn, id)
    }

    /// Remove an account, its grants, and its pending approval requests.
    pub async fn pm_account_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let record = account_locked(&conn, id)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM vault_pm_grants WHERE account_id = ?1",
            params![id],
        )?;
        for proposal in proposals::list(&tx, Some(ProposalStatus::Pending))? {
            if proposal
                .credential_use
                .as_ref()
                .is_some_and(|credential_use| credential_use.account_id == id)
            {
                proposals::decide(
                    &tx,
                    &proposal.id,
                    ProposalStatus::Rejected,
                    "system",
                    "the password-manager account was removed",
                )?;
            }
        }
        tx.execute("DELETE FROM vault_pm_accounts WHERE id = ?1", params![id])?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "pm.account.delete", "ok")
                .details(json!({ "account": record.name })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(())
    }

    /// The account's unsealed token.
    fn pm_token_locked(&self, conn: &Connection, id: &str) -> Result<Secret> {
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let (key_version, nonce, ciphertext): (u32, Vec<u8>, Vec<u8>) = conn.query_row(
            "SELECT key_version, nonce, ciphertext FROM vault_pm_accounts WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(Secret::from_bytes(self.open_row(
            key_version,
            &nonce,
            &ciphertext,
        )?))
    }

    /// Check an account's connectivity and token. Never returns a value.
    pub async fn pm_account_test(&self, id: &str, actor: &AuditActor) -> Result<AccountRecord> {
        let (record, token) = {
            let conn = self.conn.lock().await;
            let record = account_locked(&conn, id)?;
            let token = self.pm_token_locked(&conn, id)?;
            (record, token)
        };
        let result = providers::check(&record, &token).await;
        drop(token);
        let conn = self.conn.lock().await;
        record_check(&conn, id, result.as_ref().map(|_| ()))?;
        let outcome = match &result {
            Ok(()) => "ok",
            Err(failure) => failure_outcome(failure.kind),
        };
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.account.test", outcome).details(json!({
                "account": record.name, "provider": record.provider.as_str(),
            })),
        );
        result?;
        account_locked(&conn, id)
    }

    // ── Resolution ────────────────────────────────────────────────────────

    /// Resolve a reference for `consumer`: a value when a grant covers it,
    /// otherwise the pending approval request (the provider is not
    /// contacted). Every outcome is audited without the value.
    pub async fn pm_resolve(
        &self,
        text: &str,
        consumer: &Consumer,
        actor: &AuditActor,
    ) -> Result<PmOutcome> {
        let reference = PmRef::parse(text)
            .ok_or_else(|| invalid(format!("invalid password-manager reference `{text}`")))?;
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let environment = if is_valid_environment(&consumer.environment) {
            consumer.environment.clone()
        } else {
            super::DEFAULT_ENVIRONMENT.to_owned()
        };
        let now = now_millis();
        let (account, qualified, grant, consumed, token) = {
            let conn = self.conn.lock().await;
            let account = select_account(&conn, &reference)?;
            let qualified = reference.qualified(&account.name);
            let details = json!({
                "provider": account.provider.as_str(),
                "account": account.name,
                "ref": qualified,
                "subject": consumer.subject,
            });
            if let Some(policies) = &consumer.machine_policies {
                let caps = super::policy::evaluate(
                    &CapabilitySet::new(),
                    policies,
                    &account_key(&account.name),
                );
                if !caps.contains(&Capability::Use) {
                    self.audit_locked(
                        &conn,
                        &AuditEntry::new(actor, "pm.resolve", "denied").details(details),
                    );
                    return Err(VaultError::Denied(format!(
                        "the machine identity lacks `use` on `{}`",
                        account_key(&account.name)
                    ))
                    .into());
                }
            }
            if !consumer.policy_subjects.is_empty() {
                let policies = super::policy::policies_for(&conn, &consumer.policy_subjects)?;
                let templates =
                    super::policy_ext::TemplateContext::from_subjects(&consumer.policy_subjects);
                let use_only: CapabilitySet = [Capability::Use].into_iter().collect();
                let caps = super::policy::evaluate_with(
                    &use_only,
                    &policies,
                    &account_key(&account.name),
                    &templates,
                );
                if !caps.contains(&Capability::Use) {
                    self.audit_locked(
                        &conn,
                        &AuditEntry::new(actor, "pm.resolve", "denied").details(details),
                    );
                    return Err(VaultError::Denied(format!(
                        "a policy denies `use` on `{}`",
                        account_key(&account.name)
                    ))
                    .into());
                }
            }
            let Some((grant, consumed)) =
                take_grant(&conn, &consumer.subject, &account.id, &qualified, now)?
            else {
                let proposal = proposals::create_credential_use(
                    &conn,
                    CredentialUse {
                        reference: qualified.clone(),
                        account_id: account.id.clone(),
                        account: account.name.clone(),
                        provider: account.provider.as_str().to_owned(),
                        subject: consumer.subject.clone(),
                    },
                    &environment,
                    &consumer.requested_by,
                )?;
                let mut details = details;
                details["approval"] = json!(proposal.id);
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "pm.resolve", "pending").details(details),
                );
                return Ok(PmOutcome::Pending(proposal));
            };
            let token = match self.pm_token_locked(&conn, &account.id) {
                Ok(token) => token,
                Err(error) => {
                    restore_grant(&conn, &grant, consumed);
                    return Err(error);
                }
            };
            (account, qualified, grant, consumed, token)
        };
        let fetched = providers::fetch(&account, &token, &reference).await;
        drop(token);
        let fetched = fetched.and_then(|value| {
            if value.as_bytes().is_empty() {
                Err(ProviderFailure {
                    kind: FailureKind::NotFound,
                    message: "the reference resolved to an empty value".into(),
                })
            } else if value.as_bytes().len() > MAX_VAULT_SECRET_VALUE_LEN {
                Err(ProviderFailure {
                    kind: FailureKind::Unavailable,
                    message: "the value is too large".into(),
                })
            } else {
                Ok(value)
            }
        });
        let conn = self.conn.lock().await;
        let checked = match &fetched {
            Ok(_) => Ok(()),
            Err(failure) => Err(failure),
        };
        if let Err(error) = record_check(&conn, &account.id, checked) {
            tracing::warn!("recording password-manager account state failed: {error:#}");
        }
        let details = json!({
            "provider": account.provider.as_str(),
            "account": account.name,
            "ref": qualified,
            "subject": consumer.subject,
            "grant": grant.id,
        });
        match fetched {
            Ok(value) => {
                let permitted = self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "pm.resolve", "ok").details(details),
                );
                if !permitted {
                    restore_grant(&conn, &grant, consumed);
                    drop(value);
                    return Err(VaultError::AuditUnavailable.into());
                }
                Ok(PmOutcome::Value(value))
            }
            Err(failure) => {
                restore_grant(&conn, &grant, consumed);
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "pm.resolve", failure_outcome(failure.kind))
                        .details(details),
                );
                Err(anyhow::Error::new(failure))
            }
        }
    }

    /// `secret:op://…` / `secret:bws://…` in a runtime template: the MCP
    /// server or plugin that asked (the context's first MCP id), running for
    /// its owner (`user:<id>`, else `node:<id>`), is the consumer, so a grant
    /// covers that server alone. The owner's user, team, and role policies
    /// must not deny `use` on the account. A pending approval, a denial, or a
    /// provider failure leaves the reference absent (resolution stops); a
    /// sealed vault or a refused fail-closed audit is an error.
    pub(crate) async fn pm_resolve_for_runtime(
        &self,
        text: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        let actor = match &context.user_id {
            Some(user) => AuditActor::new("user", Some(user)),
            None => AuditActor::new("agent", None),
        };
        // The owner's role and team denies are unknown: fail closed, and
        // record the refused use like any other `pm.resolve` denial.
        if context.principal_unverified {
            tracing::warn!(
                "password-manager reference unresolved: the owner's principal is unverified"
            );
            self.audit(
                &AuditEntry::new(&actor, "pm.resolve", "denied").details(json!({
                    "ref": PmRef::parse(text).map(|_| text),
                    "mcpIds": context.mcp_ids,
                    "conversationId": context.conversation_id,
                    "reason": "principal_unverified",
                })),
            )
            .await;
            return Ok(None);
        }
        let owner = match &context.user_id {
            Some(user) => format!("user:{user}"),
            None => format!("node:{}", context.node_id),
        };
        let Some(subject) = context
            .mcp_ids
            .first()
            .and_then(|mcp_id| runtime_subject(mcp_id, &owner))
        else {
            tracing::warn!(
                "password-manager reference unresolved: the runtime context names no MCP server"
            );
            return Ok(None);
        };
        let environment = context
            .environment
            .clone()
            .filter(|environment| is_valid_environment(environment))
            .unwrap_or_else(super::active_environment);
        let consumer = Consumer {
            subject: subject.clone(),
            requested_by: subject,
            environment,
            machine_policies: None,
            policy_subjects: Self::context_subjects(context),
        };
        match self.pm_resolve(text, &consumer, &actor).await {
            Ok(PmOutcome::Value(value)) => Ok(value.into_string()),
            Ok(PmOutcome::Pending(proposal)) => {
                tracing::info!(
                    approval = proposal.id,
                    "password-manager reference awaits approval"
                );
                Ok(None)
            }
            Err(error)
                if error.downcast_ref::<VaultError>().is_some_and(|e| {
                    matches!(e, VaultError::Sealed | VaultError::AuditUnavailable)
                }) =>
            {
                Err(error)
            }
            Err(error) => {
                tracing::warn!("password-manager reference unresolved: {error:#}");
                Ok(None)
            }
        }
    }

    // ── Approvals and grants ──────────────────────────────────────────────

    /// A credential-use request.
    pub async fn pm_approval(&self, id: &str) -> Result<Proposal> {
        let conn = self.conn.lock().await;
        match proposals::get(&conn, id)? {
            Some(proposal) if proposal.credential_use.is_some() => Ok(proposal),
            _ => Err(VaultError::NotFound(format!("password-manager approval `{id}`")).into()),
        }
    }

    /// Credential-use requests, newest first.
    pub async fn pm_approvals(&self, status: Option<ProposalStatus>) -> Result<Vec<Proposal>> {
        let conn = self.conn.lock().await;
        if let Err(error) = proposals::expire(&conn, now_millis()) {
            tracing::warn!("expiring proposals failed: {error:#}");
        }
        Ok(proposals::list(&conn, status)?
            .into_iter()
            .filter(|proposal| proposal.credential_use.is_some())
            .collect())
    }

    /// Approve a pending credential-use request with `mode`, recording the
    /// grant in the same transaction.
    pub async fn pm_approve(
        &self,
        id: &str,
        mode: GrantMode,
        note: &str,
        decided_by: &str,
        actor: &AuditActor,
    ) -> Result<GrantRecord> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let proposal = proposals::pending(&tx, id)?;
        let Some(credential_use) = proposal.credential_use else {
            return Err(invalid("not a password-manager approval request"));
        };
        account_locked(&tx, &credential_use.account_id)?;
        if !proposals::decide(&tx, id, ProposalStatus::Approved, decided_by, note)? {
            return Err(
                VaultError::Conflict(format!("approval `{id}` is no longer pending")).into(),
            );
        }
        let now = now_millis();
        let grant_id = format!("pmg_{}", uuid::Uuid::new_v4().simple());
        tx.execute(
            "INSERT INTO vault_pm_grants
                (id, subject, account_id, reference, mode, uses_remaining, expires_at,
                 granted_by, proposal_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                grant_id,
                credential_use.subject,
                credential_use.account_id,
                credential_use.reference,
                mode.as_str(),
                (mode == GrantMode::Once).then_some(1_i64),
                now + mode.lifetime_millis(),
                decided_by,
                id,
                now
            ],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "pm.approval.approve", "ok").details(json!({
                "approval": id, "grant": grant_id, "mode": mode.as_str(),
                "account": credential_use.account, "ref": credential_use.reference,
                "subject": credential_use.subject,
            })),
        );
        let grant = grant_locked(&tx, &grant_id)?;
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(grant)
    }

    /// Reject a pending credential-use request.
    pub async fn pm_reject(
        &self,
        id: &str,
        note: &str,
        decided_by: &str,
        actor: &AuditActor,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let proposal = proposals::pending(&conn, id)?;
        if proposal.credential_use.is_none() {
            return Err(invalid("not a password-manager approval request"));
        }
        if !proposals::decide(&conn, id, ProposalStatus::Rejected, decided_by, note)? {
            return Err(
                VaultError::Conflict(format!("approval `{id}` is no longer pending")).into(),
            );
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.approval.reject", "ok").details(json!({ "approval": id })),
        );
        Ok(())
    }

    /// Grants, newest first: only active ones unless `include_inactive`.
    pub async fn pm_grant_list(&self, include_inactive: bool) -> Result<Vec<GrantRecord>> {
        let conn = self.conn.lock().await;
        let now = now_millis();
        if let Err(error) = prune(&conn, now) {
            tracing::warn!("pruning password-manager grants failed: {error:#}");
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT {GRANT_COLUMNS} FROM vault_pm_grants g
             LEFT JOIN vault_pm_accounts a ON a.id = g.account_id
             WHERE ?1 OR (g.revoked_at IS NULL AND g.expires_at > ?2
                          AND (g.uses_remaining IS NULL OR g.uses_remaining > 0))
             ORDER BY g.created_at DESC LIMIT 500"
        ))?;
        let rows = stmt.query_map(params![include_inactive, now], grant_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One grant.
    pub async fn pm_grant(&self, id: &str) -> Result<GrantRecord> {
        let conn = self.conn.lock().await;
        grant_locked(&conn, id)
    }

    /// Revoke a grant; the consumer's next use asks for approval again.
    pub async fn pm_grant_revoke(&self, id: &str, actor: &AuditActor) -> Result<GrantRecord> {
        let conn = self.conn.lock().await;
        let grant = grant_locked(&conn, id)?;
        conn.execute(
            "UPDATE vault_pm_grants SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now_millis(), id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.grant.revoke", "ok").details(json!({
                "grant": id, "account": grant.account, "ref": grant.reference,
                "subject": grant.subject,
            })),
        );
        grant_locked(&conn, id)
    }
}
