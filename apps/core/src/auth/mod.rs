use anyhow::{anyhow, Context, Result};
use ryu_crypto::{global_cipher, ContentCipher, ContentContext, FieldCipher};
use std::sync::Arc;
use tokio::sync::Mutex;

pub const DESKTOP_CLIENT_ID: &str = "ryu-desktop";

/// Per-request deadline for the device-login calls. Without one a single
/// stalled connection would park the poller forever: its 30-minute budget is
/// counted in iterations, so a request that never returns never ends the flow.
const AUTH_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn auth_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(AUTH_REQUEST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Clone, PartialEq)]
pub enum AuthStatus {
    Idle,
    Pending,
    Authenticated,
    Failed(String),
}

/// How a settled device flow ended.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceFlowResult {
    Succeeded,
    Failed(String),
}

/// The outcome of the most recently settled device flow, keyed by its user
/// code. A failed "add account" flow falls back to the still-active account
/// (`Authenticated` with that account's bearer), so `status` alone cannot tell
/// a poller whether ITS flow added an account; this record can.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceFlowOutcome {
    pub user_code: String,
    pub result: DeviceFlowResult,
}

impl DeviceFlowOutcome {
    /// The `lastFlow` object `GET /api/auth/status` publishes.
    pub fn to_wire(&self) -> serde_json::Value {
        let (result, error) = match &self.result {
            DeviceFlowResult::Succeeded => ("succeeded", None),
            DeviceFlowResult::Failed(reason) => ("failed", Some(reason.as_str())),
        };
        serde_json::json!({
            "userCode": self.user_code,
            "result": result,
            "error": error,
        })
    }
}

#[derive(Debug)]
pub struct AuthState {
    pub status: AuthStatus,
    pub token: Option<String>,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    /// The most recently settled device flow; `None` until one settles.
    pub last_flow: Option<DeviceFlowOutcome>,
}

impl AuthState {
    pub fn new() -> Self {
        let token = load_token();
        let status = if token.is_some() {
            AuthStatus::Authenticated
        } else {
            AuthStatus::Idle
        };
        Self {
            status,
            token,
            user_code: None,
            verification_uri: None,
            last_flow: None,
        }
    }
}

pub struct DeviceAuthInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
}

/// Start the device authorization flow. Requests a device code from the
/// Better Auth server, stores the user_code for display, and starts a
/// background task that polls until the user approves.
pub async fn start_device_login(
    state: Arc<Mutex<AuthState>>,
    backend_url: &str,
) -> Result<DeviceAuthInfo> {
    tracing::info!("start_device_login: requesting device code");

    let client = auth_http_client();
    let resp = client
        .post(format!("{backend_url}/api/auth/device/code"))
        .json(&serde_json::json!({
            "client_id": DESKTOP_CLIENT_ID,
            "scope": "openid profile email"
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Device code request failed ({status}): {text}"));
    }

    let data: serde_json::Value = resp.json().await?;
    let device_code = data["device_code"]
        .as_str()
        .ok_or_else(|| anyhow!("missing device_code in response"))?
        .to_string();
    let user_code = data["user_code"]
        .as_str()
        .ok_or_else(|| anyhow!("missing user_code in response"))?
        .to_string();
    let verification_uri = data["verification_uri"]
        .as_str()
        .unwrap_or("/device")
        .to_string();
    let verification_uri_complete = data["verification_uri_complete"]
        .as_str()
        .unwrap_or(&verification_uri)
        .to_string();
    let interval_secs = data["interval"].as_u64().unwrap_or(5);

    tracing::info!("start_device_login: user_code={user_code} verification_uri={verification_uri}");

    {
        let mut s = state.lock().await;
        s.status = AuthStatus::Pending;
        // Keep the current bearer: this flow also adds a second account while
        // signed in, and the active account must keep working (user JWTs, the
        // status token) while it runs and after it fails or is abandoned.
        s.user_code = Some(user_code.clone());
        s.verification_uri = Some(verification_uri_complete.clone());
    }

    let state_bg = Arc::clone(&state);
    let backend_url_owned = backend_url.to_string();
    let user_code_bg = user_code.clone();
    tokio::spawn(async move {
        poll_device_token(
            state_bg,
            backend_url_owned,
            device_code,
            user_code_bg,
            interval_secs,
        )
        .await;
    });

    Ok(DeviceAuthInfo {
        user_code,
        verification_uri,
        verification_uri_complete,
    })
}

async fn poll_device_token(
    state: Arc<Mutex<AuthState>>,
    backend_url: String,
    device_code: String,
    user_code: String,
    interval_secs: u64,
) {
    let client = auth_http_client();
    let mut interval = interval_secs.max(5);
    // Poll for up to 30 minutes
    let max_polls = 1800 / interval;

    for _ in 0..max_polls {
        tokio::time::sleep(tokio::time::Duration::from_secs(interval)).await;

        // A newer login attempt (or a cancel) replaced this flow's code. Stop,
        // so a superseded poller neither keeps hitting the backend nor later
        // overwrites the live attempt's status with its own expiry/failure.
        if !is_current_flow(&state, &user_code).await {
            tracing::debug!("device auth: login flow superseded; stopping poller");
            return;
        }

        let resp = match client
            .post(format!("{backend_url}/api/auth/device/token"))
            .json(&serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": DESKTOP_CLIENT_ID
            }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("device token poll error: {e}");
                continue;
            }
        };

        let data: serde_json::Value = match resp.json().await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("device token parse error: {e}");
                continue;
            }
        };

        if let Some(token) = data["access_token"].as_str() {
            // Resolve the account profile so the multi-account vault can list a
            // human-friendly name/email. If it stays unavailable we still add the
            // account so a switch never loses it, under an opaque placeholder id:
            // ids are stored and listed in the clear, so never derive one from
            // the bearer.
            let (user_id, email, name, image) =
                fetch_profile_with_retry(&client, &backend_url, token).await;
            let user_id = user_id.unwrap_or_else(unresolved_account_id);
            if let Err(e) = upsert_account(token, &user_id, &email, name, image) {
                tracing::warn!("failed to upsert account: {e}");
                // Fall back to the legacy single-token path so login still works.
                if let Err(e) = save_token(token) {
                    tracing::warn!("failed to save token: {e}");
                }
            }
            // Remember the backend that issued this bearer so the managed webhook
            // relay registers with the same server (and never an implicit default).
            if let Err(e) = save_backend_url(&backend_url) {
                tracing::warn!("failed to remember the sign-in backend: {e:#}");
            }
            let mut s = state.lock().await;
            settle_successful_flow(&mut s, &user_code, token);
            tracing::info!("device auth: token received, account upserted + set active");
            return;
        }

        match data["error"].as_str() {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval += 5;
                tracing::debug!("device auth: slow_down, new interval={interval}s");
                continue;
            }
            Some("access_denied") => {
                let mut s = state.lock().await;
                if s.user_code.as_deref() != Some(user_code.as_str()) {
                    return;
                }
                settle_failed_flow(&mut s, "access_denied", load_token());
                tracing::info!("device auth: access denied by user");
                return;
            }
            Some("expired_token") => {
                let mut s = state.lock().await;
                if s.user_code.as_deref() != Some(user_code.as_str()) {
                    return;
                }
                settle_failed_flow(&mut s, "device_code_expired", load_token());
                tracing::warn!("device auth: device code expired");
                return;
            }
            Some(err) => {
                let msg = err.to_string();
                let mut s = state.lock().await;
                if s.user_code.as_deref() != Some(user_code.as_str()) {
                    return;
                }
                settle_failed_flow(&mut s, &msg, load_token());
                tracing::error!("device auth: error: {msg}");
                return;
            }
            None => {}
        }
    }

    let mut s = state.lock().await;
    if s.user_code.as_deref() != Some(user_code.as_str()) {
        return;
    }
    settle_failed_flow(&mut s, "timeout", load_token());
    tracing::warn!("device auth: polling timed out");
}

