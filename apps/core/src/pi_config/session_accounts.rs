//! Account custody for SDK-backed managed Pi sessions. Native proxy providers
//! retain their existing Gateway request-local dispatcher.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::sdk_account_routing::AccountChooser;
#[cfg(test)]
use crate::server::oauth_pool_policy::{Policy, Strategy};
#[cfg(test)]
use serde_json::json;

mod assets;
mod capture;
mod projection;

use assets::materialize_assets;
#[cfg(test)]
use assets::{sanitize_selected_cache, sanitize_selected_models};
use capture::{capture_with_vault, capture_with_vault_and_policy, hash_key, verify_account};
#[cfg(test)]
use projection::publish_auth;
use projection::{publish_api_key, publish_credential, reject_link};

#[cfg(test)]
#[path = "session_account_quota_tests.rs"]
mod quota_tests;

const AFFINITY_SCOPE: &str = "pi:conversation-account-affinity:v1";
static CAPTURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAccount {
    pub provider_id: String,
    pub account_id: String,
    pub session_key: String,
    #[serde(default = "oauth_kind")]
    pub credential_kind: String,
}

fn oauth_kind() -> String {
    super::accounts::KIND_OAUTH.to_owned()
}

impl SessionAccount {
    pub fn process_identity(&self) -> String {
        format!("{}:{}", self.provider_id, self.account_id)
    }

    pub fn directory(&self) -> PathBuf {
        super::config_dir()
            .join("account-sessions")
            .join(&self.session_key)
    }

    /// The sealed vault owns refresh. Pi receives an access-only projection,
    /// without a renewable token; real expiration stays in the vault. A turn
    /// exceeding token lifetime reports authentication failure and must retry.
    pub async fn prepare_turn(&self) -> Result<()> {
        let auth_key =
            account_auth_key(&self.provider_id).context("Captured Pi provider is unavailable")?;
        let vault = super::accounts::global().context("Pi account vault is unavailable")?;
        let kind = verify_account(
            vault,
            &super::accounts::provider_scope(auth_key),
            &self.account_id,
        )?;
        if kind != self.credential_kind {
            bail!("Captured Pi credential kind changed; start a new conversation");
        }
        if kind == super::accounts::KIND_OAUTH {
            let credential = super::subscription_request_credential_for_account(
                &self.provider_id,
                &self.account_id,
            )
            .await?;
            publish_credential(&self.directory(), auth_key, &credential)
        } else {
            let credential = vault
                .credential(&super::accounts::provider_scope(auth_key), &self.account_id)?
                .context("Captured Pi credential is unavailable")?;
            publish_api_key(&self.directory(), auth_key, &credential)
        }
    }

    /// Copy the managed extension/tool assets after their normal reconciliation,
    /// before spawning this process. Never copy shared auth or other sessions.
    pub fn materialize_assets(&self) -> Result<()> {
        materialize_assets(&super::config_dir(), &self.directory(), &self.provider_id)
    }

    /// The environment the Pi for this session needs on top of the shared
    /// [`super::secret_env::secret_env`]: an API-key account's key, which the
    /// projected `auth.json` names only by reference. Empty for OAuth.
    pub fn secret_env(&self) -> Result<Vec<(String, String)>> {
        if self.credential_kind != super::accounts::KIND_API_KEY {
            return Ok(Vec::new());
        }
        let auth_key =
            account_auth_key(&self.provider_id).context("Captured Pi provider is unavailable")?;
        let vault = super::accounts::global().context("Pi account vault is unavailable")?;
        let credential = vault
            .credential(&super::accounts::provider_scope(auth_key), &self.account_id)?
            .context("Captured Pi credential is unavailable")?;
        let key = credential
            .as_str()
            .or_else(|| credential.get("key").and_then(Value::as_str))
            .filter(|key| !key.trim().is_empty())
            .context("Captured Pi API key is unavailable")?;
        Ok(vec![(
            super::secret_env::SESSION_KEY_ENV.to_owned(),
            key.to_owned(),
        )])
    }

    /// Hold this session's credential projection for the life of one Pi
    /// instance. Several instances can share a session directory (a fresh
    /// session draining beside its replacement, or a pooled Pi that outlives
    /// a pool-key change), so the projection is removed only when the last
    /// lease is dropped. The OAuth access token in it is plaintext (Pi takes
    /// no template for OAuth), so it is kept only while a Pi process may read
    /// it. Take the lease before [`Self::prepare_turn`] writes the file.
    pub fn lease_projection(&self) -> ProjectionLease {
        ProjectionLease::acquire(self.session_key.clone(), self.directory())
    }
}

