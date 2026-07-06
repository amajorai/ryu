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

/// models.dev-backed dynamic model catalog (replaces hardcoded model lists).
pub(crate) mod models_dev;

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

/// The managed subscription provider (Ryu-hosted OpenRouter). Always Gateway-
/// routed: it reuses the `openai` pin so egress is governed and metered against
/// the org's Ryu $ wallet (`apps/gateway/src/pipeline/mod.rs`), and the Gateway
/// maps its default `openrouter/auto` model onto the OpenRouter provider. No BYOK.
pub const MANAGED_OPENROUTER_ID: &str = "managed-openrouter";

/// The Gateway's OpenRouter Auto Router model — routes each prompt to a good
/// model at no extra fee. The zero-decision default for managed users.
const MANAGED_DEFAULT_MODEL: &str = "openrouter/auto";

/// Ryu-namespaced settings key holding the per-provider routing map
/// (`{ "<providerId>": "gateway" | "direct" }`). Pi ignores unknown keys, so it
/// survives round-trips. Lets each configured provider carry its own egress mode
/// while `ROUTING_KEY` still records the *active* provider's mode for back-compat.
const PROVIDER_ROUTING_KEY: &str = "x-ryu-provider-routing";

/// Ryu-namespaced settings key recording the logical *active* provider id
/// (`managed-openrouter` / `gateway` / a built-in / a custom id). Needed because
/// several logical providers (gateway, managed-openrouter) both persist
/// `defaultProvider: "openai"` on disk, so the logical id can't be derived from it.
const ACTIVE_KEY: &str = "x-ryu-active-provider";

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

/// Shared, poison-tolerant lock for tests that mutate `RYU_PI_AGENT_DIR` or the
/// managed Pi config files behind it. These globals are read from several modules.
#[cfg(test)]
pub(crate) static PI_CONFIG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_pi_config_test_env() -> std::sync::MutexGuard<'static, ()> {
    PI_CONFIG_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
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

/// Whether the managed Pi should route the *active* provider through the Gateway.
/// Defaults to `true` (Gateway-routed) when no explicit choice has been persisted,
/// preserving the pre-existing "Ryu = Pi + Gateway" behaviour.
pub fn is_gateway_routing() -> bool {
    let settings = read_settings();
    match settings.extra.get(ROUTING_KEY).and_then(Value::as_str) {
        Some(ROUTING_DIRECT) => false,
        _ => true,
    }
}

/// Providers that are *always* Gateway-routed (managed subscription or the
/// synthetic gateway provider) — their egress must stay governed/metered.
fn is_managed_or_gateway(id: &str) -> bool {
    id == GATEWAY_PROVIDER_ID || id == MANAGED_OPENROUTER_ID
}

/// The routing mode (`"gateway"` | `"direct"`) for a specific provider id.
///
/// Resolution order: managed/gateway providers are always `gateway`; otherwise the
/// explicit per-provider `PROVIDER_ROUTING_KEY` entry wins; otherwise, for the
/// *active* provider, fall back to the legacy global `ROUTING_KEY` (so pre-existing
/// installs keep their mode); otherwise default `direct` (a BYOK provider the user
/// added but never explicitly toggled routes directly to the vendor).
fn provider_routing(id: &str) -> &'static str {
    if is_managed_or_gateway(id) {
        return ROUTING_GATEWAY;
    }
    let settings = read_settings();
    if let Some(mode) = settings
        .extra
        .get(PROVIDER_ROUTING_KEY)
        .and_then(Value::as_object)
        .and_then(|m| m.get(id))
        .and_then(Value::as_str)
    {
        return if mode == ROUTING_GATEWAY {
            ROUTING_GATEWAY
        } else {
            ROUTING_DIRECT
        };
    }
    // Legacy global marker only speaks for the active provider.
    if active_provider_id_from(&settings).as_deref() == Some(id)
        && settings.extra.get(ROUTING_KEY).and_then(Value::as_str) != Some(ROUTING_DIRECT)
    {
        return ROUTING_GATEWAY;
    }
    ROUTING_DIRECT
}

/// Persist the routing mode for a single provider in the per-provider map, without
/// touching the active selection.
fn set_provider_routing(id: &str, mode: &str) -> Result<()> {
    if is_managed_or_gateway(id) {
        return Ok(()); // Always gateway; ignore attempts to flip it.
    }
    let normalized = if mode == ROUTING_GATEWAY {
        ROUTING_GATEWAY
    } else {
        ROUTING_DIRECT
    };
    let mut settings = read_settings();
    let map = settings
        .extra
        .entry(PROVIDER_ROUTING_KEY.to_owned())
        .or_insert_with(|| json!({}));
    if !map.is_object() {
        *map = json!({});
    }
    if let Some(obj) = map.as_object_mut() {
        obj.insert(id.to_owned(), Value::String(normalized.to_owned()));
    }
    write_settings(&settings)
}

/// The logical active provider id from an already-read settings view. Prefers the
/// explicit `ACTIVE_KEY`; otherwise derives it (gateway when gateway-routed, else
/// the on-disk `defaultProvider`).
fn active_provider_id_from(settings: &PiSettings) -> Option<String> {
    if let Some(active) = settings
        .extra
        .get(ACTIVE_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(active.to_owned());
    }
    let gateway = settings.extra.get(ROUTING_KEY).and_then(Value::as_str) != Some(ROUTING_DIRECT);
    if gateway {
        Some(GATEWAY_PROVIDER_ID.to_owned())
    } else {
        settings.default_provider.clone()
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
///
/// The declared `models` array is a **union**: already-declared ids + the zero-key
/// local default ([`default_gateway_model`]) + `model`. Merging (instead of
/// replacing) means switching models in the composer never removes an earlier
/// model from Pi's available list, so the user can always switch back.
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

    // Union of declared model ids (order-preserving, deduped).
    let mut ids: Vec<String> = read_models()["providers"]
        .get("openai")
        .and_then(|p| p.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let default_local = default_gateway_model();
    for candidate in [Some(default_local.as_str()), model] {
        if let Some(id) = candidate.map(str::trim).filter(|s| !s.is_empty()) {
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_owned());
            }
        }
    }
    if !ids.is_empty() {
        let entries: Vec<Value> = ids.into_iter().map(|id| json!({ "id": id })).collect();
        patch.insert("models".to_owned(), Value::Array(entries));
    }
    patch
}

