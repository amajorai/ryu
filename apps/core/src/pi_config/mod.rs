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
use ryu_kernel_contracts::schema::{ProviderRegistrationSpec, PROVIDER_OWNER_FIELD};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// models.dev-backed dynamic model catalog (replaces hardcoded model lists).
pub(crate) mod models_dev;

/// Plugin-contributed Pi extensions (`contributes.pi_extensions`) — the resolver
/// and privilege gate behind [`sync_app_pi_extensions`].
pub mod accounts;
pub mod app_extensions;
pub mod oauth_login;

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

/// Pool-backed managed providers — Ryu-supplied capacity billed against a
/// SEGREGATED donated credit pool rather than the retail pass-through one.
///
/// The `managed-<poolId>` shape is load-bearing: the desktop composer binds a
/// catalog row to a pool when the row is `managed` and its id is the pool id,
/// `managed-<poolId>`, or one of the pool's gateway provider ids
/// (`use-universal-picker.ts`). Renaming one of these silently unbinds the pool
/// and the row loses its label, its balance badge and its upsell escape.
pub const MANAGED_CLOUDFLARE_ID: &str = "managed-cloudflare";
pub const MANAGED_BEDROCK_ID: &str = "managed-bedrock";

/// OpenRouter's general-purpose model router. The zero-decision default for
/// managed users.
const OPENROUTER_AUTO_MODEL_ID: &str = "openrouter/auto";

/// OpenRouter's coding-focused Pareto model router. It selects a coding model
/// without requiring Ryu to maintain a changing model shortlist.
const OPENROUTER_PARETO_CODE_MODEL_ID: &str = "openrouter/pareto-code";

const MANAGED_DEFAULT_MODEL: &str = OPENROUTER_AUTO_MODEL_ID;

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

/// Whether a provider is MANAGED — Ryu-supplied capacity billed against a credit
/// pool, rather than a key the user brought.
///
/// Keyed on the row's `credit_pool`, never on an id: this was five separate
/// `== MANAGED_OPENROUTER_ID` comparisons, which is why the product could only
/// ever have one managed provider, and why each of the five broke it differently
/// when it did not.
fn is_managed(id: &str) -> bool {
    provider_meta(id).is_some_and(|m| !m.credit_pool.is_empty())
}

/// Providers that are *always* Gateway-routed (any managed row, or the synthetic
/// gateway provider) — their egress must stay governed/metered.
fn is_managed_or_gateway(id: &str) -> bool {
    id == GATEWAY_PROVIDER_ID || is_managed(id)
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
    gateway_openai_patch_for(model, false)
}

/// As [`gateway_openai_patch`], but routes the MANAGED provider at the hosted
/// gateway fleet when this node has managed coordinates.
///
/// This is what lets ONE node run both planes at once, which is the whole point:
///  - `managed-openrouter` → the REMOTE fleet, whose env holds the provider keys
///    and whose per-org resolve enforces the plan's credit budget;
///  - every BYOK provider → the node's OWN local gateway, using the user's keys.
///
/// Before this, both pointed at the local gateway, so a self-hosted user who
/// selected "Ryu (managed · included with your plan)" was silently routed into
/// their own keyless gateway — the subscription they paid for could not be spent
/// from anywhere except a Ryu-provisioned cloud node. Falls back to the local
/// gateway when no managed coordinates are configured, so nothing regresses on a
/// node that never opted in.
fn gateway_openai_patch_for(model: Option<&str>, managed: bool) -> Map<String, Value> {
    let fleet = if managed {
        crate::sidecar::gateway::managed_fleet()
    } else {
        None
    };
    let (base, token) = match fleet {
        Some((url, token)) => (url, token),
        None => (
            crate::sidecar::gateway::gateway_url(),
            crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned()),
        ),
    };
    let v1 = format!("{}/v1", base.trim_end_matches('/'));
    let mut patch = Map::new();
    patch.insert("baseUrl".to_owned(), Value::String(v1));
    patch.insert(
        "api".to_owned(),
        Value::String("openai-completions".to_owned()),
    );
    patch.insert("apiKey".to_owned(), Value::String(token));

    // This node's own routing preferences, on the Pi-managed path.
    //
    // Pi drives the gateway itself here — Core's `connect_openai` is not in the
    // loop — so the header Core sends on the chat path never travels for a
    // Pi-routed turn. VERIFIED against the installed Pi rather than assumed:
    // `@earendil-works/pi-coding-agent`'s `ProviderConfigSchema`
    // (`dist/core/model-config.d.ts`) declares a provider-level
    // `headers: Record<string, string>` right beside `baseUrl` / `apiKey` / `api`,
    // and `pi-ai`'s `Provider` carries it through to dispatch (its own docs draw
    // the line as "if it can be expressed as apiKey/headers/baseUrl it is provider
    // config"). That is the seam; there was no need to invent one.
    //
    // Both legs of the `fleet` match above target a GATEWAY (hosted fleet or the
    // local one), never a raw provider endpoint, so this is safe on either. Absent
    // when the node has stated no preferences, which keeps `models.json`
    // byte-identical on an untouched install.
    if let Some(prefs) = crate::sidecar::gateway::node_routing_header() {
        let mut headers = Map::new();
        headers.insert("x-ryu-node-routing".to_owned(), Value::String(prefs));
        patch.insert("headers".to_owned(), Value::Object(headers));
    }

    // Union of declared model entries (order-preserving, deduped). Ryu's bundled
    // local model gets full metadata because Pi treats unknown custom ids with
    // generic fallback metadata, which hurts context/output sizing.
    let mut entries: Vec<Value> = read_models()["providers"]
        .get("openai")
        .and_then(|p| p.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(Value::as_str)
                        .map(|id| gateway_model_entry(id, Some(m)))
                })
                .collect()
        })
        .unwrap_or_default();
    let default_local = default_gateway_model();
    // On Apple Silicon macOS 26+, advertise Apple's on-device Foundation Model
    // (served by the `apfel` engine) so it shows up as a selectable model in the
    // ryu/Pi composer. Node-gated so it never appears on machines that can't run
    // it; picking it triggers the apfel engine swap (see
    // `adapters::sync_ryu_local_engine`).
    let apple_fm = crate::catalog::registry::supported_on_node("apfel")
        .then_some(crate::sidecar::providers::apfel::APPLE_FM_MODEL_ID);
    for candidate in [Some(default_local.as_str()), apple_fm, model] {
        if let Some(id) = candidate.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(existing) = entries
                .iter_mut()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            {
                *existing = gateway_model_entry(id, Some(existing));
            } else {
                entries.push(gateway_model_entry(id, None));
            }
        }
    }
    if !entries.is_empty() {
        patch.insert("models".to_owned(), Value::Array(entries));
    }
    patch
}

fn gateway_model_entry(id: &str, existing: Option<&Value>) -> Value {
    let local_id = default_gateway_model();
    if id != local_id {
        let mut entry = existing.cloned().unwrap_or_else(|| json!({ "id": id }));
        apply_cache_compat(id, &mut entry);
        return entry;
    }

    let mut entry = existing.cloned().unwrap_or_else(|| json!({ "id": id }));
    if !entry.is_object() {
        entry = json!({ "id": id });
    }
    let obj = entry.as_object_mut().expect("gateway model entry object");
    obj.entry("id".to_owned())
        .or_insert_with(|| Value::String(id.to_owned()));
    obj.entry("name".to_owned())
        .or_insert_with(|| Value::String("Gemma 4 E2B IT Q4_K_M".to_owned()));
    obj.entry("api".to_owned())
        .or_insert_with(|| Value::String("openai-completions".to_owned()));
    obj.entry("input".to_owned())
        .or_insert_with(|| json!(["text"]));
    obj.entry("cost".to_owned()).or_insert_with(|| {
        json!({
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
        })
    });
    obj.entry("contextWindow".to_owned())
        .or_insert_with(|| json!(128_000));
    obj.entry("maxTokens".to_owned())
        .or_insert_with(|| json!(8_192));
    entry
}

/// Anthropic-style prompt caching over the Gateway is opt-in per model in Pi:
/// it only emits `cache_control` breakpoints (on the system prompt, the last
/// tool definition, and the last user/assistant text) when the model's
/// `compat.cacheControlFormat` is `"anthropic"`. Providers that cache
/// automatically (OpenAI, DeepSeek, Grok, Gemini 2.5) need no marker, and Pi
/// already sends `prompt_cache_key` on the OpenAI path, so we only stamp the
/// flag for the families that expose Anthropic-style *explicit* caching through
/// the Gateway/OpenRouter: Claude and Qwen. This matches OpenRouter's caching
/// contract (`cache_control: { type: "ephemeral" }` breakpoints on those
/// providers). Returns the format string, or `None` when the model does not use
/// explicit `cache_control` markers. Nothing is hardcoded per model: the family
/// is derived from the id so any future Claude/Qwen id inherits it.
fn explicit_cache_control_format(id: &str) -> Option<&'static str> {
    let lid = id.to_ascii_lowercase();
    let anthropic_style =
        lid.contains("claude") || lid.contains("anthropic") || lid.contains("qwen");
    anthropic_style.then_some("anthropic")
}

/// Merge the explicit prompt-cache `compat.cacheControlFormat` into a Pi model
/// entry when the model family supports it, without clobbering a
/// caller-declared `compat` block or an existing `cacheControlFormat`.
/// Idempotent; a no-op for auto-caching / non-caching families.
fn apply_cache_compat(id: &str, entry: &mut Value) {
    let Some(format) = explicit_cache_control_format(id) else {
        return;
    };
    let Some(obj) = entry.as_object_mut() else {
        return;
    };
    let compat = obj.entry("compat".to_owned()).or_insert_with(|| json!({}));
    if let Some(compat_obj) = compat.as_object_mut() {
        compat_obj
            .entry("cacheControlFormat".to_owned())
            .or_insert_with(|| Value::String(format.to_owned()));
    }
}

/// The zero-key default model for the managed Pi in Gateway-routed mode: the
/// registry's local llama.cpp chat model (swappable via `RYU_LOCAL_CHAT_MODEL_ID`,
/// never hardcoded here). The gateway's built-in prefix rules
/// route `gemma*`-style ids to its `local` provider (the llama.cpp sidecar), so a
/// fresh install with no API keys gets a working model out of the box.
///
/// The doc used to say "or `registry.json`", and that was the last half-live field
/// in the registry: this `load()` honoured the file key while the onboarding
/// downloader and `llamacpp::{mod,process}` (`from_env()`) did not, so an operator
/// who set it made the managed Pi declare a model id that llama.cpp was not serving.
/// The file key is now deleted, which is what makes `load()` here and `from_env()`
/// there return the same id by construction — so this call site is correct as it
/// stands and needs no change.
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

/// Value written to Pi's `settings.json` `skills` array to ask Pi not to
/// auto-discover skills (`!` = exclude pattern, `**` = everything). Pi
/// auto-loads `~/.agents/skills` (a hard-coded home path, independent of
/// `PI_CODING_AGENT_DIR`), which duplicated — and bypassed the allowlist of —
/// Core's own governed skill injection on the ACP prompt (QA finding B1).
///
/// **Scope of what this actually buys, verified against `pi-acp@0.0.33`:** the
/// ACP bridge itself ignores this key entirely. Its startup banner builder walks
/// the three skill roots directly (it reads `settings.json` only for the
/// `packages` key, to list extensions), and the one reader that does touch
/// `skills` (`getEnableSkillCommands`) guards it with an
/// `isObject()` that is `false` for an Array — so the array written here is not
/// even looked at by the bridge. Whether the `pi` binary behind the bridge
/// honours it for actual skill *loading* is UNVERIFIED (the binary is not
/// installed on the machines this was checked on), which is exactly why the
/// write stays: removing it would change unmeasured behaviour.
///
/// It therefore does **not** stop the startup skill dump — that is what
/// [`PI_QUIET_STARTUP`] is for.
const PI_SKILLS_DISABLED: &str = "!**";

/// Settings key written to suppress pi-acp's `session/new` startup banner.
///
/// Without it, `getQuietStartup` defaults to **false**, so on every new session
/// the bridge renders a "## Skills" bullet list of all three skill roots — one
/// of which is the hard-coded `~/.agents/skills` — and emits it as an ACP
/// `agent_message_chunk`. Core's ACP adapter maps that to assistant text, which
/// then persists as a durable assistant row: the full skills list dumped into
/// the chat before the user has said anything.
///
/// Quiet startup still lets an available-update notice through as an
/// `agent_message_chunk`, so this write is necessary but not sufficient; the
/// adapter also routes the agent's self-declared startup banner off the
/// assistant reply path (see `AcpEvent::Banner`).
const PI_QUIET_STARTUP: &str = "quietStartup";

/// Legacy spelling of [`PI_QUIET_STARTUP`]. `getQuietStartup` falls back to it,
/// so an explicit user value under the old name must not be overridden by the
/// managed default either.
const PI_QUIET_STARTUP_LEGACY: &str = "quietStart";

