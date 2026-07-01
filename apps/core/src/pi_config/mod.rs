//! Configuration layer over the Ryu-managed Pi agent.
//!
//! Ryu ships its OWN Pi binary (`~/.ryu/bin/pi`) that is completely separate from
//! any Pi the user already has on their PATH. To keep that separation total, the
//! managed Pi must also read a SEPARATE config directory — never the user's
//! `~/.pi/agent`. That directory is `~/.ryu/pi-agent` (override `RYU_PI_AGENT_DIR`),
//! wired into the Pi subprocess via the `PI_CODING_AGENT_DIR` env var (see
//! `sidecar/adapters/acp.rs::ryu_pi_acp_cmd`).
//!
//! This module is the single owner of that directory. It reads and writes the
//! three files Pi understands (per pi.dev docs — <https://pi.dev/docs>):
//!   - `settings.json` — `defaultProvider` / `defaultModel` / `defaultThinkingLevel`
//!   - `models.json`   — custom providers + per-model overrides
//!   - `auth.json`     — per-provider API keys (api-key providers, direct mode)
//!
//! Placement (CLAUDE.md §1 Core-vs-Gateway): this edits *what runs* (which model
//! the Ryu agent uses) — pure Core. The "gateway" provider option keeps the
//! existing `OPENAI_BASE_URL` injection on, so governed egress is preserved; any
//! other ("direct") provider deliberately bypasses the Gateway (an explicit,
//! user-chosen egress path — see the routing toggle in the desktop UI).

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Ryu-namespaced settings key recording whether the managed Pi routes through
/// the Gateway. Pi ignores unknown settings keys, so this rides along safely in
/// `settings.json` and survives round-trips.
const ROUTING_KEY: &str = "x-ryu-routing";
const ROUTING_GATEWAY: &str = "gateway";
const ROUTING_DIRECT: &str = "direct";

/// The logical provider id the desktop shows for Gateway-routed mode. Stored as
/// `defaultProvider: "openai"` on disk because the `OPENAI_BASE_URL` injection
/// redirects Pi's built-in `openai` provider at the local Gateway.
pub const GATEWAY_PROVIDER_ID: &str = "gateway";

// ── Paths ───────────────────────────────────────────────────────────────────

/// The isolated config directory for the Ryu-managed Pi. Override with
/// `RYU_PI_AGENT_DIR` (the "nothing hardcoded" knob); defaults to
/// `~/.ryu/pi-agent`.
pub fn config_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("RYU_PI_AGENT_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    crate::sidecar::download_manager::ryu_dir().join("pi-agent")
}

/// `config_dir()` as a string, creating the directory first. This is the value
/// passed to the Pi subprocess as `PI_CODING_AGENT_DIR`.
pub fn config_dir_str() -> String {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    dir.to_string_lossy().into_owned()
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

fn models_path() -> PathBuf {
    config_dir().join("models.json")
}

fn auth_path() -> PathBuf {
    config_dir().join("auth.json")
}

fn ensure_dir() -> Result<()> {
    let dir = config_dir();
    fs::create_dir_all(&dir).context("create Ryu Pi config dir")?;
    // The dir holds credentials (auth.json / models.json apiKey); keep it private.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Write a file that may contain credentials. On Unix the file is created with
/// `0600` from the outset (never world-readable, even briefly), mirroring Pi's
/// own `auth.json` convention; on other platforms it is a plain write.
fn write_secret_file(path: &std::path::Path, body: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("open {} for write", path.display()))?;
        file.write_all(body.as_bytes())
            .with_context(|| format!("write {}", path.display()))?;
        // Re-assert mode in case the file pre-existed with looser permissions.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, body).with_context(|| format!("write {}", path.display()))
    }
}

// ── settings.json ─────────────────────────────────────────────────────────────

