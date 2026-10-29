//! Typed usage-summary relay for hosted and Core-managed Gateways.
//!
//! This is intentionally not another tracing layer. Customer diagnostics keep
//! using `telemetry.rs` and their own OTLP destination. Core-managed node
//! relays emit allowlisted model-call facts only when diagnostics export is
//! enabled and an OTLP endpoint is configured. Hosted Gateway operator events
//! use the separate server-only relay secret.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const DIAGNOSTICS_EXPORT_ENABLED_ENV: &str = "RYU_DIAGNOSTICS_EXPORT_ENABLED";
const DIAGNOSTICS_OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const ANALYTICS_CONFIG_FILE_ENV: &str = "RYU_ANALYTICS_CONFIG_FILE";
const INGEST_URL_ENV: &str = "RYU_ANALYTICS_INGEST_URL";
const INGEST_KEY_ENV: &str = "RYU_ANALYTICS_INGEST_KEY";
const INGEST_SECRET_ENV: &str = "RYU_ANALYTICS_INGEST_SECRET";
const CONTROL_PLANE_URL_ENV: &str = "CONTROL_PLANE_URL";
const CREDITS_SECRET_FALLBACK_ENV: &str = "RYU_CREDITS_INTERNAL_SECRET";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RELAY_PATH: &str = "/api/telemetry/ryu";
const MAX_FIELD_LENGTH: usize = 128;
const DIAGNOSTICS_OPT_IN_HEADER: &str = "x-ryu-diagnostics-opt-in";

#[derive(Clone)]
enum AuthMode {
    GatewayRelayToken(String),
    HostedSecret(String),
}

#[derive(Clone)]
struct Config {
    auth: AuthMode,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum GatewayAnalyticsRelayFile {
    Disabled,
    Enabled {
        url: String,
        relay_token_path: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCallEvent {
    kind: &'static str,
    event_id: String,
    operation: String,
    provider: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    latency_ms: u64,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    service_version: &'static str,
}

#[derive(Debug, Serialize)]
struct RelayBody<T> {
    events: [T; 1],
}

fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

fn diagnostics_relay_enabled(diagnostics_export_enabled: &str, otlp_endpoint: &str) -> bool {
    truthy(diagnostics_export_enabled) && !otlp_endpoint.trim().is_empty()
}

fn endpoint(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.ends_with(RELAY_PATH) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}{RELAY_PATH}")
    }
}

/// Read the relay credential Core persisted. Core seals it with the Gateway's
/// component subkey (`encc:v1:`), which a Core-spawned Gateway receives at
/// spawn; a legacy plaintext file from an older Core still reads.
fn read_relay_token(path: &str) -> Option<String> {
    let sealer = <ryu_crypto::GatewayScope as ryu_crypto::SealScope>::sealer().ok();
    read_relay_token_with(path, sealer.as_deref())
}

fn read_relay_token_with(
    path: &str,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> Option<String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || path.file_name()?.to_str()? != "gateway-relay.token" {
        return None;
    }
    let file = std::fs::File::open(&path).ok()?;
    let mut contents = String::new();
    file.take(2049).read_to_string(&mut contents).ok()?;
    if contents.len() > 2048 {
        return None;
    }
    let stored = contents.trim();
    if stored.is_empty() {
        return None;
    }
    if !ryu_crypto::looks_sealed(stored) {
        return Some(stored.to_owned());
    }
    let Some(sealer) = sealer else {
        tracing::warn!(
            "ryu diagnostics: the relay credential is sealed and this Gateway has no sealing key; diagnostics summaries are not sent"
        );
        return None;
    };
    match sealer.open(stored) {
        Ok(token) if !token.trim().is_empty() => Some(token.trim().to_owned()),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!("ryu diagnostics: could not open the relay credential: {error}");
            None
        }
    }
}

fn configured_from_core_file() -> Option<Config> {
    let path = std::env::var(ANALYTICS_CONFIG_FILE_ENV).ok()?;
    if path.trim().is_empty() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 2048 {
        return None;
    }
    let mut contents = String::new();
    file.take(2049).read_to_string(&mut contents).ok()?;
    if contents.len() > 2048 {
        return None;
    }
    let relay = serde_json::from_str::<GatewayAnalyticsRelayFile>(&contents).ok()?;
    match relay {
        GatewayAnalyticsRelayFile::Disabled => None,
        GatewayAnalyticsRelayFile::Enabled {
            url,
            relay_token_path,
        } => {
            let key = read_relay_token(&relay_token_path)?;
            (!url.trim().is_empty()).then_some(Config {
                auth: AuthMode::GatewayRelayToken(key),
                url: endpoint(&url),
            })
        }
    }
}

