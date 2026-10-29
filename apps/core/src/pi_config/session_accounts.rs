//! Account custody for SDK-backed managed Pi sessions. Native proxy providers
//! retain their existing Gateway request-local dispatcher.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::sdk_account_routing::AccountChooser;
use crate::server::oauth_pool_policy::{Policy, Strategy};

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

fn capture_with_vault(
    vault: &super::accounts::AccountVault,
    provider_id: &str,
    auth_key: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
    explicit_identity: Option<&str>,
) -> Result<Option<SessionAccount>> {
    capture_with_vault_and_policy(
        vault,
        provider_id,
        auth_key,
        conversation_id,
        agent_id,
        explicit_identity,
        &Policy::default(),
        &mut AccountChooser::default(),
    )
}

fn capture_with_vault_and_policy(
    vault: &super::accounts::AccountVault,
    provider_id: &str,
    auth_key: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
    explicit_identity: Option<&str>,
    policy: &Policy,
    chooser: &mut AccountChooser,
) -> Result<Option<SessionAccount>> {
    let _guard = CAPTURE_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Pi account capture lock unavailable"))?;
    let scope = super::accounts::provider_scope(auth_key);
    let conversation = conversation_id.filter(|id| !id.is_empty());
    let affinity_key = conversation
        .map(|id| hash_key(&(provider_id, id, agent_id)))
        .transpose()?;
    let existing = affinity_key
        .as_deref()
        .map(|key| vault.credential(AFFINITY_SCOPE, key))
        .transpose()?
        .flatten();
    if let Some(value) = existing {
        let captured: SessionAccount = serde_json::from_value(value)?;
        if captured.provider_id != provider_id
            || affinity_key.as_deref() != Some(&captured.session_key)
        {
            bail!("Pi conversation account binding is invalid");
        }
        if explicit_identity.is_some_and(|identity| identity != captured.process_identity()) {
            bail!("Pi conversation account changed; start a new conversation");
        }
        if !policy.allowed(&captured.account_id) {
            bail!("This conversation's Pi account is disabled; enable it again or start a new conversation");
        }
        if verify_account(vault, &scope, &captured.account_id)? != captured.credential_kind {
            bail!("Captured Pi credential kind changed; start a new conversation");
        }
        return Ok(Some(captured));
    }
    let explicit_account = explicit_identity
        .map(|identity| {
            identity
                .strip_prefix(&format!("{provider_id}:"))
                .filter(|account| !account.is_empty())
                .context("Pi account identity does not match the selected provider")
        })
        .transpose()?;
    let account_id = match explicit_account {
        Some(account) => account.to_owned(),
        None => {
            if policy.strategy != Strategy::Manual {
                let accounts = vault.list(&scope)?;
                let kinds = super::sdk_account_routing::credential_kinds(provider_id);
                let mut candidates = Vec::new();
                for account in &accounts {
                    if account.needs_reauth
                        || !kinds.contains(&account.kind.as_str())
                        || !policy.allowed(&account.account_id)
                    {
                        continue;
                    }
                    if vault
                        .credential(&scope, &account.account_id)?
                        .is_some_and(|credential| {
                            sdk_credential_usable(auth_key, &account.kind, &credential)
                        })
                    {
                        if let Some(revision) =
                            vault.credential_revision(&scope, &account.account_id)?
                        {
                            candidates.push((account.account_id.as_str(), revision));
                        }
                    }
                }
                let captured: Vec<_> = candidates
                    .iter()
                    .map(
                        |(account_id, revision)| crate::server::oauth_pool_usage::Candidate {
                            account_id,
                            revision,
                        },
                    )
                    .collect();
                chooser
                    .select_captured(provider_id, &captured, None, policy)?
                    .context("No enabled SDK accounts have usable credentials")?
            } else {
                let Some(active) = vault.active_info(&scope)? else {
                    return Ok(None);
                };
                active.account_id
            }
        }
    };
    if !policy.allowed(&account_id) {
        bail!("This Pi account is disabled for new conversations");
    }
    let credential_kind = verify_account(vault, &scope, &account_id)?;
    if credential_kind == super::accounts::KIND_API_KEY
        && super::provider_meta(provider_id).is_some_and(|meta| meta.auth_kind == "subscription")
    {
        bail!("This Pi provider requires an OAuth account");
    }
    if credential_kind == super::accounts::KIND_OAUTH && !is_sdk_oauth_auth_key(auth_key) {
        if auth_key == super::CLAUDE_AUTH_KEY {
            return Ok(None);
        }
        bail!("This Pi OAuth provider has no account-qualified refresh flow; use a supported provider or an API-key account");
    }
    let session_key = affinity_key.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let captured = SessionAccount {
        provider_id: provider_id.to_owned(),
        account_id,
        session_key,
        credential_kind,
    };
    if conversation.is_some() {
        vault.upsert(
            AFFINITY_SCOPE,
            &captured.session_key,
            "Pi conversation account",
            super::accounts::KIND_OPAQUE,
            Some(serde_json::to_value(&captured)?),
        )?;
    }
    Ok(Some(captured))
}