/// End the device flow `user_code` with the token it produced: that account is
/// now active in the vault. A newer flow started while the profile was being
/// resolved stays pending (its own poller settles it).
fn settle_successful_flow(s: &mut AuthState, user_code: &str, token: &str) {
    s.last_flow = Some(DeviceFlowOutcome {
        user_code: user_code.to_string(),
        result: DeviceFlowResult::Succeeded,
    });
    s.token = Some(token.to_string());
    if s.user_code
        .as_deref()
        .is_none_or(|current| current == user_code)
    {
        s.user_code = None;
        s.verification_uri = None;
        s.status = AuthStatus::Authenticated;
    }
}

/// End a device flow that produced no token. A failed or abandoned "add
/// account" must not sign out the account that is still active in the vault, so
/// the state falls back to it (`active_token`) and reports `Failed` only when
/// there is no signed-in account left to report. The failure is recorded in
/// `last_flow` either way, so the client that started the flow can tell it
/// apart from a success even though the state reads `Authenticated`.
fn settle_failed_flow(s: &mut AuthState, reason: &str, active_token: Option<String>) {
    if let Some(user_code) = s.user_code.take() {
        s.last_flow = Some(DeviceFlowOutcome {
            user_code,
            result: DeviceFlowResult::Failed(reason.to_string()),
        });
    }
    s.verification_uri = None;
    s.status = if active_token.is_some() {
        AuthStatus::Authenticated
    } else {
        AuthStatus::Failed(reason.to_string())
    };
    s.token = active_token;
}

/// Prefix of a placeholder account id used while the profile is unresolved.
const UNRESOLVED_ACCOUNT_PREFIX: &str = "unresolved:";
/// Prefix of the id an older build derived from the raw bearer. Migrated away
/// on load; see [`scrub_bearer_account_ids`].
const LEGACY_BEARER_ID_PREFIX: &str = "token:";

/// A random placeholder account id for a login whose profile could not be
/// fetched. It is opaque by construction: nothing about the bearer is in it.
fn unresolved_account_id() -> String {
    format!(
        "{UNRESOLVED_ACCOUNT_PREFIX}{}",
        uuid::Uuid::new_v4().simple()
    )
}

