//! Gateway config write, status and control-plane proxies: `write_gateway_toml` through `is_gateway_secret_key`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Merge a `GatewayConfigPatch` into the existing `gateway.toml`, returning
/// the merged `toml::Value` for inclusion in the response. The merge strategy
/// is: load the existing file (or start from an empty table), overlay each
/// present section from the patch, write back atomically.
///
/// The write uses a `.tmp`-rename so a crash mid-write never leaves a corrupt
/// file. Unknown keys in the existing file are preserved; only the patched
/// sections are updated.
pub(in crate::server) fn write_gateway_toml(
    patch: &GatewayConfigPatch,
) -> anyhow::Result<toml::Value> {
    let path = gateway_config_path()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine gateway config path"))?;

    let mut transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(&path)?;
    let revision = transaction.snapshot().revision().clone();
    let mut root = gateway_config_document(&transaction).map_err(anyhow::Error::msg)?;

    let table = root
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("gateway.toml root is not a table"))?;

    if let Some(fw) = &patch.firewall {
        let fw_toml = toml::Value::try_from(fw)
            .map_err(|e| anyhow::anyhow!("Failed to serialize firewall patch: {e}"))?;
        if let toml::Value::Table(fw_table) = fw_toml {
            let existing = table
                .entry("firewall")
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if let toml::Value::Table(existing_table) = existing {
                for (k, v) in fw_table {
                    existing_table.insert(k, v);
                }
            }
        }
    }

    if let Some(rt) = &patch.routing {
        let rt_toml = toml::Value::try_from(rt)
            .map_err(|e| anyhow::anyhow!("Failed to serialize routing patch: {e}"))?;
        if let toml::Value::Table(rt_table) = rt_toml {
            let existing = table
                .entry("routing")
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if let toml::Value::Table(existing_table) = existing {
                for (k, v) in rt_table {
                    existing_table.insert(k, v);
                }
            }
        }
    }

    if let Some(budgets) = &patch.budgets {
        let budgets_toml = toml::Value::try_from(budgets)
            .unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new()));
        table.insert("budgets".to_string(), budgets_toml);
    }

    if let Some(auth) = &patch.auth {
        let mut auth_toml = toml::Value::try_from(auth)
            .map_err(|e| anyhow::anyhow!("Failed to serialize auth patch: {e}"))?;
        keep_redacted_gateway_client_keys(&mut auth_toml, table.get("auth"))?;
        if let toml::Value::Table(auth_table) = auth_toml {
            let existing = table
                .entry("auth")
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if let toml::Value::Table(existing_table) = existing {
                for (k, v) in auth_table {
                    existing_table.insert(k, v);
                }
            }
        }
    }

    let merged_str = toml::to_string_pretty(&root)
        .map_err(|e| anyhow::anyhow!("Failed to serialize merged config: {e}"))?;

    // Write with 0o600 permissions so provider keys / budget rules stored in
    // gateway.toml are not world-readable on multi-user systems. The parent
    // directory is restricted to 0o700 for the same reason.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = path.parent() {
            if parent.exists() {
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
    }

    transaction.commit(&revision, merged_str.as_bytes())?;

    // The merged document is echoed to the HTTP client as `effective_config`:
    // never hand back the client keys (or any other credential) it holds.
    redact_gateway_config(&mut root);
    Ok(root)
}