fn sdk_credential_usable(auth_key: &str, kind: &str, credential: &Value) -> bool {
    if kind == super::accounts::KIND_API_KEY {
        return credential
            .as_str()
            .or_else(|| credential.get("key").and_then(Value::as_str))
            .is_some_and(|key| !key.trim().is_empty());
    }
    if kind != super::accounts::KIND_OAUTH
        || !is_sdk_oauth_auth_key(auth_key)
        || credential.get("type").and_then(Value::as_str) != Some("oauth")
    {
        return false;
    }
    let refresh = credential
        .get("refresh")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let access = credential
        .get("access")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    refresh
        || (access && !super::subscription_needs_refresh(auth_key, credential, super::now_unix()))
}

fn verify_account(
    vault: &super::accounts::AccountVault,
    scope: &str,
    account_id: &str,
) -> Result<String> {
    let account = vault.list(scope)?.into_iter().find(|account| account.account_id == account_id)
        .context("This conversation's Pi account is unavailable; connect it again or start a new conversation")?;
    if ![super::accounts::KIND_OAUTH, super::accounts::KIND_API_KEY]
        .contains(&account.kind.as_str())
    {
        bail!("Captured Pi account has no supported SDK credential");
    }
    if vault.credential(scope, account_id)?.is_none() {
        bail!("Captured Pi credential is unavailable");
    }
    Ok(account.kind)
}