/// Enforce the managed-Pi config invariants. Idempotent; called at spawn time
/// (see `acp::ryu_pi_acp_cmd` and the `ryu` PATH-fallback route) so a fresh
/// install works with zero setup:
///
/// 1. **Pi-side skill injection off** — Core injects the (allowlist-gated) skill
///    block into the ACP prompt itself, so Pi loading `~/.agents/skills` on top
///    double-injected ~100 ungoverned SKILL.md manifests (QA B1). Written only
///    when the user has not set the `skills` key, so an explicit user choice in
///    the managed dir always stands. See [`PI_SKILLS_DISABLED`] for what this
///    does and does not cover.
/// 2. **Quiet startup** — pi-acp's `session/new` banner enumerates every skill
///    it can find and ships it as an assistant message, so a fresh chat opened
///    with the full skills list already dumped into it. `quietStartup: true`
///    suppresses that banner ([`PI_QUIET_STARTUP`]). Written only when neither
///    the current nor the legacy key is set.
/// 3. **A valid default model in Gateway mode** — Pi with no `defaultModel`
///    parrots its skill manifest instead of answering (QA B1). When Gateway-routed
///    and no model is set, default to [`default_gateway_model`] (the local
///    llama.cpp model — resolvable through the gateway with zero API keys) and
///    normalize `defaultProvider` to the gateway-redirected `openai`.
/// 4. **The Gateway provider pin** — [`ensure_gateway_models_json`], declaring
///    the model so Pi actually sends it over chat-completions.
pub fn ensure_managed_defaults() -> Result<()> {
    // Reflect the active account into Pi's auth.json / models.json before every
    // spawn so the files Pi reads always carry the SELECTED account, never a
    // stale one from a switch or a removed account.
    materialize_active_accounts();
    let mut settings = read_settings();
    let mut dirty = false;
    if !settings.extra.contains_key("skills") {
        settings
            .extra
            .insert("skills".to_owned(), json!([PI_SKILLS_DISABLED]));
        dirty = true;
    }

    // Same "only when the user has not chosen" guard as `skills` — and it has to
    // cover the legacy spelling too, because pi-acp's `getQuietStartup` falls
    // back to it: writing `quietStartup: true` next to a user's deliberate
    // `quietStart: false` would silently win over their choice.
    if !settings.extra.contains_key(PI_QUIET_STARTUP)
        && !settings.extra.contains_key(PI_QUIET_STARTUP_LEGACY)
    {
        settings
            .extra
            .insert(PI_QUIET_STARTUP.to_owned(), json!(true));
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
    ensure_gateway_models_json()?;
    // The three extensions that CANNOT become plugins. Each `ensure_pi_*` fn's own
    // doc says why in full; in one line each:
    //
    // - `ryu-mcp` is the flagship agent's ONLY road to Ryu's tools (pi-acp advertises
    //   no MCP-server support), so a toggle for it would be a switch that silently
    //   strips every tool from the default agent.
    // - `ryu-lsp` IS the binding for `contributes.lsp_servers`; shipping it
    //   conditionally would let a node declare language servers with nothing to run
    //   them.
    // - `ryu-plan` owns the `/plan` sentinel grammar that `plan_mode_sentinel` is
    //   pinned against at compile time, and the plan pill is advertised on
    //   "this is the managed Pi", not "the plan extension is installed" — so a
    //   disabled plan plugin would leave a literal `/plan` reaching the model on
    //   every turn.
    //
    // Everything else Pi omits by design (background bash, sub-agents) now ships as
    // a plugin through `contributes.pi_extensions`; see [`app_extensions`].
    ensure_pi_mcp_extension()?;
    ensure_pi_lsp_extension()?;
    ensure_pi_plan_extension()
}

/// The Ryu-MCP Pi extension source, embedded into the Core binary so it ships
/// regardless of install layout (Core is a compiled binary; the repo `assets/`
/// dir is not present next to it at runtime). Written into the managed Pi config
/// dir at spawn — see [`ensure_pi_mcp_extension`].
const PI_MCP_EXTENSION_SRC: &str = include_str!("../../assets/pi-extensions/ryu-mcp.ts");

/// Absolute path to the managed Pi's Ryu-MCP extension file, under the managed
/// config dir's `extensions/` folder. Pi ALSO auto-discovers `<agentDir>/extensions/`,
/// so the `settings.json` registration below is belt-and-suspenders (Pi dedups by
/// resolved path). Never touches the user's `~/.pi`.
fn pi_mcp_extension_path() -> PathBuf {
    config_dir().join("extensions").join("ryu-mcp.ts")
}

/// Ship + register the Ryu-MCP Pi extension into the MANAGED Pi config
/// (`~/.ryu/pi-agent`). This is what lets the flagship `ryu` (Pi) agent call
/// Core's MCP tools — including widget-bearing ones (Apps-SDK / MCP apps), which
/// Pi otherwise cannot reach (it advertises no MCP-server support, so Core's
/// in-process bridge is skipped for it).
///
/// **This is the flagship agent's ONLY road to Ryu's tools.** Verified against
/// `pi-acp@0.0.33` on 2026-07-31: its `initialize` reports
/// `mcpCapabilities { http: false, sse: false }`, and `session/new` stores
/// `params.mcpServers` on a session field that nothing in the bundle ever reads.
/// So the in-process bridge is not merely skipped by Core's own guard — it would
/// be accepted and silently discarded if Core sent it. The full evidence, and why
/// the guard is a spawn-string match rather than a capability read, is in
/// `sidecar::adapters::acp::acp_bridge_supported`; the three-way classification
/// (`bridge` / `pi-extension` / `none`) is `acp::RyuToolAccess`.
///
/// ## Why writing a config file is legitimate HERE
///
/// `crate::exec_approval` refuses on principle to install filesystem hooks into
/// an agent's config (Claude's `settings.json`, Codex's `config.toml`), because
/// doing so costs either a folder-trust supply-chain hole (widening
/// `settingSources` to `project`/`local`) or a subscription-credential migration
/// (relocating `CLAUDE_CONFIG_DIR`) — and the ACP `request_permission` seam
/// already governs every agent uniformly at no such cost.
///
/// Neither cost is paid here, and the difference is the *directory*, not the
/// technique. That refusal is about writing into the **user's own** config dirs.
/// [`config_dir`] is Ryu's ISOLATED dir (`~/.ryu/pi-agent`), created by Core, read
/// by no Pi the user launches themselves, and reachable only by a process Core
/// spawns with `PI_CODING_AGENT_DIR` pointed at it. Nothing here widens a trust
/// scope, relocates a credential, or changes what the user's own `pi` does. And
/// unlike a hook, this file adds no governance path of its own: every tool the
/// extension can invoke goes back out through Core's `/api/mcp/tools/call`, which
/// applies the same per-agent allowlist the in-process bridge does.
///
/// ## Why bare `acp:pi` deliberately gets nothing
///
/// The symmetrical move — shipping this extension into the user's `~/.pi` so the
/// `acp:pi` agent (and any custom agent bound to that engine) also gets Ryu
/// tools — is exactly the line above that must not be crossed. It would mean Core
/// writing executable code into a config directory the user owns and shares with
/// their own Pi sessions, which then loads on every unrelated `pi` invocation.
/// That is `exec_approval`'s objection with the costs it names actually incurred.
/// So bare `acp:pi` reaches no Ryu tools at all, by design; the flagship `ryu`
/// agent is the supported way to use Pi with Ryu's tools, and
/// `run_acp_instance` now WARNs when it spawns such an instance so the state is
/// at least visible rather than silent.
///
/// Idempotent: the extension source is (re)written only when it differs (so an
/// engine update ships the current bridge without needless disk churn), and the
/// absolute path is appended to `settings.json`'s `extensions` array only when
/// missing.
fn ensure_pi_mcp_extension() -> Result<()> {
    ship_pi_extension(&pi_mcp_extension_path(), PI_MCP_EXTENSION_SRC)
}

/// The Ryu-LSP Pi extension source, embedded for the same reason as
/// [`PI_MCP_EXTENSION_SRC`]. This is the flagship agent's **binding** for the
/// agent-neutral `contributes.lsp_servers` declaration ([`crate::lsp`]): Pi has no
/// language-server support of its own, so the extension spawns the servers Core
/// resolved, speaks LSP over their stdio, and pushes diagnostics back into the
/// model's context after edits.
///
/// Shipped unconditionally, exactly like the MCP bridge — an extension with no
/// resolved config is a silent no-op (it reads [`pi_lsp_servers_path`], finds
/// nothing, and registers no handlers), so gating the file on "does any plugin
/// declare a server today" would only add a way for the two to disagree.
const PI_LSP_EXTENSION_SRC: &str = include_str!("../../assets/pi-extensions/ryu-lsp.ts");

/// Absolute path to the managed Pi's Ryu-LSP extension file. Same folder and same
/// registration rules as [`pi_mcp_extension_path`].
fn pi_lsp_extension_path() -> PathBuf {
    config_dir().join("extensions").join("ryu-lsp.ts")
}

/// Absolute path to the resolved language-server table the Ryu-LSP extension
/// reads, written by [`write_lsp_servers_file`].
///
/// **This path is a contract with `assets/pi-extensions/ryu-lsp.ts`**, which
/// resolves it as `<PI_CODING_AGENT_DIR>/extensions/ryu-lsp.json` (Core sets that
/// env var on the Pi spawn command; `RYU_PI_AGENT_DIR` is Core's own knob and is
/// NOT in the child's environment). A mismatch is a SILENT no-op by design — the
/// extension treats an absent file as "no language servers configured" — so the
/// two spellings must be changed together.
///
/// It lives beside the extension rather than inside `settings.json` on purpose:
/// `settings.json` is rewritten on every composer model pick and sits in a 0700
/// dir next to credentials, whereas this file is regenerated wholesale, is
/// independently inspectable, and can be deleted when nothing declares a server.
fn pi_lsp_servers_path() -> PathBuf {
    config_dir().join("extensions").join("ryu-lsp.json")
}

/// Ship + register the Ryu-LSP Pi extension into the MANAGED Pi config, with the
/// same idempotency guarantees as [`ensure_pi_mcp_extension`].
fn ensure_pi_lsp_extension() -> Result<()> {
    ship_pi_extension(&pi_lsp_extension_path(), PI_LSP_EXTENSION_SRC)
}

/// The Ryu-Plan Pi extension source, embedded for the same reason as
/// [`PI_MCP_EXTENSION_SRC`].
///
/// Pi ships **none** of plan mode, to-dos or permission prompts, and says so
/// deliberately in its own docs (`pi/docs/usage.md:309`): "It intentionally does
/// not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or
/// background bash. You can build or install those workflows as extensions or
/// packages." Every other ACP agent Ryu drives (Claude Code, Codex) has all of
/// them, so without this file the *flagship* agent was the only one that could
/// not plan before editing, could not show a checklist, and could not ask before
/// running something destructive. This is that binding, built the way Pi intends.
///
/// All three live in one file on purpose: plan-mode denial and the permission
/// gate are both `tool_call` hooks, and Pi's `emitToolCall` iterates extensions in
/// load order and returns on the FIRST `block: true`. Two hooks in two files would
/// make the precedence depend on load order; one hook in one file makes it
/// explicit. Do not split them.
const PI_PLAN_EXTENSION_SRC: &str = include_str!("../../assets/pi-extensions/ryu-plan.ts");

/// Absolute path to the managed Pi's Ryu-Plan extension file. Same folder and
/// same registration rules as [`pi_mcp_extension_path`].
fn pi_plan_extension_path() -> PathBuf {
    config_dir().join("extensions").join("ryu-plan.ts")
}

/// Ship + register the Ryu-Plan Pi extension into the MANAGED Pi config, with the
/// same idempotency guarantees as [`ensure_pi_mcp_extension`].
fn ensure_pi_plan_extension() -> Result<()> {
    ship_pi_extension(&pi_plan_extension_path(), PI_PLAN_EXTENSION_SRC)
}

/// The in-band token `ryu-plan.ts` watches for on the `input` event, and the ONLY
/// Pi-specific string the agent-neutral ACP code is allowed to know about.
///
/// WHY A SENTINEL AT ALL. pi-acp closes every structural door to a per-turn mode:
/// its argv is hardcoded so `registerFlag` never sees a value; ACP session modes
/// are already taken (pi-acp maps them onto Pi *thinking levels* and rejects any
/// other id); `setSessionConfigOption` accepts only `model` and `thought_level`;
/// an extension slash command reached over ACP **deadlocks the turn** (Pi's
/// `AgentSession.prompt` short-circuits on a registered command before
/// `_runAgentPrompt`, so `agent_end` never fires and pi-acp's `pendingTurn` is
/// never settled). What is left is the prompt text itself: `ryu-plan.ts` strips
/// this token in its `input` hook and transforms the rest, so the token never
/// reaches the model.
///
/// WHY IT LIVES HERE. `sidecar/adapters/` is agent-neutral ACP plumbing; the
/// moment it spells `/plan` inline it has learned which engine is on the other
/// end. Core's composer affordance (the synthesized `ryu.plan` config option)
/// calls this one function instead, so there is exactly one place to change if
/// the extension's grammar ever moves.
///
/// The grammar is `ryu-plan.ts`'s `SENTINEL_LINE_RE` / `SENTINEL_OFF_WORD_RE`:
/// `/plan` enters, `/plan off` (and `/plan-off`) leaves, and anything after the
/// token on that line is kept as the user's task. Callers must place the returned
/// string as its own FIRST LINE of the user-message block — the extension refuses
/// a bare regex-anywhere match precisely so a pasted diff cannot flip the mode.
pub fn plan_mode_sentinel(on: bool) -> &'static str {
    if on {
        "/plan"
    } else {
        "/plan off"
    }
}

// `ryu-subagent.ts`, `ryu-shell.ts` and `ryu-monitor.ts` used to be (or, for
// the monitor, would have been) embedded here and shipped unconditionally by the
// chain above. They now live in their own packages (`plugins-store/plugins/pi-subagent`,
// `plugins-store/plugins/pi-shell`, `plugins-store/plugins/pi-monitor`) as
// `contributes.pi_extensions` rows, and reach the managed Pi dir through
// [`sync_app_pi_extensions`] instead. All three are Core-tier + pre-installed, so
// the out-of-the-box agent is unchanged; what is new is that a user can turn any
// of them off. Do NOT re-add an `ensure_pi_*_extension` for them: the plugin path
// is the one with a removal half, and a compiled-in copy would win the file back
// on the next spawn after a disable.

/// Write `src` to `ext_path` and register that absolute path in the managed
/// `settings.json`'s `extensions` array — the shared body of every Ryu-owned Pi
/// extension.
///
/// Idempotent on both halves: the source is (re)written only when its bytes
/// differ (so an engine update ships the current code without churning the disk
/// on every spawn), and the path is appended only when missing. Unrelated entries
/// a user or another Ryu write put in the array are preserved; a non-array value
/// there is replaced, because Pi would reject it anyway.
fn ship_pi_extension(ext_path: &std::path::Path, src: &str) -> Result<()> {
    if let Some(dir) = ext_path.parent() {
        fs::create_dir_all(dir).context("create Pi extensions dir")?;
    }
    let needs_write = fs::read_to_string(ext_path)
        .map(|existing| existing != src)
        .unwrap_or(true);
    if needs_write {
        fs::write(ext_path, src).with_context(|| format!("write {}", ext_path.display()))?;
    }

    let abs = ext_path.to_string_lossy().into_owned();
    let mut settings = read_settings();
    let entry = settings
        .extra
        .entry("extensions".to_owned())
        .or_insert_with(|| json!([]));
    if !entry.is_array() {
        *entry = json!([]);
    }
    let already = entry
        .as_array()
        .map(|arr| arr.iter().any(|v| v.as_str() == Some(abs.as_str())))
        .unwrap_or(false);
    if !already {
        if let Some(arr) = entry.as_array_mut() {
            arr.push(Value::String(abs));
        }
        write_settings(&settings)?;
    }
    Ok(())
}

/// Materialise the node's resolved language-server table where the Ryu-LSP
/// extension reads it — the flagship `ryu` agent's binding for
/// [`crate::lsp::LspResolution`].
///
/// **An empty resolution DELETES the file rather than writing `{}`.** Disabling
/// the last LSP-contributing plugin has to actually stop the servers, and a stale
/// table left on disk would keep spawning `gopls` on every Pi start with nothing
/// in the UI explaining why. Absent is also the extension's documented no-op
/// state, so "nothing declared" and "never configured" look identical to it.
///
/// Idempotent by content compare, matching [`ship_pi_extension`]: pi-acp spawns a
/// fresh Pi per session, so an unconditional write would touch this file on every
/// chat. That is also why the document carries no generation timestamp.
///
/// Never touches the user's `~/.pi` — [`config_dir`] is Ryu's isolated dir.
pub fn write_lsp_servers_file(resolution: &crate::lsp::LspResolution) -> Result<()> {
    let path = pi_lsp_servers_path();
    if resolution.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err).context("remove stale ryu-lsp.json"),
        }
    } else {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).context("create Pi extensions dir")?;
        }
        let body = serde_json::to_string_pretty(&resolution.to_wire_document())
            .context("serialize ryu-lsp.json")?;
        let unchanged = fs::read_to_string(&path).is_ok_and(|existing| existing == body);
        if !unchanged {
            fs::write(&path, &body).context("write ryu-lsp.json")?;
        }
        Ok(())
    }
}

/// The managed Pi's extensions folder — the single directory every Ryu-owned
/// extension (compiled-in and plugin-contributed alike) is written into, and the
/// one Pi auto-discovers.
fn pi_extensions_dir() -> PathBuf {
    config_dir().join("extensions")
}

/// Project a resolved plugin-extension set onto the managed Pi's `extensions/`
/// folder: write what is enabled, delete what is not, and prune `settings.json` to
/// match.
///
/// The binding half of [`app_extensions`], and the reason enable/disable is ONE
/// reconcile rather than two symmetric hooks: two call sites drift, and the removal
/// half is the one that actually matters. Pi auto-discovers this directory, so an
/// orphaned file from an uninstalled plugin keeps loading forever — the plugin is
/// gone from the Store and its tools are still on the agent.
///
/// Three steps, and the ownership rule that makes them safe:
///
/// 1. **Write-if-different**, matching [`ship_pi_extension`]'s idempotency — this
///    runs on every managed-Pi spawn, so an unchanged node must not churn disk.
/// 2. **Delete every `ext-*.ts` not in the resolution.** Only that prefix
///    ([`app_extensions::APP_EXTENSION_PREFIX`]) is touched, which is what keeps the
///    compiled-in `ryu-*.ts` files and anything a user dropped in by hand out of
///    reach of a resolution that came back empty.
/// 3. **Prune `settings.json`'s `extensions` array** of any `ext-`-prefixed path
///    under this folder that is no longer in the keep-set. [`ship_pi_extension`]
///    only ever appends and whether Pi tolerates a dead absolute path there is
///    unverified, so this is treated as required rather than cosmetic. Every other
///    entry — the `ryu-*` paths, anything a user added — is preserved verbatim.
///
/// Registration is by directory auto-discovery AND by array entry, the same
/// belt-and-suspenders [`ship_pi_extension`] uses (Pi dedups by resolved path).
///
/// Takes effect on the next Pi **process**, not the next turn; see the restart note
/// on [`app_extensions`].
pub fn sync_app_pi_extensions(resolution: &app_extensions::PiExtensionResolution) -> Result<()> {
    let dir = pi_extensions_dir();
    let keep = resolution.file_names();

    // REMOVALS RUN FIRST, AND UNCONDITIONALLY. Adds used to come first and used to
    // `?` on a failed write, which returned before this loop ever ran — so one
    // unwritable extension meant a REVOKED plugin's `ext-*.ts` stayed on disk and
    // kept executing inside Pi. The caller only warns, so that was silent. Removal
    // is the half with a security consequence; a failed add is a feature that does
    // not appear, and it must never be able to hold revocation hostage.
    //
    // A missing directory means there is nothing to remove, so an unreadable
    // read_dir is not an error here.
    let mut removal_error: Option<anyhow::Error> = None;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ours = name.starts_with(app_extensions::APP_EXTENSION_PREFIX)
                && name.ends_with(".ts")
                && !keep.contains(&name);
            if !ours {
                continue;
            }
            if let Err(e) = fs::remove_file(entry.path()) {
                // Keep going: one undeletable file must not strand the others.
                tracing::error!("pi extensions: could not remove revoked {name}: {e}");
                removal_error.get_or_insert_with(|| anyhow::anyhow!("remove stale {name}: {e}"));
            }
        }
    }

    if !resolution.extensions.is_empty() {
        fs::create_dir_all(&dir).context("create Pi extensions dir")?;
    }
    // Adds are best-effort per file for the same reason: one failure should not
    // abort the rest of the reconcile, and must not skip the registration prune
    // below, which is the other half of revocation.
    let mut write_error: Option<anyhow::Error> = None;
    for ext in &resolution.extensions {
        let path = dir.join(&ext.file_name);
        let needs_write = fs::read_to_string(&path)
            .map(|existing| existing != ext.source)
            .unwrap_or(true);
        if !needs_write {
            continue;
        }
        if let Err(e) = fs::write(&path, &ext.source) {
            tracing::error!("pi extensions: could not write {}: {e}", path.display());
            write_error.get_or_insert_with(|| anyhow::anyhow!("write {}: {e}", path.display()));
        }
    }

    let prune = prune_app_extension_registrations(&dir, &keep);

    // Surface a revocation failure ahead of an add failure: the caller logs one
    // error, and "a revoked extension is still on disk" is the one worth reading.
    if let Some(e) = removal_error {
        return Err(e);
    }
    prune?;
    if let Some(e) = write_error {
        return Err(e);
    }
    Ok(())
}

/// Drop `settings.json` `extensions` entries that name an `ext-*.ts` under `dir`
/// which the current resolution no longer owns, and append the ones it does.
///
/// Split out from [`sync_app_pi_extensions`] so the array surgery — the part that
/// must not touch a user's own entry — reads as one rule in one place.
fn prune_app_extension_registrations(
    dir: &std::path::Path,
    keep: &std::collections::HashSet<String>,
) -> Result<()> {
    let mut settings = read_settings();
    let entry = settings
        .extra
        .entry("extensions".to_owned())
        .or_insert_with(|| json!([]));
    if !entry.is_array() {
        *entry = json!([]);
    }
    let Some(arr) = entry.as_array_mut() else {
        return Ok(());
    };

    let before = arr.len();
    arr.retain(|value| {
        let Some(path) = value.as_str() else {
            return true;
        };
        let candidate = std::path::Path::new(path);
        // Only ever judge a path that lives in OUR folder and carries OUR prefix.
        // Anything else — a user's own extension, a `ryu-*.ts` — is not ours to
        // remove, whatever the resolution says.
        let Some(name) = candidate
            .parent()
            .filter(|parent| *parent == dir)
            .and_then(|_| candidate.file_name())
            .map(|n| n.to_string_lossy().into_owned())
        else {
            return true;
        };
        if !name.starts_with(app_extensions::APP_EXTENSION_PREFIX) {
            return true;
        }
        keep.contains(&name)
    });

    let existing: std::collections::HashSet<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let mut added = 0;
    let mut names: Vec<&String> = keep.iter().collect();
    names.sort();
    for name in names {
        let abs = dir.join(name).to_string_lossy().into_owned();
        if !existing.contains(&abs) {
            arr.push(Value::String(abs));
            added += 1;
        }
    }

    if arr.len() != before || added > 0 {
        write_settings(&settings)?;
    }
    Ok(())
}

/// Persist a composer-picked model for the managed Pi (QA finding B2).
///
/// pi-acp reports models as `"<provider>/<model-id>"` (split at the FIRST `/`,
/// mirroring pi-acp's own `setSessionModel` parsing); a bare id is treated as a
/// model on the current provider. A write here happens before the turn's ACP
/// session is built, so it takes effect on the very turn that carried the pick and
/// becomes Pi's `defaultModel` for every later session.
///
/// (This used to say "a fresh Pi RPC process per `session/new` — one per chat
/// turn". That stopped being true when the ACP session moved to being built ONCE
/// per pooled instance — see `acp::run_acp_instance` — and the pool is keyed on
/// `(conversation, agent, spawn_cmd, cwd)`. The write is still applied per turn;
/// only the process cadence changed.)
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

// ── Sidecar-declared providers (auth bridges) ─────────────────────────────────