/// The zero-key default model for the managed Pi in Gateway-routed mode: the
/// registry's local llama.cpp chat model (swappable via `RYU_LOCAL_CHAT_MODEL_ID`
/// / `registry.json`, never hardcoded here). The gateway's built-in prefix rules
/// route `gemma*`-style ids to its `local` provider (the llama.cpp sidecar), so a
/// fresh install with no API keys gets a working model out of the box.
pub fn default_gateway_model() -> String {
    crate::registry::ProviderRegistry::load()
        .local_chat_model
        .id
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

/// Value written to Pi's `settings.json` `skills` array to disable Pi's own
/// skill auto-discovery (`!` = exclude pattern, `**` = everything). Pi always
/// auto-loads `~/.agents/skills` (a hard-coded home path, independent of
/// `PI_CODING_AGENT_DIR`), which duplicated — and bypassed the allowlist of —
/// Core's own governed skill injection on the ACP prompt (QA finding B1).
const PI_SKILLS_DISABLED: &str = "!**";

/// Enforce the managed-Pi config invariants. Idempotent; called at spawn time
/// (see `acp::ryu_pi_acp_cmd` and the `ryu` PATH-fallback route) so a fresh
/// install works with zero setup:
///
/// 1. **Pi-side skill injection off** — Core injects the (allowlist-gated) skill
///    block into the ACP prompt itself, so Pi loading `~/.agents/skills` on top
///    double-injected ~100 ungoverned SKILL.md manifests (QA B1). Written only
///    when the user has not set the `skills` key, so an explicit user choice in
///    the managed dir always stands.
/// 2. **A valid default model in Gateway mode** — Pi with no `defaultModel`
///    parrots its skill manifest instead of answering (QA B1). When Gateway-routed
///    and no model is set, default to [`default_gateway_model`] (the local
///    llama.cpp model — resolvable through the gateway with zero API keys) and
///    normalize `defaultProvider` to the gateway-redirected `openai`.
/// 3. **The Gateway provider pin** — [`ensure_gateway_models_json`], declaring
///    the model so Pi actually sends it over chat-completions.
pub fn ensure_managed_defaults() -> Result<()> {
    let mut settings = read_settings();
    let mut dirty = false;

    if !settings.extra.contains_key("skills") {
        settings
            .extra
            .insert("skills".to_owned(), json!([PI_SKILLS_DISABLED]));
        dirty = true;
    }

    let gateway = settings.extra.get(ROUTING_KEY).and_then(Value::as_str) != Some(ROUTING_DIRECT);
    if gateway {
        let has_model = settings
            .default_model
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty());
        if !has_model {
            settings.default_model = Some(default_gateway_model());
            dirty = true;
        }
        let has_provider = settings
            .default_provider
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty());
        if !has_provider {
            // Gateway mode stores the built-in `openai` provider on disk (the
            // models.json pin redirects it at the local Gateway).
            settings.default_provider = Some("openai".to_owned());
            dirty = true;
        }
    }

    if dirty {
        write_settings(&settings)?;
    }
    ensure_gateway_models_json()
}

/// Persist a composer-picked model for the managed Pi (QA finding B2).
///
/// pi-acp reports models as `"<provider>/<model-id>"` (split at the FIRST `/`,
/// mirroring pi-acp's own `setSessionModel` parsing); a bare id is treated as a
/// model on the current provider. pi-acp spawns a fresh Pi RPC process per
/// `session/new` — one per chat turn — so a write here (made before the turn's
/// session is built) takes effect on the very turn that carried the pick, and
/// becomes Pi's `defaultModel` for every later session.
///
/// In Gateway-routed mode only picks on the gateway-redirected `openai` provider
/// are persisted (anything else would silently flip Pi onto a direct provider the
/// user never configured; those picks still apply live for the turn via the ACP
/// `model` config option — see `acp::apply_turn_config`). In direct mode the pick
/// is mirrored verbatim into `defaultProvider`/`defaultModel`.
pub fn persist_turn_model(picked: &str) -> Result<()> {
    let picked = picked.trim();
    if picked.is_empty() {
        return Ok(());
    }
    let (provider, model) = match picked.split_once('/') {
        Some((p, m)) if !p.trim().is_empty() && !m.trim().is_empty() => (Some(p.trim()), m.trim()),
        _ => (None, picked),
    };

    let mut settings = read_settings();
    let gateway = settings.extra.get(ROUTING_KEY).and_then(Value::as_str) != Some(ROUTING_DIRECT);

    if gateway {
        if provider.is_some_and(|p| p != "openai") {
            return Ok(());
        }
        if settings.default_model.as_deref() != Some(model) {
            settings.default_provider = Some("openai".to_owned());
            settings.default_model = Some(model.to_owned());
            write_settings(&settings)?;
        }
        // Declare the pick so Pi lists + sends it (merge — see gateway_openai_patch).
        return upsert_provider("openai", gateway_openai_patch(Some(model)));
    }

    if let Some(p) = provider {
        settings.default_provider = Some(p.to_owned());
    }
    settings.default_model = Some(model.to_owned());
    write_settings(&settings)
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
    auth_key_value(auth_key).is_some()
}