/// Live Pi instances per session key. The count is changed, and the last
/// lease removes the projection, under this lock, so a new instance's lease
/// is either counted before the removal or taken after it (and its
/// [`SessionAccount::prepare_turn`] then writes a fresh projection).
static LIVE_PROJECTIONS: std::sync::Mutex<std::collections::BTreeMap<String, usize>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// See [`SessionAccount::lease_projection`].
pub struct ProjectionLease {
    session_key: String,
    directory: PathBuf,
}

impl ProjectionLease {
    fn acquire(session_key: String, directory: PathBuf) -> Self {
        let mut live = LIVE_PROJECTIONS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *live.entry(session_key.clone()).or_insert(0) += 1;
        Self {
            session_key,
            directory,
        }
    }
}

impl Drop for ProjectionLease {
    fn drop(&mut self) {
        let mut live = LIVE_PROJECTIONS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let remaining = live.get_mut(&self.session_key).map(|count| {
            *count = count.saturating_sub(1);
            *count
        });
        if remaining.unwrap_or(0) == 0 {
            live.remove(&self.session_key);
            remove_projection_in(&self.directory);
        }
    }
}

fn remove_projection_in(directory: &Path) {
    let path = directory.join("auth.json");
    if reject_link(&path).is_err() {
        return;
    }
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(%error, "could not remove a Pi account projection"),
    }
}

/// Session keys (account-session folder names) of the conversations bound to
/// `account_id` of `provider_id`. Best-effort: an unreadable vault yields none.
pub fn session_keys_for_account(provider_id: &str, account_id: &str) -> Vec<String> {
    let Some(vault) = super::accounts::global() else {
        return Vec::new();
    };
    let Ok(entries) = vault.list(AFFINITY_SCOPE) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| vault.credential(AFFINITY_SCOPE, &entry.account_id).ok()?)
        .filter_map(|value| serde_json::from_value::<SessionAccount>(value).ok())
        .filter(|captured| captured.provider_id == provider_id && captured.account_id == account_id)
        .map(|captured| captured.session_key)
        .collect()
}

/// Copied provider lists in a session directory. Older builds copied them
/// verbatim, with every other provider's literal API key, the Core node
/// bearer and auth headers; [`materialize_assets`] regenerates them sanitized
/// before the session's next spawn, so the boot sweep simply removes them.
const COPIED_PROVIDER_LISTS: [&str; 2] = ["models.json", "models-store.json"];

/// Remove every per-session credential projection left by a Pi that did not
/// exit cleanly (Core crash, power loss), and every copied provider list an
/// older build may have left with plaintext keys in it. Called at Core boot,
/// before any Pi is spawned; a session regenerates both before its next spawn.
/// Returns how many files were removed.
pub fn sweep_projections() -> usize {
    sweep_projections_in(&super::config_dir().join("account-sessions"))
}

fn sweep_projections_in(root: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let directory = entry.path();
        let path = directory.join("auth.json");
        if path.exists() {
            remove_projection_in(&directory);
            removed += usize::from(!path.exists());
        }
        for name in COPIED_PROVIDER_LISTS {
            let path = directory.join(name);
            if reject_link(&path).is_err() {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(%error, file = name, "could not remove a Pi session provider list");
                }
            }
        }
    }
    removed
}

#[cfg(test)]
fn sdk_oauth_key(provider_id: &str) -> Option<&'static str> {
    let meta = super::provider_meta(provider_id)?;
    if [
        "claude-pro-max",
        super::CHATGPT_PROVIDER_ID,
        super::CHATGPT_PLAN_PROVIDER_ID,
    ]
    .contains(&provider_id)
        || !is_sdk_oauth_auth_key(meta.auth_key)
    {
        return None;
    }
    Some(meta.auth_key)
}