fn configured() -> Option<Config> {
    // `RYU_ANALYTICS_INGEST_*` are the least-privilege names. The existing
    // hosted fleet variables are a transition fallback so a code deploy does not
    // silently lose operator telemetry before Dokploy's stored env is migrated.
    let url = std::env::var(INGEST_URL_ENV)
        .ok()
        .or_else(|| std::env::var(CONTROL_PLANE_URL_ENV).ok())
        .filter(|value| !value.trim().is_empty());
    if let Some(secret) = std::env::var(INGEST_SECRET_ENV)
        .ok()
        .or_else(|| std::env::var(CREDITS_SECRET_FALLBACK_ENV).ok())
        .filter(|value| !value.trim().is_empty())
    {
        let url = url?;
        return Some(Config {
            auth: AuthMode::HostedSecret(secret),
            url: endpoint(&url),
        });
    }
    if let Some(config) = configured_from_core_file() {
        return Some(config);
    }
    let url = url?;
    let key = std::env::var(INGEST_KEY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    if !diagnostics_relay_enabled(
        &std::env::var(DIAGNOSTICS_EXPORT_ENABLED_ENV).unwrap_or_default(),
        &std::env::var(DIAGNOSTICS_OTLP_ENDPOINT_ENV).unwrap_or_default(),
    ) {
        return None;
    }
    Some(Config {
        auth: AuthMode::GatewayRelayToken(key),
        url: endpoint(&url),
    })
}

fn bounded(value: &str) -> String {
    value.trim().chars().take(MAX_FIELD_LENGTH).collect()
}

/// Emit a successful or failed model-call fact without awaiting the relay.
/// `error_code` is a stable class only (never a provider message or response
/// body) and is omitted for successful calls.
pub fn emit_model_call(
    operation: &str,
    provider: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    latency_ms: u64,
    outcome: &'static str,
    _error_code: Option<&str>,
) {
    let Some(config) = configured() else {
        return;
    };
    let event = ModelCallEvent {
        kind: "gateway_model_call",
        event_id: uuid::Uuid::new_v4().to_string(),
        operation: bounded(operation),
        provider: bounded(provider),
        model: bounded(model),
        input_tokens,
        output_tokens,
        latency_ms,
        outcome,
        error_code: _error_code.map(bounded),
        service_version: env!("CARGO_PKG_VERSION"),
    };
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut request = client
            .post(config.url)
            .timeout(REQUEST_TIMEOUT)
            .json(&RelayBody { events: [event] });
        request = match config.auth {
            AuthMode::GatewayRelayToken(key) => request
                .header("x-gateway-key", key)
                .header(DIAGNOSTICS_OPT_IN_HEADER, "true"),
            AuthMode::HostedSecret(secret) => request.header("x-ryu-analytics-secret", secret),
        };
        let _ = request.send().await;
    });
}

#[cfg(test)]
mod tests {
    use super::{
        diagnostics_relay_enabled, endpoint, read_relay_token, read_relay_token_with, truthy,
        GatewayAnalyticsRelayFile, ModelCallEvent,
    };

    #[test]
    fn hosted_and_local_gates_parse_explicit_values() {
        assert!(truthy(" true "));
        assert!(truthy("1"));
        assert!(!truthy("false"));
        assert!(!truthy(""));
    }

    #[test]
    fn node_relay_requires_diagnostics_consent_and_destination() {
        assert!(diagnostics_relay_enabled("true", "https://posthog.example"));
        assert!(!diagnostics_relay_enabled("0", "https://posthog.example"));
        assert!(!diagnostics_relay_enabled("1", ""));
        assert!(!diagnostics_relay_enabled("", ""));
    }

    #[test]
    fn endpoint_adds_the_relay_path_once() {
        assert_eq!(
            endpoint("https://api.example/"),
            "https://api.example/api/telemetry/ryu"
        );
        assert_eq!(
            endpoint("https://api.example/api/telemetry/ryu"),
            "https://api.example/api/telemetry/ryu"
        );
    }

    #[test]
    fn core_relay_config_reads_only_the_expected_token_file() {
        let directory =
            std::env::temp_dir().join(format!("ryu-gateway-analytics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let relay_token_path = directory.join("gateway-relay.token");
        std::fs::write(&relay_token_path, "relay-token\n").expect("write test token");
        let serialized = serde_json::json!({
            "status": "enabled",
            "url": "https://api.example/api/telemetry/ryu",
            "relay_token_path": relay_token_path.to_string_lossy(),
        });
        let parsed: GatewayAnalyticsRelayFile =
            serde_json::from_value(serialized).expect("parse relay config");

        let GatewayAnalyticsRelayFile::Enabled {
            url,
            relay_token_path,
        } = parsed
        else {
            panic!("enabled relay config should stay enabled");
        };
        assert_eq!(url, "https://api.example/api/telemetry/ryu");
        assert_eq!(
            read_relay_token(&relay_token_path).as_deref(),
            Some("relay-token")
        );
        assert_eq!(read_relay_token("/tmp/not-a-relay-token"), None);

        std::fs::remove_file(&relay_token_path).expect("remove test token");
        std::fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn sealed_relay_token_opens_only_with_the_gateway_key() {
        let directory =
            std::env::temp_dir().join(format!("ryu-gateway-sealed-relay-{}", uuid::Uuid::new_v4()));
        let path = directory.join("gateway-relay.token");
        let sealer = ryu_crypto::ComponentCipher::from_subkey_b64(
            ryu_crypto::components::GATEWAY,
            "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
        )
        .unwrap();
        ryu_crypto::write_secret_file(&path, "rgw_relay_sealed_token", &sealer).unwrap();
        let path = path.to_string_lossy().into_owned();
        assert_eq!(
            read_relay_token_with(&path, Some(&sealer)).as_deref(),
            Some("rgw_relay_sealed_token")
        );
        assert_eq!(read_relay_token_with(&path, None), None);
        let master = ryu_crypto::FieldCipher::new(&[1u8; 32]);
        assert_eq!(read_relay_token_with(&path, Some(&master)), None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn model_event_wire_shape_is_content_free() {
        let event = ModelCallEvent {
            kind: "gateway_model_call",
            event_id: "event".to_owned(),
            operation: "chat".to_owned(),
            provider: "provider".to_owned(),
            model: "model".to_owned(),
            input_tokens: 1,
            output_tokens: 2,
            latency_ms: 3,
            outcome: "error",
            error_code: Some("all_providers_unavailable".to_owned()),
            service_version: "0.2.0",
        };
        let value = serde_json::to_value(event).expect("serialize event");
        assert_eq!(value["kind"], "gateway_model_call");
        assert_eq!(value["errorCode"], "all_providers_unavailable");
        assert!(value.get("prompt").is_none());
        assert!(value.get("requestId").is_none());
    }
}