fn hash_key(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn private_dir(path: &Path) -> Result<()> {
    reject_link(path)?;
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn reject_link(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("Pi account projection cannot use symbolic links")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn publish_credential(directory: &Path, auth_key: &str, credential: &Value) -> Result<()> {
    let mut projection = credential
        .as_object()
        .context("OAuth credential is invalid")?
        .clone();
    if projection.get("type").and_then(Value::as_str) != Some("oauth")
        || projection
            .get("access")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        bail!("OAuth credential is unavailable");
    }
    projection.insert("refresh".into(), Value::String(String::new()));
    if projection.get("expires").and_then(Value::as_u64).is_none() {
        let expires =
            super::oauth_expires_at(credential).context("OAuth expiration is unavailable")?;
        projection.insert("expires".into(), json!(expires.saturating_mul(1000)));
    }
    let expiry = projection
        .get("expires")
        .and_then(Value::as_u64)
        .context("OAuth expiration is invalid")?;
    if expiry
        <= super::now_unix()
            .saturating_mul(1000)
            .saturating_add(300_000)
    {
        bail!("Captured Pi account needs Core refresh before entering the SDK validity window");
    }
    publish_auth(directory, auth_key, Value::Object(projection))
}

fn publish_api_key(directory: &Path, auth_key: &str, credential: &Value) -> Result<()> {
    credential
        .as_str()
        .or_else(|| credential.get("key").and_then(Value::as_str))
        .filter(|key| !key.trim().is_empty())
        .context("Captured Pi API key is unavailable")?;
    // The key reaches Pi in its spawn environment (`SessionAccount::secret_env`);
    // the projected file names it by reference only.
    publish_auth(
        directory,
        auth_key,
        json!({
            "type": "api_key",
            "key": super::secret_env::reference(super::secret_env::SESSION_KEY_ENV),
        }),
    )
}

fn publish_auth(directory: &Path, auth_key: &str, projection: Value) -> Result<()> {
    private_dir(directory)?;
    reject_link(&directory.join("auth.json"))?;
    let auth = serde_json::Map::from_iter([(auth_key.to_owned(), projection)]);
    let temporary = tempfile::NamedTempFile::new_in(directory)?;
    super::write_secret_file(temporary.path(), &serde_json::to_string(&auth)?)?;
    temporary
        .persist(directory.join("auth.json"))
        .map_err(|error| error.error)
        .context("Publish captured Pi account credential")?;
    Ok(())
}

fn materialize_assets(source: &Path, target: &Path, provider_id: &str) -> Result<()> {
    private_dir(target)?;
    // models.json and models-store.json are sanitized in memory and written
    // once, so no unsanitized copy ever lands in the session directory.
    for name in COPIED_PROVIDER_LISTS {
        let from = source.join(name);
        let destination = target.join(name);
        reject_link(&destination)?;
        if !from.exists() {
            continue;
        }
        if std::fs::symlink_metadata(&from)?.file_type().is_symlink() {
            bail!("Managed Pi assets must not contain symbolic links");
        }
        let mut value: Value = serde_json::from_str(&std::fs::read_to_string(&from)?)?;
        if name == "models.json" {
            sanitize_selected_models(&mut value, provider_id);
        } else {
            sanitize_selected_cache(&mut value, provider_id);
        }
        super::write_secret_file(&destination, &serde_json::to_string_pretty(&value)?)?;
    }
    for name in ["settings.json", "extensions", "skills", "prompts", "themes"] {
        let from = source.join(name);
        if name == "extensions" {
            // Session extensions are a managed projection, not user-owned assets.
            // Remove the old projection even when the source directory vanished.
            let destination = target.join(name);
            reject_link(&destination)?;
            if destination.exists() {
                std::fs::remove_dir_all(&destination)?;
            }
        }
        if from.exists() {
            copy_asset(&from, &target.join(name))?;
        }
    }
    let path = target.join("settings.json");
    let mut settings: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    settings
        .as_object_mut()
        .context("Managed Pi settings must be an object")?
        .insert(
            "defaultProvider".into(),
            Value::String(provider_id.to_owned()),
        );
    super::write_secret_file(&path, &serde_json::to_string_pretty(&settings)?)?;
    Ok(())
}

fn sanitize_selected_cache(store: &mut Value, provider_id: &str) {
    if let Some(entries) = store.as_object_mut() {
        for (id, entry) in entries.iter_mut() {
            if id == provider_id {
                continue;
            }
            strip_literal_secrets(entry);
            if let Some(models) = entry.get_mut("models").and_then(Value::as_array_mut) {
                for model in models {
                    strip_literal_secrets(model);
                }
            }
        }
    }
    if let Some(entry) = store.get_mut(provider_id) {
        strip_auth_override(entry);
        if let Some(models) = entry.get_mut("models").and_then(Value::as_array_mut) {
            for model in models {
                strip_auth_override(model);
            }
        }
    }
}

fn sanitize_selected_models(models: &mut Value, provider_id: &str) {
    // Every other provider keeps only non-secret values: `${…}` references,
    // templates and proxy sentinels resolve or work as they are, but a legacy
    // literal key never reaches a per-session copy.
    if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
        for (id, provider) in providers.iter_mut() {
            if id == provider_id {
                continue;
            }
            strip_literal_secrets(provider);
            if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
                for model in models {
                    strip_literal_secrets(model);
                }
            }
        }
    }
    let Some(provider) = models
        .get_mut("providers")
        .and_then(|providers| providers.get_mut(provider_id))
    else {
        return;
    };
    strip_auth_override(provider);
    if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            strip_auth_override(model);
        }
    }
    if let Some(models) = provider
        .get_mut("modelOverrides")
        .and_then(Value::as_object_mut)
    {
        for model in models.values_mut() {
            strip_auth_override(model);
        }
    }
}

