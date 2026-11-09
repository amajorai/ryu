//! The `[acp]` section: reading it from the Gateway or the local config file,
//! and the effective settings derived from it.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::memory::{auto_max_parallel_agents, hardware};
use super::{
    runtime_state, AcpRuntimeSettings, RuntimeConfig, DEFAULT_IDLE_TIMEOUT_MINUTES,
    MAX_PARALLEL_AGENTS, MIN_PARALLEL_AGENTS,
};

const MIN_IDLE_TIMEOUT_MINUTES: u64 = 1;
const MAX_IDLE_TIMEOUT_MINUTES: u64 = 24 * 60;
const GATEWAY_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const GATEWAY_REFRESH_TIMEOUT: Duration = Duration::from_millis(300);

pub(super) fn sanitize_config(value: &Value) -> RuntimeConfig {
    let object = value.as_object();
    let idle_timeout_minutes = object
        .and_then(|value| value.get("idle_timeout_minutes"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_MINUTES)
        .clamp(MIN_IDLE_TIMEOUT_MINUTES, MAX_IDLE_TIMEOUT_MINUTES);
    let max_parallel_agents = object
        .and_then(|value| value.get("max_parallel_agents"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| (MIN_PARALLEL_AGENTS..=MAX_PARALLEL_AGENTS).contains(value));
    let keep_computer_awake = object
        .and_then(|value| value.get("keep_computer_awake"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    RuntimeConfig {
        idle_timeout_minutes,
        max_parallel_agents,
        keep_computer_awake,
    }
}

pub(super) fn apply_config(value: &Value) {
    if let Ok(mut config) = runtime_state().config.lock() {
        *config = sanitize_config(value);
    }
    runtime_state().admission.notify.notify_waiters();
}

fn is_local_gateway() -> bool {
    let raw = crate::sidecar::gateway::gateway_url();
    url::Url::parse(&raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .is_some_and(|host| host == "127.0.0.1" || host == "localhost" || host == "::1")
}

/// Refresh the local file before a new message is routed. This is intentionally
/// limited to loopback gateways; a remote node's local file is not authoritative.
pub fn refresh_from_local_file() {
    if !is_local_gateway() {
        return;
    }
    let path = std::env::var("GATEWAY_CONFIG")
        .map(std::path::PathBuf::from)
        // Same profile-suffixed `<config>/ryu{suffix}/gateway.toml` the Gateway
        // falls back to, so a dev stack never reads the release node's policy.
        .unwrap_or_else(|_| crate::paths::config_dir().join("gateway.toml"));
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(root) = toml::from_str::<toml::Value>(&raw) else {
        return;
    };
    let section = root
        .get("acp")
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_else(|| json!({}));
    apply_config(&section);
}

/// Read the Gateway section when Core is serving a remote node or when a config
/// changed outside the desktop. The short cache prevents a burst of new chats
/// from turning the guardrail into a per-message config request.
pub async fn refresh_from_gateway(client: &reqwest::Client) {
    let should_refresh = runtime_state()
        .last_gateway_refresh
        .lock()
        .map(|mut last| {
            if last.elapsed() < GATEWAY_REFRESH_INTERVAL {
                false
            } else {
                *last = Instant::now();
                true
            }
        })
        .unwrap_or(false);
    if !should_refresh {
        return;
    }
    let result = tokio::time::timeout(
        GATEWAY_REFRESH_TIMEOUT,
        crate::sidecar::gateway::fetch_config(client),
    )
    .await;
    if let Ok(Ok(value)) = result {
        if let Some(section) = value.get("acp") {
            apply_config(section);
        }
    }
}

pub fn observe_gateway_config(value: &mut Value) {
    if let Some(section) = value.get("acp").cloned() {
        apply_config(&section);
    }
    let settings = settings();
    let Some(root) = value.as_object_mut() else {
        return;
    };
    let acp = root.entry("acp").or_insert_with(|| json!({}));
    if !acp.is_object() {
        *acp = json!({});
    }
    let object = acp
        .as_object_mut()
        .expect("ACP runtime section is an object");
    object.insert(
        "effective_max_parallel_agents".to_owned(),
        json!(settings.effective_max_parallel_agents),
    );
    object.insert(
        "auto_max_parallel_agents".to_owned(),
        json!(settings.auto_max_parallel_agents),
    );
    object.insert("active_agents".to_owned(), json!(settings.active_agents));
    object.insert(
        "hardware".to_owned(),
        serde_json::to_value(hardware()).unwrap_or_else(|_| json!({})),
    );
}

pub fn observe_gateway_patch(patch: &Value) {
    if let Some(section) = patch.get("acp") {
        apply_config(section);
    }
}

pub fn settings() -> AcpRuntimeSettings {
    let config = runtime_state()
        .config
        .lock()
        .map(|config| *config)
        .unwrap_or_default();
    let auto_max_parallel_agents = auto_max_parallel_agents();
    let effective_max_parallel_agents = config
        .max_parallel_agents
        .unwrap_or(auto_max_parallel_agents)
        .clamp(MIN_PARALLEL_AGENTS, MAX_PARALLEL_AGENTS);
    let active_agents = runtime_state()
        .admission
        .state
        .lock()
        .map(|state| state.active)
        .unwrap_or(0);
    AcpRuntimeSettings {
        idle_timeout: Duration::from_secs(config.idle_timeout_minutes * 60),
        idle_timeout_minutes: config.idle_timeout_minutes,
        max_parallel_agents: config.max_parallel_agents,
        effective_max_parallel_agents,
        auto_max_parallel_agents,
        keep_computer_awake: config.keep_computer_awake,
        active_agents,
    }
}