/// Read a stored api-key credential from `auth.json` (never surfaced to the
/// desktop; used only for server-side model discovery).
fn auth_key_value(auth_key: &str) -> Option<String> {
    read_auth()
        .get(auth_key)
        .and_then(|v| v.get("key"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
}

/// Whether `auth.json` holds ANY usable credential for a provider — either an
/// api-key (`{type:"api_key", key}`) or an OAuth/subscription login
/// (`{type:"oauth", access, refresh, …}`, which has no `key`). Used for
/// subscription providers (ChatGPT/Claude/Copilot) whose logged-in state Pi
/// records as an oauth entry, so the plain `auth_has_key` (key-only) check would
/// misreport them as unconfigured.
fn auth_has_any(auth_key: &str) -> bool {
    let Some(entry) = read_auth().get(auth_key).cloned() else {
        return false;
    };
    // api-key shape.
    if entry
        .get("key")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    // oauth shape: an access or refresh token present.
    for field in ["access", "refresh"] {
        if entry
            .get(field)
            .and_then(Value::as_str)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// Remove an api-key credential from `auth.json`.
fn clear_auth_key(auth_key: &str) -> Result<()> {
    let mut auth = read_auth();
    if auth.remove(auth_key).is_some() {
        let body = serde_json::to_string_pretty(&auth).context("serialize auth.json")?;
        write_secret_file(&auth_path(), &body)?;
    }
    Ok(())
}

/// Remove a custom-provider entry from `models.json`.
fn remove_models_provider(id: &str) -> Result<()> {
    let mut models = read_models();
    if let Some(obj) = models["providers"].as_object_mut() {
        if obj.remove(id).is_some() {
            write_models(&models)?;
        }
    }
    Ok(())
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
    /// OpenAI-compatible `GET .../models` discovery URL, or `""` when the provider
    /// exposes no such endpoint (discovery then falls back to `suggested_models`).
    /// A relative-looking value is treated as absolute; custom providers use their
    /// own `baseUrl` + `/models` instead of this field.
    pub models_url: &'static str,
}

/// The built-in providers Pi ships, plus the synthetic "gateway" provider that
/// keeps egress governed. Sourced from pi.dev `providers.md` / `models.md`.
pub const PROVIDERS: &[ProviderMeta] = &[
    ProviderMeta {
        id: MANAGED_OPENROUTER_ID,
        label: "Ryu (managed · included with your plan)",
        api: "openai-completions",
        auth_key: "",
        auth_env: "",
        // Subscription: no BYOK; billed against the plan's Ryu $ credits.
        auth_kind: "subscription",
        suggested_models: &[
            "openrouter/auto",
            "anthropic/claude-sonnet-4",
            "openai/gpt-4o",
        ],
        // Discovery goes through the local Gateway (resolved at call time), so no
        // static URL here.
        models_url: "",
    },
    ProviderMeta {
        id: GATEWAY_PROVIDER_ID,
        label: "Ryu Gateway (governed)",
        api: "openai-completions",
        auth_key: "",
        auth_env: "",
        auth_kind: "none",
        suggested_models: &[],
        models_url: "",
    },
    // Subscription LOGIN providers (Pi's OAuth). No API key — the desktop shows a
    // "Login" button that drives the ACP `authenticate` flow (probe authMethods →
    // `POST /api/agents/:id/authenticate`); Pi stores the result as an oauth entry
    // in auth.json (see `auth_has_any`). `auth_key` = Pi's own auth.json key for the
    // provider. Models come from models.dev (mapped to the underlying vendor).
    ProviderMeta {
        id: "openai-codex",
        label: "ChatGPT (Plus/Pro · login)",
        api: "openai-completions",
        auth_key: "openai-codex",
        auth_env: "",
        auth_kind: "subscription",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "claude-pro-max",
        label: "Claude (Pro/Max · login)",
        api: "anthropic-messages",
        // Pi stores the Claude Pro/Max OAuth under the `anthropic` auth key.
        auth_key: "anthropic",
        auth_env: "",
        auth_kind: "subscription",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "github-copilot",
        label: "GitHub Copilot (login)",
        api: "openai-responses",
        auth_key: "github-copilot",
        auth_env: "",
        auth_kind: "subscription",
        suggested_models: &[],
        models_url: "",
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
        models_url: "https://api.anthropic.com/v1/models",
    },
    ProviderMeta {
        id: "openai",
        label: "OpenAI",
        api: "openai-responses",
        auth_key: "openai",
        auth_env: "OPENAI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
        models_url: "https://api.openai.com/v1/models",
    },
    ProviderMeta {
        id: "google",
        label: "Google Gemini",
        api: "google-generative-ai",
        auth_key: "google",
        auth_env: "GEMINI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["gemini-2.5-pro", "gemini-2.5-flash"],
        // Google's model list uses a non-OpenAI shape; fall back to suggestions.
        models_url: "",
    },
    ProviderMeta {
        id: "deepseek",
        label: "DeepSeek",
        api: "openai-completions",
        auth_key: "deepseek",
        auth_env: "DEEPSEEK_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["deepseek-chat", "deepseek-reasoner"],
        models_url: "https://api.deepseek.com/models",
    },
    ProviderMeta {
        id: "groq",
        label: "Groq",
        api: "openai-completions",
        auth_key: "groq",
        auth_env: "GROQ_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["llama-3.3-70b-versatile"],
        models_url: "https://api.groq.com/openai/v1/models",
    },
    ProviderMeta {
        id: "mistral",
        label: "Mistral",
        api: "openai-completions",
        auth_key: "mistral",
        auth_env: "MISTRAL_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["mistral-large-latest"],
        models_url: "https://api.mistral.ai/v1/models",
    },
    ProviderMeta {
        id: "xai",
        label: "xAI",
        api: "openai-completions",
        auth_key: "xai",
        auth_env: "XAI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["grok-4", "grok-3"],
        models_url: "https://api.x.ai/v1/models",
    },
    // Additional OpenAI-compatible providers Pi ships (ids match Pi's own provider
    // table so its auth.json/models.json entries resolve). Suggestions are left thin
    // — live `/v1/models` discovery populates them; free-text always works. The
    // exotic/regional Pi providers (xiaomi, *-cn, ant-ling, opencode) stay reachable
    // via the custom OpenAI-compatible entry.
    ProviderMeta {
        id: "cerebras",
        label: "Cerebras",
        api: "openai-completions",
        auth_key: "cerebras",
        auth_env: "CEREBRAS_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[],
        models_url: "https://api.cerebras.ai/v1/models",
    },
    ProviderMeta {
        id: "fireworks",
        label: "Fireworks AI",
        api: "openai-completions",
        auth_key: "fireworks",
        auth_env: "FIREWORKS_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[],
        models_url: "https://api.fireworks.ai/inference/v1/models",
    },
    ProviderMeta {
        id: "together",
        label: "Together AI",
        api: "openai-completions",
        auth_key: "together",
        auth_env: "TOGETHER_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[],
        models_url: "https://api.together.xyz/v1/models",
    },
    ProviderMeta {
        id: "nvidia",
        label: "NVIDIA NIM",
        api: "openai-completions",
        auth_key: "nvidia",
        auth_env: "NVIDIA_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[],
        models_url: "https://integrate.api.nvidia.com/v1/models",
    },
    ProviderMeta {
        id: "moonshotai",
        label: "Moonshot (Kimi)",
        api: "openai-completions",
        auth_key: "moonshotai",
        auth_env: "MOONSHOT_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["kimi-k2-0711-preview"],
        models_url: "https://api.moonshot.ai/v1/models",
    },
    ProviderMeta {
        id: "zai",
        label: "Z.ai (GLM)",
        api: "openai-completions",
        auth_key: "zai",
        auth_env: "ZAI_API_KEY",
        auth_kind: "api-key",
        suggested_models: &["glm-4.6"],
        // Z.ai's model list uses a non-standard path; rely on suggestions/free-text.
        models_url: "",
    },
    ProviderMeta {
        id: "minimax",
        label: "MiniMax",
        api: "openai-completions",
        auth_key: "minimax",
        auth_env: "MINIMAX_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "huggingface",
        label: "Hugging Face",
        api: "openai-completions",
        auth_key: "huggingface",
        auth_env: "HF_TOKEN",
        auth_kind: "api-key",
        suggested_models: &[],
        models_url: "https://router.huggingface.co/v1/models",
    },
    ProviderMeta {
        id: "openrouter",
        label: "OpenRouter (BYOK)",
        api: "openai-completions",
        auth_key: "openrouter",
        auth_env: "OPENROUTER_API_KEY",
        auth_kind: "api-key",
        suggested_models: &[
            "openrouter/auto",
            "anthropic/claude-sonnet-4",
            "openai/gpt-4o",
        ],
        models_url: "https://openrouter.ai/api/v1/models",
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
    // "none" (gateway) needs no credential. The managed provider is a subscription
    // gated server-side by the plan's wallet, so it is always usable here.
    if meta.auth_kind == "none" || meta.id == MANAGED_OPENROUTER_ID {
        return true;
    }
    // Login-based subscription providers (ChatGPT/Claude/Copilot): "configured" =
    // Pi has a stored OAuth login for them (auth.json `{type:"oauth", …}`).
    if meta.auth_kind == "subscription" {
        return !meta.auth_key.is_empty() && auth_has_any(meta.auth_key);
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
    /// Logical active provider id ("managed-openrouter" / "gateway" / a
    /// built-in / a custom id).
    pub provider: String,
    pub model: Option<String>,
    #[serde(rename = "thinkingLevel")]
    pub thinking_level: Option<String>,
    /// The active provider's routing: "gateway" | "direct".
    pub routing: String,
    /// Per-provider routing map for every configured provider, so the desktop can
    /// render each provider's toggle without a round-trip.
    #[serde(rename = "providerRouting")]
    pub provider_routing: Map<String, Value>,
    #[serde(rename = "configDir")]
    pub config_dir: String,
}

/// Read the current configuration.
pub fn current() -> PiConfigView {
    let settings = read_settings();
    let provider =
        active_provider_id_from(&settings).unwrap_or_else(|| GATEWAY_PROVIDER_ID.to_owned());
    let routing = provider_routing(&provider).to_owned();

    // Surface routing for every provider that is either built-in or configured.
    let mut routing_map = Map::new();
    for meta in PROVIDERS {
        routing_map.insert(
            meta.id.to_owned(),
            Value::String(provider_routing(meta.id).to_owned()),
        );
    }
    for id in custom_provider_ids() {
        routing_map
            .entry(id.clone())
            .or_insert_with(|| Value::String(provider_routing(&id).to_owned()));
    }

    PiConfigView {
        provider,
        model: settings.default_model.clone(),
        thinking_level: settings.default_thinking_level.clone(),
        routing,
        provider_routing: routing_map,
        config_dir: config_dir().to_string_lossy().into_owned(),
    }
}

/// The catalog of supported providers + thinking levels, with per-provider
/// `configured` and `suggestedModels` so the desktop can render a picker.
pub fn catalog() -> Value {
    let custom_ids = custom_provider_ids();
    let active = active_provider_id_from(&read_settings());
    let is_active = |id: &str| active.as_deref() == Some(id);
    let mut providers: Vec<Value> = PROVIDERS
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "label": p.label,
                "api": p.api,
                "authKind": p.auth_kind,
                "authEnv": p.auth_env,
                "routing": provider_routing(p.id),
                // Managed/gateway providers can't be flipped off Gateway routing.
                "routingLocked": is_managed_or_gateway(p.id),
                "managed": p.id == MANAGED_OPENROUTER_ID,
                "configured": provider_configured(p),
                "active": is_active(p.id),
                "custom": false,
                "suggestedModels": p.suggested_models,
                "supportsDiscovery": !p.models_url.is_empty(),
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
            "routing": provider_routing(&id),
            "routingLocked": false,
            "managed": false,
            "configured": custom_provider_has_key(&id),
            "active": is_active(&id),
            "custom": true,
            "suggestedModels": [],
            // Custom providers discover against their own baseUrl + /models.
            "supportsDiscovery": true,
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

    // managed-openrouter and the synthetic gateway provider both route through the
    // local Gateway via the built-in `openai` pin, so egress stays governed.
    let gateway = is_managed_or_gateway(&provider);
    let managed = provider == MANAGED_OPENROUTER_ID;
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

    // Managed users get OpenRouter's Auto Router by default (zero decisions); the
    // Gateway maps `openrouter/auto` onto the OpenRouter provider + credits wallet.
    let effective_model = if managed && model.is_none() {
        Some(MANAGED_DEFAULT_MODEL.to_owned())
    } else {
        model.clone()
    };

    // 1) settings.json — defaultProvider/defaultModel/thinking + routing markers +
    //    the logical active-provider id.
    let mut settings = read_settings();
    // In gateway mode, `defaultProvider` is the built-in `openai` provider that
    // the models.json pin redirects at the local Gateway.
    settings.default_provider = Some(if gateway {
        "openai".to_owned()
    } else {
        provider.clone()
    });
    settings.default_model = effective_model.clone();
    settings.default_thinking_level = thinking.clone();
    // Legacy global marker: records the *active* provider's mode for back-compat.
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
    // Remember the logical active provider so `current()` can report
    // managed-openrouter vs gateway (both persist `openai` on disk).
    settings
        .extra
        .insert(ACTIVE_KEY.to_owned(), Value::String(provider.clone()));
    write_settings(&settings)?;

    // Mirror the active provider's mode into the per-provider map too.
    if !is_managed_or_gateway(&provider) {
        set_provider_routing(&provider, ROUTING_DIRECT)?;
    }

    if gateway {
        // Pin Pi's built-in `openai` provider at the Gateway in models.json — the
        // `OPENAI_BASE_URL` env injection alone is ignored by Pi (see
        // `gateway_openai_patch`). Declare the chosen model so Pi sends it (not its
        // built-in `gpt-5.4` default) over chat-completions.
        upsert_provider("openai", gateway_openai_patch(effective_model.as_deref()))?;
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

// ── Multi-provider config (Zed-style: configure many, activate one) ─────────────

/// Configure a provider's credential / base URL / routing **without** activating
/// it. This is the Zed-style flow: many providers can be set up side by side, and
/// `apply()` (activate) picks which one the agent uses. Returns the refreshed
/// catalog so the desktop re-renders every provider's `configured`/`routing` state.
#[derive(Debug, Deserialize)]
pub struct ProviderConfigInput {
    /// Provider id (built-in id, or a new custom id when `base_url` is set).
    pub provider: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: Option<String>,
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
    /// Optional per-provider routing override ("gateway" | "direct").
    #[serde(default)]
    pub routing: Option<String>,
}

/// Persist a provider's credentials + routing without changing the active
/// selection. See [`ProviderConfigInput`].
pub fn configure_provider(input: ProviderConfigInput) -> Result<Value> {
    let provider = input.provider.trim().to_owned();
    if provider.is_empty() {
        anyhow::bail!("provider is required");
    }
    if is_managed_or_gateway(&provider) {
        // Managed/gateway providers carry no BYOK credential; only routing (locked
        // to gateway) — nothing to configure. Activation is the only action.
        anyhow::bail!("provider '{provider}' needs no configuration; activate it instead");
    }

    let base_url = non_empty(&input.base_url);
    let api_key = non_empty(&input.api_key);
    let custom_api = non_empty(&input.api);
    let is_builtin = provider_meta(&provider).is_some();

    if !is_builtin && base_url.is_none() && !custom_provider_ids().contains(&provider) {
        anyhow::bail!(
            "unknown provider '{provider}'; supply a baseUrl to define a custom provider"
        );
    }

    if let Some(url) = &base_url {
        // Custom OpenAI-compatible provider → models.json entry.
        let mut patch = Map::new();
        patch.insert("baseUrl".to_owned(), Value::String(url.clone()));
        patch.insert(
            "api".to_owned(),
            Value::String(custom_api.unwrap_or_else(|| "openai-completions".to_owned())),
        );
        if let Some(key) = &api_key {
            patch.insert("apiKey".to_owned(), Value::String(key.clone()));
        }
        upsert_provider(&provider, patch)?;
    } else if let (Some(meta), Some(key)) = (provider_meta(&provider), &api_key) {
        if !meta.auth_key.is_empty() {
            set_auth_key(meta.auth_key, key)?;
        }
    }

    if let Some(mode) = non_empty(&input.routing) {
        set_provider_routing(&provider, &mode)?;
    }

    Ok(catalog())
}

/// Remove a provider's stored credential (and, for custom providers, its whole
/// entry) and its routing override. If it was the active provider, the active
/// selection falls back to the managed/gateway default. Returns the refreshed
/// catalog.
pub fn remove_provider(id: &str) -> Result<Value> {
    let id = id.trim();
    if id.is_empty() {
        anyhow::bail!("provider id is required");
    }
    if is_managed_or_gateway(id) {
        anyhow::bail!("the managed/gateway provider cannot be removed");
    }

    if let Some(meta) = provider_meta(id) {
        if !meta.auth_key.is_empty() {
            clear_auth_key(meta.auth_key)?;
        }
    }
    remove_models_provider(id)?;

    // Drop its routing override.
    let mut settings = read_settings();
    let mut dirty = false;
    if let Some(map) = settings
        .extra
        .get_mut(PROVIDER_ROUTING_KEY)
        .and_then(Value::as_object_mut)
    {
        if map.remove(id).is_some() {
            dirty = true;
        }
    }
    // If we just removed the active provider, revert to the managed default.
    if active_provider_id_from(&settings).as_deref() == Some(id) {
        settings.extra.insert(
            ACTIVE_KEY.to_owned(),
            Value::String(GATEWAY_PROVIDER_ID.to_owned()),
        );
        settings.extra.insert(
            ROUTING_KEY.to_owned(),
            Value::String(ROUTING_GATEWAY.to_owned()),
        );
        settings.default_provider = Some("openai".to_owned());
        dirty = true;
    }
    if dirty {
        write_settings(&settings)?;
    }
    Ok(catalog())
}

// ── Model discovery (OpenAI-compatible `GET /models`, static fallback) ──────────

/// Request to discover a provider's live model list.
#[derive(Debug, Deserialize)]
pub struct DiscoverInput {
    /// A known/custom provider id to resolve the URL + key from stored config.
    #[serde(default)]
    pub provider: Option<String>,
    /// An explicit base URL (e.g. a not-yet-saved custom provider being tested).
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    /// An explicit key to try (never persisted here; used only for the probe).
    #[serde(rename = "apiKey", default)]
    pub api_key: Option<String>,
}

/// How a discovery request authenticates to the upstream `GET /models`.
enum DiscoveryAuth {
    Bearer(String),
    /// Anthropic uses `x-api-key` + `anthropic-version` rather than a bearer token.
    Anthropic(String),
    None,
}

/// Build the `.../models` URL from a base URL, tolerating trailing slashes and an
/// already-appended `/models`.
fn models_url_from_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/models") {
        trimmed.to_owned()
    } else {
        format!("{trimmed}/models")
    }
}

/// Discover a provider's models via its OpenAI-compatible `GET /models` endpoint,
/// falling back to the provider's static `suggested_models` when discovery is
/// unavailable or errors. Returns `{ models: [{id}], source: "discovery" |
/// "fallback" }`. Runs server-side so keys never reach the browser.
pub async fn discover_models(input: DiscoverInput) -> Value {
    let provider_id = non_empty(&input.provider);
    let explicit_base = non_empty(&input.base_url);
    let explicit_key = non_empty(&input.api_key);

    // Resolve (url, auth) for the probe.
    let resolved: Option<(String, DiscoveryAuth)> = if let Some(base) = &explicit_base {
        let auth = explicit_key
            .clone()
            .map(DiscoveryAuth::Bearer)
            .unwrap_or(DiscoveryAuth::None);
        Some((models_url_from_base(base), auth))
    } else if let Some(id) = &provider_id {
        resolve_provider_discovery(id, explicit_key.clone())
    } else {
        None
    };

    // Tier 1 — a live provider `GET /v1/models` (freshest, provider-authoritative).
    if let Some((url, auth)) = resolved {
        if let Ok(models) = fetch_models(&url, auth).await {
            if !models.is_empty() {
                return json!({ "models": models, "source": "discovery" });
            }
        }
    }

    // Tier 2 — models.dev, the upstream registry Pi's own table is generated from
    // (covers providers without a live key or without an OpenAI `/v1/models`, e.g.
    // Google and the subscription providers).
    if let Some(id) = &provider_id {
        let md = models_dev::models_for(id).await;
        if !md.is_empty() {
            return json!({ "models": md, "source": "models.dev" });
        }
    }

    // Tier 3 — the tiny static seed (offline, unknown provider). Free-text entry in
    // the UI always works regardless.
    let seed: Vec<Value> = provider_id
        .as_deref()
        .and_then(provider_meta)
        .map(|m| m.suggested_models)
        .unwrap_or(&[])
        .iter()
        .map(|id| json!({ "id": id }))
        .collect();
    json!({ "models": seed, "source": "fallback" })
}

/// Resolve the discovery URL + auth for a known/custom provider id from stored
/// config. Returns `None` when the provider has no discoverable endpoint (e.g.
/// Google's non-OpenAI shape), so the caller falls back to suggestions.
fn resolve_provider_discovery(
    id: &str,
    explicit_key: Option<String>,
) -> Option<(String, DiscoveryAuth)> {
    // Managed/gateway → the local Gateway's own /v1/models.
    if is_managed_or_gateway(id) {
        let base = crate::sidecar::gateway::gateway_url();
        let url = format!("{}/v1/models", base.trim_end_matches('/'));
        let token =
            crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());
        return Some((url, DiscoveryAuth::Bearer(token)));
    }

    if let Some(meta) = provider_meta(id) {
        if meta.models_url.is_empty() {
            return None; // No OpenAI-style discovery (e.g. Google).
        }
        let key = explicit_key
            .or_else(|| auth_key_value(meta.auth_key))
            .or_else(|| std::env::var(meta.auth_env).ok().filter(|s| !s.is_empty()));
        let auth = match key {
            Some(k) if id == "anthropic" => DiscoveryAuth::Anthropic(k),
            Some(k) => DiscoveryAuth::Bearer(k),
            None => DiscoveryAuth::None,
        };
        return Some((meta.models_url.to_owned(), auth));
    }

    // Custom provider defined in models.json → its baseUrl + /models.
    let entry = read_models()["providers"].get(id)?.clone();
    let base = entry.get("baseUrl").and_then(Value::as_str)?;
    let key = explicit_key.or_else(|| {
        entry
            .get("apiKey")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|s| !s.is_empty())
    });
    let auth = key
        .map(DiscoveryAuth::Bearer)
        .unwrap_or(DiscoveryAuth::None);
    Some((models_url_from_base(base), auth))
}

/// GET the `/models` endpoint and parse the OpenAI/Anthropic `{ data: [{id,…}] }`
/// shape into `[{id}]`. Short timeout so a dead endpoint fails fast to fallback.
async fn fetch_models(url: &str, auth: DiscoveryAuth) -> Result<Vec<Value>> {
    let client = reqwest::Client::new();
    let mut req = client.get(url).timeout(std::time::Duration::from_secs(8));
    match auth {
        DiscoveryAuth::Bearer(token) => req = req.bearer_auth(token),
        DiscoveryAuth::Anthropic(key) => {
            req = req
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        }
        DiscoveryAuth::None => {}
    }
    let resp = req.send().await.context("discover models request")?;
    if !resp.status().is_success() {
        anyhow::bail!("discovery endpoint returned {}", resp.status());
    }
    let body: Value = resp.json().await.context("parse discovery response")?;
    // OpenAI + Anthropic both use `{ data: [ { id, ... } ] }`; OpenRouter too.
    let items = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let models: Vec<Value> = items
        .into_iter()
        .filter_map(|m| {
            let id = m
                .get("id")
                .or_else(|| m.get("name"))
                .and_then(Value::as_str)?
                .to_owned();
            let mut out = Map::new();
            out.insert("id".to_owned(), Value::String(id));
            if let Some(name) = m.get("display_name").and_then(Value::as_str) {
                out.insert("name".to_owned(), Value::String(name.to_owned()));
            }
            Some(Value::Object(out))
        })
        .collect();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point the config dir at a temp location for the duration of a test.
    fn with_temp_dir<F: FnOnce()>(f: F) {
        let _guard = lock_pi_config_test_env();
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
    fn managed_defaults_fill_model_provider_and_disable_pi_skills() {
        with_temp_dir(|| {
            ensure_managed_defaults().unwrap();
            let settings = read_settings();
            // Fresh install (gateway-routed by default): a non-empty zero-key
            // default model + the gateway-redirected provider are written…
            let model = settings.default_model.clone().unwrap();
            assert!(!model.trim().is_empty());
            assert_eq!(settings.default_provider.as_deref(), Some("openai"));
            // …Pi's own skill auto-discovery is disabled…
            assert_eq!(
                settings.extra.get("skills"),
                Some(&json!([PI_SKILLS_DISABLED]))
            );
            // …and the model is declared on the gateway-pinned openai provider.
            let models = read_models();
            let declared = models["providers"]["openai"]["models"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            assert!(declared.iter().any(|m| m["id"] == json!(model.clone())));
        });
    }

    #[test]
    fn managed_defaults_do_not_clobber_user_choices() {
        with_temp_dir(|| {
            let _ = ensure_dir();
            fs::write(
                settings_path(),
                r#"{"defaultProvider":"openai","defaultModel":"my-model","skills":["+/keep/me"]}"#,
            )
            .unwrap();
            ensure_managed_defaults().unwrap();
            let settings = read_settings();
            assert_eq!(settings.default_model.as_deref(), Some("my-model"));
            assert_eq!(settings.extra.get("skills"), Some(&json!(["+/keep/me"])));
        });
    }

    #[test]
    fn persist_turn_model_gateway_openai_pick_is_persisted_and_declared() {
        with_temp_dir(|| {
            persist_turn_model("openai/gpt-4o").unwrap();
            let settings = read_settings();
            assert_eq!(settings.default_provider.as_deref(), Some("openai"));
            assert_eq!(settings.default_model.as_deref(), Some("gpt-4o"));
            let models = read_models();
            let declared = models["providers"]["openai"]["models"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            assert!(declared.iter().any(|m| m["id"] == json!("gpt-4o")));
        });
    }

    #[test]
    fn persist_turn_model_gateway_skips_non_openai_providers() {
        with_temp_dir(|| {
            persist_turn_model("anthropic/claude-sonnet-4").unwrap();
            let settings = read_settings();
            // Gateway mode must not be flipped onto a direct provider by a pick.
            assert!(settings.default_model.is_none());
            assert!(settings.default_provider.is_none());
        });
    }

    #[test]
    fn persist_turn_model_direct_mode_mirrors_pick() {
        with_temp_dir(|| {
            apply(PiConfigInput {
                provider: "anthropic".to_owned(),
                model: Some("claude-3-5-haiku-20241022".to_owned()),
                thinking_level: None,
                api_key: Some("sk-ant-test".to_owned()),
                base_url: None,
                api: None,
            })
            .unwrap();
            persist_turn_model("anthropic/claude-sonnet-4-20250514").unwrap();
            let settings = read_settings();
            assert_eq!(settings.default_provider.as_deref(), Some("anthropic"));
            assert_eq!(
                settings.default_model.as_deref(),
                Some("claude-sonnet-4-20250514")
            );
            // Direct mode is preserved.
            assert!(!is_gateway_routing());
        });
    }

    #[test]
    fn gateway_patch_merges_declared_models_instead_of_replacing() {
        with_temp_dir(|| {
            persist_turn_model("openai/model-a").unwrap();
            persist_turn_model("openai/model-b").unwrap();
            let models = read_models();
            let declared: Vec<String> = models["providers"]["openai"]["models"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_owned))
                .collect();
            // Both picks stay declared so the user can switch back.
            assert!(declared.iter().any(|id| id == "model-a"));
            assert!(declared.iter().any(|id| id == "model-b"));
        });
    }

    #[test]
    fn managed_openrouter_activation_pins_gateway_and_defaults_auto() {
        with_temp_dir(|| {
            let view = apply(PiConfigInput {
                provider: MANAGED_OPENROUTER_ID.to_owned(),
                model: None,
                thinking_level: None,
                api_key: None,
                base_url: None,
                api: None,
            })
            .unwrap();
            // Logical active provider is reported as managed (not raw "openai").
            assert_eq!(view.provider, MANAGED_OPENROUTER_ID);
            assert_eq!(view.routing, "gateway");
            // Managed users default to the Auto Router.
            assert_eq!(view.model.as_deref(), Some(MANAGED_DEFAULT_MODEL));
            assert!(is_gateway_routing());
            // On disk it rides the openai gateway pin so egress is governed.
            let settings = read_settings();
            assert_eq!(settings.default_provider.as_deref(), Some("openai"));
            let models = read_models();
            assert!(models["providers"]["openai"]["models"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == json!(MANAGED_DEFAULT_MODEL)));
        });
    }

    #[test]
    fn configure_provider_stores_key_without_activating() {
        with_temp_dir(|| {
            // Fresh install is gateway-routed; configuring a BYOK provider must not
            // steal the active selection.
            let catalog = configure_provider(ProviderConfigInput {
                provider: "anthropic".to_owned(),
                api_key: Some("sk-ant-test".to_owned()),
                base_url: None,
                api: None,
                routing: None,
            })
            .unwrap();
            // Still gateway-active.
            assert!(is_gateway_routing());
            assert_eq!(current().provider, GATEWAY_PROVIDER_ID);
            // Key is stored + surfaced as configured, but not active.
            assert!(auth_has_key("anthropic"));
            let anthropic = catalog["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == "anthropic")
                .unwrap();
            assert_eq!(anthropic["configured"], json!(true));
            assert_eq!(anthropic["active"], json!(false));
        });
    }

    #[test]
    fn per_provider_routing_toggle_persists() {
        with_temp_dir(|| {
            configure_provider(ProviderConfigInput {
                provider: "openai".to_owned(),
                api_key: Some("sk-test".to_owned()),
                base_url: None,
                api: None,
                routing: Some("gateway".to_owned()),
            })
            .unwrap();
            assert_eq!(provider_routing("openai"), "gateway");
            configure_provider(ProviderConfigInput {
                provider: "openai".to_owned(),
                api_key: None,
                base_url: None,
                api: None,
                routing: Some("direct".to_owned()),
            })
            .unwrap();
            assert_eq!(provider_routing("openai"), "direct");
        });
    }

    #[test]
    fn managed_and_gateway_routing_cannot_be_flipped() {
        with_temp_dir(|| {
            // set_provider_routing is a no-op for locked providers.
            set_provider_routing(MANAGED_OPENROUTER_ID, "direct").unwrap();
            assert_eq!(provider_routing(MANAGED_OPENROUTER_ID), "gateway");
            assert_eq!(provider_routing(GATEWAY_PROVIDER_ID), "gateway");
        });
    }

    #[test]
    fn remove_provider_clears_key_and_reverts_active() {
        with_temp_dir(|| {
            apply(PiConfigInput {
                provider: "anthropic".to_owned(),
                model: Some("claude-sonnet-4-20250514".to_owned()),
                thinking_level: None,
                api_key: Some("sk-ant-test".to_owned()),
                base_url: None,
                api: None,
            })
            .unwrap();
            assert_eq!(current().provider, "anthropic");
            assert!(auth_has_key("anthropic"));

            remove_provider("anthropic").unwrap();
            // Key gone, active reverts to the managed/gateway default.
            assert!(!auth_has_key("anthropic"));
            assert_eq!(current().provider, GATEWAY_PROVIDER_ID);
            assert!(is_gateway_routing());
        });
    }

    #[test]
    fn managed_provider_cannot_be_configured_or_removed() {
        with_temp_dir(|| {
            assert!(configure_provider(ProviderConfigInput {
                provider: MANAGED_OPENROUTER_ID.to_owned(),
                api_key: Some("nope".to_owned()),
                base_url: None,
                api: None,
                routing: None,
            })
            .is_err());
            assert!(remove_provider(GATEWAY_PROVIDER_ID).is_err());
        });
    }

    #[test]
    fn discover_models_falls_back_when_provider_unknown_and_registry_offline() {
        // An unknown provider with the models.dev registry pointed at an
        // unreachable host: tier-1 (no url) and tier-2 (not in registry) both yield
        // nothing, so we get the tier-3 fallback with an empty model list. Free-text
        // entry covers this case in the UI. Deterministic + offline.
        with_temp_dir(|| {
            std::env::set_var("RYU_MODELS_DEV_URL", "http://127.0.0.1:1/none");
            let rt = tokio::runtime::Runtime::new().unwrap();
            let out = rt.block_on(discover_models(DiscoverInput {
                provider: Some("definitely-not-a-provider-xyz".to_owned()),
                base_url: None,
                api_key: None,
            }));
            std::env::remove_var("RYU_MODELS_DEV_URL");
            assert_eq!(out["source"], "fallback");
            assert_eq!(out["models"].as_array().unwrap().len(), 0);
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