/// True while `user_code` is still the flow the auth state is waiting on.
async fn is_current_flow(state: &Mutex<AuthState>, user_code: &str) -> bool {
    state.lock().await.user_code.as_deref() == Some(user_code)
}

// ── Multi-account vault ───────────────────────────────────────────────────────

/// One signed-in account. Tokens NEVER leave the device: this struct is the
/// on-disk vault shape and the `token` field is only ever read locally to pick
/// which bearer to send. Endpoints that list accounts strip `token` first.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Account {
    pub token: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
}

/// The persisted multi-account vault: `<ryu_dir>/accounts.json`.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct AccountVault {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(rename = "activeUserId", default)]
    pub active_user_id: Option<String>,
    /// Stored accounts whose token or a profile field did not open (another
    /// key, a damaged value). They are not usable, but every rewrite of
    /// `accounts.json` carries them forward unchanged so a later key recovery
    /// can still read them; removing that `userId` drops them.
    #[serde(skip)]
    unreadable: Vec<PersistedAccount>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedAccount {
    token: String,
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    image: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedAccountVault {
    #[serde(default)]
    accounts: Vec<PersistedAccount>,
    #[serde(rename = "activeUserId", default)]
    active_user_id: Option<String>,
}

fn master_cipher() -> Result<FieldCipher> {
    crate::crypto_host::install();
    global_cipher().context("loading auth encryption key")
}

/// Registered content-store name of `accounts.json` (KDF input; never rename).
const ACCOUNTS_STORE: &str = "accounts.json";

/// The content cipher that seals account profile fields (email, name, avatar
/// URL) in `accounts.json`, each bound to the account's user id and field.
fn profile_cipher() -> Result<ContentCipher> {
    crate::crypto_host::install();
    ryu_crypto::content_cipher(ACCOUNTS_STORE).context("loading account profile key")
}

fn profile_context(field: &str, user_id: &str) -> ContentContext {
    ContentContext::new(format!("accounts.{field}")).with("user_id", user_id)
}

fn seal_profile(
    pii: &ContentCipher,
    field: &str,
    user_id: &str,
    value: Option<&str>,
) -> Result<Option<String>> {
    value
        .filter(|value| !value.is_empty())
        .map(|value| pii.seal_text(value, &profile_context(field, user_id)))
        .transpose()
}

/// Open one profile field; reports whether it was legacy plaintext.
fn open_profile(
    pii: &ContentCipher,
    field: &str,
    user_id: &str,
    stored: Option<String>,
) -> Result<(Option<String>, bool)> {
    let Some(stored) = stored else {
        return Ok((None, false));
    };
    let opened = pii.open_text(&stored, &profile_context(field, user_id))?;
    Ok((Some(opened.value), opened.needs_reseal))
}

/// Seal one stored profile field of an unreadable account when it is still
/// legacy plaintext; anything else (already sealed, or not opening) is kept
/// exactly as stored.
fn reseal_stored_profile(
    pii: &ContentCipher,
    field: &str,
    user_id: &str,
    stored: Option<String>,
) -> Option<String> {
    let value = stored?;
    match open_profile(pii, field, user_id, Some(value.clone())) {
        Ok((Some(plain), true)) => seal_profile(pii, field, user_id, Some(&plain))
            .ok()
            .flatten()
            .or(Some(value)),
        _ => Some(value),
    }
}

/// Whether a stored (unreadable) account still holds a plaintext profile field.
fn has_legacy_profile(pii: &ContentCipher, account: &PersistedAccount) -> bool {
    let user_id = account.user_id.as_str();
    [
        ("email", Some(account.email.clone())),
        ("name", account.name.clone()),
        ("image", account.image.clone()),
    ]
    .into_iter()
    .any(|(field, stored)| {
        let stored = stored.filter(|value| !value.is_empty());
        open_profile(pii, field, user_id, stored).is_ok_and(|(_, legacy)| legacy)
    })
}

fn persisted_vault(
    vault: &AccountVault,
    cipher: &FieldCipher,
    pii: &ContentCipher,
) -> Result<PersistedAccountVault> {
    let mut accounts = vault
        .accounts
        .iter()
        .map(|account| {
            let user_id = account.user_id.as_str();
            Ok(PersistedAccount {
                token: cipher.seal(&account.token)?,
                user_id: account.user_id.clone(),
                email: seal_profile(pii, "email", user_id, Some(account.email.as_str()))?
                    .unwrap_or_default(),
                name: seal_profile(pii, "name", user_id, account.name.as_deref())?,
                image: seal_profile(pii, "image", user_id, account.image.as_deref())?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    // Unreadable accounts are carried forward (token as stored), with any
    // plaintext profile field sealed; one replaced by a live account is dropped.
    for stored in &vault.unreadable {
        if vault.accounts.iter().any(|a| a.user_id == stored.user_id) {
            continue;
        }
        let user_id = stored.user_id.as_str();
        accounts.push(PersistedAccount {
            token: stored.token.clone(),
            user_id: stored.user_id.clone(),
            email: reseal_stored_profile(pii, "email", user_id, Some(stored.email.clone()))
                .unwrap_or_default(),
            name: reseal_stored_profile(pii, "name", user_id, stored.name.clone()),
            image: reseal_stored_profile(pii, "image", user_id, stored.image.clone()),
        });
    }
    Ok(PersistedAccountVault {
        accounts,
        active_user_id: vault.active_user_id.clone(),
    })
}

fn runtime_account(
    account: PersistedAccount,
    cipher: &FieldCipher,
    pii: &ContentCipher,
) -> Result<(Account, bool)> {
    let user_id = account.user_id;
    let (email, email_legacy) = open_profile(pii, "email", &user_id, Some(account.email))?;
    let (name, name_legacy) = open_profile(pii, "name", &user_id, account.name)?;
    let (image, image_legacy) = open_profile(pii, "image", &user_id, account.image)?;
    Ok((
        Account {
            token: cipher.open(&account.token)?,
            email: email.unwrap_or_default(),
            name,
            image,
            user_id,
        },
        email_legacy || name_legacy || image_legacy,
    ))
}

/// Open every account. An account whose token or a profile field does not open
/// is left out of the usable list (logged) instead of failing the whole vault,
/// and kept as stored so a rewrite carries it forward. The flag reports whether
/// any field (of a usable or an unreadable account) was legacy plaintext, so
/// the file should be rewritten.
fn runtime_vault(
    stored: PersistedAccountVault,
    cipher: &FieldCipher,
    pii: &ContentCipher,
) -> (AccountVault, bool) {
    let mut accounts = Vec::with_capacity(stored.accounts.len());
    let mut unreadable = Vec::new();
    let mut needs_reseal = false;
    for account in stored.accounts {
        match runtime_account(account.clone(), cipher, pii) {
            Ok((account, legacy)) => {
                needs_reseal |= legacy;
                accounts.push(account);
            }
            Err(_) => {
                needs_reseal |= has_legacy_profile(pii, &account);
                unreadable.push(account);
            }
        }
    }
    if !unreadable.is_empty() {
        tracing::warn!(
            dropped = unreadable.len(),
            "auth account vault: accounts whose sealed fields do not open were skipped"
        );
    }
    (
        AccountVault {
            accounts,
            active_user_id: stored.active_user_id,
            unreadable,
        },
        needs_reseal,
    )
}

impl AccountVault {
    /// The active account, if the pointer resolves to one in the list.
    pub fn active(&self) -> Option<&Account> {
        let id = self.active_user_id.as_deref()?;
        self.accounts.iter().find(|a| a.user_id == id)
    }
}

fn accounts_path() -> std::path::PathBuf {
    crate::paths::secret_path("accounts.json")
}

/// Replace account ids an older build derived from the raw bearer
/// (`token:<bearer>`) with opaque placeholders, keeping the active pointer on
/// the same account. Returns whether anything changed.
fn scrub_bearer_account_ids(vault: &mut AccountVault) -> bool {
    let mut changed = false;
    for account in &mut vault.accounts {
        if !account.user_id.starts_with(LEGACY_BEARER_ID_PREFIX) {
            continue;
        }
        let replacement = unresolved_account_id();
        if vault.active_user_id.as_deref() == Some(account.user_id.as_str()) {
            vault.active_user_id = Some(replacement.clone());
        }
        account.user_id = replacement;
        changed = true;
    }
    if vault
        .active_user_id
        .as_deref()
        .is_some_and(|id| id.starts_with(LEGACY_BEARER_ID_PREFIX))
    {
        // A dangling pointer that still embeds a bearer: drop it rather than
        // keep the secret on disk.
        vault.active_user_id = vault.accounts.first().map(|a| a.user_id.clone());
        changed = true;
    }
    changed
}

/// Load the vault from `accounts.json`. Returns an empty vault when the file is
/// absent or malformed (callers fall back to the legacy single-token path).
pub fn load_accounts() -> AccountVault {
    let Ok(bytes) = std::fs::read(accounts_path()) else {
        return AccountVault::default();
    };
    let Ok(stored) = serde_json::from_slice::<PersistedAccountVault>(&bytes) else {
        return AccountVault::default();
    };
    let (Ok(cipher), Ok(pii)) = (master_cipher(), profile_cipher()) else {
        tracing::warn!("auth account vault unavailable: master key could not be loaded");
        return AccountVault::default();
    };
    let (mut vault, needs_reseal) = runtime_vault(stored, &cipher, &pii);
    let scrubbed = scrub_bearer_account_ids(&mut vault);
    if needs_reseal || scrubbed {
        // Seal profile fields an older build wrote in plaintext, and rewrite the
        // file so a bearer-derived account id no longer sits on disk in the
        // clear. The legacy values are replaced only by this complete, sealed
        // rewrite; the returned vault is scrubbed even if it fails.
        match persisted_vault(&vault, &cipher, &pii)
            .and_then(|stored| Ok(serde_json::to_string_pretty(&stored)?))
            .and_then(|json| write_secret_file(&accounts_path(), &json))
        {
            Ok(()) => {
                if needs_reseal {
                    tracing::info!("sealed legacy account profile fields in accounts.json");
                }
                if scrubbed {
                    tracing::info!("auth account vault: replaced bearer-derived account ids");
                }
            }
            Err(error) => tracing::warn!(error = %error, "could not rewrite accounts.json"),
        }
    }
    vault
}

/// Persist the vault to `accounts.json` (0600) and mirror the active account's
/// token into the legacy `auth.json` so single-token consumers keep working.
pub fn save_accounts(vault: &AccountVault) -> Result<()> {
    let path = accounts_path();
    let cipher = master_cipher()?;
    let stored = persisted_vault(vault, &cipher, &profile_cipher()?)?;
    write_secret_file(&path, &serde_json::to_string_pretty(&stored)?)?;
    match vault.active().map(|a| a.token.clone()) {
        Some(token) => save_token(&token)?,
        None => {
            let _ = clear_token();
        }
    }
    Ok(())
}

/// Insert or update an account (dedupe by `userId`) and make it the active one.
/// Existing accounts are preserved — this never wipes the vault.
pub fn upsert_account(
    token: &str,
    user_id: &str,
    email: &str,
    name: Option<String>,
    image: Option<String>,
) -> Result<AccountVault> {
    let mut vault = load_accounts();
    let account = Account {
        token: token.to_string(),
        user_id: user_id.to_string(),
        email: email.to_string(),
        name,
        image,
    };
    if let Some(existing) = vault.accounts.iter_mut().find(|a| a.user_id == user_id) {
        *existing = account;
    } else {
        vault.accounts.push(account);
    }
    vault.active_user_id = Some(user_id.to_string());
    save_accounts(&vault)?;
    Ok(vault)
}

/// Switch the active account. Errors if `user_id` is not in the vault.
pub fn switch_account(user_id: &str) -> Result<AccountVault> {
    let mut vault = load_accounts();
    if !vault.accounts.iter().any(|a| a.user_id == user_id) {
        return Err(anyhow!("no account with userId {user_id}"));
    }
    vault.active_user_id = Some(user_id.to_string());
    save_accounts(&vault)?;
    Ok(vault)
}

/// Remove an account by `userId`. If it was active, fall to the first remaining
/// account (else `None`). Returns the new active `userId`.
pub fn remove_account(user_id: &str) -> Result<Option<String>> {
    let mut vault = load_accounts();
    vault.accounts.retain(|a| a.user_id != user_id);
    vault.unreadable.retain(|a| a.user_id != user_id);
    if vault.active_user_id.as_deref() == Some(user_id) {
        vault.active_user_id = vault.accounts.first().map(|a| a.user_id.clone());
    }
    save_accounts(&vault)?;
    Ok(vault.active_user_id.clone())
}

/// The active account's token, if any.
pub fn active_token() -> Option<String> {
    load_accounts().active().map(|a| a.token.clone())
}

/// [`fetch_profile`] with a short retry, so one transient backend failure right
/// after the device code is approved does not leave the account unresolved.
async fn fetch_profile_with_retry(
    client: &reqwest::Client,
    backend_url: &str,
    token: &str,
) -> (Option<String>, String, Option<String>, Option<String>) {
    const ATTEMPTS: u64 = 3;
    let mut profile = fetch_profile(client, backend_url, token).await;
    for attempt in 1..ATTEMPTS {
        if profile.0.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(attempt)).await;
        profile = fetch_profile(client, backend_url, token).await;
    }
    profile
}

/// Fetch the signed-in user's profile from Better Auth using a fresh bearer
/// token. Returns `(user_id, email, name, image)`; `user_id` is `None` if the
/// request fails or the response is missing an id.
async fn fetch_profile(
    client: &reqwest::Client,
    backend_url: &str,
    token: &str,
) -> (Option<String>, String, Option<String>, Option<String>) {
    let resp = match client
        .get(format!("{backend_url}/api/auth/get-session"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("get-session request failed: {e}");
            return (None, String::new(), None, None);
        }
    };
    let data: serde_json::Value = match resp.json().await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("get-session parse failed: {e}");
            return (None, String::new(), None, None);
        }
    };
    let user = &data["user"];
    let user_id = user["id"].as_str().map(str::to_string);
    let email = user["email"].as_str().unwrap_or_default().to_string();
    let name = user["name"].as_str().map(str::to_string);
    let image = user["image"].as_str().map(str::to_string);
    (user_id, email, name, image)
}

// ── Token persistence ────────────────────────────────────────────────────────

pub fn save_token(token: &str) -> Result<()> {
    let path = token_path();
    let cipher = master_cipher()?;
    let data = serde_json::json!({ "token": cipher.seal(token)? });
    write_secret_file(&path, &serde_json::to_string(&data)?)?;
    Ok(())
}

pub fn load_token() -> Option<String> {
    // Prefer the multi-account vault's active token; fall back to the legacy
    // single-token `auth.json` for backward compatibility.
    if let Some(token) = active_token() {
        return Some(token);
    }
    let cipher = master_cipher().ok()?;
    let bytes = std::fs::read(token_path()).ok()?;
    let data: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let stored = data["token"]
        .as_str()
        .or_else(|| data["access_token"].as_str())?;
    cipher.open(stored).ok()
}

/// `<data dir>/state/auth-backend.json`: the backend a device sign-in succeeded
/// against.
fn backend_url_path() -> std::path::PathBuf {
    crate::paths::state_path("auth-backend.json")
}

/// A backend base URL as stored: trimmed, no trailing slash, `http(s)` with a
/// host. `None` for anything else, so a malformed value is never persisted or
/// used as a relay server.
fn normalize_backend_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = url::Url::parse(trimmed).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
        .then(|| trimmed.to_owned())
}

/// Remember the backend a device sign-in succeeded against (the server that
/// issued the active bearer). Overwrites the previous value.
pub fn save_backend_url(backend_url: &str) -> Result<()> {
    let url = normalize_backend_url(backend_url)
        .ok_or_else(|| anyhow!("the sign-in backend is not an http(s) URL"))?;
    let path = backend_url_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({ "backendUrl": url }))?,
    )
    .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// The backend the last successful device sign-in used, if any.
