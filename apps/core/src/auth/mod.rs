use anyhow::{anyhow, Result};
use std::sync::Arc;
use tokio::sync::Mutex;

pub const DESKTOP_CLIENT_ID: &str = "ryu-desktop";

#[derive(Debug, Clone, PartialEq)]
pub enum AuthStatus {
    Idle,
    Pending,
    Authenticated,
    Failed(String),
}

#[derive(Debug)]
pub struct AuthState {
    pub status: AuthStatus,
    pub token: Option<String>,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
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

    let client = reqwest::Client::new();
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
        s.token = None;
        s.user_code = Some(user_code.clone());
        s.verification_uri = Some(verification_uri_complete.clone());
    }

    let state_bg = Arc::clone(&state);
    let backend_url_owned = backend_url.to_string();
    tokio::spawn(async move {
        poll_device_token(state_bg, backend_url_owned, device_code, interval_secs).await;
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
    interval_secs: u64,
) {
    let client = reqwest::Client::new();
    let mut interval = interval_secs.max(5);
    // Poll for up to 30 minutes
    let max_polls = 1800 / interval;

    for _ in 0..max_polls {
        tokio::time::sleep(tokio::time::Duration::from_secs(interval)).await;

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
            // human-friendly name/email. On failure we still add the account
            // keyed by token, so a switch never loses it.
            let (user_id, email, name, image) = fetch_profile(&client, &backend_url, token).await;
            let user_id = user_id.unwrap_or_else(|| format!("token:{token}"));
            if let Err(e) = upsert_account(token, &user_id, &email, name, image) {
                tracing::warn!("failed to upsert account: {e}");
                // Fall back to the legacy single-token path so login still works.
                if let Err(e) = save_token(token) {
                    tracing::warn!("failed to save token: {e}");
                }
            }
            let mut s = state.lock().await;
            s.status = AuthStatus::Authenticated;
            s.token = Some(token.to_string());
            s.user_code = None;
            s.verification_uri = None;
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
                s.status = AuthStatus::Failed("access_denied".to_string());
                s.user_code = None;
                s.verification_uri = None;
                tracing::info!("device auth: access denied by user");
                return;
            }
            Some("expired_token") => {
                let mut s = state.lock().await;
                s.status = AuthStatus::Failed("device_code_expired".to_string());
                s.user_code = None;
                s.verification_uri = None;
                tracing::warn!("device auth: device code expired");
                return;
            }
            Some(err) => {
                let msg = err.to_string();
                let mut s = state.lock().await;
                s.status = AuthStatus::Failed(msg.clone());
                s.user_code = None;
                s.verification_uri = None;
                tracing::error!("device auth: error: {msg}");
                return;
            }
            None => {}
        }
    }

    let mut s = state.lock().await;
    s.status = AuthStatus::Failed("timeout".to_string());
    s.user_code = None;
    s.verification_uri = None;
    tracing::warn!("device auth: polling timed out");
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
}

impl AccountVault {
    /// The active account, if the pointer resolves to one in the list.
    pub fn active(&self) -> Option<&Account> {
        let id = self.active_user_id.as_deref()?;
        self.accounts.iter().find(|a| a.user_id == id)
    }
}

fn accounts_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join("accounts.json")
}

/// Load the vault from `accounts.json`. Returns an empty vault when the file is
/// absent or malformed (callers fall back to the legacy single-token path).
pub fn load_accounts() -> AccountVault {
    let Ok(bytes) = std::fs::read(accounts_path()) else {
        return AccountVault::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Persist the vault to `accounts.json` (0600) and mirror the active account's
/// token into the legacy `auth.json` so single-token consumers keep working.
pub fn save_accounts(vault: &AccountVault) -> Result<()> {
    let path = accounts_path();
    write_secret_file(&path, &serde_json::to_string_pretty(vault)?)?;
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
    let data = serde_json::json!({ "token": token });
    write_secret_file(&path, &serde_json::to_string(&data)?)?;
    Ok(())
}

pub fn load_token() -> Option<String> {
    // Prefer the multi-account vault's active token; fall back to the legacy
    // single-token `auth.json` for backward compatibility.
    if let Some(token) = active_token() {
        return Some(token);
    }
    let bytes = std::fs::read(token_path()).ok()?;
    let data: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    data["token"]
        .as_str()
        .or_else(|| data["access_token"].as_str())
        .map(str::to_string)
}

pub fn clear_token() -> Result<()> {
    let path = token_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

fn token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join("auth.json")
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

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(path, body)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };
        assert_eq!(vault.active().unwrap().user_id, "u2");
        assert_eq!(vault.active().unwrap().token, "t2");

        // A dangling pointer resolves to None (not the first account).
        let dangling = AccountVault {
            accounts: vec![account("u1", "t1")],
            active_user_id: Some("ghost".to_owned()),
        };
        assert!(dangling.active().is_none());

        // No pointer at all → None.
        let unset = AccountVault {
            accounts: vec![account("u1", "t1")],
            active_user_id: None,
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

}
