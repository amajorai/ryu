//! Typed usage-summary relay for hosted and Core-managed Gateways.
//!
//! This is intentionally not another tracing layer. Customer diagnostics keep
//! using `telemetry.rs` and their own OTLP destination. Core-managed node
//! relays emit allowlisted model-call facts only when diagnostics export is
//! enabled and an OTLP endpoint is configured. Hosted Gateway operator events
//! use the separate server-only relay secret.
//!
//! A model call only queues its event: `relay` holds the cached
//! configuration and posts the queue in batches (`batch`).

use std::io::Read;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

mod batch;
mod relay;

pub use relay::shutdown;

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
struct RelayBody<'a, T> {
    events: &'a [T],
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

/// Process-wide relay client, so model-call facts reuse pooled keep-alive
/// connections and one TLS configuration instead of a new client per call.
/// The per-request timeout is set on each request builder.
fn relay_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Emit a successful or failed model-call fact without awaiting the relay.
/// `error_code` is a stable class only (never a provider message or response
/// body) and is omitted for successful calls. The event is queued and leaves
/// in the next batch; this reads no environment variable and no file.
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
    if !relay::enabled() {
        return;
    }
    relay::push(ModelCallEvent {
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
    });
}

#[cfg(test)]
mod tests;