pub fn load_backend_url() -> Option<String> {
    let bytes = std::fs::read(backend_url_path()).ok()?;
    let data: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    normalize_backend_url(data["backendUrl"].as_str()?)
}

pub fn clear_token() -> Result<()> {
    let path = token_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

fn token_path() -> std::path::PathBuf {
    crate::paths::secret_path("auth.json")
}

fn write_secret_file(path: &std::path::Path, body: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
    }

    // Atomic and owner-only: truncating in place would leave an empty vault
    // after a crash mid-write, signing every account out.
    crate::atomic_file::write_atomic(path, body.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cipher() -> FieldCipher {
        FieldCipher::new(&[0x52; 32])
    }

    fn test_pii() -> ContentCipher {
        ContentCipher::from_root(&[0x53; 32], ACCOUNTS_STORE)
    }

    #[test]
    fn the_sign_in_backend_is_kept_only_as_a_clean_http_url() {
        for (raw, want) in [
            ("https://api.example.com/", Some("https://api.example.com")),
            (" http://localhost:3000 ", Some("http://localhost:3000")),
            (
                "https://api.example.com/ryu/",
                Some("https://api.example.com/ryu"),
            ),
            ("", None),
            ("not a url", None),
            ("ftp://example.com", None),
            ("javascript:alert(1)", None),
        ] {
            assert_eq!(normalize_backend_url(raw).as_deref(), want, "{raw:?}");
        }
    }

    #[test]
    fn profile_fields_are_sealed_and_bound_to_their_account() {
        let mut first = account("u1", "t1");
        first.email = "ada-private@example.com".to_owned();
        first.image = Some("https://img.example/ada-avatar".to_owned());
        let vault = AccountVault {
            accounts: vec![first, account("u2", "t2")],
            active_user_id: Some("u1".to_owned()),
            ..AccountVault::default()
        };
        let stored = persisted_vault(&vault, &test_cipher(), &test_pii()).unwrap();
        let json = serde_json::to_string(&stored).unwrap();
        assert!(!json.contains("ada-private"));
        assert!(!json.contains("ada-avatar"));
        assert!(stored.accounts[0].email.starts_with("encb:v1:"));

        // A field copied onto another account does not open: only that account
        // is dropped.
        let mut swapped = stored.clone();
        swapped.accounts[1].email = swapped.accounts[0].email.clone();
        let (opened, _) = runtime_vault(swapped, &test_cipher(), &test_pii());
        assert_eq!(opened.accounts.len(), 1);
        assert_eq!(opened.accounts[0].email, "ada-private@example.com");

        let (opened, needs_reseal) = runtime_vault(stored, &test_cipher(), &test_pii());
        assert!(!needs_reseal);
        assert_eq!(opened.accounts.len(), 2);
        assert_eq!(
            opened.accounts[0].image.as_deref(),
            Some("https://img.example/ada-avatar")
        );
    }

    #[test]
    fn legacy_plaintext_profile_fields_still_read_and_ask_for_a_reseal() {
        let raw = format!(
            r#"{{"accounts":[{{"token":"{}","userId":"u1","email":"legacy@example.com","name":"Legacy"}}],"activeUserId":"u1"}}"#,
            test_cipher().seal("tok").unwrap()
        );
        let stored: PersistedAccountVault = serde_json::from_str(&raw).unwrap();
        let (vault, needs_reseal) = runtime_vault(stored, &test_cipher(), &test_pii());
        assert!(needs_reseal);
        assert_eq!(vault.accounts[0].email, "legacy@example.com");
        assert_eq!(vault.accounts[0].name.as_deref(), Some("Legacy"));
        let resealed = persisted_vault(&vault, &test_cipher(), &test_pii()).unwrap();
        let (again, needs_reseal) = runtime_vault(resealed, &test_cipher(), &test_pii());
        assert!(!needs_reseal);
        assert_eq!(again.accounts[0].email, "legacy@example.com");
    }

    #[test]
    fn unreadable_account_is_carried_forward_and_others_are_resealed() {
        let other_key = FieldCipher::new(&[0x99; 32]);
        let raw = format!(
            r#"{{"accounts":[
                {{"token":"{}","userId":"u1","email":"legacy-ok@example.com","name":"Ok"}},
                {{"token":"{}","userId":"u2","email":"legacy-lost@example.com","image":"https://img.example/lost-avatar"}}
            ],"activeUserId":"u1"}}"#,
            test_cipher().seal("tok-1").unwrap(),
            other_key.seal("tok-2").unwrap()
        );
        let stored: PersistedAccountVault = serde_json::from_str(&raw).unwrap();
        let (vault, needs_reseal) = runtime_vault(stored, &test_cipher(), &test_pii());
        // One account does not open, yet the legacy plaintext must still go.
        assert!(needs_reseal);
        assert_eq!(vault.accounts.len(), 1);
        let rewritten = persisted_vault(&vault, &test_cipher(), &test_pii()).unwrap();
        let json = serde_json::to_string(&rewritten).unwrap();
        for marker in ["legacy-ok", "legacy-lost", "lost-avatar"] {
            assert!(!json.contains(marker), "{marker} left in {json}");
        }
        // The unreadable account survives the rewrite with its token untouched.
        assert_eq!(rewritten.accounts.len(), 2);
        let lost = rewritten
            .accounts
            .iter()
            .find(|a| a.user_id == "u2")
            .unwrap();
        assert_eq!(other_key.open(&lost.token).unwrap(), "tok-2");
        let (again, needs_reseal) = runtime_vault(rewritten, &test_cipher(), &test_pii());
        assert!(!needs_reseal);
        assert_eq!(again.accounts[0].email, "legacy-ok@example.com");
        assert_eq!(again.unreadable.len(), 1);
        // Its profile now opens under the profile key once its token does.
        let lost = &again.unreadable[0];
        let (email, legacy) =
            open_profile(&test_pii(), "email", "u2", Some(lost.email.clone())).unwrap();
        assert_eq!(email.as_deref(), Some("legacy-lost@example.com"));
        assert!(!legacy);
        // A save (e.g. switching accounts) keeps it too.
        let saved = persisted_vault(&again, &test_cipher(), &test_pii()).unwrap();
        assert_eq!(saved.accounts.len(), 2);
    }

    fn account(user_id: &str, token: &str) -> Account {
        Account {
            token: token.to_owned(),
            user_id: user_id.to_owned(),
            email: format!("{user_id}@x.io"),
            name: Some(user_id.to_owned()),
            image: None,
        }
    }

    #[test]
    fn active_resolves_the_pointer_or_none() {
        let vault = AccountVault {
            accounts: vec![account("u1", "t1"), account("u2", "t2")],
            active_user_id: Some("u2".to_owned()),
            ..AccountVault::default()
        };
        assert_eq!(vault.active().unwrap().user_id, "u2");
        assert_eq!(vault.active().unwrap().token, "t2");

        // A dangling pointer resolves to None (not the first account).
        let dangling = AccountVault {
            accounts: vec![account("u1", "t1")],
            active_user_id: Some("ghost".to_owned()),
            ..AccountVault::default()
        };
        assert!(dangling.active().is_none());

        // No pointer at all → None.
        let unset = AccountVault {
            accounts: vec![account("u1", "t1")],
            active_user_id: None,
            ..AccountVault::default()
        };
        assert!(unset.active().is_none());

        // Empty vault → None.
        assert!(AccountVault::default().active().is_none());
    }

    #[test]
    fn vault_serde_round_trips_and_renames_active_pointer() {
        let vault = AccountVault {
            accounts: vec![account("u1", "t1")],
            active_user_id: Some("u1".to_owned()),
            ..AccountVault::default()
        };
        let json = serde_json::to_value(&vault).unwrap();
        // The pointer serializes under the camelCase wire name.
        assert_eq!(json["activeUserId"], "u1");
        assert_eq!(json["accounts"][0]["userId"], "u1");

        let back: AccountVault = serde_json::from_value(json).unwrap();
        assert_eq!(back.active_user_id.as_deref(), Some("u1"));
        assert_eq!(back.accounts.len(), 1);
    }

    #[test]
    fn account_deserializes_with_missing_optionals() {
        // email/name/image default when absent; userId is the wire rename.
        let raw = r#"{ "token": "tok", "userId": "u9" }"#;
        let a: Account = serde_json::from_str(raw).unwrap();
        assert_eq!(a.user_id, "u9");
        assert_eq!(a.email, "");
        assert!(a.name.is_none());
        assert!(a.image.is_none());
    }

    #[test]
    fn malformed_vault_json_falls_back_to_default_via_unwrap_or_default() {
        // Mirrors load_accounts' `unwrap_or_default()` on a corrupt file.
        let vault: AccountVault = serde_json::from_slice(b"not json").unwrap_or_default();
        assert!(vault.accounts.is_empty());
        assert!(vault.active_user_id.is_none());
    }

    #[test]
    fn persisted_account_tokens_are_sealed_and_round_trip() {
        let vault = AccountVault {
            accounts: vec![account("u1", "account-token-secret")],
            active_user_id: Some("u1".to_owned()),
            ..AccountVault::default()
        };
        let cipher = test_cipher();
        let stored = persisted_vault(&vault, &cipher, &test_pii()).unwrap();
        let json = serde_json::to_string(&stored).unwrap();
        assert!(json.contains("enc:v1:"));
        assert!(!json.contains("account-token-secret"));
        assert_eq!(
            runtime_vault(stored, &cipher, &test_pii())
                .0
                .active()
                .unwrap()
                .token,
            "account-token-secret"
        );
    }

    #[test]
    fn bearer_derived_account_ids_are_scrubbed_and_the_pointer_follows() {
        let mut leaked = account("u1", "eyJsecret");
        leaked.user_id = "token:eyJsecret".to_owned();
        let mut vault = AccountVault {
            accounts: vec![leaked, account("u2", "t2")],
            active_user_id: Some("token:eyJsecret".to_owned()),
            unreadable: Vec::new(),
        };
        assert!(scrub_bearer_account_ids(&mut vault));
        let migrated = &vault.accounts[0];
        assert!(migrated.user_id.starts_with(UNRESOLVED_ACCOUNT_PREFIX));
        assert_eq!(
            vault.active_user_id.as_deref(),
            Some(migrated.user_id.as_str())
        );
        assert_eq!(vault.active().unwrap().token, "eyJsecret");
        assert_eq!(vault.accounts[1].user_id, "u2");

        // Nothing that is persisted in the clear still carries the bearer.
        let stored = persisted_vault(&vault, &test_cipher(), &test_pii()).unwrap();
        assert!(!serde_json::to_string(&stored)
            .unwrap()
            .contains("eyJsecret"));

        // Already clean: nothing to rewrite.
        assert!(!scrub_bearer_account_ids(&mut vault));
    }

    #[test]
    fn dangling_bearer_pointer_is_replaced() {
        let mut vault = AccountVault {
            accounts: vec![account("u1", "t1")],
            active_user_id: Some("token:eyJsecret".to_owned()),
            unreadable: Vec::new(),
        };
        assert!(scrub_bearer_account_ids(&mut vault));
        assert_eq!(vault.active_user_id.as_deref(), Some("u1"));
    }

    #[test]
    fn unresolved_account_ids_are_opaque_and_unique() {
        let first = unresolved_account_id();
        assert!(first.starts_with(UNRESOLVED_ACCOUNT_PREFIX));
        assert_ne!(first, unresolved_account_id());
    }

    fn pending_state(token: Option<&str>) -> AuthState {
        AuthState {
            status: AuthStatus::Pending,
            token: token.map(str::to_owned),
            user_code: Some("ABCD".to_owned()),
            verification_uri: Some("https://example.test/device".to_owned()),
            last_flow: None,
        }
    }

    #[test]
    fn a_failed_add_account_flow_keeps_the_active_account_signed_in() {
        let mut state = pending_state(Some("bearer-a"));
        settle_failed_flow(&mut state, "access_denied", Some("bearer-a".to_owned()));
        assert_eq!(state.status, AuthStatus::Authenticated);
        assert_eq!(state.token.as_deref(), Some("bearer-a"));
        assert!(state.user_code.is_none());
        assert!(state.verification_uri.is_none());
    }

    #[test]
    fn a_failed_first_sign_in_reports_the_reason() {
        let mut state = pending_state(None);
        settle_failed_flow(&mut state, "device_code_expired", None);
        assert_eq!(
            state.status,
            AuthStatus::Failed("device_code_expired".to_owned())
        );
        assert!(state.token.is_none());
        assert!(state.user_code.is_none());
    }

    #[test]
    fn a_failed_add_account_flow_is_recorded_as_failed_under_its_code() {
        // The state falls back to the active account (`Authenticated` + its
        // bearer), so only `last_flow` tells the starting client the add failed.
        let mut state = pending_state(Some("bearer-a"));
        settle_failed_flow(&mut state, "access_denied", Some("bearer-a".to_owned()));
        let outcome = state.last_flow.as_ref().expect("settled flow is recorded");
        assert_eq!(outcome.user_code, "ABCD");
        assert_eq!(
            outcome.result,
            DeviceFlowResult::Failed("access_denied".to_owned())
        );
        assert_eq!(
            outcome.to_wire(),
            serde_json::json!({
                "userCode": "ABCD",
                "result": "failed",
                "error": "access_denied",
            })
        );
    }

    #[test]
    fn a_successful_flow_is_recorded_as_succeeded_under_its_code() {
        let mut state = pending_state(Some("bearer-a"));
        settle_successful_flow(&mut state, "ABCD", "bearer-b");
        assert_eq!(state.status, AuthStatus::Authenticated);
        assert_eq!(state.token.as_deref(), Some("bearer-b"));
        assert!(state.user_code.is_none());
        assert!(state.verification_uri.is_none());
        assert_eq!(
            state.last_flow.as_ref().map(DeviceFlowOutcome::to_wire),
            Some(serde_json::json!({
                "userCode": "ABCD",
                "result": "succeeded",
                "error": null,
            }))
        );
    }

    #[test]
    fn auth_token_envelope_never_contains_plaintext() {
        let cipher = test_cipher();
        let sealed = cipher.seal("device-token-secret").unwrap();
        assert!(sealed.starts_with("enc:v1:"));
        assert!(!sealed.contains("device-token-secret"));
        assert_eq!(cipher.open(&sealed).unwrap(), "device-token-secret");
    }
}
