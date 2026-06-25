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
            if let Err(e) = save_token(token) {
                tracing::warn!("failed to save token: {e}");
            }
            let mut s = state.lock().await;
            s.status = AuthStatus::Authenticated;
            s.token = Some(token.to_string());
            s.user_code = None;
            s.verification_uri = None;
            tracing::info!("device auth: token received and saved");
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

// ── Token persistence ────────────────────────────────────────────────────────

pub fn save_token(token: &str) -> Result<()> {
    let path = token_path();
    let data = serde_json::json!({ "token": token });
    write_secret_file(&path, &serde_json::to_string(&data)?)?;
    Ok(())
}

pub fn load_token() -> Option<String> {
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
        use std::os::unix::fs::OpenOptionsExt;

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
