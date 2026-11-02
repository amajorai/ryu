//! The installed Pi's own model table and its credential refresh.

use super::*;

/// Read the installed Pi provider's own model table without a network request.
/// Discovery remains usable when models.dev is offline or has no cached entry.
/// A missing managed Pi installation is normal during setup, so callers can
/// continue to the remote registry and free-text model input.
pub(in crate::pi_config) fn builtin_catalog_provider_id(ryu_provider_id: &str) -> Option<&str> {
    oauth_provider_id(ryu_provider_id).or_else(|| {
        crate::pi_config::provider_meta(ryu_provider_id)
            .filter(|meta| meta.auth_kind == "api-key" && !meta.auth_key.is_empty())
            .map(|meta| meta.auth_key)
    })
}

pub async fn builtin_models(ryu_provider_id: &str) -> Vec<Value> {
    if ryu_provider_id == crate::pi_config::CHATGPT_PLAN_PROVIDER_ID {
        return Vec::new();
    }
    let Some(provider) = builtin_catalog_provider_id(ryu_provider_id) else {
        return Vec::new();
    };
    let pi_dir = crate::sidecar::adapters::acp::managed_pi_dir();
    if !pi_dir
        .join("node_modules/@earendil-works/pi-ai/package.json")
        .is_file()
    {
        return Vec::new();
    }
    let Some(runtime) = js_runtime() else {
        return Vec::new();
    };
    if ensure_bridge().is_err() {
        return Vec::new();
    }

    let mut command = tokio::process::Command::new(runtime);
    command
        .arg(BRIDGE_FILE)
        .arg(provider)
        .arg("models")
        .current_dir(pi_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .no_window();
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return Vec::new();
    };
    // Cold SDK imports can exceed five seconds on Windows under build/disk load.
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut lines = BufReader::new(stdout).lines();
        let Some(line) = lines.next_line().await.ok().flatten() else {
            return Vec::new();
        };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            return Vec::new();
        };
        if event.get("type").and_then(Value::as_str) != Some("models") {
            return Vec::new();
        }
        event
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    })
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    result.unwrap_or_default()
}

/// Ask Pi's own OAuth implementation to rotate an account credential. The
/// credential travels over the child's stdin/stdout pipes, never in argv, env,
/// stderr, or a log line. Each provider owns its token exchange contract.
pub async fn refresh_credential(auth_key: &str, credential: &Value) -> Result<Option<Value>> {
    if auth_key == "kiro" {
        return crate::pi_config::kiro_oauth::refresh(credential.clone())
            .await
            .map(Some)
            .map_err(Into::into);
    }
    if auth_key == crate::pi_config::CHATGPT_PLAN_AUTH_KEY {
        let saved = crate::pi_config::chatgpt_plan::StoredAccount::from_value(credential)?;
        let rotated = crate::pi_config::chatgpt_plan::refresh(saved.credential()?.clone()).await?;
        return Ok(Some(serde_json::to_value(rotated)?));
    }
    let provider = match auth_key {
        crate::pi_config::CHATGPT_AUTH_KEY | "openai" => "openai-codex",
        "anthropic" | "openai-codex" | "github-copilot" | "kimi-coding" | "radius"
        | "openrouter" | "xai" => auth_key,
        _ => return Ok(None),
    };
    // These preparation failures occur before any credential is dispatched.
    let runtime = js_runtime().ok_or(crate::pi_config::accounts::RefreshFailure::Transient)?;
    crate::sidecar::adapters::acp::ensure_managed_pi()
        .await
        .map_err(|_| crate::pi_config::accounts::RefreshFailure::Transient)?;
    ensure_bridge().map_err(|_| crate::pi_config::accounts::RefreshFailure::Transient)?;

    let mut child = tokio::process::Command::new(runtime);
    child
        .arg(BRIDGE_FILE)
        .arg(provider)
        .arg("refresh")
        .current_dir(crate::sidecar::adapters::acp::managed_pi_dir())
        .env("PI_CODING_AGENT_DIR", crate::pi_config::config_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .no_window();
    if provider == "anthropic" {
        // A Claude route through the owner's desktop covers token refresh too.
        // A route that applies but cannot run refuses the refresh rather than
        // sending it from the cloud.
        child.envs(
            crate::local_egress::providers::bridge_proxy_env(
                crate::local_egress::providers::ProviderRoute::Claude,
            )
            .map_err(|_| crate::pi_config::accounts::RefreshFailure::Transient)?,
        );
    }
    let mut child = child
        .spawn()
        .map_err(|_| crate::pi_config::accounts::RefreshFailure::Transient)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(crate::pi_config::accounts::RefreshFailure::Transient)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(crate::pi_config::accounts::RefreshFailure::Transient)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let input = format!(
            "{}\n",
            json!({ "type": "refresh", "credential": credential })
        );
        stdin.write_all(input.as_bytes()).await?;
        stdin.flush().await?;
        drop(stdin);
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let event: Value = serde_json::from_str(&line)
                .context("OAuth refresh helper returned invalid JSON")?;
            match event.get("type").and_then(Value::as_str) {
                Some("done") => {
                    let refreshed = event.get("credential").cloned().unwrap_or(Value::Null);
                    if refreshed.get("type").and_then(Value::as_str) != Some("oauth")
                        || refreshed.get("access").and_then(Value::as_str).is_none()
                    {
                        anyhow::bail!("OAuth refresh helper returned an invalid credential");
                    }
                    return Ok(refreshed);
                }
                Some("error") => {
                    let failure = match event.get("refreshFailure").and_then(Value::as_str) {
                        Some("revoked") => crate::pi_config::accounts::RefreshFailure::Revoked,
                        Some("transient") => crate::pi_config::accounts::RefreshFailure::Transient,
                        _ => crate::pi_config::accounts::RefreshFailure::Uncertain,
                    };
                    return Err(failure.into());
                }
                _ => {}
            }
        }
        anyhow::bail!("OAuth refresh helper exited without a result")
    })
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    Ok(Some(result.context("OAuth refresh helper timed out")??))
}
