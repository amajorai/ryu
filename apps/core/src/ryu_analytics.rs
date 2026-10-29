//! Opt-in diagnostics summaries relayed from Ryu Cloud-enrolled nodes.
//!
//! This is separate from `telemetry.rs`: Core and Gateway keep exporting their
//! redacted OTLP spans to the user's selected endpoint, while this producer sends
//! only an allowlisted summary to the Ryu control-plane relay when diagnostics
//! export is enabled and an OTLP destination is configured.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const BEAT_INTERVAL: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_PLANE_URL_ENV: &str = "RYU_CONTROL_PLANE_URL";
const SERVER_URL_ENV: &str = "RYU_SERVER_URL";
const MANAGED_NODE_ENV: &str = "RYU_MANAGED_NODE";
const ANALYTICS_CONFIG_FILE_ENV: &str = "RYU_ANALYTICS_CONFIG_FILE";
const ANALYTICS_CONFIG_FILE_NAME: &str = "gateway-analytics.json";
const DIAGNOSTICS_OPT_IN_HEADER: &str = "x-ryu-diagnostics-opt-in";
static GATEWAY_CONFIG_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone)]
struct RelayConfig {
    base_url: String,
    relay_token: String,
    relay_token_path: PathBuf,
    node_kind: RelayNodeKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RelayNodeKind {
    ManagedCloud,
    EnrolledSelfHosted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreHeartbeat {
    kind: &'static str,
    event_id: String,
    service_version: &'static str,
    os: &'static str,
    arch: &'static str,
    managed_node: bool,
}

#[derive(Debug, Serialize)]
struct RelayBody<T> {
    events: [T; 1],
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
enum GatewayRelayFile {
    Disabled,
    Enabled {
        url: String,
        relay_token_path: String,
    },
}

fn truthy(value: Option<String>) -> bool {
    value
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
        .unwrap_or(false)
}

fn control_plane_base_url() -> Option<String> {
    std::env::var(CONTROL_PLANE_URL_ENV)
        .ok()
        .or_else(|| std::env::var(SERVER_URL_ENV).ok())
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

fn gateway_analytics_config_path() -> PathBuf {
    std::env::var_os(ANALYTICS_CONFIG_FILE_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| crate::paths::state_path(ANALYTICS_CONFIG_FILE_NAME))
}

fn write_gateway_analytics_config(path: &Path, config: &GatewayRelayFile) -> std::io::Result<()> {
    use std::io::Write;

    let _write_guard = GATEWAY_CONFIG_WRITE_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("Gateway relay config writer lock poisoned"))?;
    let bytes = serde_json::to_vec(config).map_err(std::io::Error::other)?;
    if std::fs::read(path).is_ok_and(|current| current == bytes) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let Some(file_name) = path.file_name() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Gateway relay config path has no file name",
        ));
    };
    let temporary_path = path.with_file_name(format!(
        "{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

/// Publish only the relay URL and token-file path for a Core-managed Gateway.
/// The Axiom token never leaves the Ryu control plane.
pub fn sync_gateway_relay_config() {
    let config = relay_config(
        crate::telemetry::is_export_consented(),
        crate::telemetry::otlp_endpoint().is_some(),
    )
    .map(|relay| GatewayRelayFile::Enabled {
        url: relay_url(&relay.base_url),
        relay_token_path: relay.relay_token_path.to_string_lossy().into_owned(),
    })
    .unwrap_or(GatewayRelayFile::Disabled);

    if let Err(error) = write_gateway_analytics_config(&gateway_analytics_config_path(), &config) {
        tracing::warn!(error = %error, "ryu diagnostics: failed to update local Gateway relay config");
    }
}

fn relay_config(
    diagnostics_export_enabled: bool,
    diagnostics_endpoint_configured: bool,
) -> Option<RelayConfig> {
    if !diagnostics_export_enabled || !diagnostics_endpoint_configured {
        return None;
    }

    let (node_kind, base_url, relay_token, relay_token_path) =
        if truthy(std::env::var(MANAGED_NODE_ENV).ok()) {
            let relay_token_path = crate::sidecar::control_plane::gateway_relay_token_path();
            if !relay_token_path.is_file() {
                return None;
            }
            (
                RelayNodeKind::ManagedCloud,
                control_plane_base_url()?,
                crate::sidecar::gateway::gateway_relay_token()?
                    .trim()
                    .to_owned(),
                relay_token_path,
            )
        } else {
            let relay = crate::fleet::enrolled_diagnostics_relay()?;
            let relay_token_path =
                crate::sidecar::control_plane::persist_gateway_relay_token(&relay.relay_token)
                    .ok()?;
            (
                RelayNodeKind::EnrolledSelfHosted,
                relay.control_plane_url,
                relay.relay_token,
                relay_token_path,
            )
        };

    if !should_send(
        true,
        diagnostics_export_enabled,
        diagnostics_endpoint_configured,
        &relay_token,
        &base_url,
    ) {
        return None;
    }
    Some(RelayConfig {
        base_url,
        relay_token,
        relay_token_path,
        node_kind,
    })
}

/// A Core-managed Gateway reads the bounded relay config file on each model
/// summary. Pass its path even when it is disabled so later enrollment or opt-in
/// can take effect without sharing credentials through the Gateway environment.
pub fn gateway_child_env() -> Vec<(String, String)> {
    sync_gateway_relay_config();
    vec![(
        ANALYTICS_CONFIG_FILE_ENV.to_owned(),
        gateway_analytics_config_path()
            .to_string_lossy()
            .into_owned(),
    )]
}

fn relay_url(base_url: &str) -> String {
    format!("{}/api/telemetry/ryu", base_url.trim_end_matches('/'))
}

fn should_send(
    relay_credential_available: bool,
    diagnostics_export_enabled: bool,
    diagnostics_endpoint_configured: bool,
    relay_token: &str,
    base_url: &str,
) -> bool {
    relay_credential_available
        && diagnostics_export_enabled
        && diagnostics_endpoint_configured
        && !relay_token.trim().is_empty()
        && !base_url.trim().is_empty()
}

async fn send_heartbeat(client: &reqwest::Client, config: &RelayConfig) {
    let heartbeat = CoreHeartbeat {
        kind: "core_heartbeat",
        event_id: uuid::Uuid::new_v4().to_string(),
        service_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        managed_node: config.node_kind == RelayNodeKind::ManagedCloud,
    };
    let response = client
        .post(relay_url(&config.base_url))
        .header("x-gateway-key", &config.relay_token)
        .header(DIAGNOSTICS_OPT_IN_HEADER, "true")
        .timeout(REQUEST_TIMEOUT)
        .json(&RelayBody {
            events: [heartbeat],
        })
        .send()
        .await;
    if let Err(error) = response {
        tracing::debug!(error = %error, "ryu diagnostics: Core heartbeat dropped");
    }
}

/// Send an enrolled-node heartbeat only when diagnostics export is enabled and
/// an OTLP destination is active. The shared runtime gate follows preference
/// writes, so an in-session opt-out stops the next egress without a restart.
pub fn spawn() {
    sync_gateway_relay_config();
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut interval = tokio::time::interval(BEAT_INTERVAL);
        loop {
            interval.tick().await;
            let diagnostics_export_enabled = crate::telemetry::is_export_consented();
            let diagnostics_endpoint_configured = crate::telemetry::otlp_endpoint().is_some();
            sync_gateway_relay_config();
            if let Some(config) =
                relay_config(diagnostics_export_enabled, diagnostics_endpoint_configured)
            {
                send_heartbeat(&client, &config).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{relay_url, should_send, write_gateway_analytics_config, GatewayRelayFile};

    #[test]
    fn diagnostics_mirror_requires_node_consent_and_coordinates() {
        assert!(should_send(
            true,
            true,
            true,
            "rgw_key",
            "https://api.example"
        ));
        assert!(!should_send(
            false,
            true,
            true,
            "rgw_key",
            "https://api.example"
        ));
        assert!(!should_send(
            true,
            false,
            true,
            "rgw_key",
            "https://api.example"
        ));
        assert!(!should_send(
            true,
            true,
            false,
            "rgw_key",
            "https://api.example"
        ));
        assert!(!should_send(true, true, true, "", "https://api.example"));
        assert!(!should_send(true, true, true, "rgw_key", ""));
    }

    #[test]
    fn gateway_config_file_contains_only_relay_coordinates() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("gateway-analytics.json");
        let config = GatewayRelayFile::Enabled {
            url: "https://api.example/api/telemetry/ryu".to_owned(),
            relay_token_path: "/var/lib/ryu/.ryu/gateway-relay.token".to_owned(),
        };

        write_gateway_analytics_config(&path, &config).expect("write relay config");
        write_gateway_analytics_config(&path, &config).expect("idempotent relay config write");

        let bytes = std::fs::read(&path).expect("read relay config");
        let parsed: GatewayRelayFile =
            serde_json::from_slice(&bytes).expect("deserialize gateway relay config");
        assert_eq!(parsed, config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let permissions = std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(permissions, 0o600);
        }
    }

    #[test]
    fn relay_url_has_one_api_mount() {
        assert_eq!(
            relay_url("https://api.example/"),
            "https://api.example/api/telemetry/ryu"
        );
    }
}