/// Client keys are never returned to HTTP callers (`***` / `••••••`), so a
/// read-modify-write client sends the placeholder back. Keep the stored key of
/// the entry with the same name instead of persisting the placeholder; a
/// placeholder with no stored entry to keep is an error.
pub(in crate::server) fn keep_redacted_gateway_client_keys(
    incoming_auth: &mut toml::Value,
    current_auth: Option<&toml::Value>,
) -> anyhow::Result<()> {
    let Some(entries) = incoming_auth
        .get_mut("api_keys")
        .and_then(toml::Value::as_array_mut)
    else {
        return Ok(());
    };
    let current = current_auth
        .and_then(|auth| auth.get("api_keys"))
        .and_then(toml::Value::as_array);
    for entry in entries.iter_mut() {
        let Some(table) = entry.as_table_mut() else {
            continue;
        };
        let Some(key) = table.get("key").and_then(toml::Value::as_str) else {
            continue;
        };
        if !ryu_crypto::redact::is_placeholder(key) {
            continue;
        }
        let name = table
            .get("name")
            .and_then(toml::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let stored = current
            .into_iter()
            .flatten()
            .find(|saved| saved.get("name").and_then(toml::Value::as_str) == Some(name.as_str()))
            .and_then(|saved| saved.get("key"))
            .and_then(toml::Value::as_str)
            .filter(|stored| !ryu_crypto::redact::is_placeholder(stored))
            .ok_or_else(|| {
                anyhow::anyhow!("no existing Gateway API key named '{name}' to preserve")
            })?;
        table.insert("key".to_owned(), toml::Value::String(stored.to_owned()));
    }
    Ok(())
}

/// Give a test process a fixed master key so `gateway.toml` writes can seal
/// secrets (the same constant the identity tests use).
#[cfg(test)]
pub(crate) fn gateway_seal_test_key() {
    use base64::Engine as _;
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::env::set_var("RYU_MASTER_KEY", key);
}

/// Write `data` to `path` with owner-only permissions (0o600 on Unix).
/// Uses a plain `OpenOptions` call on Windows — the BYOK vault unit (#140)
/// will add Windows ACL restriction when it lands.
pub(in crate::server) fn write_secret_file(
    path: &std::path::Path,
    data: &[u8],
) -> anyhow::Result<()> {
    use std::io::Write as _;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

/// `PUT /api/gateway/config` — write a validated TOML subset (firewall,
/// routing, budgets) to `gateway.toml` and trigger a gateway refresh.
///
/// **IMPORTANT:** `GatewayManager::refresh()` stops and respawns the gateway
/// process. This drops any in-flight requests and resets all in-memory metrics
/// counters (rate-limit windows, circuit-breaker state, eval scores, cache).
/// Callers should treat writes as low-frequency operations and avoid calling
/// during peak load.
///
/// When `RYU_GATEWAY_MANAGED=0`, the write is still persisted to disk (the next
/// manual gateway restart will pick it up), but `refresh()` is a no-op and the
/// response includes `"externally_managed": true` with a notice that a restart
/// is required for the change to take effect.
pub(in crate::server) async fn gateway_config_write(
    State(state): State<ServerState>,
    Json(patch): Json<GatewayConfigPatch>,
) -> axum::response::Response {
    if patch.firewall.is_none()
        && patch.routing.is_none()
        && patch.budgets.is_none()
        && patch.auth.is_none()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Request body must include at least one of: firewall, routing, budgets, auth"
                .to_owned(),
        );
    }

    // Persist the patch to disk first. If this fails the gateway is unchanged.
    let merged = match tokio::task::spawn_blocking(move || write_gateway_toml(&patch)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            return match e.downcast::<ryu_gw_credentials::ConfigCommitError>() {
                Ok(error) => gateway_config_transaction_error(error).into_response(),
                Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
        }
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("config write task panicked: {e}"),
            );
        }
    };

    // Attempt to refresh the gateway so the new config takes effect immediately.
    // refresh() returns Ok(false) when RYU_GATEWAY_MANAGED=0 (externally managed).
    match state.gateway.refresh().await {
        Ok(false) => {
            // Externally managed: file write succeeded, but Core does not own
            // the gateway process. The operator must restart it manually.
            let config_path = gateway_config_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            Json(json!({
                "ok": true,
                "externally_managed": true,
                "notice": "gateway.toml updated; restart the gateway process for changes to take effect (RYU_GATEWAY_MANAGED=0)",
                "config_path": config_path,
                "effective_config": merged,
            }))
            .into_response()
        }
        Ok(true) => Json(json!({
            "ok": true,
            "externally_managed": false,
            "notice": "gateway restarted; in-flight requests were dropped and in-memory metrics counters reset",
            "effective_config": merged,
        }))
        .into_response(),
        Err(e) => {
            // The file write succeeded but the refresh failed. The config on disk
            // is updated; the running gateway still has the old config until it
            // is restarted manually.
            let config_path = gateway_config_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "ok": false,
                    "notice": "gateway.toml updated but gateway refresh failed; restart the gateway manually",
                    "config_path": config_path,
                    "effective_config": merged,
                    "error": e.to_string(),
                })),
            )
                .into_response()
        }
    }
}

/// `POST /api/gateway/restart` — a recovery action for the preflight/health
/// page. Respawns the managed gateway child (stop → start, then health-wait) via
/// `GatewayManager::refresh`. A no-op that reports `externally_managed: true`
/// when the gateway is not Core-managed (remote/external), since Core does not
/// own that process. Always 200 with `{ success, ... }`.
#[utoipa::path(
    post,
    path = "/api/gateway/restart",
    tag = "Gateway",
    summary = "Restart the Core-managed gateway sidecar",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_restart(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Json<serde_json::Value> {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return Json(json!({
            "success": false,
            "error": "insufficient permissions: gateway.configure",
        }));
    }

    match state.gateway.refresh().await {
        Ok(true) => {
            record_gateway_control(&state, "gateway.restart", "gateway_process", None, &caller)
                .await;
            Json(json!({ "success": true }))
        }
        Ok(false) => Json(json!({
            "success": false,
            "externally_managed": true,
            "notice": "gateway is externally managed; Core does not control its process",
        })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

pub(in crate::server) const REDACTED_GATEWAY_CONFIG_VALUE: &str = "***";

pub(in crate::server) fn is_gateway_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.ends_with("_api_key")
        || key.ends_with("_api_keys")
        || key.ends_with("_token")
        || key.ends_with("_secret")
        || matches!(
            key.as_str(),
            "api_key"
                | "api_keys"
                | "access_token"
                | "access_key_id"
                | "secret_access_key"
                | "session_token"
                | "app_secret"
                | "app_token"
                | "bot_token"
                | "verify_token"
                | "gateway_key"
                | "internal_secret"
                | "authorization"
                | "bearer"
                | "bearer_token"
                | "client_secret"
                | "credential"
                | "credentials"
                | "encryption_key"
                | "key"
                | "keys"
                | "master_key"
                | "password"
                | "private_key"
                | "refresh_token"
                | "secret"
                | "secret_key"
                | "signing_key"
                | "signing_secret"
                | "token"
                | "webhook_secret"
        )
}