/// Register a plugin sidecar's OpenAI-compatible endpoint as a selectable provider.
///
/// Called by the sidecar supervisor once the process reports healthy, driven by the
/// sidecar's `provides_provider` manifest declaration. A sidecar cannot do this for
/// itself: it holds only `RYU_EXT_TOKEN` (scoped to the ext-proxy hop and
/// `/api/host/*`) and the host-RPC vocabulary has no provider-registration method.
///
/// Refuses, rather than merges, when:
/// - the id is not a safe token (path separators / case tricks that could shadow a
///   built-in under a different normalization), or
/// - the id names a **built-in** provider or the managed/gateway pair, or
/// - the id names an existing entry owned by someone else (a hand-configured provider
///   or another plugin).
///
/// That last pair is the load-bearing guard. `baseUrl` is where inference traffic —
/// carrying the user's live credential — is sent, so letting a plugin overwrite
/// `openai-codex` or a user's own entry would hand it that traffic. See
/// [`ProviderRegistrationSpec`] for the full rationale.
/// `api_key` is the sidecar's minted `RYU_EXT_TOKEN`. It is written into the entry so
/// Pi — which reads `models.json` and calls `baseUrl` **directly**, bypassing Core's
/// ext-proxy — presents the bearer the extension-host bootstrap demands. Without it
/// every inference request is refused 401 by the bootstrap's `authorized()` gate, since
/// loopback is deliberately not treated as authentication.
pub fn register_sidecar_provider(
    plugin_id: &str,
    spec: &ProviderRegistrationSpec,
    port: u16,
    api_key: Option<&str>,
) -> Result<()> {
    let id = spec.id.trim();
    if !ProviderRegistrationSpec::id_is_safe(id) {
        anyhow::bail!(
            "provider id '{id}' is not a safe token (lowercase alphanumerics, '-', '_', max 64)"
        );
    }
    if provider_meta(id).is_some() || is_managed_or_gateway(id) {
        anyhow::bail!(
            "plugin '{plugin_id}' may not register provider '{id}': it collides with a built-in \
             provider; a plugin overriding a built-in could redirect subscription traffic"
        );
    }
    if let Some(owner) = provider_owner(id) {
        if owner != plugin_id {
            anyhow::bail!(
                "plugin '{plugin_id}' may not register provider '{id}': already owned by \
                 '{owner}'"
            );
        }
    } else if custom_provider_ids().iter().any(|existing| existing == id) {
        anyhow::bail!(
            "plugin '{plugin_id}' may not register provider '{id}': an unowned provider with \
             that id already exists (configured by hand?)"
        );
    }

    let mut patch = Map::new();
    patch.insert("baseUrl".to_owned(), Value::String(spec.base_url(port)));
    patch.insert(
        "api".to_owned(),
        Value::String(spec.effective_api().to_owned()),
    );
    patch.insert(
        PROVIDER_OWNER_FIELD.to_owned(),
        Value::String(plugin_id.to_owned()),
    );
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        // models.json is written with `write_secret_file`, so this rides with the same
        // protection as any other provider credential.
        patch.insert("apiKey".to_owned(), Value::String(key.to_owned()));
    }
    if let Some(label) = spec.label.as_deref().filter(|s| !s.trim().is_empty()) {
        patch.insert("label".to_owned(), Value::String(label.to_owned()));
    }
    if !spec.models.is_empty() {
        patch.insert(
            "models".to_owned(),
            Value::Array(
                spec.models
                    .iter()
                    .map(|m| json!({ "id": m }))
                    .collect::<Vec<_>>(),
            ),
        );
    }
    upsert_provider(id, patch)
}

/// Remove a provider previously registered by `plugin_id`. Called when the plugin is
/// disabled or uninstalled, so a dead loopback port is never left selectable.
///
/// A no-op unless the entry is stamped as owned by this plugin, so a plugin can never
/// delete a hand-configured provider or one owned by another plugin. Returns whether
/// an entry was actually removed.
pub fn deregister_sidecar_provider(plugin_id: &str, provider_id: &str) -> Result<bool> {
    let id = provider_id.trim();
    if id.is_empty() {
        return Ok(false);
    }
    match provider_owner(id) {
        Some(owner) if owner == plugin_id => {
            remove_provider(id)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Drop EVERY sidecar-registered provider entry (anything carrying
/// [`PROVIDER_OWNER_FIELD`]) from `models.json`. Returns how many were removed.
///
/// Called once at Core boot, before the sidecar reconcile pass, unconditionally.
///
/// **Why unconditional.** [`deregister_sidecar_provider`] runs only from a sidecar's
/// own `stop()` and from the crash hook the health monitor fires when it catches that
/// sidecar's child dead (`ManifestSidecar::on_crash_detected`) — both of which need a
/// live Core to run at all. So an unclean Core exit — SIGKILL, panic, OOM, power loss — leaves
/// `{ baseUrl: "http://127.0.0.1:<port>", apiKey: "<that plugin's ext token>" }`
/// persisted. Pi reads `models.json` and dials `baseUrl` **directly**, bypassing the
/// ext-proxy and every gate that guards it, so on the next boot — if any other process
/// now holds that port — Pi hands a stranger the plugin's minted token plus every
/// inference request body. Same class as the ext-proxy hole this sits next to: a
/// persisted port outliving the process that owned it. The proxy's registration gate
/// cannot fix it, because Pi never goes through the proxy.
///
/// Purging is safe, not merely tolerable: re-registration is automatic (a
/// `ManifestSidecar` is reconstructed at boot with `provider_registered = false`, so the
/// first Healthy edge rewrites the entry), and the purge window is exactly the
/// "not healthy yet" state the entry is supposed to represent. Unowned entries — a
/// hand-configured Ollama/vLLM provider — and the built-ins are untouched, which is the
/// same ownership rule [`deregister_sidecar_provider`] enforces.
///
/// Removes the entry directly rather than routing through [`remove_provider`]: this is
/// a boot-time sweep of many entries and `remove_provider` also rewrites settings
/// (active provider / routing) per call. The active selection is left alone on purpose —
/// re-registration restores the entry moments later, and silently repointing the user's
/// active provider at the gateway on every unclean restart would be the louder bug.
pub fn purge_sidecar_providers() -> Result<usize> {
    let mut models = read_models();
    let Some(providers) = models["providers"].as_object_mut() else {
        return Ok(0);
    };
    let owned: Vec<String> = providers
        .iter()
        .filter(|(_, entry)| entry.get(PROVIDER_OWNER_FIELD).is_some())
        .map(|(id, _)| id.clone())
        .collect();
    if owned.is_empty() {
        return Ok(0);
    }
    for id in &owned {
        providers.remove(id);
    }
    tracing::info!(
        "pi_config: purged {} stale sidecar-registered provider(s) at boot: {}",
        owned.len(),
        owned.join(", ")
    );
    write_models(&models)?;
    Ok(owned.len())
}

/// The plugin id stamped on a custom provider entry, if it was sidecar-registered.
fn provider_owner(id: &str) -> Option<String> {
    read_models()["providers"]
        .get(id)?
        .get(PROVIDER_OWNER_FIELD)?
        .as_str()
        .map(str::to_owned)
}

/// The `models.json` key prefix under which an AGENT's per-model visibility
/// overrides are stored (`agent:claude` → the `claude` agent's toggles).
///
/// An external agent (Claude Code, Codex, …) advertises its own model list over
/// ACP; it is not a Pi provider and has no credential, base URL or routing. But
/// the ONE thing the user wants for it is exactly what a provider already has —
/// a per-model on/off flag — and [`set_model_enabled`] is already a generic
/// `{provider, model, enabled}` writer. So agent overrides reuse that store under
/// a reserved namespace rather than growing a second one.
///
/// The namespace is load-bearing in one direction: [`custom_provider_ids`] must
/// EXCLUDE these keys, or every toggled agent would surface in the catalog as a
/// user-added custom provider (an unconfigured "agent:claude" row in the picker
/// and the providers tab) and would be accepted as a routing target.
pub const AGENT_OVERRIDE_PREFIX: &str = "agent:";

/// The user-added provider ids in `models.json`, excluding the reserved
/// [`AGENT_OVERRIDE_PREFIX`] keys (which are agent model-visibility scopes, not
/// providers).
fn custom_provider_ids() -> Vec<String> {
    read_models()["providers"]
        .as_object()
        .map(|m| {
            m.keys()
                .filter(|k| !k.starts_with(AGENT_OVERRIDE_PREFIX))
                .cloned()
                .collect()
        })
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
/// with `0600` permissions on Unix to match Pi's own convention. Also records
/// the key as an account in the sealed vault, so the provider can hold several
/// keys side by side and switch between them.
fn set_auth_key(auth_key: &str, key: &str) -> Result<()> {
    ensure_dir()?;
    let mut auth = read_auth();
    auth.insert(
        auth_key.to_owned(),
        json!({ "type": "api_key", "key": key }),
    );
    let body = serde_json::to_string_pretty(&auth).context("serialize auth.json")?;
    write_secret_file(&auth_path(), &body)?;
    vault_upsert_credential(
        &accounts::provider_scope(auth_key),
        "API key",
        accounts::KIND_API_KEY,
        json!({ "type": "api_key", "key": key }),
    );
    Ok(())
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

// ── Sealed account vault (multi-account, the system locker) ───────────────────
//
// `auth.json` / `models.json` hold the ACTIVE credential per provider, in Pi's
// native shape, so Pi's reading path never changes. The master-key-sealed vault
// (`~/.ryu/pi-accounts.db`, see [`accounts`]) is the multi-account store: every
// credential is sealed there, and the active one is *materialized* into Pi's
// files. Writes here never fail the primary file write when the vault has not
// been published (early boot / unit tests) — the credential still lands in the
// active slot, it just is not yet part of the multi-account vault.

/// Run `f` with the process-global account vault. Errors when it has not been
/// published yet, so account-management routes fail loudly rather than silently
/// pretending nothing exists.
pub(crate) fn with_account_vault<T>(
    f: impl FnOnce(&accounts::AccountVault) -> Result<T>,
) -> Result<T> {
    let vault = accounts::global()
        .ok_or_else(|| anyhow::anyhow!("the pi-accounts vault is not initialized"))?;
    f(vault)
}

/// A unique, human-friendly label for a new account in `scope`, disambiguating
/// a repeat login (the second ChatGPT login is "ChatGPT · 2").
fn vault_account_label(vault: &accounts::AccountVault, scope: &str, base: &str) -> String {
    let existing: std::collections::HashSet<String> = vault
        .list(scope)
        .map(|rows| rows.into_iter().map(|r| r.label).collect())
        .unwrap_or_default();
    if !existing.contains(base) {
        return base.to_owned();
    }
    let mut n = 2;
    while existing.contains(&format!("{base} · {n}")) {
        n += 1;
    }
    format!("{base} · {n}")
}

/// Best-effort vault write: store `credential` as a NEW account in `scope` and
/// make it active. Never fails the primary write when the vault is unavailable —
/// the credential still lands in the active slot. `label` is the base display
/// name; duplicates get a " · N" suffix.
fn vault_upsert_credential(scope: &str, base_label: &str, kind: &str, credential: Value) {
    let Some(vault) = accounts::global() else {
        return;
    };
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let label = vault_account_label(vault, scope, base_label);
    if let Err(e) = vault.upsert(scope, &account_id, &label, kind, Some(credential)) {
        tracing::warn!(
            scope,
            error = %e,
            "account vault write failed (credential kept in the active slot only)"
        );
    }
}

/// Sealed-vault fallback for "does `scope` have any usable credential". The
/// vault is additive to `auth.json`, so a provider that was configured before
/// the vault existed — or whose active slot was cleared without removing its
/// accounts — still reads as configured off the vault alone.
fn vault_has_any(scope: &str) -> bool {
    match accounts::global() {
        Some(vault) => vault
            .list(scope)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false),
        None => false,
    }
}

/// Migrate credentials already sitting in Pi's plaintext files (`auth.json`
/// api-key + oauth entries, `models.json` custom-provider `apiKey`s) into the
/// sealed vault, one account per slot, active. Idempotent: a slot the vault
/// already holds is left alone, so re-running after a partial failure only
/// imports what is missing. Called at boot and before materialization.
pub(crate) fn sync_plaintext_into_vault() {
    let Some(vault) = accounts::global() else {
        return;
    };
    for (auth_key, entry) in read_auth() {
        let Some(credential) = usable_credential(&entry) else {
            continue;
        };
        let scope = accounts::provider_scope(&auth_key);
        let already = vault.count(&scope).unwrap_or(0) > 0;
        if already {
            continue;
        }
        let base = match credential.get("type").and_then(Value::as_str) {
            Some("oauth") => "Login",
            _ => "API key",
        };
        if let Err(e) = vault.upsert(
            &scope,
            &new_account_id(),
            base,
            credential_kind(&entry),
            Some(credential),
        ) {
            tracing::warn!(scope, error = %e, "could not import legacy credential into the account vault");
        }
    }
    // Custom-provider apiKeys in models.json.
    let models = read_models();
    if let Some(providers) = models["providers"].as_object() {
        for (id, provider) in providers {
            let Some(key) = provider
                .get("apiKey")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let scope = accounts::provider_scope(id);
            if vault.count(&scope).unwrap_or(0) > 0 {
                continue;
            }
            if let Err(e) = vault.upsert(
                &scope,
                &new_account_id(),
                "API key",
                accounts::KIND_API_KEY,
                Some(Value::String(key.to_owned())),
            ) {
                tracing::warn!(scope, error = %e, "could not import custom-provider key into the account vault");
            }
        }
    }
}

fn new_account_id() -> String {
    format!("acct_{}", uuid::Uuid::new_v4().simple())
}

/// Extract a credential object worth vaulting from an `auth.json` entry — the
/// api-key shape (`{type:"api_key", key}`) or the oauth shape (any usable
/// `access`/`refresh`). Returns `None` for empty/degenerate entries.
fn usable_credential(entry: &Value) -> Option<Value> {
    if entry
        .get("key")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return Some(entry.clone());
    }
    let has_token = ["access", "refresh"].iter().any(|f| {
        entry
            .get(*f)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    });
    has_token.then(|| entry.clone())
}

/// Classify an `auth.json` entry for the vault `kind` column.
fn credential_kind(entry: &Value) -> &'static str {
    match entry.get("type").and_then(Value::as_str) {
        Some("oauth") => accounts::KIND_OAUTH,
        _ => accounts::KIND_API_KEY,
    }
}

/// Materialize every provider scope's ACTIVE account into Pi's `auth.json` /
/// `models.json`, so the files Pi reads on spawn always carry the selected
/// account. A scope whose active account was removed has its slot cleared,
/// rather than leaving a stale credential Pi would silently use. Call this at
/// spawn (`ensure_managed_defaults`) and after any account switch.
pub(crate) fn materialize_active_accounts() {
    // Import first so a fresh install's plaintext files seed the vault before it
    // is the source of truth for what goes back into them.
    sync_plaintext_into_vault();
    let Some(vault) = accounts::global() else {
        return;
    };
    let Ok(scopes) = vault.scopes() else {
        return;
    };
    let mut auth = read_auth();
    let mut models = read_models();
    let mut auth_dirty = false;
    let mut models_dirty = false;
    for scope in scopes {
        if !accounts::is_provider_scope(&scope) {
            continue;
        }
        let auth_key = accounts::scope_key(&scope);
        match vault.active_credential(&scope) {
            Ok(Some((_account_id, credential))) => {
                // Custom-provider scopes store a bare key string; everything else
                // stores the Pi entry object verbatim.
                if let Some(key) = credential.as_str() {
                    if let Some(providers) = models["providers"].as_object_mut() {
                        if let Some(entry) = providers.get_mut(auth_key) {
                            if let Some(obj) = entry.as_object_mut() {
                                obj.insert("apiKey".to_owned(), Value::String(key.to_owned()));
                                models_dirty = true;
                            }
                        }
                    }
                } else {
                    auth.insert(auth_key.to_owned(), credential);
                    auth_dirty = true;
                }
            }
            Ok(None) => {
                // No active account for the scope → clear its Pi slot.
                if auth.remove(auth_key).is_some() {
                    auth_dirty = true;
                }
            }
            Err(e) => {
                tracing::warn!(scope, error = %e, "materialize: could not read active account credential");
            }
        }
    }
    if auth_dirty {
        if let Err(e) = write_secret_file(
            &auth_path(),
            &serde_json::to_string_pretty(&auth).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "materialize: could not write auth.json");
        }
    }
    if models_dirty {
        if let Err(e) = write_models(&models) {
            tracing::warn!(error = %e, "materialize: could not write models.json");
        }
    }
}

// ── OAuth subscription token refresh ──────────────────────────────────────────

/// Seconds of skew before an access token's `expires_at` at which we proactively
/// refresh. A turn that starts inside this window would likely 401 partway
/// through, so we mint a fresh token first.
const OAUTH_REFRESH_SKEW_SECS: u64 = 60;

/// Static OAuth-refresh parameters for a subscription provider the managed Pi can
/// log into (`type:"oauth"` in `auth.json`).
///
/// **Provenance / trust (read before touching these values).** Pi does not vendor
/// its own login source into this repo, so the endpoints + client ids below could
/// NOT be verified against an in-repo file. They are the *public* PKCE client
/// identifiers the underlying CLIs (Claude Code, Codex) use for subscription login
/// — public, non-secret values (a PKCE public client carries no client secret, so
/// nothing secret is hardcoded here). Two things bound the blast radius of a stale
/// value: (1) both token endpoints live on the vendor's own first-party domain
/// (`console.anthropic.com` / `auth.openai.com`) — the same origins Ryu already
/// talks to for subscription usage (the `ryu_usage` crate) — so a wrong
/// value fails the refresh loudly instead of leaking the refresh token to a third
/// party; and (2) a *failed* refresh does not consume the (single-use) refresh
/// token, so a wrong id degrades to a no-op, never a logout. Every field is
/// overridable at runtime (the "nothing hardcoded" knob) via the env vars named
/// below, so a rotated id/endpoint is corrected without a rebuild.
struct OAuthProvider {
    /// The `auth.json` key whose oauth entry this refreshes.
    auth_key: &'static str,
    /// OAuth 2.0 token endpoint (RFC 6749 §6, `grant_type=refresh_token`).
    token_url: &'static str,
    /// Public PKCE client id.
    client_id: &'static str,
    /// `scope` to echo on refresh when the provider requires it (`""` = omit).
    scope: &'static str,
    /// Env var overriding `token_url` (nothing hardcoded).
    token_url_env: &'static str,
    /// Env var overriding `client_id`.
    client_id_env: &'static str,
}

/// The subscription providers whose Pi oauth login Ryu can refresh. See
/// [`OAuthProvider`] for the trust/provenance rationale behind these constants.
const OAUTH_PROVIDERS: &[OAuthProvider] = &[
    // Claude Pro/Max — stored under the `anthropic` auth key (see `PROVIDERS`).
    OAuthProvider {
        auth_key: "anthropic",
        token_url: "https://console.anthropic.com/v1/oauth/token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        scope: "",
        token_url_env: "RYU_PI_OAUTH_ANTHROPIC_TOKEN_URL",
        client_id_env: "RYU_PI_OAUTH_ANTHROPIC_CLIENT_ID",
    },
    // ChatGPT / Codex subscription — Pi's codex login stores it under `openai-codex`;
    // the plain `openai` key is listed too so an oauth login persisted there also
    // refreshes. Both use the same public Codex PKCE client.
    OAuthProvider {
        auth_key: "openai-codex",
        token_url: "https://auth.openai.com/oauth/token",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        scope: "openid profile email",
        token_url_env: "RYU_PI_OAUTH_OPENAI_TOKEN_URL",
        client_id_env: "RYU_PI_OAUTH_OPENAI_CLIENT_ID",
    },
    OAuthProvider {
        auth_key: "openai",
        token_url: "https://auth.openai.com/oauth/token",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        scope: "openid profile email",
        token_url_env: "RYU_PI_OAUTH_OPENAI_TOKEN_URL",
        client_id_env: "RYU_PI_OAUTH_OPENAI_CLIENT_ID",
    },
    // TODO(github-copilot): Copilot's credential is a bespoke GitHub device →
    // Copilot-token exchange, NOT a plain OAuth refresh grant, and no authoritative
    // endpoint/client is vendored in-repo to verify against — so it is deliberately
    // left unwired (`refresh_oauth` warns + returns `Ok(false)`) rather than guessed.
];

fn oauth_provider(auth_key: &str) -> Option<&'static OAuthProvider> {
    OAUTH_PROVIDERS.iter().find(|p| p.auth_key == auth_key)
}

/// Current unix time in whole seconds. This is real runtime Rust (not a workflow
/// script), so `SystemTime` is the correct clock.
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read an oauth entry's expiry as unix *seconds*. Prefers `expires_at` (seconds —
/// the shape this module writes back); tolerates `expires` in milliseconds (the
/// opencode/Pi on-disk convention) so a token Pi itself wrote is not needlessly
/// re-refreshed every turn. Values in the millisecond range (≫ a plausible seconds
/// timestamp) are divided down.
fn oauth_expires_at(entry: &Value) -> Option<u64> {
    if let Some(secs) = entry.get("expires_at").and_then(Value::as_u64) {
        return Some(secs);
    }
    entry.get("expires").and_then(Value::as_u64).map(|v| {
        // ~1e11 cleanly separates seconds (now ≈ 1.7e9) from milliseconds (≈ 1.7e12).
        if v > 100_000_000_000 {
            v / 1000
        } else {
            v
        }
    })
}

/// Whether an oauth entry's access token is expired or close enough to expiry
/// (within [`OAUTH_REFRESH_SKEW_SECS`]) to warrant a refresh now. A missing expiry
/// is treated as expired (refresh), per the fail-safe default.
fn oauth_needs_refresh(entry: &Value) -> bool {
    match oauth_expires_at(entry) {
        Some(expires_at) => expires_at <= now_unix().saturating_add(OAUTH_REFRESH_SKEW_SECS),
        None => true,
    }
}

/// Merge a refreshed `{access, refresh?, expires_at}` back into the provider's
/// oauth entry and persist the whole `auth.json` (`0600` on Unix), leaving every
/// other field (`type`, account id, scopes, …) intact — mirroring
/// [`clear_auth_key`]'s read-modify-write of the same file. The refreshed entry
/// is also written back into the sealed vault's active account, so the vault
/// copy never goes stale.
fn persist_oauth_refresh(
    auth_key: &str,
    access: &str,
    refresh: Option<&str>,
    expires_at: Option<u64>,
) -> Result<()> {
    ensure_dir()?;
    let mut auth = read_auth();
    let entry = auth
        .entry(auth_key.to_owned())
        .or_insert_with(|| json!({ "type": "oauth" }));
    let obj = entry
        .as_object_mut()
        .context("refresh_oauth: stored auth entry is not a JSON object")?;
    obj.insert("access".to_owned(), Value::String(access.to_owned()));
    if let Some(refresh) = refresh {
        obj.insert("refresh".to_owned(), Value::String(refresh.to_owned()));
    }
    if let Some(expires_at) = expires_at {
        obj.insert("expires_at".to_owned(), json!(expires_at));
    }
    drop(obj);
    let refreshed_entry = entry.clone();
    let kind = credential_kind(&refreshed_entry);
    let body = serde_json::to_string_pretty(&auth).context("serialize auth.json")?;
    write_secret_file(&auth_path(), &body)?;
    // Keep the vault's active copy fresh so switching away and back does not
    // resurrect an expired token.
    if let Some(vault) = accounts::global() {
        let scope = accounts::provider_scope(auth_key);
        if let Ok(Some(info)) = vault.active_info(&scope) {
            if let Err(e) = vault.upsert(
                &scope,
                &info.account_id,
                &info.label,
                kind,
                Some(refreshed_entry),
            ) {
                tracing::warn!(
                    auth_key,
                    error = %e,
                    "could not sync refreshed tokens into the account vault"
                );
            }
        }
    }
    Ok(())
}

/// Refresh the OAuth access token for a Pi subscription login stored in
/// `auth.json`, if one exists and is at/near expiry. Returns `Ok(true)` when a new
/// access token was minted and persisted, `Ok(false)` when nothing needed doing
/// (not an oauth entry, still fresh, or the provider has no known refresh flow).
///
/// This targets the managed Pi's OWN isolated `auth.json` (`~/.ryu/pi-agent`),
/// NEVER the user's `~/.claude` / `~/.codex`. That distinction is what makes
/// refreshing safe here: unlike the read-only usage feature (the `ryu_usage` crate, which
/// must not refresh a shared, single-use CLI token or it would log the real CLI
/// out with `refresh_token_reused`), rotating a token in Ryu's private copy only
/// affects this copy. pi-acp also spawns a fresh Pi process per `session/new` (one
/// per turn), so a refresh made just before the turn lands before any Pi process
/// holds the token — no double-refresh race with Pi's own client.
pub async fn refresh_oauth(auth_key: &str) -> Result<bool> {
    let Some(entry) = read_auth().get(auth_key).cloned() else {
        return Ok(false);
    };
    // Only oauth entries carry a refresh token; api-key entries never expire.
    let Some(refresh) = entry
        .get("refresh")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(false);
    };
    if !oauth_needs_refresh(&entry) {
        return Ok(false);
    }

    let Some(provider) = oauth_provider(auth_key) else {
        tracing::warn!(
            auth_key,
            "refresh_oauth: no known OAuth refresh flow for this provider — skipping (TODO: wire it)"
        );
        return Ok(false);
    };

    // Resolve endpoint + client id, honoring the env overrides (nothing hardcoded).
    let token_url = std::env::var(provider.token_url_env)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| provider.token_url.to_owned());
    let client_id = std::env::var(provider.client_id_env)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| provider.client_id.to_owned());

    // OAuth 2.0 refresh grant (RFC 6749 §6), sent as JSON — the body shape both the
    // Claude and Codex token endpoints accept.
    let mut body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": client_id,
    });
    if !provider.scope.is_empty() {
        body["scope"] = Value::String(provider.scope.to_owned());
    }

    let resp = reqwest::Client::new()
        .post(&token_url)
        .timeout(std::time::Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .with_context(|| format!("refresh_oauth: POST {token_url}"))?;
    let status = resp.status();
    if !status.is_success() {
        // A failed refresh does NOT consume the single-use refresh token, so the
        // stored credential is left untouched and Pi can still refresh on its own.
        let detail = resp.text().await.unwrap_or_default();
        anyhow::bail!("refresh_oauth: {auth_key} token endpoint returned {status}: {detail}");
    }
    let tokens: Value = resp
        .json()
        .await
        .context("refresh_oauth: parse token response")?;

    let Some(access) = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        anyhow::bail!("refresh_oauth: {auth_key} token response carried no access_token");
    };
    // Providers MAY rotate the refresh token; keep the existing one if they didn't.
    let rotated_refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let expires_at = tokens
        .get("expires_in")
        .and_then(Value::as_u64)
        .map(|secs| now_unix().saturating_add(secs));

    persist_oauth_refresh(auth_key, access, rotated_refresh, expires_at)?;
    tracing::info!(
        auth_key,
        "refresh_oauth: minted a fresh subscription access token"
    );
    Ok(true)
}

