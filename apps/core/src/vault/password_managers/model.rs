//! Password-manager data: in-memory secret values, accounts, references,
//! grants, and resolution consumers and outcomes.
//!
//! test-exempt: code moved verbatim out of `mod.rs`; exercised by tests.rs
//! (`references_follow_the_grammar`, `secrets_are_redacted_and_zeroed`,
//! `ttl_grants_last_until_revoked_or_expired`).

use super::*;

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

    pub(super) fn parse(value: &str) -> Option<Self> {
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
    pub(super) fn prefix(self) -> &'static str {
        match self {
            Self::Op => "op://",
            Self::Bws => "bws://",
        }
    }

    pub(super) fn family(self) -> &'static str {
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

pub(super) fn is_valid_segment(segment: &str) -> bool {
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

pub(super) fn is_uuid(text: &str) -> bool {
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
    crate::vault::transit::is_valid_key_name(name)
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

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "once" => Some(Self::Once),
            "1h" => Some(Self::Hour),
            "24h" => Some(Self::Day),
            "30d" => Some(Self::Month),
            _ => None,
        }
    }

    pub(super) fn lifetime_millis(self) -> i64 {
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
    match ConsumerSubject::parse(subject) {
        ConsumerSubject::BrokerSession { minter } => {
            format!("A broker session minted by {minter}")
        }
        ConsumerSubject::ExplicitRead { principal } => format!("{principal} (explicit read)"),
        ConsumerSubject::Runtime { mcp, owner } => {
            format!("MCP server or plugin `{mcp}` running for {owner}")
        }
        ConsumerSubject::Other(subject) => subject.to_owned(),
    }
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
