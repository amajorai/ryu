use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

// ── Token file location ────────────────────────────────────────────────────

fn auth_file_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".ryu").join("auth.json")
}

// ── Persisted auth data ────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthData {
    pub token: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

pub fn load_token() -> Option<AuthData> {
    let content = std::fs::read_to_string(auth_file_path()).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save_token(data: &AuthData) -> Result<()> {
    let path = auth_file_path();
    write_secret_file(&path, &serde_json::to_string_pretty(data)?).context("writing auth.json")?;
    Ok(())
}

pub fn clear_token() -> Result<()> {
    let path = auth_file_path();
    if path.exists() {
        std::fs::remove_file(&path).context("removing auth.json")?;
    }
    Ok(())
}

// ── OAuth login flow via Ryu Core ──────────────────────────────────────────

const LOGIN_TIMEOUT_SECS: u64 = 300;

fn core_url() -> String {
    std::env::var("RYU_CORE_URL").unwrap_or_else(|_| "http://localhost:7980".into())
}

pub async fn run_login(backend_url: &str) -> Result<()> {
    let core = core_url();

    // Tell Core to start the OAuth flow.
    let resp = HTTP
        .post(format!("{core}/api/auth/login"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("failed to reach Ryu Core — make sure it is running")?;

    if !resp.status().is_success() {
        anyhow::bail!("Core returned {} for /api/auth/login", resp.status());
    }

    let payload: serde_json::Value = resp.json().await.context("invalid JSON from Core")?;
    let auth_url = payload["authUrl"]
        .as_str()
        .or_else(|| payload["verificationUriComplete"].as_str())
        .or_else(|| payload["verificationUri"].as_str())
        .ok_or_else(|| anyhow!("no authUrl in Core response"))?;
    let user_code = payload["userCode"].as_str();

    println!("Opening browser for login...");
    println!("If the browser does not open, visit:\n  {auth_url}");
    if let Some(code) = user_code {
        println!("Device code: {code}");
    }
    let _ = open::that(auth_url);
    println!("Waiting for authentication (Ctrl+C to cancel)...");

    // Poll Core until authenticated or timeout.
    let token = tokio::time::timeout(
        Duration::from_secs(LOGIN_TIMEOUT_SECS),
        poll_core_status(&core),
    )
    .await
    .map_err(|_| anyhow!("login timed out after {} seconds", LOGIN_TIMEOUT_SECS))??;

    let auth_data = fetch_user_info(backend_url, &token)
        .await
        .unwrap_or(AuthData {
            token: token.clone(),
            email: None,
            name: None,
        });

    save_token(&auth_data)?;
    println!("Authentication successful!");
    if let Some(name) = &auth_data.name {
        println!("Name:  {name}");
    }
    if let Some(email) = &auth_data.email {
        println!("Email: {email}");
    }
    Ok(())
}

/// Poll `GET /api/auth/status` every 1.5 s until Core reports authenticated.
async fn poll_core_status(core_url: &str) -> Result<String> {
    loop {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if let Ok(r) = HTTP
            .get(format!("{core_url}/api/auth/status"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                if data["authenticated"].as_bool().unwrap_or(false) {
                    if let Some(auth_data) = load_token() {
                        return Ok(auth_data.token);
                    }
                }
            }
        }
    }
}

fn write_secret_file(path: &std::path::Path, body: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("creating ~/.ryu directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .context("setting ~/.ryu permissions")?;
        }
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .context("opening auth.json")?;
        file.write_all(body.as_bytes())
            .context("writing auth.json")?;
        file.sync_all().context("syncing auth.json")?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .context("setting auth.json permissions")?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(path, body).context("writing auth.json")?;
    }

    Ok(())
}

// ── Background login for TUI ──────────────────────────────────────────────

pub enum LoginEvent {
    Success,
    Error(String),
}

pub fn spawn_login_background(
    backend_url: &str,
) -> tokio::sync::mpsc::UnboundedReceiver<LoginEvent> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let backend_url = backend_url.to_owned();

    tokio::spawn(async move {
        match run_login(&backend_url).await {
            Ok(()) => {
                let _ = tx.send(LoginEvent::Success);
            }
            Err(e) => {
                let _ = tx.send(LoginEvent::Error(e.to_string()));
            }
        }
    });

    rx
}

// ── Fetch user info using the new token ───────────────────────────────────

async fn fetch_user_info(backend_url: &str, token: &str) -> Result<AuthData> {
    let resp = authed_get(backend_url, "/api/auth/get-session", token).await?;
    let user = resp.get("user");
    Ok(AuthData {
        token: token.to_owned(),
        email: user
            .and_then(|u| u.get("email"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        name: user
            .and_then(|u| u.get("name"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    })
}

// ── Authenticated HTTP helpers ────────────────────────────────────────────

static HTTP: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(reqwest::Client::new);

fn extract_error(body: &serde_json::Value) -> &str {
    body.get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("request failed")
}

fn require_token() -> Result<AuthData> {
    load_token().ok_or_else(|| {
        anyhow!("Not logged in. Run `ryu login` or press l in the Account tab to authenticate.")
    })
}

pub fn require_token_and_url() -> Result<(AuthData, String)> {
    let data = require_token()?;
    let url = std::env::var("RYU_AUTH_URL").unwrap_or_else(|_| "http://localhost:3000".into());
    Ok((data, url))
}

async fn check_resp(resp: reqwest::Response) -> Result<serde_json::Value> {
    if !resp.status().is_success() {
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        anyhow::bail!("{} (HTTP {status})", extract_error(&body));
    }
    resp.json().await.context("failed to parse response")
}

async fn authed_get(backend_url: &str, path: &str, token: &str) -> Result<serde_json::Value> {
    let resp = HTTP
        .get(format!("{backend_url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("network request failed")?;
    check_resp(resp).await
}

async fn authed_delete(backend_url: &str, path: &str, token: &str) -> Result<serde_json::Value> {
    let resp = HTTP
        .delete(format!("{backend_url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("network request failed")?;
    check_resp(resp).await
}

async fn authed_put_json(
    backend_url: &str,
    path: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    let resp = HTTP
        .put(format!("{backend_url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("network request failed")?;
    check_resp(resp).await
}

// ── Full session (richer than fetch_user_info) ────────────────────────────

pub async fn fetch_full_session(backend_url: &str, token: &str) -> Result<serde_json::Value> {
    authed_get(backend_url, "/api/auth/get-session", token).await
}

// ── Password status ──────────────────────────────────────────────────────

pub async fn fetch_password_status(backend_url: &str, token: &str) -> Result<serde_json::Value> {
    authed_get(backend_url, "/api/user/password-status", token).await
}

// ── Sessions ─────────────────────────────────────────────────────────────

pub async fn fetch_sessions(backend_url: &str, token: &str) -> Result<Vec<serde_json::Value>> {
    let resp = authed_get(backend_url, "/api/sessions", token).await?;
    let sessions = resp
        .get("sessions")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(sessions)
}

pub async fn revoke_session(backend_url: &str, token: &str, session_id: &str) -> Result<()> {
    authed_delete(backend_url, &format!("/api/sessions/{session_id}"), token).await?;
    Ok(())
}

pub async fn revoke_all_other_sessions(backend_url: &str, token: &str) -> Result<()> {
    authed_delete(backend_url, "/api/sessions", token).await?;
    Ok(())
}

// ── Multi-account (Core owns the vault) ──────────────────────────────────

/// One signed-in account as returned by Core's `/api/auth/accounts`. Tokens
/// never leave the device, so this safe shape carries no token — only the
/// fields the switcher renders plus the `active` marker.
#[derive(Debug, Clone, Deserialize)]
pub struct Account {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub active: bool,
}

/// `GET {core}/api/auth/accounts` — list every signed-in account. Core owns the
/// vault; the CLI never stores accounts locally.
pub async fn fetch_accounts() -> Result<Vec<Account>> {
    let core = core_url();
    let resp = HTTP
        .get(format!("{core}/api/auth/accounts"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("failed to reach Ryu Core")?;
    let body = check_resp(resp).await?;
    let accounts = body
        .get("accounts")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<Account>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    Ok(accounts)
}

/// `POST {core}/api/auth/accounts/switch` — make `user_id` the active account.
pub async fn switch_account(user_id: &str) -> Result<()> {
    post_account_action("switch", user_id).await
}

/// `POST {core}/api/auth/accounts/remove` — sign one account out of the vault.
pub async fn remove_account(user_id: &str) -> Result<()> {
    post_account_action("remove", user_id).await
}

async fn post_account_action(action: &str, user_id: &str) -> Result<()> {
    let core = core_url();
    let resp = HTTP
        .post(format!("{core}/api/auth/accounts/{action}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "userId": user_id }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("failed to reach Ryu Core")?;
    let body = check_resp(resp).await?;
    if body.get("success").and_then(|v| v.as_bool()) == Some(false) {
        anyhow::bail!("{}", extract_error(&body));
    }
    Ok(())
}

// ── Billing / subscription ───────────────────────────────────────────────

pub async fn fetch_subscription_status(
    backend_url: &str,
    token: &str,
) -> Result<serde_json::Value> {
    authed_get(backend_url, "/api/billing/subscription-status", token).await
}

pub async fn fetch_invoices(backend_url: &str, token: &str) -> Result<Vec<serde_json::Value>> {
    let resp = authed_get(backend_url, "/api/billing/invoices", token).await?;
    let invoices = resp
        .get("invoices")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(invoices)
}

// ── Profile ──────────────────────────────────────────────────────────────

pub async fn update_display_name(backend_url: &str, token: &str, name: &str) -> Result<()> {
    authed_put_json(
        backend_url,
        "/api/profile/name",
        token,
        &serde_json::json!({ "name": name }),
    )
    .await?;
    Ok(())
}

// ── Combined auth info fetch (used by TUI) ───────────────────────────────

pub async fn fetch_auth_info() -> Option<crate::app::AuthInfo> {
    let data = load_token()?;
    let url = std::env::var("RYU_AUTH_URL").unwrap_or_else(|_| "http://localhost:3000".into());

    let (session_res, pw_res, sub_res, sessions_res) = tokio::join!(
        fetch_full_session(&url, &data.token),
        fetch_password_status(&url, &data.token),
        fetch_subscription_status(&url, &data.token),
        fetch_sessions(&url, &data.token),
    );

    let session = session_res.ok()?;
    let user = session.get("user")?;

    let name = user
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_owned();
    let email = user
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("—")
        .to_owned();
    let verified = user
        .get("emailVerified")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let two_factor = user
        .get("twoFactorEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let (has_password, auth_method) = pw_res
        .map(|pw| {
            let hp = pw
                .get("hasPassword")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let am = pw
                .get("authMethod")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_owned();
            (hp, am)
        })
        .unwrap_or((false, "unknown".to_owned()));

    let plan = sub_res
        .map(|s| crate::format_plan(&s))
        .unwrap_or_else(|_| "—".to_owned());

    let session_count = sessions_res.map(|s| s.len()).unwrap_or(0);

    Some(crate::app::AuthInfo {
        name,
        email,
        verified,
        two_factor,
        has_password,
        auth_method,
        plan,
        session_count,
    })
}