/// Drop a literal (non-template, non-sentinel) `apiKey` and literal auth
/// headers from a provider entry another session might otherwise inherit.
fn strip_literal_secrets(provider: &mut Value) {
    let Some(object) = provider.as_object_mut() else {
        return;
    };
    if object
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|key| !super::secret_env::is_non_secret_key(key))
    {
        object.remove("apiKey");
    }
    if let Some(headers) = object.get_mut("headers").and_then(Value::as_object_mut) {
        headers.retain(|name, value| {
            !AUTH_HEADERS.contains(&name.to_ascii_lowercase().as_str())
                || value
                    .as_str()
                    .is_some_and(super::secret_env::is_non_secret_key)
        });
    }
}

const AUTH_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "api-key",
    "x-api-key",
    "x-goog-api-key",
    "x-ryu-node-token",
];

fn strip_auth_override(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.remove("apiKey");
    object.remove("authHeader");
    if let Some(headers) = object.get_mut("headers").and_then(Value::as_object_mut) {
        headers.retain(|name, _| {
            ![
                "authorization",
                "proxy-authorization",
                "api-key",
                "x-api-key",
                "x-goog-api-key",
            ]
            .contains(&name.to_ascii_lowercase().as_str())
        });
    }
}

fn copy_asset(source: &Path, target: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        bail!("Managed Pi assets must not contain symbolic links");
    }
    if metadata.is_dir() {
        private_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_asset(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        reject_link(target)?;
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(target)?.write_all(&std::fs::read(source)?)?;
    } else {
        bail!("Managed Pi asset is not a regular file");
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod peek_tests {
    use super::*;

    fn save(vault: &super::super::accounts::AccountVault, account: &str) {
        vault
            .upsert(
                &super::super::accounts::provider_scope("github-copilot"),
                account,
                account,
                super::super::accounts::KIND_OAUTH,
                Some(json!({
                    "type": "oauth",
                    "access": account,
                    "refresh": "fixture-refresh",
                    "expires": 4_000_000_000_000_u64
                })),
            )
            .unwrap();
    }

    #[test]
    fn peek_creates_no_affinity_and_reads_an_existing_one() {
        let vault = super::super::accounts::AccountVault::in_memory().unwrap();
        save(&vault, "first");
        let before = vault.count(AFFINITY_SCOPE).unwrap();
        assert_eq!(
            peek_with_vault(&vault, "github-copilot", Some("chat"), "ryu").unwrap(),
            None
        );
        assert_eq!(vault.count(AFFINITY_SCOPE).unwrap(), before);

        capture_with_vault(
            &vault,
            "github-copilot",
            "github-copilot",
            Some("chat"),
            "ryu",
            None,
        )
        .unwrap();
        let after_capture = vault.count(AFFINITY_SCOPE).unwrap();
        save(&vault, "second");
        assert_eq!(
            peek_with_vault(&vault, "github-copilot", Some("chat"), "ryu").unwrap(),
            Some("first".to_owned())
        );
        assert_eq!(
            peek_with_vault(&vault, "github-copilot", Some("other-chat"), "ryu").unwrap(),
            None
        );
        assert_eq!(
            peek_with_vault(&vault, "github-copilot", None, "ryu").unwrap(),
            None
        );
        assert_eq!(
            peek_with_vault(&vault, "claude-pro-max", Some("chat"), "ryu").unwrap(),
            None
        );
        assert_eq!(vault.count(AFFINITY_SCOPE).unwrap(), after_capture);
    }
}