/// The vault auth key of a provider whose direct managed SDK sessions keep a
/// per-conversation account affinity, or `None` when the provider has none
/// (native proxies, managed rows, the Gateway).
pub(crate) fn account_auth_key(provider_id: &str) -> Option<&str> {
    if [
        super::KIRO_PROVIDER_ID,
        "claude-pro-max",
        super::CHATGPT_PROVIDER_ID,
        super::CHATGPT_PLAN_PROVIDER_ID,
        super::GATEWAY_PROVIDER_ID,
    ]
    .contains(&provider_id)
    {
        return None;
    }
    match super::provider_meta(provider_id) {
        Some(meta) if meta.credit_pool.is_empty() && !meta.auth_key.is_empty() => {
            Some(meta.auth_key)
        }
        Some(_) => None,
        None => Some(provider_id),
    }
}

pub(super) fn is_sdk_oauth_auth_key(auth_key: &str) -> bool {
    super::OAUTH_REFRESH_KEYS.contains(&auth_key)
        && ![
            super::KIRO_PROVIDER_ID,
            super::CLAUDE_AUTH_KEY,
            super::CHATGPT_AUTH_KEY,
            super::CHATGPT_PLAN_AUTH_KEY,
            "openai",
        ]
        .contains(&auth_key)
}

/// Capture once per conversation/provider/agent. Explicit overrides must match
/// existing affinity. Removing its login fails closed instead of selecting the
/// current account. Hashing all path inputs prevents path traversal.
pub fn capture(
    provider_id: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
    explicit_identity: Option<&str>,
) -> Result<Option<SessionAccount>> {
    let Some(auth_key) = account_auth_key(provider_id) else {
        return Ok(None);
    };
    let vault = super::accounts::global().context("Pi account vault is unavailable")?;
    capture_with_vault(
        vault,
        provider_id,
        auth_key,
        conversation_id,
        agent_id,
        explicit_identity,
    )
}

/// Resolve policy before either usage attribution or process dispatch captures
/// an account. Selection affects only a missing conversation affinity record.
pub async fn capture_for_turn(
    provider_id: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
) -> Result<Option<SessionAccount>> {
    if !super::sdk_account_routing::supported(provider_id) {
        return capture(provider_id, conversation_id, agent_id, None);
    }
    let preferences = match crate::learning::global_state() {
        Some(state) => state.preferences.clone(),
        None => crate::server::preferences::PreferencesStore::open_default()?,
    };
    let policy = crate::server::oauth_pool_policy::load(&preferences, provider_id).await;
    if super::sdk_account_routing::quota_observations_supported(provider_id) {
        if let Some(meta) = super::provider_meta(provider_id) {
            crate::server::oauth_pool_usage::warm_in_background(meta.id, &policy);
        }
    }
    let auth_key = account_auth_key(provider_id).context("Pi provider has no SDK account scope")?;
    let vault = super::accounts::global().context("Pi account vault is unavailable")?;
    static CHOOSER: OnceLock<std::sync::Mutex<AccountChooser>> = OnceLock::new();
    let mut chooser = CHOOSER
        .get_or_init(|| std::sync::Mutex::new(AccountChooser::default()))
        .lock()
        .map_err(|_| anyhow::anyhow!("Pi account chooser unavailable"))?;
    capture_with_vault_and_policy(
        vault,
        provider_id,
        auth_key,
        conversation_id,
        agent_id,
        None,
        &policy,
        &mut chooser,
    )
}

/// The account a conversation's existing affinity names, without creating,
/// refreshing or validating one. Never writes to the vault: a conversation with
/// no affinity yet reads `None`, and the next turn's capture still decides.
pub fn peek(
    provider_id: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
) -> Result<Option<String>> {
    let Some(vault) = super::accounts::global() else {
        return Ok(None);
    };
    peek_with_vault(vault, provider_id, conversation_id, agent_id)
}

fn peek_with_vault(
    vault: &super::accounts::AccountVault,
    provider_id: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
) -> Result<Option<String>> {
    if account_auth_key(provider_id).is_none() {
        return Ok(None);
    }
    let Some(conversation) = conversation_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let affinity_key = hash_key(&(provider_id, conversation, agent_id))?;
    let Some(value) = vault.credential(AFFINITY_SCOPE, &affinity_key)? else {
        return Ok(None);
    };
    let captured: SessionAccount = serde_json::from_value(value)?;
    let matches = captured.provider_id == provider_id && captured.session_key == affinity_key;
    Ok(matches.then_some(captured.account_id))
}

#[cfg(test)]
mod assets_tests;

#[cfg(test)]
mod capture_tests;

#[cfg(test)]
mod peek_tests;

#[cfg(test)]
mod policy_tests;

#[cfg(test)]
mod projection_tests;
