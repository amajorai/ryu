//! Linked plan accounts: several Claude or ChatGPT sign-ins on one node.
//!
//! Each linked account is a separate config folder for the provider's own CLI
//! (`CLAUDE_CONFIG_DIR` for `claude`, `CODEX_HOME` for `codex`). Ryu creates the folder,
//! starts the CLI's own sign-in with that folder, and from then on runs every call for
//! that account with it. The CLI writes its sign-in there itself; Ryu never reads,
//! copies or stores it, and only asks the CLI for its status
//! (docs/subscription-cloud-sessions.md §0b).
//!
//! The implicit [`DEFAULT_ACCOUNT`] is the CLI's own default sign-in (no override), so a
//! node that links nothing keeps working as before.
//!
//! Only the node owner can link accounts on their node: every route here goes through
//! the same owner-only gate as the rest of the plan backends.

use super::Provider;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The CLI's own default sign-in on this node.
pub(crate) const DEFAULT_ACCOUNT: &str = "default";
/// The most accounts one owner may link per provider.
pub(crate) const MAX_ACCOUNTS_PER_PROVIDER: usize = 8;
const MAX_LABEL_CHARS: usize = 40;

/// A linked account. It holds no credential: only where the CLI keeps its own sign-in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanAccount {
    /// 12 lowercase hex characters.
    pub(crate) id: String,
    pub(crate) provider: ProviderId,
    /// The owner's own name for it ("work", "personal").
    pub(crate) label: String,
    pub(crate) created_at: u64,
}

/// A provider as it appears on the wire and in account keys.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    utoipa::ToSchema,
)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProviderId {
    Anthropic,
    Openai,
}

impl From<Provider> for ProviderId {
    fn from(provider: Provider) -> Self {
        match provider {
            Provider::Anthropic => Self::Anthropic,
            Provider::Openai => Self::Openai,
        }
    }
}

impl ProviderId {
    pub(crate) fn provider(self) -> Provider {
        match self {
            Self::Anthropic => Provider::Anthropic,
            Self::Openai => Provider::Openai,
        }
    }
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
        }
    }
    /// "Claude" or "Codex", for tags like "Claude · work".
    pub(crate) fn product(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude",
            Self::Openai => "Codex",
        }
    }
    /// The variable that points the provider's CLI at an account's config folder.
    pub(crate) fn config_env(self) -> &'static str {
        match self {
            Self::Anthropic => "CLAUDE_CONFIG_DIR",
            Self::Openai => "CODEX_HOME",
        }
    }
}

/// The key that cooldowns are tracked under: one per account, not per provider.
pub(crate) fn account_key(provider: Provider, account_id: &str) -> String {
    format!("{}:{account_id}", ProviderId::from(provider).wire())
}

/// A session's account pin, `<provider>:<id>`.
pub(crate) fn parse_pin(raw: &str) -> Option<(ProviderId, &str)> {
    let (provider, id) = raw.split_once(':')?;
    let provider = match provider {
        "anthropic" => ProviderId::Anthropic,
        "openai" => ProviderId::Openai,
        _ => return None,
    };
    id_ok(id).then_some((provider, id))
}

pub(crate) fn id_ok(id: &str) -> bool {
    id == DEFAULT_ACCOUNT
        || (id.len() == 12
            && id
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
}

/// A label the owner can read back: 1-40 characters, no control characters.
pub(crate) fn clean_label(raw: &str) -> Option<String> {
    let label = raw.trim();
    (!label.is_empty()
        && label.chars().count() <= MAX_LABEL_CHARS
        && !label.chars().any(char::is_control))
    .then(|| label.to_owned())
}

pub(crate) fn new_id() -> String {
    let mut bytes = [0_u8; 6];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
static ROOT: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_root_for_test(root: Option<PathBuf>) {
    *ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = root;
}

/// `<data dir>/state/plan-accounts/<provider>-<id>`: the account's CLI config folder.
/// `None` for the default account (the CLI's own default) or a malformed id, so no
/// caller can build a path outside this folder.
pub(crate) fn config_dir(provider: Provider, account_id: &str) -> Option<PathBuf> {
    if account_id == DEFAULT_ACCOUNT || !id_ok(account_id) {
        return None;
    }
    let rel = format!(
        "plan-accounts/{}-{account_id}",
        ProviderId::from(provider).wire()
    );
    #[cfg(test)]
    if let Some(root) = ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return Some(root.join(rel));
    }
    Some(crate::paths::state_path(&rel))
}

/// Make the account's folder, readable by the owner only.
pub(crate) fn create_dir(provider: Provider, account_id: &str) -> std::io::Result<PathBuf> {
    let dir = config_dir(provider, account_id)
        .ok_or_else(|| std::io::Error::other("not a linked account"))?;
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Delete the account's folder, and with it the CLI's own sign-in for that account.
pub(crate) fn remove_dir(provider: Provider, account_id: &str) -> std::io::Result<()> {
    let Some(dir) = config_dir(provider, account_id) else {
        return Ok(());
    };
    match std::fs::remove_dir_all(&dir) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