/// Best-effort proactive refresh of every subscription OAuth login the managed Pi
/// might use this turn. Called just before a Ryu/Pi ACP turn is sent (see
/// `acp::run_acp_instance`) so a long-running / long-idle chat whose access token
/// expired since the previous turn gets a fresh one before Pi makes its first model
/// call. NEVER fails the turn: each provider is refreshed independently and errors
/// are logged, not propagated. The common case is cheap — a provider with no oauth
/// entry, or a still-fresh token, returns after a single `auth.json` read with no
/// network call.
pub async fn refresh_pi_oauth_logins() {
    for provider in OAUTH_PROVIDERS {
        if let Err(e) = refresh_oauth(provider.auth_key).await {
            tracing::warn!(
                auth_key = provider.auth_key,
                error = %e,
                "refresh_pi_oauth_logins: refresh failed (continuing)"
            );
        }
    }
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
    /// The `CreditPoolId` this row's traffic attributes to at the Gateway, or
    /// `""` for a BYOK provider.
    ///
    /// Non-empty ⇒ MANAGED: Ryu-supplied capacity, no BYOK, always Gateway-routed.
    /// "Managed" used to be an id equality against a single constant, which is why
    /// there could only ever be one managed provider; it is a property of the row
    /// now, so adding supply is one entry rather than an edit at every branch that
    /// asked the question.
    ///
    /// The string must match an id in `packages/auth/src/lib/credit-pools.ts`
    /// (mirrored for the Gateway at `apps/gateway/src/credit_pools.rs`). Core does
    /// NOT carry a third copy of that catalog — it needs one id per row, not the
    /// table. A near-miss is silent in the worst way: the Gateway attributes the
    /// spend to no pool, so the grant it was supposed to draw is never touched.
    pub credit_pool: &'static str,
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
        // Retail pass-through supply — the residual pool, with no donated
        // allowance behind it. `visible: false` in the pool catalog, which is why
        // this row keeps its own label rather than borrowing the pool's ("Ryu").
        credit_pool: "openrouter",
        suggested_models: &[
            OPENROUTER_AUTO_MODEL_ID,
            OPENROUTER_PARETO_CODE_MODEL_ID,
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
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    // ── Pool-backed managed supply ────────────────────────────────────────────
    //
    // Ryu runs on donated provider credit, segregated into pools so a $50 grant of
    // cheap open-model capacity cannot be spent on expensive frontier capacity.
    // A grant is restricted to its own pool, and the Gateway attributes a request
    // to a pool from the provider that actually served it.
    //
    // Until these rows existed, the ONLY managed entry was `managed-openrouter`,
    // whose default `openrouter/auto` routes to the `openrouter` provider and
    // therefore attributes to the retail pool. A user holding only "Ryu Fast"
    // credit has no budget under that key and `unrestricted` of zero, so the
    // Gateway's pre-flight gate refused the turn with a 402 — on a wallet showing
    // a positive balance. The credits were not merely unspent; they were
    // unspendable through the UI.
    //
    // WHAT SELECTS A POOL IS THE MODEL ID, not this row. Every Gateway-routed
    // provider writes the same `defaultProvider: "openai"` pin and the same
    // managed-fleet patch, so Core cannot pin a provider — the Gateway's router
    // matches the model id's PREFIX (`crates/gateway/router/src/lib.rs`). These
    // rows exist to put routable ids in front of the user and to name the supply
    // in the user's own words; `suggested_models` is therefore not a garnish, it
    // is the entire list the picker will show (`models_url` is empty and a pool
    // row is deliberately excluded from Gateway discovery, which would merge in
    // every other provider's models and offer ids that debit the wrong pool).
    //
    // THERE ARE NO "Ryu Vision" / "Ryu Reasoning" ROWS, and adding them here is a
    // money bug, not a feature. The router ships no builtin prefix for `vertex` or
    // `openai-credits` — deliberately, because `google/gemini-*` is a live
    // OpenRouter id and claiming that prefix would break working traffic. Their
    // ids would fall through to `default_provider` and debit the wrong pool. Those
    // two need an operator `routing.model_map` on the managed fleet first, which
    // is fleet configuration, not a change here.
    ProviderMeta {
        id: MANAGED_CLOUDFLARE_ID,
        // Byte-for-byte `CREDIT_POOLS.cloudflare.label`: the composer reads the
        // pool catalog for its own label, and Settings renders THIS string raw, so
        // a divergence shows the same supply under two names.
        label: "Ryu Fast",
        api: "openai-completions",
        auth_key: "",
        auth_env: "",
        // Not "subscription": there is no login and no BYOK. Free-tier and
        // referral grants land in this pool, so a user can hold it with no plan at
        // all — and `provider_configured` treats "none" as always usable.
        auth_kind: "none",
        credit_pool: "cloudflare",
        // Every id here is asserted routable to `cloudflare` by the router's own
        // tests. Do not add one without adding it there.
        suggested_models: &[
            "@cf/meta/llama-3.1-8b-instruct",
            "@cf/mistral/mistral-7b-instruct-v0.2",
            "@cf/qwen/qwen1.5-14b-chat-awq",
        ],
        models_url: "",
    },
    ProviderMeta {
        id: MANAGED_BEDROCK_ID,
        label: "Ryu Frontier",
        api: "openai-completions",
        auth_key: "",
        auth_env: "",
        auth_kind: "none",
        credit_pool: "bedrock",
        // `anthropic.` / `amazon.` / `meta.` / `mistral.` are the routable
        // prefixes. NOT `cohere.` / `ai21.` / `writer.` / `deepseek.`, which the
        // router leaves unclaimed, and NOT the `us.` / `eu.` / `apac.`
        // inference-profile forms.
        suggested_models: &[
            "anthropic.claude-3-5-sonnet-20241022-v2:0",
            "amazon.nova-pro-v1:0",
            "meta.llama3-1-70b-instruct-v1:0",
        ],
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
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
        credit_pool: "",
        suggested_models: &[
            OPENROUTER_AUTO_MODEL_ID,
            OPENROUTER_PARETO_CODE_MODEL_ID,
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
    // "none" (gateway, and the pool-backed managed rows) needs no credential. A
    // managed provider is gated server-side by the wallet — a plan's credits or a
    // pool-restricted grant — so it is always usable from here.
    if meta.auth_kind == "none" || is_managed(meta.id) {
        return true;
    }
    // Login-based subscription providers (ChatGPT/Claude/Copilot): "configured" =
    // Pi has a stored OAuth login for them (auth.json `{type:"oauth", …}`), or
    // the sealed vault holds an account.
    if meta.auth_kind == "subscription" {
        return !meta.auth_key.is_empty()
            && (auth_has_any(meta.auth_key)
                || vault_has_any(&accounts::provider_scope(meta.auth_key)));
    }
    if !meta.auth_key.is_empty()
        && (auth_has_key(meta.auth_key) || vault_has_any(&accounts::provider_scope(meta.auth_key)))
    {
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

/// Whether a *subscription* provider (ChatGPT / Claude / Copilot) currently has a
/// login stored in Pi's `auth.json`. `None` when `provider_id` is not a known
/// subscription provider — i.e. there is no ground truth to check.
///
/// This is the observable an ACP `authenticate` call must be judged against. The
/// RPC returning `Ok` proves only that the agent subprocess did not error; Pi's
/// `pi_terminal_login` method, for one, answers success immediately without doing
/// any login at all. `auth.json` gaining a credential is what "logged in" means,
/// so the authenticate route re-reads this after the call rather than reporting
/// the RPC result. Uncached by design (`read_auth` hits disk each time), so a
/// before/after comparison across the call actually observes a change.
pub fn subscription_login_present(provider_id: &str) -> Option<bool> {
    let meta = provider_meta(provider_id)?;
    if meta.auth_kind != "subscription" {
        return None;
    }
    Some(
        !meta.auth_key.is_empty()
            && (auth_has_any(meta.auth_key)
                || vault_has_any(&accounts::provider_scope(meta.auth_key))),
    )
}

// ── Account management (multi-account switch/remove, backed by the vault) ─────

/// The vault scope for a provider id: its `auth.json` key for a built-in, its
/// `models.json` id for a custom provider. `None` for managed/gateway rows that
/// hold no credential.
pub fn provider_account_scope(provider_id: &str) -> Option<String> {
    if is_managed_or_gateway(provider_id) {
        return None;
    }
    // Custom providers have no `ProviderMeta` row (they live in models.json),
    // so the scope keys off the provider id itself for those.
    let key = match provider_meta(provider_id) {
        Some(meta) if !meta.auth_key.is_empty() => meta.auth_key.to_owned(),
        _ => provider_id.to_owned(),
    };
    Some(accounts::provider_scope(&key))
}

/// Map a Pi provider id to the local Gateway provider-key slot, when the
/// Gateway supports installing that account. Subscription OAuth and custom
/// providers intentionally return `None`: their credentials must not be copied
/// into the shared Gateway config through this BYOK path.
pub fn gateway_provider_slug(provider_id: &str) -> Option<&'static str> {
    match provider_id.trim() {
        "anthropic" => Some("anthropic"),
        "google" => Some("gemini"),
        "openai" => Some("openai"),
        "openrouter" => Some("openrouter"),
        _ => None,
    }
}

/// Read one saved API-key account for the Gateway handoff without exposing the
/// credential through an HTTP response. OAuth and opaque accounts are rejected:
/// the shared Gateway only accepts its own provider-key vault, while subscription
/// credentials stay with the caller's local passthrough.
pub fn provider_account_api_key(provider_id: &str, account_id: &str) -> Result<String> {
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' has no Gateway key slot"))?;
    let vault = accounts::global()
        .ok_or_else(|| anyhow::anyhow!("the pi-accounts vault is not initialized"))?;
    let info = vault
        .list(&scope)?
        .into_iter()
        .find(|account| account.account_id == account_id)
        .ok_or_else(|| {
            anyhow::anyhow!("no account with id '{account_id}' for provider '{provider_id}'")
        })?;
    if info.kind != accounts::KIND_API_KEY {
        anyhow::bail!(
            "account '{}' is not an API-key account and cannot be installed in the Gateway",
            info.label
        );
    }
    let credential = vault
        .credential(&scope, account_id)?
        .ok_or_else(|| anyhow::anyhow!("account '{}' has no readable credential", info.label))?;
    let key = credential
        .as_str()
        .or_else(|| credential.get("key").and_then(Value::as_str))
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| anyhow::anyhow!("account '{}' has no API key", info.label))?;
    Ok(key.to_owned())
}

/// Read one saved subscription credential for the account-aware usage reader.
///
/// The credential stays inside Core: this helper is only called by the usage
/// route, which passes it directly to `ryu-usage` and returns normalized meters.
/// API-key and opaque accounts are rejected here so the usage endpoint cannot be
/// repurposed as a generic secret reader.
pub fn subscription_account_credential(
    provider_id: &str,
    account_id: &str,
) -> Result<Option<Value>> {
    let meta = provider_meta(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{provider_id}'"))?;
    if meta.auth_kind != "subscription" || meta.auth_key.is_empty() {
        anyhow::bail!("provider '{provider_id}' is not a subscription provider");
    }
    let scope = accounts::provider_scope(meta.auth_key);
    let vault = accounts::global()
        .ok_or_else(|| anyhow::anyhow!("the pi-accounts vault is not initialized"))?;
    let info = vault
        .list(&scope)?
        .into_iter()
        .find(|account| account.account_id == account_id)
        .ok_or_else(|| {
            anyhow::anyhow!("no account with id '{account_id}' for provider '{provider_id}'")
        })?;
    if info.kind != accounts::KIND_OAUTH {
        return Ok(None);
    }
    vault.credential(&scope, account_id)
}

/// Mark one saved account as the selected Gateway account after the Gateway has
/// accepted its key. This marker is independent from `active`, which is the
/// account selected for the current Ryu session.
pub fn set_provider_gateway_active(provider_id: &str, account_id: &str) -> Result<bool> {
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' has no Gateway account scope"))?;
    with_account_vault(|vault| vault.set_gateway_active(&scope, account_id))
}

/// The accounts a provider holds, labels only. `[]` when it holds none.
pub fn list_provider_accounts(provider_id: &str) -> Vec<accounts::AccountInfo> {
    let Some(scope) = provider_account_scope(provider_id) else {
        return Vec::new();
    };
    match accounts::global() {
        Some(vault) => vault.list(&scope).unwrap_or_default(),
        None => Vec::new(),
    }
}

/// Make `account_id` the active account for a provider and materialize it into
/// Pi's files. Returns the refreshed catalog. Errors when the provider has no
/// such account.
pub fn switch_provider_account(provider_id: &str, account_id: &str) -> Result<Value> {
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' holds no accounts"))?;
    let switched = with_account_vault(|vault| vault.set_active(&scope, account_id))?;
    if !switched {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    materialize_active_accounts();
    Ok(catalog())
}

/// Remove `account_id` from a provider. If it was active, the newest remaining
/// account becomes active and is materialized (the slot is cleared otherwise).
/// Returns the refreshed catalog.
pub fn remove_provider_account(provider_id: &str, account_id: &str) -> Result<Value> {
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' holds no accounts"))?;
    let removed = with_account_vault(|vault| vault.remove(&scope, account_id))?;
    if !removed {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    // Promote a remaining account so a removed active login does not leave the
    // provider with a cleared slot it cannot use.
    let remaining = with_account_vault(|vault| vault.list(&scope))?;
    if !remaining.is_empty() && !remaining.iter().any(|a| a.active) {
        if let Some(next) = remaining.first() {
            let _ = with_account_vault(|vault| vault.set_active(&scope, &next.account_id));
        }
    }
    materialize_active_accounts();
    Ok(catalog())
}

/// Snapshot every usable credential currently in Pi's `auth.json` into the
/// sealed vault as an account (deduped by credential content), for the managed
/// Pi's ACP login path — after `authenticate` the agent subprocess writes the
/// credential itself, and this is how Ryu captures it as a switchable account.
/// Called on a successful managed-Pi `authenticate` and at boot.
pub fn capture_pi_auth_into_vault() {
    let Some(vault) = accounts::global() else {
        return;
    };
    for (auth_key, entry) in read_auth() {
        let Some(credential) = usable_credential(&entry) else {
            continue;
        };
        let scope = accounts::provider_scope(&auth_key);
        if vault.has_credential(&scope, &credential).unwrap_or(false) {
            continue;
        }
        let base = provider_label_for_auth_key(&auth_key);
        if let Err(e) = vault.upsert(
            &scope,
            &new_account_id(),
            &vault_account_label(vault, &scope, base),
            credential_kind(&entry),
            Some(credential),
        ) {
            tracing::warn!(
                auth_key,
                error = %e,
                "could not capture Pi login into the account vault"
            );
        }
    }
    materialize_active_accounts();
}

/// A human label for an `auth.json` key: the first built-in provider whose
/// `auth_key` it names, else "Account".
fn provider_label_for_auth_key(auth_key: &str) -> &'static str {
    PROVIDERS
        .iter()
        .find(|p| p.auth_key == auth_key)
        .map(|p| p.label)
        .unwrap_or("Account")
}

fn rows_to_values(rows: Vec<accounts::AccountInfo>) -> Vec<Value> {
    rows.into_iter()
        .map(|info| serde_json::to_value(info).unwrap_or_default())
        .collect()
}

/// List an ACP agent's accounts (labels only). For the managed Pi this is the
/// aggregate of its provider accounts, each tagged with the provider it belongs
/// to; for every other agent it is its opaque sign-ins.
pub fn list_acp_accounts(spawn_cmd: &str) -> Vec<Value> {
    let Some(vault) = accounts::global() else {
        return Vec::new();
    };
    let scope = accounts::acp_scope(spawn_cmd);
    // Managed Pi: aggregate the provider scopes, tagged by provider.
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        let mut out = Vec::new();
        for meta in PROVIDERS {
            if meta.auth_key.is_empty() {
                continue;
            }
            let provider_scope = accounts::provider_scope(meta.auth_key);
            if let Ok(accounts) = vault.list(&provider_scope) {
                for info in accounts {
                    let mut v = serde_json::to_value(&info).unwrap_or_default();
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("provider".to_owned(), Value::String(meta.id.to_owned()));
                    }
                    out.push(v);
                }
            }
        }
        return out;
    }
    // Any other agent: its own opaque scope.
    vault.list(&scope).map(rows_to_values).unwrap_or_default()
}

/// Record a successful ACP `authenticate` in the vault. Managed Pi → snapshot
/// Pi's `auth.json` (real, switchable credentials); any other agent → an opaque
/// account under its scope (its own auth files are not Ryu's to read), deduped
/// by label so a re-login refreshes the existing sign-in rather than stacking.
pub fn record_acp_account(spawn_cmd: &str, provider_id: Option<&str>) {
    let Some(vault) = accounts::global() else {
        return;
    };
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        capture_pi_auth_into_vault();
        return;
    }
    let scope = accounts::acp_scope(spawn_cmd);
    let base = provider_id
        .and_then(provider_meta)
        .map(|m| m.label)
        .unwrap_or("Signed-in account");
    // Re-login to the same agent = refresh that account, not a duplicate row.
    if let Ok(Some(existing)) = vault.find_by_label(&scope, base) {
        if let Err(e) = vault.set_active(&scope, &existing.account_id) {
            tracing::warn!(error = %e, "could not refresh ACP account in the vault");
        }
        return;
    }
    if let Err(e) = vault.upsert(&scope, &new_account_id(), base, accounts::KIND_OPAQUE, None) {
        tracing::warn!(error = %e, "could not record ACP account in the vault");
    }
}

/// Make `account_id` the active account for an ACP agent. For the managed Pi the
/// account carries a `provider` tag naming the provider scope to switch; for any
/// other agent switching means re-running the agent's own login (the route's
/// job), so this only acknowledges.
pub fn switch_acp_account(
    spawn_cmd: &str,
    account_id: &str,
    provider: Option<&str>,
) -> Result<bool> {
    let Some(vault) = accounts::global() else {
        return Ok(false);
    };
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        let provider = provider.ok_or_else(|| {
            anyhow::anyhow!("the managed Pi account needs its provider to switch")
        })?;
        let scope = provider_account_scope(provider)
            .ok_or_else(|| anyhow::anyhow!("provider '{provider}' holds no accounts"))?;
        let switched = vault.set_active(&scope, account_id)?;
        if switched {
            materialize_active_accounts();
        }
        return Ok(switched);
    }
    Ok(true)
}

/// Remove an account from an ACP agent. Managed Pi → remove from its provider
/// scope (and materialize); any other agent → remove the opaque account.
pub fn remove_acp_account(spawn_cmd: &str, account_id: &str) -> Result<bool> {
    let Some(vault) = accounts::global() else {
        return Ok(false);
    };
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        let mut removed = false;
        for meta in PROVIDERS {
            if meta.auth_key.is_empty() {
                continue;
            }
            let provider_scope = accounts::provider_scope(meta.auth_key);
            if vault.remove(&provider_scope, account_id)? {
                removed = true;
                break;
            }
        }
        if removed {
            materialize_active_accounts();
        }
        return Ok(removed);
    }
    let scope = accounts::acp_scope(spawn_cmd);
    vault.remove(&scope, account_id)
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

/// Extract a provider's per-model `enabled` overrides from an already-read
/// models.json value, as a `{ modelId: bool }` map. Only ids the user has
/// explicitly toggled appear; an absent id means the model is enabled (default).
/// `models` reads the value returned by [`read_models`].
fn model_overrides(models: &Value, id: &str) -> Value {
    let mut out = Map::new();
    if let Some(list) = models["providers"]
        .get(id)
        .and_then(|p| p.get("models"))
        .and_then(Value::as_array)
    {
        for entry in list {
            let Some(model_id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(enabled) = entry.get("enabled").and_then(Value::as_bool) {
                out.insert(model_id.to_owned(), Value::Bool(enabled));
            }
        }
    }
    Value::Object(out)
}

/// Every agent's per-model overrides as `{ agentId: { modelId: bool } }`, read
/// from the reserved [`AGENT_OVERRIDE_PREFIX`] keys of an already-read
/// models.json value. An agent with no toggles is absent, and an untoggled model
/// is absent from its map — absent means enabled, exactly as for a provider.
fn agent_model_overrides(models: &Value) -> Value {
    let mut out = Map::new();
    let Some(providers) = models["providers"].as_object() else {
        return Value::Object(out);
    };
    for key in providers.keys() {
        let Some(agent_id) = key.strip_prefix(AGENT_OVERRIDE_PREFIX) else {
            continue;
        };
        if agent_id.is_empty() {
            continue;
        }
        out.insert(agent_id.to_owned(), model_overrides(models, key));
    }
    Value::Object(out)
}

/// The catalog of supported providers + thinking levels, with per-provider
/// `configured` and `suggestedModels` so the desktop can render a picker.
/// The API key stored for one provider, in the same priority order
/// [`provider_configured`] reports on: the `auth.json` api-key credential, then
/// the provider's auth env var, then a custom provider's `models.json` `apiKey`.
///
/// SERVER-SIDE ONLY. This is how the `GET /api/providers/:id/credits` handler
/// hands a key to the credit reader, which needs it for one `Authorization`
/// header. It must never reach a response body — the whole point of keeping key
/// resolution here (rather than giving `ryu-usage` a credential seam) is that the
/// one caller is a handler that returns a normalized snapshot and nothing else.
pub fn provider_api_key(id: &str) -> Option<String> {
    if let Some(meta) = provider_meta(id) {
        // A subscription (OAuth) provider has no api key to read; its auth.json
        // entry is an oauth blob, and handing that to a billing endpoint would be
        // both wrong and a credential leak into the wrong vendor.
        if meta.auth_kind == "subscription" {
            return None;
        }
        if !meta.auth_key.is_empty() {
            if let Some(key) = auth_key_value(meta.auth_key) {
                return Some(key);
            }
        }
        if !meta.auth_env.is_empty() {
            if let Ok(key) = std::env::var(meta.auth_env) {
                let trimmed = key.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        return None;
    }
    // Custom (user-added) provider: its key lives inline in models.json.
    read_models()["providers"]
        .get(id)
        .and_then(|p| p.get("apiKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The account listing a provider row carries — labels, kinds, active flag and
/// timestamps, NEVER a credential. `[]` when the vault is not published.
fn provider_accounts(scope: &str) -> Vec<Value> {
    match accounts::global() {
        Some(vault) => vault
            .list(scope)
            .map(|rows| {
                rows.into_iter()
                    .map(|info| serde_json::to_value(info).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

pub fn catalog() -> Value {
    let custom_ids = custom_provider_ids();
    let active = active_provider_id_from(&read_settings());
    let is_active = |id: &str| active.as_deref() == Some(id);
    // Read models.json once so each provider can surface its per-model `enabled`
    // overrides without a file read per iteration.
    let models_value = read_models();
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
                "managed": is_managed(p.id),
                // The credit pool this row's spend attributes to, so the composer
                // can bind the row to the pool catalog and show its balance. Empty
                // for BYOK.
                "creditPool": p.credit_pool,
                "configured": provider_configured(p),
                "active": is_active(p.id),
                "custom": false,
                "suggestedModels": p.suggested_models,
                "supportsDiscovery": !p.models_url.is_empty(),
                // Per-model enabled overrides (absent id ⇒ enabled). Lets the
                // desktop render each model's on/off toggle.
                "modelOverrides": model_overrides(&models_value, p.id),
                // Every account the provider holds in the sealed vault (labels
                // only — never a credential). Lets the picker list + switch.
                "accounts": provider_accounts(&accounts::provider_scope(p.auth_key)),
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
            "configured": custom_provider_has_key(&id) || vault_has_any(&accounts::provider_scope(&id)),
            "active": is_active(&id),
            "custom": true,
            "suggestedModels": [],
            // Custom providers discover against their own baseUrl + /models.
            "supportsDiscovery": true,
            "modelOverrides": model_overrides(&models_value, &id),
            "accounts": provider_accounts(&accounts::provider_scope(&id)),
        }));
    }

    json!({
        "providers": providers,
        // Per-AGENT model visibility, keyed by agent id (the `agent:` scopes in
        // models.json with the prefix stripped). Same absent ⇒ enabled rule as a
        // provider's `modelOverrides`. Carried on the catalog so every surface
        // that already reads the catalog can filter an agent's advertised model
        // list without a second request.
        "agentModelOverrides": agent_model_overrides(&models_value),
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
    let managed = is_managed(&provider);
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

    // A managed row with no explicit model gets its OWN first suggestion, not a
    // single global default. For `managed-openrouter` that is still
    // `MANAGED_DEFAULT_MODEL` (the Auto Router — zero decisions), because it is
    // that row's first suggestion; for a pool row it has to be an id that routes
    // to THAT pool, or the turn silently bills a different supply than the one the
    // user picked. This also matches the desktop, which sends `models[0].id`.
    let effective_model = if managed && model.is_none() {
        provider_meta(&provider)
            .and_then(|m| m.suggested_models.first())
            .map(|s| (*s).to_owned())
            .or_else(|| Some(MANAGED_DEFAULT_MODEL.to_owned()))
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
        //
        // `managed` picks the HOSTED fleet when this node has managed coordinates,
        // so the plan's credits are spendable from a self-hosted node; the
        // synthetic gateway provider and every BYOK provider stay local.
        upsert_provider(
            "openai",
            gateway_openai_patch_for(effective_model.as_deref(), managed),
        )?;
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
            vault_upsert_credential(
                &accounts::provider_scope(&provider),
                "API key",
                accounts::KIND_API_KEY,
                Value::String(key.clone()),
            );
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
            vault_upsert_credential(
                &accounts::provider_scope(&provider),
                "API key",
                accounts::KIND_API_KEY,
                Value::String(key.clone()),
            );
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

// ── Per-model enable/disable (LobeChat-style) ──────────────────────────────────

/// Toggle a single model on/off within a provider.
#[derive(Debug, Deserialize)]
pub struct ModelEnabledInput {
    /// Provider id (built-in or custom).
    pub provider: String,
    /// Model id to toggle.
    pub model: String,
    /// Desired state; `false` disables the model (absent ⇒ enabled).
    pub enabled: bool,
}

/// Persist a per-model `enabled` flag on the provider's models.json entry.
/// Absent = enabled, so a model is only recorded once explicitly toggled and
/// existing configs are unaffected. Returns the refreshed catalog so the desktop
/// re-renders the model's toggle state.
pub fn set_model_enabled(input: ModelEnabledInput) -> Result<Value> {
    let provider = input.provider.trim().to_owned();
    let model = input.model.trim().to_owned();
    if provider.is_empty() || model.is_empty() {
        anyhow::bail!("provider and model are required");
    }

    let mut models = read_models();
    let providers = models["providers"]
        .as_object_mut()
        .expect("providers object ensured by read_models");
    let entry = providers
        .entry(provider)
        .or_insert_with(|| json!({ "models": [] }));
    let obj = entry
        .as_object_mut()
        .context("provider entry is not an object")?;
    let list = obj.entry("models".to_owned()).or_insert_with(|| json!([]));
    let arr = list
        .as_array_mut()
        .context("provider models is not an array")?;

    if let Some(existing) = arr
        .iter_mut()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(model.as_str()))
    {
        if let Some(map) = existing.as_object_mut() {
            map.insert("enabled".to_owned(), Value::Bool(input.enabled));
        }
    } else {
        arr.push(json!({ "id": model, "enabled": input.enabled }));
    }

    write_models(&models)?;
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
    /// Pi `api` type of a not-yet-saved custom provider (e.g. `anthropic-messages`).
    /// Lets an Anthropic-format endpoint be probed with `x-api-key` +
    /// `anthropic-version` instead of a bearer token. Defaults to OpenAI-style.
    #[serde(default)]
    pub api: Option<String>,
}

/// How a discovery request authenticates to the upstream `GET /models`.
enum DiscoveryAuth {
    Bearer(String),
    /// Anthropic uses `x-api-key` + `anthropic-version` rather than a bearer token.
    Anthropic(String),
    None,
}

/// Pick the discovery auth for a custom/explicit provider from its Pi `api` type:
/// Anthropic-format endpoints (`anthropic-messages`) authenticate with
/// `x-api-key` + `anthropic-version`; every other (OpenAI-style) endpoint uses a
/// bearer token. No key → an unauthenticated probe (`None`).
fn discovery_auth_for(api: Option<&str>, key: Option<String>) -> DiscoveryAuth {
    match key {
        Some(k) if api == Some("anthropic-messages") => DiscoveryAuth::Anthropic(k),
        Some(k) => DiscoveryAuth::Bearer(k),
        None => DiscoveryAuth::None,
    }
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
    let explicit_api = non_empty(&input.api);

    // Resolve (url, auth) for the probe.
    let resolved: Option<(String, DiscoveryAuth)> = if let Some(base) = &explicit_base {
        let auth = discovery_auth_for(explicit_api.as_deref(), explicit_key.clone());
        Some((models_url_from_base(base), auth))
    } else if let Some(id) = &provider_id {
        resolve_provider_discovery(id, explicit_key.clone())
    } else {
        None
    };

    // Tier 1 — a live provider `GET /v1/models` (freshest, provider-authoritative).
    if let Some((url, auth)) = resolved {
        let allow_trusted_local = provider_id
            .as_deref()
            .is_some_and(|id| id == GATEWAY_PROVIDER_ID || id == MANAGED_OPENROUTER_ID);
        if let Ok(models) = fetch_models(&url, auth, allow_trusted_local).await {
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

/// A live connectivity probe against a provider's models endpoint.
#[derive(Debug, Deserialize)]
pub struct CheckInput {
    /// A known/custom provider id to resolve the URL + key from stored config.
    #[serde(default)]
    pub provider: Option<String>,
    /// An explicit base URL (e.g. a not-yet-saved custom provider being tested).
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    /// An explicit key to try (never persisted; used only for the probe).
    #[serde(rename = "apiKey", default)]
    pub api_key: Option<String>,
    /// Pi `api` type of a not-yet-saved custom provider (e.g. `anthropic-messages`),
    /// so an Anthropic-format endpoint is probed with `x-api-key`.
    #[serde(default)]
    pub api: Option<String>,
}

/// The result of a [`check_provider`] connectivity probe.
#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub ok: bool,
    #[serde(rename = "latencyMs")]
    pub latency_ms: u64,
    #[serde(rename = "modelCount")]
    pub model_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Live-check a provider's connectivity by doing one authenticated GET against
/// its models endpoint (the same URL/auth resolution [`discover_models`] uses).
/// Persists nothing — it only reports reachability, latency, and model count so
/// the desktop can show an inline "OK · 120ms · 42 models" / error status.
pub async fn check_provider(input: CheckInput) -> CheckResult {
    let provider_id = non_empty(&input.provider);
    let explicit_base = non_empty(&input.base_url);
    let explicit_key = non_empty(&input.api_key);
    let explicit_api = non_empty(&input.api);

    // Resolve (url, auth) exactly like Tier 1 of discovery.
    let resolved: Option<(String, DiscoveryAuth)> = if let Some(base) = &explicit_base {
        let auth = discovery_auth_for(explicit_api.as_deref(), explicit_key.clone());
        Some((models_url_from_base(base), auth))
    } else if let Some(id) = &provider_id {
        resolve_provider_discovery(id, explicit_key.clone())
    } else {
        None
    };

    let Some((url, auth)) = resolved else {
        return CheckResult {
            ok: false,
            latency_ms: 0,
            model_count: 0,
            error: Some("no reachable models endpoint for this provider".to_owned()),
        };
    };

    let started = std::time::Instant::now();
    let allow_trusted_local = provider_id
        .as_deref()
        .is_some_and(|id| id == GATEWAY_PROVIDER_ID || id == MANAGED_OPENROUTER_ID);
    match fetch_models(&url, auth, allow_trusted_local).await {
        Ok(models) => CheckResult {
            ok: true,
            latency_ms: started.elapsed().as_millis() as u64,
            model_count: models.len(),
            error: None,
        },
        Err(e) => CheckResult {
            ok: false,
            latency_ms: started.elapsed().as_millis() as u64,
            model_count: 0,
            error: Some(e.to_string()),
        },
    }
}

/// Resolve the discovery URL + auth for a known/custom provider id from stored
/// config. Returns `None` when the provider has no discoverable endpoint (e.g.
/// Google's non-OpenAI shape), so the caller falls back to suggestions.
fn resolve_provider_discovery(
    id: &str,
    explicit_key: Option<String>,
) -> Option<(String, DiscoveryAuth)> {
    // Gateway and the retail managed row → the local Gateway's own /v1/models.
    //
    // Deliberately NOT every managed row. The Gateway's discovery merges every
    // configured provider's models into one flat list with no provider or pool
    // field on any entry, so a pool row would offer ids that route elsewhere and
    // silently debit a pool the user holds nothing in. A pool row falls through to
    // its own curated `suggested_models`, every one of which is asserted routable.
    if id == GATEWAY_PROVIDER_ID || id == MANAGED_OPENROUTER_ID {
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
        // Keyed on the provider's API FORMAT, not its id, so any Anthropic-format
        // built-in probes with `x-api-key` + `anthropic-version` — the same rule
        // the custom-provider path below applies. An id-equality check would send
        // a bearer token to the next `anthropic-messages` provider added here.
        let auth = discovery_auth_for(Some(meta.api), key);
        return Some((meta.models_url.to_owned(), auth));
    }

    // Custom provider defined in models.json → its baseUrl + /models. Honor the
    // stored `api` type so an Anthropic-format custom endpoint probes with
    // `x-api-key` instead of a bearer token.
    let entry = read_models()["providers"].get(id)?.clone();
    let base = entry.get("baseUrl").and_then(Value::as_str)?;
    let key = explicit_key.or_else(|| {
        entry
            .get("apiKey")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|s| !s.is_empty())
    });
    let api = entry.get("api").and_then(Value::as_str);
    let auth = discovery_auth_for(api, key);
    Some((models_url_from_base(base), auth))
}

/// GET the `/models` endpoint and parse the OpenAI/Anthropic `{ data: [{id,…}] }`
/// shape into `[{id}]`. Short timeout so a dead endpoint fails fast to fallback.
async fn fetch_models(
    url: &str,
    auth: DiscoveryAuth,
    allow_trusted_local: bool,
) -> Result<Vec<Value>> {
    let parsed = reqwest::Url::parse(url).context("parse discovery URL")?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("discovery URL has no host"))?;
    let trusted_local = allow_trusted_local && is_trusted_gateway_endpoint(&parsed);
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none());
    if !trusted_local {
        let (_, screened) = crate::server::screen_egress_url_pinned(url, true, None)
            .await
            .context("screen discovery endpoint")?;
        if let crate::server::ScreenedEgress::Pinned(addresses) = screened {
            builder = builder.resolve_to_addrs(host, &addresses);
        }
    }
    let client = builder.build().context("build discovery client")?;
    let mut req = client.get(parsed);
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
            // Anthropic spells the human label `display_name`; OpenRouter and the
            // OpenAI-compatible routers spell it `name`. Reading only the first left
            // every OpenRouter row rendering as its raw slug — including the Auto
            // Router (`openrouter/auto`), which is the managed plan's own default.
            if let Some(name) = m
                .get("display_name")
                .or_else(|| m.get("name"))
                .and_then(Value::as_str)
            {
                out.insert("name".to_owned(), Value::String(name.to_owned()));
            }
            Some(Value::Object(out))
        })
        .collect();
    Ok(models)
}

/// The built-in Gateway provider is the one intentional loopback discovery
/// target. Compare the complete authority so a custom provider cannot opt into
/// this exception merely by using the logical `gateway` id or a similar path.
fn is_trusted_gateway_endpoint(url: &reqwest::Url) -> bool {
    let Ok(gateway) = reqwest::Url::parse(&crate::sidecar::gateway::gateway_url()) else {
        return false;
    };
    url.scheme() == gateway.scheme()
        && url.host_str() == gateway.host_str()
        && url.port_or_known_default() == gateway.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point the config dir at a temp location for the duration of a test.
    ///
    /// Takes the **registry** env lock as well as the pi-config one. Several of
    /// these tests reach `default_gateway_model()` → `ProviderRegistry::load()`,
    /// which reads the process-global `RYU_LOCAL_CHAT_MODEL_*` /
    /// `RYU_REGISTRY_PATH` vars that `registry::tests` mutate transiently under
    /// *their* lock. Without this, `gateway_patch_upgrades_bare_default_model_metadata`
    /// — which calls `default_gateway_model()` twice, once to build the entry and
    /// once inside `ensure_gateway_models_json` — can read two different ids across
    /// a concurrent `RYU_LOCAL_CHAT_MODEL_ID` override and fail its `"Gemma 4 E2B IT
    /// Q4_K_M"` assertion. A cross-module flake, not a bug in either test.
    ///
    /// Lock order is pi-config → registry, and it is the only order taken anywhere:
    /// `registry::tests` never acquire the pi-config lock, and `sidecar::adapters`'
    /// two pi-config users acquire nothing else. Keep it that way — the inverse
    /// order in any new test deadlocks the whole suite, which is far worse than the
    /// flake this closes.
    pub(crate) fn with_temp_dir<F: FnOnce()>(f: F) {
        let _guard = lock_pi_config_test_env();
        let _registry_guard = crate::registry::lock_registry_env();
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
    fn pi_mcp_extension_is_shipped_and_registered_idempotently() {
        with_temp_dir(|| {
            // First call: writes the extension source and registers its absolute
            // path in settings.json "extensions".
            ensure_pi_mcp_extension().expect("first ensure");
            let ext_path = pi_mcp_extension_path();
            assert!(
                ext_path.exists(),
                "extension file is shipped to the managed dir"
            );
            let shipped = fs::read_to_string(&ext_path).unwrap();
            assert_eq!(
                shipped, PI_MCP_EXTENSION_SRC,
                "shipped source matches the embed"
            );

            let abs = ext_path.to_string_lossy().into_owned();
            let settings = read_settings();
            let exts = settings
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned();
            let exts = exts.expect("extensions array present");
            assert!(
                exts.iter()
                    .filter(|v| v.as_str() == Some(abs.as_str()))
                    .count()
                    == 1,
                "registered exactly once"
            );

            // Second call: idempotent — no duplicate path, source unchanged.
            ensure_pi_mcp_extension().expect("second ensure");
            let settings2 = read_settings();
            let exts2 = settings2
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array present");
            assert_eq!(
                exts2
                    .iter()
                    .filter(|v| v.as_str() == Some(abs.as_str()))
                    .count(),
                1,
                "second ensure does not duplicate the registration"
            );
        });
    }

    #[test]
    fn pi_mcp_extension_preserves_unrelated_extensions() {
        with_temp_dir(|| {
            // A user (or another Ryu write) already listed an extension; ours must
            // be appended, not clobber theirs.
            let mut settings = read_settings();
            settings
                .extra
                .insert("extensions".to_owned(), json!(["/tmp/other-ext.ts"]));
            write_settings(&settings).unwrap();

            ensure_pi_mcp_extension().expect("ensure");
            let exts = read_settings()
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array");
            let abs = pi_mcp_extension_path().to_string_lossy().into_owned();
            assert!(exts.iter().any(|v| v.as_str() == Some("/tmp/other-ext.ts")));
            assert!(exts.iter().any(|v| v.as_str() == Some(abs.as_str())));
        });
    }

    #[test]
    fn pi_lsp_extension_is_shipped_and_registered_idempotently() {
        with_temp_dir(|| {
            ensure_pi_lsp_extension().expect("first ensure");
            let ext_path = pi_lsp_extension_path();
            let shipped = fs::read_to_string(&ext_path).expect("extension file is shipped");
            assert_eq!(
                shipped, PI_LSP_EXTENSION_SRC,
                "shipped source matches the embed"
            );

            // A second ensure must neither rewrite the source nor double-register.
            let mtime = fs::metadata(&ext_path).unwrap().modified().unwrap();
            ensure_pi_lsp_extension().expect("second ensure");
            assert_eq!(
                fs::metadata(&ext_path).unwrap().modified().unwrap(),
                mtime,
                "identical source is not rewritten"
            );

            let abs = ext_path.to_string_lossy().into_owned();
            let exts = read_settings()
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array present");
            assert_eq!(
                exts.iter()
                    .filter(|v| v.as_str() == Some(abs.as_str()))
                    .count(),
                1,
                "registered exactly once"
            );
        });
    }

    #[test]
    fn pi_plan_extension_is_shipped_and_registered_idempotently() {
        with_temp_dir(|| {
            ensure_pi_plan_extension().expect("first ensure");
            let ext_path = pi_plan_extension_path();
            let shipped = fs::read_to_string(&ext_path).expect("extension file is shipped");
            assert_eq!(
                shipped, PI_PLAN_EXTENSION_SRC,
                "shipped source matches the embed"
            );

            // A second ensure must neither rewrite the source nor double-register.
            let mtime = fs::metadata(&ext_path).unwrap().modified().unwrap();
            ensure_pi_plan_extension().expect("second ensure");
            assert_eq!(
                fs::metadata(&ext_path).unwrap().modified().unwrap(),
                mtime,
                "identical source is not rewritten"
            );

            let abs = ext_path.to_string_lossy().into_owned();
            let exts = read_settings()
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array present");
            assert_eq!(
                exts.iter()
                    .filter(|v| v.as_str() == Some(abs.as_str()))
                    .count(),
                1,
                "registered exactly once"
            );
        });
    }

    #[test]
    fn pi_plan_extension_preserves_unrelated_extensions() {
        with_temp_dir(|| {
            let mut settings = read_settings();
            settings
                .extra
                .insert("extensions".to_owned(), json!(["/tmp/other-ext.ts"]));
            write_settings(&settings).unwrap();

            ensure_pi_plan_extension().expect("ensure");
            let exts = read_settings()
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array");
            let abs = pi_plan_extension_path().to_string_lossy().into_owned();
            assert!(exts.iter().any(|v| v.as_str() == Some("/tmp/other-ext.ts")));
            assert!(exts.iter().any(|v| v.as_str() == Some(abs.as_str())));
        });
    }

    /// The sentinel is a CONTRACT with `ryu-plan.ts`, not a free-form string: the
    /// extension matches it with `/^\/plan(-off)?(?![\w-])[ \t]*(.*)$/` against the
    /// first line of the prompt (or of its final `\n\n` block), then strips it. If
    /// this drifts, plan mode does not fail loudly — the token simply reaches the
    /// model as literal text and the mode never engages. So these assertions pin
    /// the exact bytes the extension's regexes accept.
    #[test]
    fn plan_mode_sentinel_matches_the_extension_grammar() {
        assert_eq!(plan_mode_sentinel(true), "/plan");
        assert_eq!(plan_mode_sentinel(false), "/plan off");

        // The extension's own two regexes, transcribed. `regex` is not a Core
        // dependency, so this is a hand-rolled equivalent of what they accept —
        // the point is that the token is a bare `/plan`, optionally followed by
        // the word `off`, with nothing else attached to it.
        for on in [true, false] {
            let s = plan_mode_sentinel(on);
            assert!(s.starts_with("/plan"), "{s}: sentinel token is `/plan`");
            let rest = &s["/plan".len()..];
            assert!(
                rest.is_empty() || rest == " off",
                "{s}: only the `off` word may follow, separated by a space"
            );
            // `(?![\w-])` — the character after the token must never extend it,
            // or `/planning` and `/plan-offsite` would match too.
            assert!(
                !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '-'),
                "{s}: the token must not run into a word character"
            );
            // Single line: callers place this as its own first line, and a
            // newline inside it would push the sentinel off that line.
            assert!(!s.contains('\n'), "{s}: sentinel is a single line");
            assert_eq!(s.trim(), s, "{s}: no leading/trailing whitespace");
        }

        // ON and OFF must be distinguishable — `/plan off` starting with `/plan`
        // is exactly why the extension checks the `off` word before concluding
        // "enter". A helper that returned the same string for both would silently
        // make the pill a one-way switch.
        assert_ne!(plan_mode_sentinel(true), plan_mode_sentinel(false));
    }

    #[test]
    fn managed_defaults_ship_every_compiled_in_extension() {
        with_temp_dir(|| {
            ensure_managed_defaults().expect("managed defaults");
            assert!(pi_mcp_extension_path().exists());
            assert!(
                pi_lsp_extension_path().exists(),
                "the LSP binding rides the same spawn-time invariant pass as the MCP bridge"
            );
            assert!(pi_plan_extension_path().exists());
        });
    }

    /// The UPGRADE path: a Core that ships a newer extension body must overwrite
    /// the copy an OLDER Core already wrote to the user's managed Pi dir.
    ///
    /// **Why this is a test and not a comment.** The extensions are `include_str!`d
    /// into the Core binary, so they travel with a Core upgrade for free — but only
    /// as far as the binary. Reaching the user's `~/.ryu/pi-agent/extensions/`
    /// depends entirely on [`ship_pi_extension`] doing a CONTENT compare
    /// (`existing != src`) rather than an existence check. Those two are one word
    /// apart and behave identically on a fresh install, so the difference is
    /// invisible to every other test here — `managed_defaults_ship_every_ryu_extension`
    /// and the per-extension idempotency tests all start from an empty dir.
    ///
    /// If someone "optimises" that to write-if-absent, every EXISTING user is frozen
    /// on whatever extension body their first install wrote, forever, while the
    /// release notes say the fix shipped. That is the silent-degradation class this
    /// file's guards exist to prevent, so it gets pinned from the upgrade side too.
    ///
    /// Registration is asserted as well: the settings entry must not be duplicated
    /// by the rewrite, since the path is unchanged.
    #[test]
    fn a_stale_extension_body_is_replaced_on_upgrade() {
        with_temp_dir(|| {
            // An older Core's install: every extension present, but with a body
            // that predates the current embed.
            ensure_managed_defaults().expect("first install");
            let stale = "// shipped by an older Ryu\n";
            let paths = [
                pi_mcp_extension_path(),
                pi_lsp_extension_path(),
                pi_plan_extension_path(),
            ];
            for path in &paths {
                fs::write(path, stale).expect("age the installed extension");
            }

            // The upgraded Core's spawn-time invariant pass.
            ensure_managed_defaults().expect("upgrade");

            for (path, expected) in paths.iter().zip([
                PI_MCP_EXTENSION_SRC,
                PI_LSP_EXTENSION_SRC,
                PI_PLAN_EXTENSION_SRC,
            ]) {
                let on_disk = fs::read_to_string(path).expect("extension still present");
                assert_ne!(
                    on_disk,
                    stale,
                    "{} was left at the older body — an upgraded Core never reached the user",
                    path.display()
                );
                assert_eq!(
                    on_disk,
                    expected,
                    "{} does not match the embed after upgrade",
                    path.display()
                );
            }

            let exts = read_settings()
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array present");
            for path in &paths {
                let abs = path.to_string_lossy().into_owned();
                assert_eq!(
                    exts.iter()
                        .filter(|v| v.as_str() == Some(abs.as_str()))
                        .count(),
                    1,
                    "{abs} registered exactly once after the upgrade rewrite"
                );
            }
        });
    }

    /// The bijection guard: every `.ts` asset under `apps/core/assets/pi-extensions/`
    /// must actually reach the managed Pi dir when Core runs its spawn-time
    /// invariant pass.
    ///
    /// **Why this exists.** Nothing forces a new pi-extension asset to be wired up.
    /// Dropping a `.ts` into that folder without an `include_str!` +
    /// `ensure_pi_*_extension()` + a line in [`ensure_managed_defaults`] compiles,
    /// ships nothing, and fails **silently** at runtime — the feature looks landed
    /// and is simply absent. That is exactly how `ryu-plan.ts` could have gone in.
    ///
    /// This guard now covers only the **compiled-in** road. The plugin road
    /// (`contributes.pi_extensions`) has its own pair in
    /// [`crate::plugin_manifest`]: `builtin_pi_extension_table_matches_package_manifests`
    /// (declared ⇄ embedded) and `packaged_pi_extension_files_are_all_declared`
    /// (nothing on disk is undeclared), plus
    /// [`super::app_extensions_round_trip_writes_then_removes`] for the bytes
    /// actually reaching the managed dir. The three assets left here are the ones
    /// that must never become plugins; see the chain comment in
    /// [`ensure_managed_defaults`].
    ///
    /// Three properties, and all three are load-bearing:
    /// 1. it drives [`ensure_managed_defaults`], not the individual `ensure_pi_*`
    ///    fns — so forgetting the chain line fails here even though every
    ///    per-extension test above still passes;
    /// 2. it compares BYTES, not existence — so an `include_str!` pointing at the
    ///    wrong asset (a copy/paste of the trio above) fails here;
    /// 3. it asserts the exact asset count, so a globbing or extension-filter
    ///    mistake that skips a file cannot pass by vacuous truth.
    #[test]
    fn every_pi_extension_asset_is_shipped() {
        with_temp_dir(|| {
            ensure_managed_defaults().expect("managed defaults");

            let assets_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("assets")
                .join("pi-extensions");
            let shipped_dir = config_dir().join("extensions");

            let mut assets: Vec<PathBuf> = fs::read_dir(&assets_dir)
                .expect("read the pi-extensions asset dir")
                .map(|entry| entry.expect("asset dir entry").path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("ts"))
                .collect();
            assets.sort();

            // Every extension shipped by `ensure_managed_defaults` today. Change
            // this deliberately when adding one — or when moving one out to a
            // plugin package, which is what took it from 5 to 3.
            const EXPECTED_ASSETS: usize = 3;
            assert_eq!(
                assets.len(),
                EXPECTED_ASSETS,
                "a pi-extension asset was added or removed without updating the \
                 shipping chain in ensure_managed_defaults: {assets:?}"
            );

            for asset in &assets {
                let name = asset
                    .file_name()
                    .expect("asset file name")
                    .to_string_lossy()
                    .into_owned();
                let shipped = shipped_dir.join(&name);
                let shipped_src = fs::read_to_string(&shipped).unwrap_or_else(|err| {
                    panic!(
                        "{name} is a pi-extension asset but ensure_managed_defaults never \
                         shipped it ({err}). Two valid answers: if it must be compiled in \
                         (see the chain comment in ensure_managed_defaults), add a \
                         PI_*_EXTENSION_SRC include_str!, a pi_*_extension_path(), an \
                         ensure_pi_*_extension() and a chain line. Otherwise it belongs in a \
                         plugin package as a contributes.pi_extensions row — move the file to \
                         plugins-store/{{plugins,lsp,external_plugins}}/<pkg>/pi-extensions/ and drop EXPECTED_ASSETS by one."
                    )
                });
                let asset_src = fs::read_to_string(asset).expect("read asset source");
                assert_eq!(
                    shipped_src, asset_src,
                    "{name} was shipped, but not from its own asset — an include_str! \
                     points at the wrong file"
                );
            }
        });
    }

    /// One resolved plugin extension, as [`app_extensions::resolve_pi_extensions`]
    /// would produce it.
    fn resolved_ext(plugin: &str, id: &str, source: &str) -> app_extensions::PiExtensionResolution {
        app_extensions::PiExtensionResolution {
            extensions: vec![app_extensions::ResolvedPiExtension {
                plugin_id: plugin.to_owned(),
                extension_id: id.to_owned(),
                file_name: format!(
                    "ext-{}-{id}.ts",
                    crate::plugin_manifest::plugin_dir_name(plugin)
                ),
                source: source.to_owned(),
            }],
            skipped: vec![],
        }
    }

    /// The whole point of the seam: an enabled plugin's extension is WRITTEN with
    /// its own bytes and registered, and disabling that plugin (an empty
    /// resolution) takes both the file and its `settings.json` entry away again.
    ///
    /// The byte compare is not decoration. A wrong file name or a prefix mismatch
    /// in the reconciler would still satisfy the table⇄manifest bijection tests
    /// while the extension silently never loads — which is the exact failure
    /// `every_pi_extension_asset_is_shipped` exists to prevent on the other road.
    #[test]
    fn app_extensions_round_trip_writes_then_removes() {
        with_temp_dir(|| {
            let source = "// background bash\nexport default {};\n";
            sync_app_pi_extensions(&resolved_ext("@ryu/pi-shell", "shell", source))
                .expect("materialize");

            let path = pi_extensions_dir().join("ext-@ryu+pi-shell-shell.ts");
            assert_eq!(
                fs::read_to_string(&path).expect("extension written"),
                source,
                "the materialized file must carry the resolved source verbatim"
            );
            let abs = path.to_string_lossy().into_owned();
            let registered = |settings: &PiSettings| {
                settings
                    .extra
                    .get("extensions")
                    .and_then(Value::as_array)
                    .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(abs.as_str())))
            };
            assert!(registered(&read_settings()), "path registered in settings");

            // Disable: the reconcile is driven by the resolution, so an empty one is
            // exactly what an uninstall or a disable produces.
            sync_app_pi_extensions(&app_extensions::PiExtensionResolution::default())
                .expect("reconcile empty");
            assert!(
                !path.exists(),
                "disabling the plugin must delete the file — Pi auto-discovers this \
                 directory, so an orphan keeps loading forever"
            );
            assert!(
                !registered(&read_settings()),
                "the settings.json registration must be pruned with the file"
            );
        });
    }

    /// The ownership boundary: the reconciler owns `ext-*.ts` and NOTHING else.
    ///
    /// This is the invariant whose failure bricks the flagship agent — an empty
    /// resolution (every extension-contributing plugin disabled) must not be able
    /// to delete `ryu-mcp.ts`, which is the managed Pi's only road to Ryu's tools.
    #[test]
    fn the_reconciler_never_touches_files_it_does_not_own() {
        with_temp_dir(|| {
            ensure_managed_defaults().expect("managed defaults");
            let dir = pi_extensions_dir();
            let hand_written = dir.join("my-own.ts");
            fs::write(&hand_written, "// dropped in by hand\n").expect("write");

            // A user entry in the array that is not even in this folder.
            let mut settings = read_settings();
            let elsewhere = "/somewhere/else/mine.ts";
            settings
                .extra
                .entry("extensions".to_owned())
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .expect("array")
                .push(Value::String(elsewhere.to_owned()));
            write_settings(&settings).expect("write settings");

            sync_app_pi_extensions(&app_extensions::PiExtensionResolution::default())
                .expect("reconcile empty");

            assert!(
                dir.join("ryu-mcp.ts").exists(),
                "compiled-in extension kept"
            );
            assert!(
                dir.join("ryu-lsp.ts").exists(),
                "compiled-in extension kept"
            );
            assert!(
                dir.join("ryu-plan.ts").exists(),
                "compiled-in extension kept"
            );
            assert!(
                hand_written.exists(),
                "a user's own file is not ours to delete"
            );

            let arr = read_settings()
                .extra
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .expect("extensions array");
            assert!(
                arr.iter().any(|v| v.as_str() == Some(elsewhere)),
                "an unrelated registration must survive the prune"
            );
            assert_eq!(
                arr.iter()
                    .filter(|v| v
                        .as_str()
                        .is_some_and(|s| s.contains("ryu-mcp.ts") || s.contains("ryu-plan.ts")))
                    .count(),
                2,
                "the compiled-in registrations must survive the prune"
            );
        });
    }

    /// Re-materializing an unchanged set must not rewrite the file: this runs on
    /// every managed-Pi spawn, so an unconditional write would churn the disk on
    /// every new chat. Same content-compare contract as [`ship_pi_extension`].
    #[test]
    fn app_extensions_are_written_only_when_they_change() {
        with_temp_dir(|| {
            let resolution = resolved_ext("@ryu/pi-shell", "shell", "// v1\n");
            sync_app_pi_extensions(&resolution).expect("first");
            let path = pi_extensions_dir().join("ext-@ryu+pi-shell-shell.ts");
            let first = fs::metadata(&path)
                .expect("stat")
                .modified()
                .expect("mtime");

            sync_app_pi_extensions(&resolution).expect("second");
            assert_eq!(
                fs::metadata(&path)
                    .expect("stat")
                    .modified()
                    .expect("mtime"),
                first,
                "an unchanged resolution must not rewrite the file"
            );

            // A changed source DOES land, so idempotency never becomes staleness.
            sync_app_pi_extensions(&resolved_ext("@ryu/pi-shell", "shell", "// v2\n"))
                .expect("upgrade");
            assert_eq!(fs::read_to_string(&path).expect("read"), "// v2\n");
        });
    }

    /// One resolved stdio server, built through serde so the Claude Code defaults
    /// (`restartOnCrash` / `diagnostics` = true) come from the contract itself.
    fn resolved_go_server() -> crate::lsp::LspResolution {
        let config = serde_json::from_value(json!({
            "command": "gopls",
            "extensionToLanguage": { ".go": "go" },
        }))
        .expect("valid declaration");
        crate::lsp::LspResolution {
            servers: vec![crate::lsp::ResolvedLspServer {
                plugin_id: "com.example.go".to_owned(),
                server_name: "go".to_owned(),
                config,
            }],
            skipped: vec![],
        }
    }

    #[test]
    fn lsp_servers_file_lands_where_the_extension_reads_it() {
        with_temp_dir(|| {
            write_lsp_servers_file(&resolved_go_server()).expect("write");

            // The path is a contract with assets/pi-extensions/ryu-lsp.ts, which
            // reads `<PI_CODING_AGENT_DIR>/extensions/ryu-lsp.json`.
            let path = config_dir().join("extensions").join("ryu-lsp.json");
            let doc: Value =
                serde_json::from_str(&fs::read_to_string(&path).expect("file written"))
                    .expect("valid JSON");
            let entry = &doc["servers"]["com.example.go/go"];
            assert_eq!(entry["command"], "gopls");
            assert_eq!(entry["extensionToLanguage"][".go"], "go");
            assert_eq!(entry["restartOnCrash"], true);
        });
    }

    #[test]
    fn lsp_servers_file_is_written_once_and_removed_when_nothing_is_declared() {
        with_temp_dir(|| {
            let path = config_dir().join("extensions").join("ryu-lsp.json");
            write_lsp_servers_file(&resolved_go_server()).expect("write");
            let mtime = fs::metadata(&path).unwrap().modified().unwrap();

            write_lsp_servers_file(&resolved_go_server()).expect("second write");
            assert_eq!(
                fs::metadata(&path).unwrap().modified().unwrap(),
                mtime,
                "an unchanged table is not rewritten on every Pi spawn"
            );

            // Disabling the last contributing plugin must actually stop the
            // servers, so the stale table is removed rather than left behind.
            write_lsp_servers_file(&crate::lsp::LspResolution::default()).expect("empty write");
            assert!(!path.exists(), "an empty resolution deletes the file");

            // ...and removing an already-absent file is not an error.
            write_lsp_servers_file(&crate::lsp::LspResolution::default()).expect("idempotent");
        });
    }

    #[test]
    fn explicit_cache_control_format_matches_claude_and_qwen_only() {
        // Explicit Anthropic-style cache_control families.
        assert_eq!(
            explicit_cache_control_format("claude-sonnet-4"),
            Some("anthropic")
        );
        assert_eq!(
            explicit_cache_control_format("anthropic/claude-3.5-sonnet"),
            Some("anthropic")
        );
        assert_eq!(
            explicit_cache_control_format("qwen/qwen3-coder-plus"),
            Some("anthropic")
        );
        // Auto-caching or non-caching families: no marker.
        assert_eq!(explicit_cache_control_format("gpt-4o"), None);
        assert_eq!(explicit_cache_control_format("openai/gpt-4o"), None);
        assert_eq!(explicit_cache_control_format("google/gemini-2.5-pro"), None);
        assert_eq!(
            explicit_cache_control_format("deepseek/deepseek-chat"),
            None
        );
        assert_eq!(explicit_cache_control_format("x-ai/grok-4"), None);
    }

    #[test]
    fn gateway_model_entry_stamps_cache_control_for_claude() {
        // A cache-capable non-local id gets the compat flag so Pi emits
        // cache_control breakpoints toward the gateway/OpenRouter.
        let entry = gateway_model_entry("anthropic/claude-sonnet-4", None);
        assert_eq!(
            entry["compat"]["cacheControlFormat"],
            json!("anthropic"),
            "claude entry should opt into anthropic cache_control markers"
        );
        assert_eq!(entry["id"], json!("anthropic/claude-sonnet-4"));

        // An OpenAI id (auto-caches, Pi sends prompt_cache_key) stays bare.
        let openai = gateway_model_entry("gpt-4o", None);
        assert!(openai.get("compat").is_none());
    }

    #[test]
    fn apply_cache_compat_preserves_caller_declared_compat() {
        // Do not clobber an existing compat block or a caller's own format.
        let mut entry = json!({
            "id": "anthropic/claude-sonnet-4",
            "compat": { "cacheControlFormat": "anthropic", "supportsStrictMode": true }
        });
        apply_cache_compat("anthropic/claude-sonnet-4", &mut entry);
        assert_eq!(entry["compat"]["supportsStrictMode"], json!(true));
        assert_eq!(entry["compat"]["cacheControlFormat"], json!("anthropic"));
    }

    #[test]
    /// Managed reaches the HOSTED fleet while the synthetic gateway provider
    /// stays LOCAL — both on the same node — and managed falls back to local when
    /// no fleet coordinates are configured.
    ///
    /// Regression: both used to resolve to the local gateway, so a self-hosted
    /// user who picked "Ryu (managed · included with your plan)" was routed into
    /// their own keyless gateway and could never spend the plan they paid for.
    ///
    /// One test, not three: these mutate PROCESS-GLOBAL env and `cargo test` runs
    /// test fns in parallel, so separate cases race each other's vars.
    #[test]
    fn managed_routes_at_the_fleet_while_byok_stays_local() {
        struct EnvGuard(&'static str, Option<String>);
        impl EnvGuard {
            fn set(k: &'static str, v: &str) -> Self {
                let prev = std::env::var(k).ok();
                std::env::set_var(k, v);
                Self(k, prev)
            }
            fn clear(k: &'static str) -> Self {
                let prev = std::env::var(k).ok();
                std::env::remove_var(k);
                Self(k, prev)
            }
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.1 {
                    Some(v) => std::env::set_var(self.0, v),
                    None => std::env::remove_var(self.0),
                }
            }
        }

        with_temp_dir(|| {
            {
                let _u = EnvGuard::set("RYU_MANAGED_GATEWAY_URL", "https://gw.example.test");
                let _t = EnvGuard::set("RYU_MANAGED_GATEWAY_TOKEN", "rgw_unit_test");

                let managed = gateway_openai_patch_for(Some("openrouter/auto"), true);
                assert_eq!(
                    managed.get("baseUrl").and_then(Value::as_str),
                    Some("https://gw.example.test/v1")
                );
                assert_eq!(
                    managed.get("apiKey").and_then(Value::as_str),
                    Some("rgw_unit_test")
                );

                // BYOK keeps the local gateway even while managed is configured.
                let local = gateway_openai_patch_for(Some("gpt-4o"), false);
                let base = local.get("baseUrl").and_then(Value::as_str).unwrap();
                assert!(
                    base.contains("127.0.0.1"),
                    "BYOK must stay on the local gateway, got {base}"
                );
            }
            {
                // No coordinates ⇒ managed falls back to local (opt-in must not
                // regress a node that never opted in).
                let _u = EnvGuard::clear("RYU_MANAGED_GATEWAY_URL");
                let _t = EnvGuard::clear("RYU_MANAGED_GATEWAY_TOKEN");
                crate::sidecar::gateway::set_managed_fleet_pref(None, None);
                let patch = gateway_openai_patch_for(Some("openrouter/auto"), true);
                let base = patch.get("baseUrl").and_then(Value::as_str).unwrap();
                assert!(
                    base.contains("127.0.0.1"),
                    "expected local fallback, got {base}"
                );
            }
        });
    }

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

    /// A sidecar-declared provider round-trips: registered at the sidecar's loopback
    /// port with ownership stamped, then removed again on deregistration.
    #[test]
    fn sidecar_provider_registers_and_deregisters() {
        with_temp_dir(|| {
            let spec = ProviderRegistrationSpec {
                id: "chatgpt-bridge".to_owned(),
                label: Some("ChatGPT bridge".to_owned()),
                api: None,
                base_path: None,
                models: vec!["gpt-5".to_owned()],
            };
            register_sidecar_provider("com.example.bridge", &spec, 7997, Some("ext-tok")).unwrap();

            let entry = read_models()["providers"]["chatgpt-bridge"].clone();
            assert_eq!(entry["baseUrl"], "http://127.0.0.1:7997/v1");
            assert_eq!(entry["api"], "openai-completions");
            assert_eq!(entry[PROVIDER_OWNER_FIELD], "com.example.bridge");
            assert_eq!(entry["models"][0]["id"], "gpt-5");
            // The ext-token MUST be written as the apiKey: Pi calls baseUrl directly,
            // bypassing the ext-proxy, and the extension-host bootstrap 401s any request
            // without this exact bearer. Dropping it silently breaks every inference call.
            assert_eq!(entry["apiKey"], "ext-tok");

            assert!(deregister_sidecar_provider("com.example.bridge", "chatgpt-bridge").unwrap());
            assert!(read_models()["providers"].get("chatgpt-bridge").is_none());
        });
    }

    /// The boot purge: an unclean exit leaves a sidecar-owned entry holding a loopback
    /// `baseUrl` and the plugin's minted ext token, and Pi dials that `baseUrl`
    /// DIRECTLY — bypassing the ext-proxy and its registration gate — so if any other
    /// process now holds the port it is handed the token and every request body. The
    /// sweep must take every owned entry and leave hand-configured ones alone: the
    /// ownership stamp is the whole authority for touching an entry.
    #[test]
    fn stale_owned_provider_entries_are_purged_at_boot() {
        with_temp_dir(|| {
            let spec = ProviderRegistrationSpec {
                id: "chatgpt-bridge".to_owned(),
                label: None,
                api: None,
                base_path: None,
                models: vec![],
            };
            register_sidecar_provider("com.example.bridge", &spec, 7997, Some("ext-tok")).unwrap();
            // A provider the USER configured by hand — no owner stamp, so not ours.
            let mut mine = Map::new();
            mine.insert(
                "baseUrl".to_owned(),
                Value::String("http://127.0.0.1:11434/v1".to_owned()),
            );
            upsert_provider("my-ollama", mine).unwrap();

            assert_eq!(purge_sidecar_providers().unwrap(), 1);

            let providers = read_models()["providers"].clone();
            assert!(
                providers.get("chatgpt-bridge").is_none(),
                "the stale sidecar entry (and its ext token) must be gone"
            );
            assert_eq!(
                providers["my-ollama"]["baseUrl"], "http://127.0.0.1:11434/v1",
                "an unowned, hand-configured provider must survive untouched"
            );

            // Idempotent: nothing owned left to purge.
            assert_eq!(purge_sidecar_providers().unwrap(), 0);
        });
    }

    // A `purged_sidecar_provider_is_absent_then_restored_on_reregister` test used to
    // sit here, claiming to cover "defect 3, the state half". It did not: every call it
    // made — `register_sidecar_provider`, `purge_sidecar_providers`, `read_models` — is
    // pre-existing behavior covered by the two tests above, so reverting the defect-3
    // fix (the `provides_provider` ⇒ eager-start coercion) in its entirety left it
    // passing. A test that cannot fail for the defect it names is worse than no test:
    // it reads as coverage. The coercion is a `sidecar::manifest_sidecar` concern and is
    // covered there — `provider_declaring_sidecar_starts_eagerly_even_when_lazy` for the
    // predicate, `apply_sidecars_gates_the_register_only_branch_on_starts_eagerly` for
    // the call site that makes the predicate matter.

    /// The load-bearing guard: a plugin may NOT claim a built-in provider id. Allowing
    /// it would let a plugin repoint `openai-codex`'s baseUrl at its own server and
    /// collect the user's live subscription token on the next request.
    #[test]
    fn sidecar_provider_cannot_override_builtin() {
        with_temp_dir(|| {
            let spec = ProviderRegistrationSpec {
                id: "openai-codex".to_owned(),
                label: None,
                api: None,
                base_path: None,
                models: vec![],
            };
            let err = register_sidecar_provider("com.evil.plugin", &spec, 9999, None).unwrap_err();
            assert!(
                err.to_string().contains("built-in"),
                "expected built-in collision refusal, got: {err}"
            );
            assert!(read_models()["providers"].get("openai-codex").is_none());
        });
    }

    /// A plugin may not hijack, or delete, a provider another owner created.
    #[test]
    fn sidecar_provider_respects_ownership() {
        with_temp_dir(|| {
            let spec = ProviderRegistrationSpec {
                id: "shared-id".to_owned(),
                label: None,
                api: None,
                base_path: None,
                models: vec![],
            };
            register_sidecar_provider("com.first.plugin", &spec, 7001, None).unwrap();

            let err =
                register_sidecar_provider("com.second.plugin", &spec, 7002, None).unwrap_err();
            assert!(
                err.to_string().contains("already owned by"),
                "expected ownership refusal, got: {err}"
            );
            // The original entry is untouched.
            assert_eq!(
                read_models()["providers"]["shared-id"]["baseUrl"],
                "http://127.0.0.1:7001/v1"
            );
            // And a non-owner cannot remove it.
            assert!(!deregister_sidecar_provider("com.second.plugin", "shared-id").unwrap());
            assert!(read_models()["providers"].get("shared-id").is_some());
        });
    }

    /// An id that is not a safe token is refused before it can reach the models file.
    #[test]
    fn sidecar_provider_rejects_unsafe_id() {
        with_temp_dir(|| {
            for bad in ["", "../escape", "Has-Caps", "with space", "sla/sh"] {
                let spec = ProviderRegistrationSpec {
                    id: bad.to_owned(),
                    label: None,
                    api: None,
                    base_path: None,
                    models: vec![],
                };
                let err =
                    register_sidecar_provider("com.example.bridge", &spec, 7003, None).unwrap_err();
                assert!(
                    err.to_string().contains("not a safe token"),
                    "id {bad:?} should be refused, got: {err}"
                );
            }
        });
    }

    /// A hand-configured provider (no owner stamp) is never adopted or clobbered.
    #[test]
    fn sidecar_provider_refuses_unowned_existing() {
        with_temp_dir(|| {
            configure_provider(ProviderConfigInput {
                provider: "handmade".to_owned(),
                api_key: None,
                base_url: Some("http://localhost:1234/v1".to_owned()),
                api: None,
                routing: None,
            })
            .unwrap();

            let spec = ProviderRegistrationSpec {
                id: "handmade".to_owned(),
                label: None,
                api: None,
                base_path: None,
                models: vec![],
            };
            let err =
                register_sidecar_provider("com.example.bridge", &spec, 7004, None).unwrap_err();
            assert!(
                err.to_string().contains("unowned provider"),
                "expected unowned refusal, got: {err}"
            );
            assert_eq!(
                read_models()["providers"]["handmade"]["baseUrl"],
                "http://localhost:1234/v1"
            );
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
            let default = declared
                .iter()
                .find(|m| m["id"] == json!(model.clone()))
                .expect("default model declared");
            assert_eq!(default["api"], json!("openai-completions"));
            assert_eq!(default["contextWindow"], json!(128_000));
            assert_eq!(default["maxTokens"], json!(8_192));
            assert_eq!(
                default["cost"],
                json!({
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0
                })
            );
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

    /// The managed default that stops a brand-new chat opening with the whole
    /// machine's skills list already sitting in it as an assistant message.
    ///
    /// pi-acp's `getQuietStartup` defaults to **false**, so without this key it
    /// builds a "## Skills" listing of all three skill roots (including the
    /// hard-coded `~/.agents/skills`) on every `session/new` and emits it as an
    /// `agent_message_chunk` — which Core then persists as an assistant row.
    /// The `skills: ["!**"]` write next to it does NOT cover this: the bridge's
    /// banner builder never consults the skills setting at all.
    #[test]
    fn managed_defaults_quiet_the_pi_startup_banner() {
        with_temp_dir(|| {
            ensure_managed_defaults().unwrap();
            assert_eq!(
                read_settings().extra.get(PI_QUIET_STARTUP),
                Some(&json!(true))
            );
        });
    }

    /// Same "an explicit user choice stands" guard the `skills` write has — and
    /// it has to hold for the legacy key too, because `getQuietStartup` reads
    /// `quietStartup` first but falls back to `quietStart`. Writing our default
    /// alongside a user's `quietStart: false` would take precedence over it and
    /// silently reverse their choice, which is the one failure mode a "only when
    /// unset" guard exists to prevent.
    #[test]
    fn managed_defaults_respect_an_explicit_startup_banner_choice() {
        for key in [PI_QUIET_STARTUP, PI_QUIET_STARTUP_LEGACY] {
            with_temp_dir(|| {
                let _ = ensure_dir();
                fs::write(settings_path(), format!(r#"{{"{key}":false}}"#)).unwrap();
                ensure_managed_defaults().unwrap();
                let settings = read_settings();
                assert_eq!(
                    settings.extra.get(key),
                    Some(&json!(false)),
                    "{key}: the user's choice must survive"
                );
                assert!(
                    !(key == PI_QUIET_STARTUP_LEGACY
                        && settings.extra.contains_key(PI_QUIET_STARTUP)),
                    "the legacy key is what pi falls back to; writing the current \
                     one next to it would override the user's `false`"
                );
            });
        }
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
    fn gateway_patch_upgrades_bare_default_model_metadata() {
        with_temp_dir(|| {
            let default_model = default_gateway_model();
            upsert_provider(
                "openai",
                json!({
                    "api": "openai-completions",
                    "models": [
                        { "id": default_model },
                        { "id": "gpt-4o" }
                    ]
                })
                .as_object()
                .cloned()
                .unwrap(),
            )
            .unwrap();
            ensure_gateway_models_json().unwrap();
            let models = read_models();
            let declared = models["providers"]["openai"]["models"].as_array().unwrap();
            let default = declared
                .iter()
                .find(|m| m["id"] == json!(default_model))
                .expect("default model declared");
            assert_eq!(default["name"], json!("Gemma 4 E2B IT Q4_K_M"));
            assert_eq!(default["api"], json!("openai-completions"));
            assert_eq!(default["contextWindow"], json!(128_000));
            assert_eq!(default["maxTokens"], json!(8_192));
            assert!(declared.iter().any(|m| m == &json!({ "id": "gpt-4o" })));
        });
    }

    /// A pool row activates like the managed row, but defaults to a model that
    /// routes to ITS OWN pool.
    ///
    /// The default model is the whole point. Core cannot pin a provider — every
    /// Gateway-routed row writes the same `defaultProvider: "openai"` pin — so the
    /// MODEL ID is the only thing that decides which supply the turn bills. A pool
    /// row that fell back to the global `openrouter/auto` would present itself as
    /// "Ryu Fast" and then spend the retail pool.
    #[test]
    fn a_pool_row_defaults_to_a_model_that_routes_to_its_own_pool() {
        with_temp_dir(|| {
            let view = apply(PiConfigInput {
                provider: MANAGED_CLOUDFLARE_ID.to_owned(),
                model: None,
                thinking_level: None,
                api_key: None,
                base_url: None,
                api: None,
            })
            .unwrap();
            assert_eq!(view.provider, MANAGED_CLOUDFLARE_ID);
            // Always Gateway-routed: a pool row's egress must stay metered, or the
            // spend never reaches the pool it was supposed to draw from.
            assert_eq!(view.routing, "gateway");
            assert_eq!(
                view.model.as_deref(),
                Some("@cf/meta/llama-3.1-8b-instruct")
            );
            assert_ne!(view.model.as_deref(), Some(MANAGED_DEFAULT_MODEL));
            let settings = read_settings();
            assert_eq!(settings.default_provider.as_deref(), Some("openai"));
        });
    }

    /// Every pool row reaches the desktop as `managed`, routing-locked, and
    /// carrying its pool id.
    ///
    /// `managed` is the line that turns the composer on: it binds the row to the
    /// pool catalog, which is where the row's label, its balance badge and its
    /// upsell escape come from. Before this, `managed` was an equality against one
    /// id, so a second managed provider was invisible to all three.
    #[test]
    fn pool_rows_reach_the_catalog_as_managed_and_routing_locked() {
        with_temp_dir(|| {
            let catalog = catalog();
            let providers = catalog["providers"].as_array().unwrap();
            for (id, pool) in [
                (MANAGED_CLOUDFLARE_ID, "cloudflare"),
                (MANAGED_BEDROCK_ID, "bedrock"),
                (MANAGED_OPENROUTER_ID, "openrouter"),
            ] {
                let row = providers
                    .iter()
                    .find(|p| p["id"] == json!(id))
                    .unwrap_or_else(|| panic!("{id} is in the catalog"));
                assert_eq!(row["managed"], json!(true), "{id} is managed");
                assert_eq!(row["routingLocked"], json!(true), "{id} is locked");
                assert_eq!(row["creditPool"], json!(pool), "{id} carries its pool");
                // The LABEL is duplicated: Settings renders Core's string raw
                // while the composer reads the pool catalog's. Nothing enforces
                // the match at compile time (they are different languages), so it
                // is pinned here against the labels in
                // `packages/auth/src/lib/credit-pools.ts`. A drift shows the same
                // supply under two names on two screens.
                let expected_label = match pool {
                    "cloudflare" => Some("Ryu Fast"),
                    "bedrock" => Some("Ryu Frontier"),
                    // The retail row keeps its own longer label: its pool is
                    // `visible: false` in the catalog, so it has no user-facing
                    // pool name to borrow.
                    _ => None,
                };
                if let Some(expected) = expected_label {
                    assert_eq!(
                        row["label"],
                        json!(expected),
                        "{id}'s label must match CREDIT_POOLS byte-for-byte"
                    );
                }
                assert_eq!(row["configured"], json!(true), "{id} needs no key");
            }
            // A BYOK row is none of those things.
            let byok = providers.iter().find(|p| p["id"] == json!("anthropic"));
            if let Some(byok) = byok {
                assert_eq!(byok["managed"], json!(false));
                assert_eq!(byok["creditPool"], json!(""));
            }
        });
    }

    /// A pool row keeps its curated model list instead of the Gateway's merged one.
    ///
    /// Gateway discovery returns every configured provider's models in one flat
    /// list with no provider or pool on any entry. Offering that under "Ryu Fast"
    /// would put ids in front of the user that route somewhere else entirely and
    /// silently bill a pool they hold nothing in.
    #[test]
    fn a_pool_row_does_not_take_the_gateways_merged_model_list() {
        with_temp_dir(|| {
            assert!(resolve_provider_discovery(MANAGED_CLOUDFLARE_ID, None).is_none());
            assert!(resolve_provider_discovery(MANAGED_BEDROCK_ID, None).is_none());
            // The retail managed row still does — it has no curated list.
            assert!(resolve_provider_discovery(MANAGED_OPENROUTER_ID, None).is_some());
        });
    }

    /// A pool row's suggested models must reach that pool's supply, and must
    /// never carry ANOTHER pool's prefix.
    ///
    /// This is the money guard. Core cannot pin a provider — every Gateway-routed
    /// row writes the same `defaultProvider: "openai"` pin — so the model id's
    /// PREFIX is the only thing deciding which supply a turn bills, and a wrong id
    /// bills a pool the user did not choose with no error anywhere.
    ///
    /// Two rules, because the pools are not symmetric:
    ///
    ///  - A SEGREGATED pool (cloudflare, bedrock) must be reached by prefix. Its
    ///    ids are useless otherwise: with the prefix absent they fall through to
    ///    the fleet's `default_provider`, which is the retail pool.
    ///  - The RESIDUAL pool (openrouter) is that fallback, so its ids legitimately
    ///    carry no prefix — `anthropic/claude-sonnet-4` is an OpenRouter id that
    ///    routes by falling through, and demanding a prefix of it would be
    ///    demanding a router row that must not exist (an `anthropic/` builtin
    ///    would re-home the id onto a provider that cannot even serve its dialect).
    ///    What it must NOT do is carry a segregated pool's prefix, which would
    ///    silently spend a donated allowance on retail traffic.
    ///
    /// The prefixes are restated here as literals ON PURPOSE. Importing them would
    /// make this test agree with a router change automatically, and agreeing
    /// automatically is exactly what must not happen when the disagreement is
    /// somebody's money.
    #[test]
    fn every_pool_row_model_reaches_its_own_supply() {
        // Mirrors the segregated rows of `builtin_prefixes()` in
        // crates/gateway/router/src/lib.rs. There is deliberately NO row for
        // `vertex` or `openai-credits` — see the PROVIDERS table.
        let segregated: &[(&str, &[&str])] = &[
            ("cloudflare", &["@cf/"]),
            ("bedrock", &["anthropic.", "amazon.", "meta.", "mistral."]),
        ];
        /// The pool a request lands in when no builtin prefix claims the id.
        const RESIDUAL_POOL: &str = "openrouter";

        for meta in PROVIDERS.iter().filter(|m| !m.credit_pool.is_empty()) {
            assert!(
                !meta.suggested_models.is_empty(),
                "`{}` has no suggested models, and a pool row gets no discovery — \
                 the picker would show an empty list",
                meta.id
            );
            let own = segregated
                .iter()
                .find(|(pool, _)| *pool == meta.credit_pool);
            assert!(
                own.is_some() || meta.credit_pool == RESIDUAL_POOL,
                "provider `{}` claims pool `{}`, which the router has no builtin \
                 prefix for and which is not the residual pool — its traffic would \
                 fall through to `default_provider` and debit the wrong supply",
                meta.id,
                meta.credit_pool
            );
            for model in meta.suggested_models {
                if let Some((_, prefixes)) = own {
                    assert!(
                        prefixes.iter().any(|p| model.starts_with(p)),
                        "`{}` suggests `{model}`, which carries no prefix routing to \
                         `{}` — that turn would fall through to the residual pool",
                        meta.id,
                        meta.credit_pool
                    );
                } else {
                    // The residual row: no prefix required, but it must not steal
                    // a segregated pool's.
                    for (pool, prefixes) in segregated {
                        assert!(
                            !prefixes.iter().any(|p| model.starts_with(p)),
                            "`{}` (residual) suggests `{model}`, which carries a \
                             `{pool}` prefix — retail traffic would silently spend \
                             the donated {pool} allowance",
                            meta.id
                        );
                    }
                }
            }
        }
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
            assert!(PROVIDERS
                .iter()
                .find(|provider| provider.id == MANAGED_OPENROUTER_ID)
                .is_some_and(|provider| {
                    provider
                        .suggested_models
                        .contains(&OPENROUTER_PARETO_CODE_MODEL_ID)
                }));
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
    fn subscription_account_credential_rejects_non_subscription_providers() {
        with_temp_dir(|| {
            let error = subscription_account_credential("openai", "acct-1")
                .expect_err("API-key providers must not enter the usage reader");
            assert!(error.to_string().contains("is not a subscription provider"));
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
                api: None,
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

    #[test]
    fn disabling_a_model_records_only_that_model() {
        with_temp_dir(|| {
            let catalog = set_model_enabled(ModelEnabledInput {
                provider: "openai".to_owned(),
                model: "gpt-4o".to_owned(),
                enabled: false,
            })
            .expect("toggle");
            let openai = catalog["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == "openai")
                .expect("openai row");
            assert_eq!(openai["modelOverrides"]["gpt-4o"], json!(false));
            // Untoggled models stay absent — absent means enabled, so an existing
            // config keeps every model it had before the feature existed.
            assert!(openai["modelOverrides"].as_object().unwrap().len() == 1);

            // Re-enabling records `true` rather than deleting, which is what lets
            // the desktop show the switch as explicitly on.
            let catalog = set_model_enabled(ModelEnabledInput {
                provider: "openai".to_owned(),
                model: "gpt-4o".to_owned(),
                enabled: true,
            })
            .expect("re-enable");
            let openai = catalog["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == "openai")
                .expect("openai row");
            assert_eq!(openai["modelOverrides"]["gpt-4o"], json!(true));
        });
    }

    #[test]
    fn agent_model_overrides_are_scoped_and_never_look_like_a_provider() {
        with_temp_dir(|| {
            let catalog = set_model_enabled(ModelEnabledInput {
                provider: format!("{AGENT_OVERRIDE_PREFIX}claude"),
                model: "claude-haiku-4-5".to_owned(),
                enabled: false,
            })
            .expect("toggle an agent's model");

            // Surfaced under its own map, keyed by the bare agent id.
            assert_eq!(
                catalog["agentModelOverrides"]["claude"]["claude-haiku-4-5"],
                json!(false)
            );

            // …and NOT as a custom provider. A leaked `agent:claude` row would
            // render an unconfigured provider in the picker and the providers tab,
            // and would be accepted as a routing target.
            let ids: Vec<&str> = catalog["providers"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|p| p["id"].as_str())
                .collect();
            assert!(
                !ids.iter().any(|id| id.starts_with(AGENT_OVERRIDE_PREFIX)),
                "agent scopes must not appear as providers: {ids:?}"
            );
            assert!(
                !custom_provider_ids()
                    .iter()
                    .any(|id| id.starts_with(AGENT_OVERRIDE_PREFIX)),
                "agent scopes must not be treated as custom providers"
            );
        });
    }

    #[test]
    fn provider_discovery_rejects_loopback_before_connecting() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let error = runtime
            .block_on(fetch_models(
                "http://127.0.0.1:1/models",
                DiscoveryAuth::None,
                false,
            ))
            .expect_err("custom provider checks must reject loopback");
        assert!(
            error.to_string().contains("screen discovery endpoint"),
            "unexpected loopback rejection: {error}"
        );
    }
}