/// A lenient view of Pi's `settings.json`: the fields Ryu manages are typed; any
/// other keys the user (or Pi) wrote are preserved verbatim in `extra` so writes
/// never clobber unmanaged settings.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PiSettings {
    #[serde(
        rename = "defaultProvider",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub default_provider: Option<String>,
    #[serde(
        rename = "defaultModel",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub default_model: Option<String>,
    #[serde(
        rename = "defaultThinkingLevel",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub default_thinking_level: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn read_settings() -> PiSettings {
    let Ok(raw) = fs::read_to_string(settings_path()) else {
        return PiSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_settings(settings: &PiSettings) -> Result<()> {
    ensure_dir()?;
    let body = serde_json::to_string_pretty(settings).context("serialize settings.json")?;
    fs::write(settings_path(), body).context("write settings.json")
}

/// Whether the managed Pi should route through the Gateway. Defaults to `true`
/// (Gateway-routed) when no explicit choice has been persisted, preserving the
/// pre-existing "Ryu = Pi + Gateway" behaviour.
pub fn is_gateway_routing() -> bool {
    let settings = read_settings();
    match settings.extra.get(ROUTING_KEY).and_then(Value::as_str) {
        Some(ROUTING_DIRECT) => false,
        _ => true,
    }
}

/// Build the `models.json` provider patch that pins Pi's built-in `openai`
/// provider at the local Ryu Gateway.
///
/// **Why this exists:** Pi's built-in `openai` provider defaults to the OpenAI
/// **Responses API** at `api.openai.com` and does **not** honor the
/// `OPENAI_BASE_URL` env var, so the spawn-time env injection alone never reaches
/// the Gateway (Pi calls OpenAI directly → 401, or the Gateway 404s `/v1/responses`).
/// This override redirects it: `baseUrl` = the local Gateway's `/v1`, `api` =
/// `openai-completions` (the Gateway speaks `/v1/chat/completions`, not
/// `/v1/responses`), `apiKey` = the Gateway token.
///
/// `model` (the chosen `defaultModel`) is **declared** in the provider's `models`
/// array. This is essential: a Ryu/local model id like `gemma-4-E2B-it-Q4_K_M` is
/// not one of Pi's built-in `openai` models, so without declaring it Pi falls back
/// to its built-in default (`gpt-5.4`), whose own `openai-responses` api overrides
/// the provider-level `openai-completions` — and the Gateway then 404s `/responses`
/// (or routes the wrong model id). Declaring the model as a custom `openai-completions`
/// model makes Pi send the right id over chat-completions to the Gateway.
fn gateway_openai_patch(model: Option<&str>) -> Map<String, Value> {
    let base = crate::sidecar::gateway::gateway_url();
    let v1 = format!("{}/v1", base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());
    let mut patch = Map::new();
    patch.insert("baseUrl".to_owned(), Value::String(v1));
    patch.insert(
        "api".to_owned(),
        Value::String("openai-completions".to_owned()),
    );
    patch.insert("apiKey".to_owned(), Value::String(token));
    if let Some(id) = model.map(str::trim).filter(|s| !s.is_empty()) {
        patch.insert("models".to_owned(), json!([{ "id": id }]));
    }
    patch
}

/// Ensure `models.json` pins the `openai` provider at the Gateway whenever the
/// managed Pi is in Gateway-routed mode. Idempotent (merges via [`upsert_provider`]).
/// Called at spawn time (see `acp::ryu_pi_acp_cmd`) so the Ryu agent routes
/// through the Gateway out of the box even if the user never opened the Pi-config
/// UI. A no-op in direct mode (the user's chosen provider config stands). The
/// declared model is read from `settings.json`'s `defaultModel`.
pub fn ensure_gateway_models_json() -> Result<()> {
    if is_gateway_routing() {
        let model = read_settings().default_model;
        upsert_provider("openai", gateway_openai_patch(model.as_deref()))?;
    }
    Ok(())
}

// ── models.json ───────────────────────────────────────────────────────────────

fn read_models() -> Value {
    let raw = fs::read_to_string(models_path()).unwrap_or_default();
    let mut value: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    if !value
        .get("providers")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        value["providers"] = json!({});
    }
    value
}

fn write_models(value: &Value) -> Result<()> {
    ensure_dir()?;
    let body = serde_json::to_string_pretty(value).context("serialize models.json")?;
    // models.json can hold a custom provider's `apiKey`, so treat it as secret.
    write_secret_file(&models_path(), &body)
}

/// Insert or update a custom provider entry (Ollama / LM Studio / vLLM / proxy)
/// in `models.json`, merging into any existing entry so unrelated fields survive.
fn upsert_provider(id: &str, patch: Map<String, Value>) -> Result<()> {
    let mut models = read_models();
    let providers = models["providers"]
        .as_object_mut()
        .expect("providers object ensured by read_models");
    let entry = providers.entry(id.to_owned()).or_insert_with(|| json!({}));
    if let Some(obj) = entry.as_object_mut() {
        for (key, val) in patch {
            obj.insert(key, val);
        }
    } else {
        *entry = Value::Object(patch);
    }
    write_models(&models)
}

fn custom_provider_ids() -> Vec<String> {
    read_models()["providers"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

fn custom_provider_has_key(id: &str) -> bool {
    read_models()["providers"]
        .get(id)
        .and_then(|p| p.get("apiKey"))
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

// ── auth.json ─────────────────────────────────────────────────────────────────

fn read_auth() -> Map<String, Value> {
    let raw = fs::read_to_string(auth_path()).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Store an api-key credential for a built-in provider in `auth.json`, using the
/// `{ "type": "api_key", "key": ... }` shape Pi expects. The file is written
/// with `0600` permissions on Unix to match Pi's own convention.
fn set_auth_key(auth_key: &str, key: &str) -> Result<()> {
    ensure_dir()?;
    let mut auth = read_auth();
    auth.insert(
        auth_key.to_owned(),
        json!({ "type": "api_key", "key": key }),
    );
    let body = serde_json::to_string_pretty(&auth).context("serialize auth.json")?;
    write_secret_file(&auth_path(), &body)
}

fn auth_has_key(auth_key: &str) -> bool {
    read_auth()
        .get(auth_key)
        .and_then(|v| v.get("key"))
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

// ── Provider catalog (the supported set, per pi.dev docs) ──────────────────────

/// Static metadata for a provider Pi supports. The model list is intentionally a
/// small set of *suggestions* (models churn faster than this table) — the UI also
/// accepts a free-text model id.
pub struct ProviderMeta {
    pub id: &'static str,
    pub label: &'static str,
    /// Pi `api` type: openai-completions / openai-responses / anthropic-messages /
    /// google-generative-ai.
    pub api: &'static str,
    /// `auth.json` key for an api-key credential.
    pub auth_key: &'static str,
    /// Environment variable Pi reads for this provider's key.
    pub auth_env: &'static str,
    /// "subscription" (OAuth via Pi `/login`), "api-key", or "none" (Gateway).
    pub auth_kind: &'static str,
    pub suggested_models: &'static [&'static str],
}

/// The built-in providers Pi ships, plus the synthetic "gateway" provider that
/// keeps egress governed. Sourced from pi.dev `providers.md` / `models.md`.
pub const PROVIDERS: &[ProviderMeta] = &[
    ProviderMeta {
        id: GATEWAY_PROVIDER_ID,
        label: "Ryu Gateway (governed)",
        api: "openai-completions",
        auth_key: "",
        auth_env: "",
        auth_kind: "none",
        suggested_models: &[],
    },
    ProviderMeta {
        id: "anthropic",
        label: "Anthropic",
        api: "anthropic-messages",
        auth_key: "anthropic",
        auth_env: "ANTHROPIC_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[
            "claude-opus-4-20250514",
            "claude-sonnet-4-20250514",
            "claude-3-5-haiku-20241022",
        ],
    },
    ProviderMeta {
        id: "openai",
        label: "OpenAI",
        api: "openai-responses",
        auth_key: "openai",
        auth_env: "OPENAI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    },
    ProviderMeta {
        id: "google",
        label: "Google Gemini",
        api: "google-generative-ai",
        auth_key: "google",
        auth_env: "GEMINI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    ProviderMeta {
        id: "deepseek",
        label: "DeepSeek",
        api: "openai-completions",
        auth_key: "deepseek",
        auth_env: "DEEPSEEK_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["deepseek-chat", "deepseek-reasoner"],
    },
    ProviderMeta {
        id: "groq",
        label: "Groq",
        api: "openai-completions",
        auth_key: "groq",
        auth_env: "GROQ_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["llama-3.3-70b-versatile"],
    },
    ProviderMeta {
        id: "mistral",
        label: "Mistral",
        api: "openai-completions",
        auth_key: "mistral",
        auth_env: "MISTRAL_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["mistral-large-latest"],
    },
    ProviderMeta {
        id: "xai",
        label: "xAI",
        api: "openai-completions",
        auth_key: "xai",
        auth_env: "XAI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["grok-4", "grok-3"],
    },
    ProviderMeta {
        id: "openrouter",
        label: "OpenRouter",
        api: "openai-completions",
        auth_key: "openrouter",
        auth_env: "OPENROUTER_API_KEY",
        auth_kind: "api-key",
        // `openrouter/auto` is OpenRouter's Auto Router: it picks the best model
        // per prompt at no extra fee. Listed first so managed users get a
        // zero-decision "just route it well" option.
        suggested_models: &["openrouter/auto", "anthropic/claude-sonnet-4", "openai/gpt-4o"],
    },
];

/// The thinking levels Pi accepts for `defaultThinkingLevel`.
pub const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];

fn provider_meta(id: &str) -> Option<&'static ProviderMeta> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// Whether a provider has a usable credential (auth.json key, environment
/// variable, or — for custom providers — an `apiKey` in models.json).
fn provider_configured(meta: &ProviderMeta) -> bool {
    if meta.auth_kind == "none" {
        return true;
    }
    if !meta.auth_key.is_empty() && auth_has_key(meta.auth_key) {
        return true;
    }
    if !meta.auth_env.is_empty()
        && std::env::var(meta.auth_env)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    {
        return true;
    }
    false
}

// ── Public API (consumed by the HTTP handlers) ────────────────────────────────

/// The current Pi configuration, as surfaced to the desktop. Never contains
/// secrets.
#[derive(Debug, Serialize)]
pub struct PiConfigView {
    /// Logical provider id ("gateway" or a built-in/custom id).
    pub provider: String,
    pub model: Option<String>,
    #[serde(rename = "thinkingLevel")]
    pub thinking_level: Option<String>,
    /// "gateway" | "direct".
    pub routing: String,
    #[serde(rename = "configDir")]
    pub config_dir: String,
}

/// Read the current configuration.
pub fn current() -> PiConfigView {
    let settings = read_settings();
    let gateway = is_gateway_routing();
    let provider = if gateway {
        GATEWAY_PROVIDER_ID.to_owned()
    } else {
        settings
            .default_provider
            .clone()
            .unwrap_or_else(|| GATEWAY_PROVIDER_ID.to_owned())
    };
    PiConfigView {
        provider,
        model: settings.default_model,
        thinking_level: settings.default_thinking_level,
        routing: if gateway {
            ROUTING_GATEWAY.to_owned()
        } else {
            ROUTING_DIRECT.to_owned()
        },
        config_dir: config_dir().to_string_lossy().into_owned(),
    }
}

/// The catalog of supported providers + thinking levels, with per-provider
/// `configured` and `suggestedModels` so the desktop can render a picker.
pub fn catalog() -> Value {
    let custom_ids = custom_provider_ids();
    let mut providers: Vec<Value> = PROVIDERS
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "label": p.label,
                "api": p.api,
                "authKind": p.auth_kind,
                "authEnv": p.auth_env,
                "routing": if p.id == GATEWAY_PROVIDER_ID { ROUTING_GATEWAY } else { ROUTING_DIRECT },
                "configured": provider_configured(p),
                "custom": false,
                "suggestedModels": p.suggested_models,
            })
        })
        .collect();

    // User-defined custom providers in models.json that aren't built-ins
    // (e.g. a local Ollama/LM Studio/vLLM endpoint the user added).
    for id in custom_ids {
        if provider_meta(&id).is_some() {
            continue;
        }
        providers.push(json!({
            "id": id,
            "label": id,
            "api": "openai-completions",
            "authKind": "api-key",
            "authEnv": "",
            "routing": ROUTING_DIRECT,
            "configured": custom_provider_has_key(&id),
            "custom": true,
            "suggestedModels": [],
        }));
    }

    json!({
        "providers": providers,
        "thinkingLevels": THINKING_LEVELS,
        "apiTypes": [
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "google-generative-ai",
        ],
    })
}

/// The desired configuration sent from the desktop.
#[derive(Debug, Deserialize)]
pub struct PiConfigInput {
    /// Logical provider id ("gateway" or a built-in/custom id).
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(rename = "thinkingLevel", default)]
    pub thinking_level: Option<String>,
    /// Optional api-key credential. For built-in providers it is written to
    /// `auth.json`; for custom providers (with `base_url`) it is written as the
    /// provider `apiKey` in `models.json`. Never returned on read.
    #[serde(rename = "apiKey", default)]
    pub api_key: Option<String>,
    /// Optional base URL for a custom OpenAI-compatible provider (Ollama,
    /// LM Studio, vLLM, a proxy). When set, a `models.json` provider entry is
    /// written.
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    /// Pi `api` type for a custom provider (defaults to `openai-completions`).
    #[serde(default)]
    pub api: Option<String>,
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Apply a configuration change, writing the relevant Pi config files in the
/// isolated directory. Returns the resulting view.
pub fn apply(input: PiConfigInput) -> Result<PiConfigView> {
    let provider = input.provider.trim().to_owned();
    if provider.is_empty() {
        anyhow::bail!("provider is required");
    }
    let model = non_empty(&input.model);
    let thinking = non_empty(&input.thinking_level);
    if let Some(level) = &thinking {
        if !THINKING_LEVELS.contains(&level.as_str()) {
            anyhow::bail!("unsupported thinking level '{level}'");
        }
    }

    let gateway = provider == GATEWAY_PROVIDER_ID;
    let base_url = non_empty(&input.base_url);
    let api_key = non_empty(&input.api_key);
    let custom_api = non_empty(&input.api);

    // Validate non-gateway providers against the supported set, unless the user
    // is defining a custom provider (identified by a base URL).
    if !gateway
        && base_url.is_none()
        && provider_meta(&provider).is_none()
        && !custom_provider_ids().contains(&provider)
    {
        anyhow::bail!(
            "unknown provider '{provider}'; supply a baseUrl to define a custom provider"
        );
    }

    // 1) settings.json — defaultProvider/defaultModel/thinking + routing marker.
    let mut settings = read_settings();
    // In gateway mode, `defaultProvider` is the built-in `openai` provider that
    // the OPENAI_BASE_URL injection redirects at the local Gateway.
    settings.default_provider = Some(if gateway {
        "openai".to_owned()
    } else {
        provider.clone()
    });
    settings.default_model = model.clone();
    settings.default_thinking_level = thinking.clone();
    settings.extra.insert(
        ROUTING_KEY.to_owned(),
        Value::String(
            if gateway {
                ROUTING_GATEWAY
            } else {
                ROUTING_DIRECT
            }
            .to_owned(),
        ),
    );
    write_settings(&settings)?;

    if gateway {
        // Pin Pi's built-in `openai` provider at the Gateway in models.json — the
        // `OPENAI_BASE_URL` env injection alone is ignored by Pi (see
        // `gateway_openai_patch`). Declare the chosen model so Pi sends it (not its
        // built-in `gpt-5.4` default) over chat-completions.
        upsert_provider("openai", gateway_openai_patch(model.as_deref()))?;
        return Ok(current());
    }

    // 2) Custom provider (local/proxy) → models.json entry.
    if let Some(url) = &base_url {
        let mut patch = Map::new();
        patch.insert("baseUrl".to_owned(), Value::String(url.clone()));
        patch.insert(
            "api".to_owned(),
            Value::String(custom_api.unwrap_or_else(|| "openai-completions".to_owned())),
        );
        if let Some(key) = &api_key {
            patch.insert("apiKey".to_owned(), Value::String(key.clone()));
        }
        if let Some(model_id) = &model {
            patch.insert("models".to_owned(), json!([{ "id": model_id }]));
        }
        upsert_provider(&provider, patch)?;
    } else if let (Some(meta), Some(key)) = (provider_meta(&provider), &api_key) {
        // 3) Built-in provider credential → auth.json.
        if !meta.auth_key.is_empty() {
            set_auth_key(meta.auth_key, key)?;
        }
    }

    Ok(current())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point the config dir at a temp location for the duration of a test.
    fn with_temp_dir<F: FnOnce()>(f: F) {
        let dir = std::env::temp_dir().join(format!("ryu-pi-config-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("RYU_PI_AGENT_DIR", &dir);
        f();
        std::env::remove_var("RYU_PI_AGENT_DIR");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gateway_is_default_routing() {
        with_temp_dir(|| {
            assert!(is_gateway_routing());
            let view = current();
            assert_eq!(view.provider, GATEWAY_PROVIDER_ID);
            assert_eq!(view.routing, "gateway");
        });
    }

    #[test]
    fn apply_gateway_writes_openai_provider_and_marker() {
        with_temp_dir(|| {
            let view = apply(PiConfigInput {
                provider: GATEWAY_PROVIDER_ID.to_owned(),
                model: Some("gpt-4o".to_owned()),
                thinking_level: Some("medium".to_owned()),
                api_key: None,
                base_url: None,
                api: None,
            })
            .unwrap();
            assert_eq!(view.provider, "gateway");
            assert_eq!(view.routing, "gateway");
            assert_eq!(view.model.as_deref(), Some("gpt-4o"));
            // On disk, gateway mode stores the openai provider + routing marker.
            let settings = read_settings();
            assert_eq!(settings.default_provider.as_deref(), Some("openai"));
            assert!(is_gateway_routing());
        });
    }

    #[test]
    fn apply_direct_provider_disables_gateway_routing() {
        with_temp_dir(|| {
            let view = apply(PiConfigInput {
                provider: "anthropic".to_owned(),
                model: Some("claude-sonnet-4-20250514".to_owned()),
                thinking_level: None,
                api_key: Some("sk-ant-test".to_owned()),
                base_url: None,
                api: None,
            })
            .unwrap();
            assert_eq!(view.provider, "anthropic");
            assert_eq!(view.routing, "direct");
            assert!(!is_gateway_routing());
            // The key is written to auth.json under the provider's auth key.
            assert!(auth_has_key("anthropic"));
        });
    }

    #[test]
    fn apply_custom_provider_writes_models_json() {
        with_temp_dir(|| {
            apply(PiConfigInput {
                provider: "ollama".to_owned(),
                model: Some("llama3.1:8b".to_owned()),
                thinking_level: None,
                api_key: Some("ollama".to_owned()),
                base_url: Some("http://localhost:11434/v1".to_owned()),
                api: None,
            })
            .unwrap();
            let models = read_models();
            let entry = &models["providers"]["ollama"];
            assert_eq!(entry["baseUrl"], "http://localhost:11434/v1");
            assert_eq!(entry["api"], "openai-completions");
            assert_eq!(entry["models"][0]["id"], "llama3.1:8b");
            assert!(!is_gateway_routing());
        });
    }

    #[test]
    fn unknown_provider_without_base_url_is_rejected() {
        with_temp_dir(|| {
            let err = apply(PiConfigInput {
                provider: "made-up".to_owned(),
                model: None,
                thinking_level: None,
                api_key: None,
                base_url: None,
                api: None,
            })
            .unwrap_err();
            assert!(err.to_string().contains("unknown provider"));
        });
    }

    #[test]
    fn settings_round_trip_preserves_unknown_keys() {
        with_temp_dir(|| {
            let _ = ensure_dir();
            fs::write(settings_path(), r#"{"theme":"light","defaultModel":"old"}"#).unwrap();
            apply(PiConfigInput {
                provider: GATEWAY_PROVIDER_ID.to_owned(),
                model: Some("gpt-4o".to_owned()),
                thinking_level: None,
                api_key: None,
                base_url: None,
                api: None,
            })
            .unwrap();
            let settings = read_settings();
            // Unmanaged key survives.
            assert_eq!(
                settings.extra.get("theme").and_then(Value::as_str),
                Some("light")
            );
            assert_eq!(settings.default_model.as_deref(), Some("gpt-4o"));
        });
    }
}
