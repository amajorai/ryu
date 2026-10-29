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

#[cfg(test)]
mod shipped_lsp_runtime_tests;

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use ryu_kernel_contracts::schema::{ProviderRegistrationSpec, PROVIDER_OWNER_FIELD};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// models.dev-backed dynamic model catalog (replaces hardcoded model lists).
pub(crate) mod models_dev;

/// Plugin-contributed Pi extensions (`contributes.pi_extensions`) — the resolver
/// and privilege gate behind [`sync_app_pi_extensions`].
pub mod accounts;
pub mod app_extensions;
pub mod chatgpt_plan;
pub mod kiro_oauth;
pub mod native_accounts;
pub mod oauth_login;
pub mod qoder_cli;
pub(crate) mod sdk_account_routing;
pub(crate) mod secret_env;
pub mod session_accounts;
pub mod transcripts;

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
/// the org's Ryu $ wallet (`apps/gateway/src/pipeline/debit.rs`), and the Gateway
/// maps its default `openrouter/auto` model onto the OpenRouter provider. No BYOK.
pub const MANAGED_OPENROUTER_ID: &str = "managed-openrouter";

/// RETIRED per-tier managed rows ("Ryu Fast", "Ryu Frontier", "Ryu Vision",
/// "Ryu Reasoning", "Ryu Code"). The picker now offers ONE managed provider,
/// Ryu Router ([`MANAGED_OPENROUTER_ID`]), with models under their real names;
/// free credit is spent automatically when Ryu can serve the pick from its own
/// supply (the Gateway's `own_supply` routing over the control plane's
/// published own-supply table).
///
/// The ids are kept only so a saved selection naming one still resolves: see
/// [`canonical_provider_id`] and the spawn-time migration in
/// [`ensure_managed_defaults`]. They are never offered.
pub const MANAGED_CLOUDFLARE_ID: &str = "managed-cloudflare";
pub const MANAGED_BEDROCK_ID: &str = "managed-bedrock";
pub const MANAGED_VERTEX_ID: &str = "managed-vertex";
pub const MANAGED_OPENAI_CREDITS_ID: &str = "managed-openai-credits";
pub const MANAGED_ANTHROPIC_CREDITS_ID: &str = "managed-anthropic-credits";
const LEGACY_MANAGED_TIER_IDS: &[&str] = &[
    MANAGED_CLOUDFLARE_ID,
    MANAGED_BEDROCK_ID,
    MANAGED_VERTEX_ID,
    MANAGED_OPENAI_CREDITS_ID,
    MANAGED_ANTHROPIC_CREDITS_ID,
];

/// The provider id a (possibly saved) selection means today: a retired
/// per-tier managed row resolves to the single Ryu Router row.
pub(crate) fn canonical_provider_id(id: &str) -> &str {
    if LEGACY_MANAGED_TIER_IDS.contains(&id) {
        MANAGED_OPENROUTER_ID
    } else {
        id
    }
}

/// The Ryu Router id a saved retired-tier model maps to: a Ryu alias
/// (`ryu-code/standard`) becomes the real model id it names
/// (`anthropic/claude-sonnet-4.5`) when Ryu Router lists it, else the managed
/// default. `None` for anything that is not a retired alias.
fn migrate_legacy_tier_model(model: &str) -> Option<String> {
    let (slot, upstream) = ryu_gw_router::pool_model_alias_route(model)?;
    Some(
        ryu_gw_router::pool_model_equivalent_id(slot, upstream)
            .unwrap_or(MANAGED_DEFAULT_MODEL)
            .to_owned(),
    )
}

/// The Ryu Router models free credit currently pays for — the picker's "Free"
/// tag. The control plane's public projection (`/api/own-supply/free-models`),
/// refreshed every 10 minutes by `sidecar::control_plane::
/// run_free_models_refresh_loop` and cached on disk: only models an admin has
/// enabled on one of Ryu's own provider accounts, whose account still has
/// allowance. EMPTY before the first fetch, so the tag under-promises rather
/// than marking a model the Gateway would not serve for free. Ids only: the
/// supplier behind a model never reaches Core.
fn ryu_router_free_models() -> Vec<String> {
    ryu_model_catalog::ryu_free_models::current_ids(&ryu_free_models_cache_path())
}

/// Where Core keeps the last good Free-id list: `<data dir>/cache/`, through
/// the data-dir layout (a regenerable cache).
pub(crate) fn ryu_free_models_cache_path() -> std::path::PathBuf {
    crate::paths::cache_path(ryu_model_catalog::ryu_free_models::CACHE_FILE)
}

/// Native ChatGPT-account provider backed by the Login with ChatGPT session
/// flow. This is deliberately distinct from [`openai-codex`], whose Pi runtime
/// owns the Codex client path.
pub const CHATGPT_PROVIDER_ID: &str = "chatgpt";
pub const CHATGPT_AUTH_KEY: &str = "openai-chatgpt";
pub const CHATGPT_PLAN_PROVIDER_ID: &str = "chatgpt-plan";
pub const CHATGPT_PLAN_AUTH_KEY: &str = "openai-chatgpt-plan";
pub const CLAUDE_AUTH_KEY: &str = "anthropic";
pub const KIRO_PROVIDER_ID: &str = "kiro";
const CLAUDE_PROXY_ACCESS: &str = "sk-ant-oat-ryu-local-proxy";

fn claude_proxy_credential() -> Value {
    json!({
        "type": "oauth",
        "access": CLAUDE_PROXY_ACCESS,
        "refresh": "ryu-local-proxy",
        "expires": 4_102_444_800_000_u64
    })
}

fn is_claude_proxy_credential(auth_key: &str, credential: &Value) -> bool {
    auth_key == CLAUDE_AUTH_KEY
        && credential.get("access").and_then(Value::as_str) == Some(CLAUDE_PROXY_ACCESS)
}
// Pi 1.x's `openai-codex` catalog, led by its default (`gpt-6.1-sol`). A model
// a user already saved is still declared (see `chatgpt_provider_patch`).
const CHATGPT_SUGGESTED_MODELS: &[&str] = &["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"];
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
// `@earendil-works/pi-ai` extracts an account id from the Codex adapter's
// `apiKey` before it sends a request. The actual ChatGPT bearer is intentionally
// resolved inside Core, so this non-secret JWT-shaped sentinel satisfies that
// adapter precondition while Core authenticates the loopback request with the
// separate node-token header below. Split the literal so generic secret scanners
// do not mistake this documented adapter sentinel for a credential.
const CHATGPT_PROXY_API_KEY: &str = concat!(
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.",
    "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicnl1LWxvY2FsIn19",
    ".",
);

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
    crate::required_update_runtime::pi_config_root(
        &crate::sidecar::download_manager::ryu_dir(),
        &crate::paths::config_dir(),
    )
    .expect("managed Pi configuration was validated during runtime admission")
}

/// `config_dir()` as a string, creating the directory first. This is the value
/// passed to the Pi subprocess as `PI_CODING_AGENT_DIR`.
pub fn config_dir_str() -> String {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    // Pi writes plaintext transcripts here: keep the folders owner-only and
    // apply the transcript age cap (at most once a day).
    transcripts::maintain_once_a_day(dir.clone());
    dir.to_string_lossy().into_owned()
}

/// Name of the legacy limited-agent config directory, which used to sit
/// inside [`config_dir`]. Removed on the next limited spawn.
const LEGACY_LIMITED_AGENT_DIR: &str = "agent-limited";

/// The folder holding the config directories of managed Pis spawned for agents
/// with limited model provider access: a sibling of [`config_dir`] named
/// `<name>-limited` (`runtimes/pi-agent-limited` by default). It must never sit
/// inside the managed dir, so the OS sandbox can hide the whole managed dir
/// (the user's provider keys and sign-ins) from a limited agent while its own
/// config stays readable. Each agent gets its own folder in it
/// ([`limited_agent_dir`]); the OS sandbox hides the others' from a confined
/// agent, so one agent can never plant code another agent's Pi loads.
pub fn limited_agents_root() -> PathBuf {
    limited_agents_root_for(&config_dir())
}

fn limited_agents_root_for(managed: &std::path::Path) -> PathBuf {
    match managed.file_name() {
        Some(name) => {
            let mut limited = name.to_os_string();
            limited.push("-limited");
            managed.with_file_name(limited)
        }
        None => crate::paths::runtime_dir("pi-agent-limited"),
    }
}

/// Prefix of a per-agent limited config folder name; the rest is
/// [`LIMITED_AGENT_DIR_HASH_LEN`] hex digits of the agent id's SHA-256.
const LIMITED_AGENT_DIR_PREFIX: &str = "agent-";
const LIMITED_AGENT_DIR_HASH_LEN: usize = 32;

/// The folder name of `agent_id`'s limited Pi config: a hash, so any agent id
/// maps to one safe path component.
fn limited_agent_dir_name(agent_id: Option<&str>) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(agent_id.unwrap_or_default().as_bytes());
    let mut name = hex::encode(digest);
    name.truncate(LIMITED_AGENT_DIR_HASH_LEN);
    format!("{LIMITED_AGENT_DIR_PREFIX}{name}")
}

fn is_limited_agent_dir_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.strip_prefix(LIMITED_AGENT_DIR_PREFIX))
        .is_some_and(|hash| {
            hash.len() == LIMITED_AGENT_DIR_HASH_LEN
                && hash
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// The config directory a managed Pi spawned for `agent_id` with limited model
/// provider access reads, inside [`limited_agents_root`].
pub fn limited_agent_dir(agent_id: Option<&str>) -> PathBuf {
    limited_agents_root().join(limited_agent_dir_name(agent_id))
}

/// Remove `agent_id`'s limited Pi config folder, including the saved Pi
/// sessions and debug log kept there across rebuilds. Used when the agent is
/// deleted; a folder that does not exist is not an error.
pub fn remove_limited_agent_dir(agent_id: &str) -> Result<()> {
    let dir = limited_agent_dir(Some(agent_id));
    anyhow::ensure!(
        dir.parent() == Some(limited_agents_root().as_path())
            && dir.file_name().is_some_and(is_limited_agent_dir_name),
        "{} is not a limited-agent Pi config dir",
        dir.display()
    );
    remove_entry(&dir)
}

/// Whether `path` is one of the config dirs Core hands a managed Pi: the
/// managed dir in Gateway routing, or a limited agent's own dir.
pub fn is_managed_agent_dir(path: &std::path::Path) -> bool {
    (path == config_dir() && is_gateway_routing())
        || (path.parent() == Some(limited_agents_root().as_path())
            && path.file_name().is_some_and(is_limited_agent_dir_name))
}

/// The `PI_CODING_AGENT_DIR` for a managed Pi spawned for `agent_id`.
///
/// `None` provider access (unrestricted) reads the managed dir itself. A
/// limited agent gets its own [`limited_agent_dir`] instead, rebuilt on every
/// spawn: the managed settings and extensions, and a `models.json` holding only
/// the Gateway provider pin, with no `auth.json`. The managed dir carries the
/// user's active provider keys (see [`materialize_active_accounts`]); a Pi
/// reading it could switch to one of those providers and call it directly,
/// where the agent's signed provider access is never checked. Call after
/// [`ensure_managed_defaults`], in Gateway routing only.
pub fn agent_config_dir_str(
    agent_id: Option<&str>,
    provider_access: Option<&[String]>,
) -> Result<String> {
    let Some(provider_access) = provider_access else {
        return Ok(config_dir_str());
    };
    let source = config_dir();
    let root = limited_agents_root_for(&source);
    match fs::remove_dir_all(source.join(LEGACY_LIMITED_AGENT_DIR)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(%error, "could not remove the legacy limited-agent Pi config dir");
        }
    }
    prepare_limited_agents_root(&root)?;
    let target = root.join(limited_agent_dir_name(agent_id));
    let model = limited_agent_model_choice(provider_access).model;
    write_limited_agent_dir(
        &source,
        &target,
        Some(model.as_str()),
        gateway_openai_patch(Some(model.as_str())),
    )?;
    Ok(target.to_string_lossy().into_owned())
}

/// Rebuild the limited agent's Pi config dir `dir` in place right before its
/// Pi starts. [`agent_config_dir_str`] already rebuilds it when the route is
/// resolved, but the agent's earlier Pi can write to its own dir until this new
/// one starts, and Pi loads code and prompts from it. The default model the
/// route chose stays when it is one [`limited_agent_model_choice`] can pick:
/// the managed default, a suggested model of a built-in provider, or the
/// zero-key local model. Anything else falls back to the local model (Gateway
/// still enforces the agent's provider access). Refuses a path that is not a
/// limited agent's own folder.
pub fn refresh_limited_agent_dir(dir: &std::path::Path) -> Result<()> {
    let source = config_dir();
    let root = limited_agents_root_for(&source);
    anyhow::ensure!(
        dir.parent() == Some(root.as_path())
            && dir.file_name().is_some_and(is_limited_agent_dir_name),
        "{} is not a limited-agent Pi config dir",
        dir.display()
    );
    let written: Option<String> = fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<PiSettings>(&raw).ok())
        .and_then(|settings| settings.default_model);
    let local = default_gateway_model();
    let managed = read_settings().default_model;
    let model = match written {
        Some(model)
            if model == local
                || Some(&model) == managed.as_ref()
                || is_suggested_provider_model(&model) =>
        {
            model
        }
        _ => local,
    };
    prepare_limited_agents_root(&root)?;
    write_limited_agent_dir(
        &source,
        dir,
        Some(model.as_str()),
        gateway_openai_patch(Some(model.as_str())),
    )
}

/// Where the default model of a limited agent's managed Pi comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LimitedModelSource {
    /// The managed default, on a model provider the agent may use.
    AllowedProvider,
    /// The managed default, served from Ryu's own supply (Ryu credits).
    RyuCredits,
    /// A suggested model of a signed-in provider the agent may use, because
    /// the managed default is on one it may not.
    FirstAllowedModel,
    /// A model on the keyless local engine.
    Local,
}

/// The default model a limited agent's managed Pi starts on, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitedModelChoice {
    pub model: String,
    pub source: LimitedModelSource,
}

/// The default model a limited agent's Pi starts on, for an agent whose model
/// provider access is `provider_access` (Gateway registry ids; empty for "Its
/// own identity"). See [`choose_limited_agent_model`].
pub fn limited_agent_model_choice(provider_access: &[String]) -> LimitedModelChoice {
    choose_limited_agent_model(
        read_settings().default_model.as_deref(),
        provider_access,
        &ryu_router_free_models(),
        allowed_provider_candidates,
        default_gateway_model(),
    )
}

/// Pick a limited agent's default model so Gateway's agent provider check
/// (which this mirrors, see [`crate::agent_access::provider_needs_no_user_credential`])
/// lets its turns through:
///
/// 1. the managed default, when the slot it routes to is in
///    `provider_access`, or needs none of the user's credentials (Ryu's own
///    supply or the local engine), or it is a Ryu Router pick Ryu serves from
///    its own supply on free credit (`free_models`, the picker's "Free" list;
///    the Auto Router whenever that list is not empty);
/// 2. otherwise the first suggested model of a signed-in provider whose slot
///    is in `provider_access` (`candidates` lists them in catalog order);
/// 3. otherwise `local`, the zero-key local model.
///
/// The slot a model id routes to is read from the Gateway's compiled-in rules
/// ([`ryu_gw_router::builtin_route`]); an id only an operator's model map or
/// the Gateway's default provider would place is never assumed allowed.
fn choose_limited_agent_model(
    managed: Option<&str>,
    provider_access: &[String],
    free_models: &[String],
    candidates: impl FnOnce() -> Vec<String>,
    local: String,
) -> LimitedModelChoice {
    let allowed = |slot: &str| provider_access.iter().any(|id| id == slot);
    if let Some(model) = managed.map(str::trim).filter(|model| !model.is_empty()) {
        let slot = ryu_gw_router::builtin_route(model);
        let source = if model == local {
            Some(LimitedModelSource::Local)
        } else {
            match slot.as_deref() {
                Some(slot) if allowed(slot) => Some(LimitedModelSource::AllowedProvider),
                Some(ryu_gw_router::LOCAL_SLOT | ryu_gw_router::CLASSIFY_SLOT) => {
                    Some(LimitedModelSource::Local)
                }
                Some(slot) if crate::agent_access::provider_needs_no_user_credential(slot) => {
                    Some(LimitedModelSource::RyuCredits)
                }
                None | Some(RYU_ROUTER_SLOT) if ryu_router_serves_free(model, free_models) => {
                    Some(LimitedModelSource::RyuCredits)
                }
                _ => None,
            }
        };
        if let Some(source) = source {
            return LimitedModelChoice {
                model: model.to_owned(),
                source,
            };
        }
    }
    let fallback = candidates()
        .into_iter()
        .find(|model| ryu_gw_router::builtin_route(model).is_some_and(|slot| allowed(&slot)));
    match fallback {
        Some(model) => LimitedModelChoice {
            model,
            source: LimitedModelSource::FirstAllowedModel,
        },
        None => LimitedModelChoice {
            model: local,
            source: LimitedModelSource::Local,
        },
    }
}

/// The Gateway slot Ryu Router picks route to (the managed OpenRouter).
const RYU_ROUTER_SLOT: &str = "openrouter";

/// Whether Ryu serves the Ryu Router pick `model` from its own supply on free
/// credit: a pick on the "Free" list, or the Auto Router while any model is
/// free (the Gateway then serves it with an own-supply pool's default model).
fn ryu_router_serves_free(model: &str, free_models: &[String]) -> bool {
    if model == OPENROUTER_AUTO_MODEL_ID {
        return !free_models.is_empty();
    }
    free_models.iter().any(|free| free == model)
}

/// The suggested models of every signed-in built-in provider, in catalog
/// order, leaving out Ryu's managed rows and models the user turned off. A
/// provider with no suggested models is skipped before its sign-in is read.
fn allowed_provider_candidates() -> Vec<String> {
    PROVIDERS
        .iter()
        .filter(|meta| !meta.suggested_models.is_empty())
        .filter(|meta| !is_managed_or_gateway(meta.id) && meta.auth_kind != "none")
        .filter(|meta| provider_configured(meta))
        .flat_map(|meta| enabled_suggested_models(meta.id))
        .collect()
}

/// Whether `model` is a suggested model of a built-in provider (one
/// [`allowed_provider_candidates`] could pick).
fn is_suggested_provider_model(model: &str) -> bool {
    PROVIDERS
        .iter()
        .filter(|meta| !is_managed_or_gateway(meta.id) && meta.auth_kind != "none")
        .any(|meta| meta.suggested_models.contains(&model))
}

/// Create the limited agents' root as a real, private directory, and remove
/// whatever in it is not a per-agent folder (the files of the older shared
/// layout, or anything an agent left there). A symlinked root is refused.
fn prepare_limited_agents_root(root: &std::path::Path) -> Result<()> {
    match fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => anyhow::bail!(
            "the limited-agent Pi config folder {} is not a directory",
            root.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).context("create the limited-agent Pi config folder")?;
        }
        Err(error) => {
            return Err(error).context("inspect the limited-agent Pi config folder");
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(root, fs::Permissions::from_mode(0o700));
    }
    for entry in fs::read_dir(root)
        .context("read the limited-agent Pi config folder")?
        .flatten()
    {
        let is_agent_dir = is_limited_agent_dir_name(&entry.file_name())
            && entry.file_type().is_ok_and(|kind| kind.is_dir());
        if !is_agent_dir {
            remove_entry(&entry.path())?;
        }
    }
    Ok(())
}

/// Remove a file, symlink or directory tree without following a symlink.
fn remove_entry(path: &std::path::Path) -> Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("remove stale Pi config entry {}", path.display()))
        }
    }
}

/// Files Core writes at the top of a limited agent's Pi config dir. Everything
/// else there, except Pi's own data below, is removed on every spawn: Pi also
/// loads code and prompts from its config dir (`extensions/<dir>/`,
/// `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`,
/// `themes/`, `tools/`, `bin/`), so nothing the agent wrote there may survive
/// into its next start.
const LIMITED_AGENT_DIR_FILES: &[&str] = &["settings.json", "models.json"];
const LIMITED_AGENT_EXTENSIONS_DIR: &str = "extensions";
/// What Pi itself writes there that holds data, never code or config: its
/// saved sessions and its debug log. They are kept, so rebuilding the folder
/// for one start does not wipe the sessions of a Pi already running for the
/// same agent, or the ones a later `session/load` resumes. Only a real folder
/// or file is kept; a symlink under either name is removed.
const LIMITED_AGENT_SESSIONS_DIR: &str = "sessions";
const LIMITED_AGENT_DEBUG_LOG: &str = "pi-debug.log";

/// Write the limited-agent Pi config dir `target` from the managed dir
/// `source`, from scratch. The only provider is `openai`, set to `gateway_pin`
/// (the Gateway URL and the per-process bearer template), the default provider
/// is forced to it, so the only model route left is the Gateway, and the
/// default model is `default_model`.
fn write_limited_agent_dir(
    source: &std::path::Path,
    target: &std::path::Path,
    default_model: Option<&str>,
    gateway_pin: Map<String, Value>,
) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => remove_entry(target)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("inspect the limited-agent Pi config dir"),
    }
    fs::create_dir_all(target).context("create the limited-agent Pi config dir")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(target, fs::Permissions::from_mode(0o700));
    }
    // Only Core's own files survive: no stale credential file, and nothing the
    // agent planted for its Pi to load.
    for entry in fs::read_dir(target)
        .context("read the limited-agent Pi config dir")?
        .flatten()
    {
        let name = entry.file_name();
        let kind = entry.file_type().ok();
        let keep = match name.to_str() {
            Some(LIMITED_AGENT_EXTENSIONS_DIR | LIMITED_AGENT_SESSIONS_DIR) => {
                kind.is_some_and(|kind| kind.is_dir())
            }
            Some(name) if LIMITED_AGENT_DIR_FILES.contains(&name) => {
                kind.is_some_and(|kind| kind.is_file())
            }
            Some(LIMITED_AGENT_DEBUG_LOG) => kind.is_some_and(|kind| kind.is_file()),
            _ => false,
        };
        if !keep {
            remove_entry(&entry.path())?;
        }
    }

    let mut settings: PiSettings = fs::read_to_string(source.join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    settings.default_provider = Some("openai".to_owned());
    if let Some(model) = default_model {
        settings.default_model = Some(model.to_owned());
    }
    let body = serde_json::to_string_pretty(&settings).context("serialize settings.json")?;
    crate::atomic_file::write_atomic(&target.join("settings.json"), body.as_bytes())
        .context("write the limited-agent Pi settings.json")?;

    // Keep the managed pin's model list; replace every connection field.
    let managed: Value = fs::read_to_string(source.join("models.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));
    let mut pin = Map::new();
    if let Some(models) = managed["providers"]["openai"].get("models") {
        pin.insert("models".to_owned(), models.clone());
    }
    pin.extend(gateway_pin);
    let models = json!({ "providers": { "openai": Value::Object(pin) } });
    let body = serde_json::to_string_pretty(&models).context("serialize models.json")?;
    write_secret_file(&target.join("models.json"), &body)?;

    // The managed extensions (Ryu's own and enabled plugins') are flat files.
    // Mirror them exactly: Pi loads every file and folder here, so one left
    // behind by a since-disabled plugin, or put there by the agent, would
    // otherwise run in its Pi.
    let extensions = target.join(LIMITED_AGENT_EXTENSIONS_DIR);
    fs::create_dir_all(&extensions).context("create the limited-agent Pi extensions dir")?;
    let shipped: Vec<_> = fs::read_dir(source.join(LIMITED_AGENT_EXTENSIONS_DIR))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|entry| entry.file_name())
                .collect()
        })
        .unwrap_or_default();
    for entry in fs::read_dir(&extensions)
        .context("read the limited-agent Pi extensions dir")?
        .flatten()
    {
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if !is_file || !shipped.contains(&entry.file_name()) {
            remove_entry(&entry.path())?;
        }
    }
    for name in &shipped {
        fs::copy(
            source.join(LIMITED_AGENT_EXTENSIONS_DIR).join(name),
            extensions.join(name),
        )
        .with_context(|| format!("copy Pi extension {}", name.to_string_lossy()))?;
    }
    Ok(())
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

/// Write a file that may contain credentials. Replaced atomically (temp file +
/// fsync + rename) so a crash mid-write cannot leave Pi with a truncated
/// `auth.json`/`models.json`; the temp file is created `0600` on Unix, so the
/// result is never world-readable, even briefly, mirroring Pi's own `auth.json`
/// convention.
fn write_secret_file(path: &std::path::Path, body: &str) -> Result<()> {
    crate::atomic_file::write_atomic(path, body.as_bytes())
        .with_context(|| format!("write {}", path.display()))
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
    // Atomic: a torn write would parse as empty, and the next write would then
    // persist defaults over every unmanaged key the user had in settings.json.
    crate::atomic_file::write_atomic(&settings_path(), body.as_bytes())
        .context("write settings.json")
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
    if id == CHATGPT_PLAN_PROVIDER_ID {
        return ROUTING_DIRECT;
    }
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
    if qoder_cli::is_provider(id) && mode != ROUTING_DIRECT {
        anyhow::bail!("Qoder CLI profiles use direct Core routing");
    }
    if id == CHATGPT_PLAN_PROVIDER_ID {
        if mode != ROUTING_DIRECT {
            anyhow::bail!("ChatGPT plan usage uses its direct OpenAI connection");
        }
        return Ok(());
    }
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
        return Some(canonical_provider_id(active).to_owned());
    }
    let gateway = settings.extra.get(ROUTING_KEY).and_then(Value::as_str) != Some(ROUTING_DIRECT);
    if gateway {
        Some(GATEWAY_PROVIDER_ID.to_owned())
    } else {
        settings.default_provider.clone()
    }
}

/// Ryu's subscription row is a product identity; Pi registers the Claude
/// transport under its native `anthropic` provider id.
fn pi_provider_id(provider: &str) -> &str {
    match provider {
        "claude-pro-max" => "anthropic",
        _ => provider,
    }
}

/// Build the `models.json` provider patch that pins Pi's built-in `openai`
/// provider at the local Ryu Gateway.
///
/// **Why this exists:** Pi's built-in `openai` provider defaults to the OpenAI
/// **Responses API** at `api.openai.com` and does **not** honor the
/// `OPENAI_BASE_URL` env var, so the spawn-time env injection alone never reaches
/// the Gateway. This override redirects it: `baseUrl` = the Gateway's `/v1`,
/// `api` = `openai-responses`, and `apiKey` = the Gateway token.
///
/// `model` (the chosen `defaultModel`) is **declared** in the provider's `models`
/// array. This is essential: a Ryu/local model id like `gemma-4-E2B-it-Q4_K_M` is
/// not one of Pi's built-in `openai` models, so without declaring it Pi falls back
/// to its built-in default (`gpt-5.5`), whose model-level API can override the
/// provider setting. Declared models use Responses by default; models that need
/// explicit OpenRouter cache-control breakpoints use Chat Completions so Pi can
/// emit those markers.
///
/// The declared `models` array is a **union**: already-declared ids + the zero-key
/// local default ([`default_gateway_model`]) + `model`. Merging (instead of
/// replacing) means switching models in the composer never removes an earlier
/// model from Pi's available list, so the user can always switch back.
fn gateway_openai_patch(model: Option<&str>) -> Map<String, Value> {
    gateway_openai_patch_for(model, false)
}

/// Build the managed Pi entry for the native ChatGPT provider.
///
/// Pi's Codex API adapter emits the Responses wire format. The base URL is a
/// loopback Core route rather than `chatgpt.com` so Core can refresh the
/// selected ChatGPT session and add the account id on every request without
/// materializing a bearer token into `models.json`.
fn chatgpt_provider_patch(model: Option<&str>) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert(
        "baseUrl".to_owned(),
        Value::String(format!(
            "{}/api/pi-config/chatgpt",
            crate::sidecar::gateway::core_self_url().trim_end_matches('/')
        )),
    );
    patch.insert(
        "api".to_owned(),
        Value::String("openai-codex-responses".to_owned()),
    );
    patch.insert(
        "apiKey".to_owned(),
        Value::String(CHATGPT_PROXY_API_KEY.to_owned()),
    );
    let mut headers = Map::new();
    headers.insert(
        "x-ryu-node-token".to_owned(),
        Value::String(secret_env::reference(secret_env::NODE_TOKEN_ENV)),
    );
    patch.insert("headers".to_owned(), Value::Object(headers));

    let mut entries: Vec<Value> = read_models()["providers"]
        .get(CHATGPT_PROVIDER_ID)
        .and_then(|provider| provider.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|entry| {
                    entry
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|id| json!({ "id": id }))
                })
                .collect()
        })
        .unwrap_or_default();

    for candidate in CHATGPT_SUGGESTED_MODELS
        .iter()
        .copied()
        .chain(model.into_iter())
    {
        if !entries
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(candidate))
        {
            entries.push(json!({ "id": candidate }));
        }
    }
    patch.insert("models".to_owned(), Value::Array(entries));
    patch
}

fn claude_provider_patch() -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert(
        "baseUrl".to_owned(),
        Value::String(format!(
            "{}/api/pi-config/claude",
            crate::sidecar::gateway::core_self_url().trim_end_matches('/')
        )),
    );
    patch.insert(
        "api".to_owned(),
        Value::String("anthropic-messages".to_owned()),
    );
    let mut headers = Map::new();
    headers.insert(
        "x-ryu-node-token".to_owned(),
        Value::String(secret_env::reference(secret_env::NODE_TOKEN_ENV)),
    );
    headers.insert(
        "x-ryu-session-id".to_owned(),
        Value::String("$RYU_PI_HOST_CONVERSATION_ID".to_owned()),
    );
    patch.insert("headers".to_owned(), Value::Object(headers));
    patch
}

fn chatgpt_plan_provider_patch(model: &str) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert(
        "baseUrl".to_owned(),
        json!(format!(
            "{}/api/pi-config/chatgpt-plan",
            crate::sidecar::gateway::core_self_url().trim_end_matches('/')
        )),
    );
    patch.insert("api".to_owned(), json!("openai-responses"));
    patch.insert("apiKey".to_owned(), json!("ryu-chatgpt-plan-proxy"));
    patch.insert(
        "headers".to_owned(),
        json!({
            "x-ryu-node-token": secret_env::reference(secret_env::NODE_TOKEN_ENV),
            "x-ryu-session-id": "$RYU_PI_HOST_CONVERSATION_ID"
        }),
    );
    patch.insert("models".to_owned(), json!([{ "id": model }]));
    patch
}

pub fn ensure_chatgpt_plan_models_json() -> Result<()> {
    let settings = read_settings();
    if active_provider_id_from(&settings).as_deref() == Some(CHATGPT_PLAN_PROVIDER_ID) {
        if let Some(model) = settings
            .default_model
            .as_deref()
            .filter(|model| !model.is_empty())
        {
            upsert_provider(CHATGPT_PLAN_PROVIDER_ID, chatgpt_plan_provider_patch(model))?;
        }
    }
    Ok(())
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
    // Pi resolves this template from the process environment (verified against
    // its native resolve-config-value implementation). A shared models.json must
    // never overwrite the per-agent credential installed at ACP spawn.
    // The fleet bearer itself travels in the Pi process environment
    // ([`secret_env::FLEET_TOKEN_ENV`]), never in this shared file.
    //
    // When Core signs the agent's scoped Gateway bearer itself, Pi talks to
    // Core's ACP inference proxy, which presents the current bearer on every
    // request, so a long-lived Pi survives the bearer's remint. Pi does not
    // template `baseUrl`, so the proxy is pinned here rather than per spawn.
    let (v1, token) = match fleet {
        Some((url, _token)) => (
            format!("{}/v1", url.trim_end_matches('/')),
            secret_env::reference(secret_env::FLEET_TOKEN_ENV),
        ),
        None if crate::sidecar::gateway::scoped_inference_proxy_enabled() => (
            crate::sidecar::gateway::acp_inference_proxy_v1(),
            "${OPENAI_API_KEY}".to_owned(),
        ),
        None => (
            format!(
                "{}/v1",
                crate::sidecar::gateway::configured_gateway_url().trim_end_matches('/')
            ),
            "${OPENAI_API_KEY}".to_owned(),
        ),
    };
    let mut patch = Map::new();
    patch.insert("baseUrl".to_owned(), Value::String(v1));
    patch.insert(
        "api".to_owned(),
        Value::String("openai-responses".to_owned()),
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
        let api = if explicit_cache_control_format(id).is_some() {
            // Pi's OpenAI Responses adapter does not emit the per-block cache
            // breakpoints OpenRouter needs for Claude, supported Qwen routes,
            // and Gemini versions that require explicit caching.
            // Keep those models on Chat Completions so compat.cacheControlFormat
            // can add the markers; other models retain the Responses path.
            "openai-completions"
        } else {
            "openai-responses"
        };
        entry["api"] = Value::String(api.to_owned());
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
    obj.insert(
        "api".to_owned(),
        Value::String("openai-responses".to_owned()),
    );
    // The bundled Gemma 4 model is multimodal when its companion `mmproj`
    // artifact is present. Keep that capability in Pi's model metadata even
    // when an older settings file already declared the model as text-only;
    // otherwise Pi replaces the image with an "image omitted" placeholder
    // before the request reaches the local Gateway.
    obj.insert("input".to_owned(), json!(["text", "image"]));
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
/// automatically (OpenAI, most DeepSeek, Grok, Gemini 2.5+) need no marker, and Pi
/// already sends `prompt_cache_key` on the OpenAI path, so we only stamp the
/// flag for the families that expose Anthropic-style *explicit* caching through
/// the Gateway/OpenRouter: Claude, supported Alibaba Qwen models, DeepSeek
/// V3.2, and older Gemini models. This matches OpenRouter's explicit cache-control support.
/// Returns the format string, or `None` when the model does not use explicit
/// `cache_control` markers. Qwen matching is intentionally limited to routes
/// OpenRouter documents as cacheable; snapshot models must not receive markers.
fn explicit_cache_control_format(id: &str) -> Option<&'static str> {
    let lid = id.to_ascii_lowercase();
    let claude = lid.contains("claude") || lid.contains("anthropic");
    let alibaba_cache_model = [
        "deepseek-v3.2",
        "qwen3-max",
        "qwen-plus",
        "qwen3.6-plus",
        "qwen3-coder-plus",
        "qwen3-coder-flash",
    ]
    .iter()
    .any(|family| lid.contains(family));
    let anthropic_style = claude || alibaba_cache_model;
    let legacy_gemini = lid.contains("gemini") && !gemini_has_implicit_caching(&lid);
    (anthropic_style || legacy_gemini).then_some("anthropic")
}

fn gemini_has_implicit_caching(id: &str) -> bool {
    let Some(version) = id
        .split("gemini-")
        .nth(1)
        .and_then(|tail| tail.split('-').next())
    else {
        return false;
    };
    let mut parts = version.split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    major > 2 || (major == 2 && minor >= 5)
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

/// Keep the native ChatGPT provider's loopback route and node bearer current
/// after a token rotation or profile-port change. The user OAuth credential is
/// intentionally resolved at request time by the Core proxy, not written here.
pub fn ensure_chatgpt_models_json() -> Result<()> {
    if active_provider_id_from(&read_settings()).as_deref() == Some(CHATGPT_PROVIDER_ID) {
        let model = read_settings().default_model;
        upsert_provider(
            CHATGPT_PROVIDER_ID,
            chatgpt_provider_patch(model.as_deref()),
        )?;
    }
    Ok(())
}

pub fn ensure_claude_models_json() -> Result<()> {
    let oauth_active = if let Some(vault) = accounts::global() {
        let scope = accounts::provider_scope(CLAUDE_AUTH_KEY);
        vault
            .active_info(&scope)?
            .is_some_and(|active| active.kind == accounts::KIND_OAUTH)
    } else {
        false
    };
    let mut models = read_models();
    let original = models.clone();
    update_claude_model_route(&mut models, oauth_active)?;
    if models != original {
        write_models(&models)?;
    }
    Ok(())
}

/// Pi carries only a local proxy key; the OAuth credential stays in the vault.
pub fn ensure_kiro_models_json(model: Option<&str>) -> Result<()> {
    let mut patch = Map::new();
    patch.insert(
        "baseUrl".to_owned(),
        json!(format!(
            "{}/api/pi-config/kiro/v1",
            crate::sidecar::gateway::core_self_url().trim_end_matches('/')
        )),
    );
    patch.insert("api".to_owned(), json!("openai-completions"));
    patch.insert("apiKey".to_owned(), json!("ryu-local-proxy"));
    patch.insert("headers".to_owned(), json!({"x-ryu-node-token": secret_env::reference(secret_env::NODE_TOKEN_ENV), "x-ryu-session-id": "$RYU_PI_HOST_CONVERSATION_ID"}));
    let mut models = read_models()["providers"][KIRO_PROVIDER_ID]["models"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(id) = model.filter(|id| !id.trim().is_empty()) {
        if !models.iter().any(|entry| entry["id"].as_str() == Some(id)) {
            models.push(json!({"id":id, "name":id, "input":["text"]}));
        }
    }
    if !models.is_empty() {
        patch.insert("models".to_owned(), Value::Array(models));
    }
    upsert_provider(KIRO_PROVIDER_ID, patch)
}

fn update_claude_model_route(models: &mut Value, oauth_active: bool) -> Result<()> {
    let providers = models["providers"]
        .as_object_mut()
        .expect("providers object ensured by read_models");
    if oauth_active {
        let entry = providers
            .entry(CLAUDE_AUTH_KEY.to_owned())
            .or_insert_with(|| json!({}));
        let object = entry
            .as_object_mut()
            .context("Anthropic model entry is not an object")?;
        object.remove("apiKey");
        for (key, value) in claude_provider_patch() {
            if key == "headers" {
                let headers = object
                    .entry("headers".to_owned())
                    .or_insert_with(|| json!({}));
                let headers = headers
                    .as_object_mut()
                    .context("Anthropic headers are not an object")?;
                headers.extend(value.as_object().expect("Claude patch headers").clone());
            } else {
                object.insert(key, value);
            }
        }
        return Ok(());
    }
    if let Some(object) = providers
        .get_mut(CLAUDE_AUTH_KEY)
        .and_then(Value::as_object_mut)
    {
        if object
            .get("baseUrl")
            .and_then(Value::as_str)
            .is_some_and(|url| url.ends_with("/api/pi-config/claude"))
        {
            object.insert(
                "baseUrl".to_owned(),
                Value::String("https://api.anthropic.com".to_owned()),
            );
            if let Some(headers) = object.get_mut("headers").and_then(Value::as_object_mut) {
                headers.remove("x-ryu-node-token");
                headers.remove("x-ryu-session-id");
            }
            return Ok(());
        }
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

/// Pi's default tool selection (`settings.json` `defaultTools`). Entries of the
/// form `+name` / `-name` adjust Pi's built-in defaults instead of replacing them
/// (Pi 0.99+), so the managed default below adds one tool and leaves the rest of
/// Pi's selection — and every later Pi default change — intact.
const PI_DEFAULT_TOOLS: &str = "defaultTools";

/// Pi's `codemode` tool: the model writes a short script that calls Pi's tools
/// (and the deferred `mcp__ryu__*` tools) in parallel inside Pi's QuickJS
/// sandbox, instead of one tool call per round trip. Nested calls still pass
/// through every extension `tool_call` handler, so `ryu-plan`'s plan-mode and
/// command guards apply to them unchanged.
const PI_CODEMODE_DEFAULT_TOOL: &str = "+codemode";

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
/// 5. **Codemode on** — `defaultTools: ["+codemode"]` ([`PI_CODEMODE_DEFAULT_TOOL`]).
///    Written only when the user has not set `defaultTools`; `"-codemode"` (or
///    any explicit list) in the managed `settings.json` turns it off.
pub fn ensure_managed_defaults() -> Result<()> {
    // Reflect the active account into Pi's auth.json / models.json before every
    // spawn so the files Pi reads always carry the SELECTED account, never a
    // stale one from a switch or a removed account.
    materialize_active_accounts();
    let mut settings = read_settings();
    let mut dirty = false;
    if settings.default_provider.as_deref() == Some("claude-pro-max") {
        // Older Ryu builds wrote the product row id as Pi's provider id. Pi
        // registers `anthropic`; preserve the product selection separately.
        if settings.extra.get(ROUTING_KEY).and_then(Value::as_str) == Some(ROUTING_DIRECT) {
            settings.default_provider = Some("anthropic".to_owned());
            settings
                .extra
                .entry(ACTIVE_KEY.to_owned())
                .or_insert_with(|| Value::String("claude-pro-max".to_owned()));
        } else {
            settings.default_provider = Some("openai".to_owned());
        }
        dirty = true;
    }
    // Retired per-tier managed rows → the single Ryu Router row, and their
    // Ryu aliases → the real model id the user now picks (else the default).
    let legacy_active = settings
        .extra
        .get(ACTIVE_KEY)
        .and_then(Value::as_str)
        .is_some_and(|active| LEGACY_MANAGED_TIER_IDS.contains(&active.trim()));
    if legacy_active {
        settings.extra.insert(
            ACTIVE_KEY.to_owned(),
            Value::String(MANAGED_OPENROUTER_ID.to_owned()),
        );
        dirty = true;
    }
    if let Some(migrated) = settings
        .default_model
        .as_deref()
        .and_then(migrate_legacy_tier_model)
    {
        settings.default_model = Some(migrated);
        dirty = true;
    }
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

    if !settings.extra.contains_key(PI_DEFAULT_TOOLS) {
        settings.extra.insert(
            PI_DEFAULT_TOOLS.to_owned(),
            json!([PI_CODEMODE_DEFAULT_TOOL]),
        );
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
    ensure_chatgpt_models_json()?;
    ensure_chatgpt_plan_models_json()?;
    ensure_claude_models_json()?;
    // The three extensions that CANNOT become plugins. Each `ensure_pi_*` fn's own
    // doc says why in full; in one line each:
    //
    // - `ryu-mcp` is the flagship agent's ONLY road to Ryu's tools (pi-acp ignores
    //   `session/new` MCP servers; the extension registers Core's bridge with Pi's
    //   own MCP client and keeps the `ryu_call_tool` proxy), so a toggle for it
    //   would be a switch that silently strips every tool from the default agent.
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

/// Every Pi extension Ryu itself ships, as `(file name, source)`: Core's own
/// three plus the built-in plugins' embedded ones. The managed runtime readiness
/// probe loads these against a candidate Pi before it may be activated.
pub(crate) fn shipped_pi_extensions() -> Vec<(String, &'static str)> {
    let core = [
        ("ryu-mcp.ts", PI_MCP_EXTENSION_SRC),
        ("ryu-lsp.ts", PI_LSP_EXTENSION_SRC),
        ("ryu-plan.ts", PI_PLAN_EXTENSION_SRC),
    ]
    .map(|(name, source)| (name.to_owned(), source));
    let plugins =
        crate::plugin_manifest::builtin_pi_extension_sources().filter_map(|(path, source)| {
            let name = std::path::Path::new(path).file_name()?.to_str()?.to_owned();
            Some((name, source))
        });
    core.into_iter().chain(plugins).collect()
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
        settings.default_provider = Some(pi_provider_id(p).to_owned());
        settings
            .extra
            .insert(ACTIVE_KEY.to_owned(), Value::String(p.to_owned()));
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
    // The node bearer is never written here: a literal `x-ryu-node-token` (from
    // an older build) becomes the env reference on every write.
    let mut value = value.clone();
    secret_env::template_node_token_headers(&mut value);
    let body = serde_json::to_string_pretty(&value).context("serialize models.json")?;
    // Provider secrets are `${RYU_PI_…}` references (see [`secret_env`]); a
    // legacy literal `apiKey` may remain until the vault imports it, so the
    // file stays owner-only.
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
        // The minted token stays in Core's memory and reaches Pi in its spawn
        // environment; models.json carries only the `${RYU_PI_EXT_…}` reference.
        secret_env::remember_ext_token(id, key);
        patch.insert(
            "apiKey".to_owned(),
            Value::String(secret_env::reference(&secret_env::ext_token_env(id))),
        );
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
            secret_env::forget_ext_token(id);
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
        secret_env::forget_ext_token(id);
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
    set_auth_key_with_vault(auth_key, key, accounts::global())
}

fn set_auth_key_with_vault(
    auth_key: &str,
    key: &str,
    vault: Option<&accounts::AccountVault>,
) -> Result<()> {
    ensure_dir()?;
    // Fail closed: the sealed vault is the only place the key is kept, and
    // auth.json receives a reference Pi resolves from its spawn environment.
    let vault = vault.context(
        "The sealed provider account store is unavailable, so the API key was not saved",
    )?;
    vault_upsert_credential(
        Some(vault),
        &accounts::provider_scope(auth_key),
        "API key",
        accounts::KIND_API_KEY,
        json!({ "type": "api_key", "key": key }),
    )?;
    let mut auth = read_auth();
    auth.insert(auth_key.to_owned(), auth_key_reference(auth_key));
    let body = serde_json::to_string_pretty(&auth).context("serialize auth.json")?;
    write_secret_file(&auth_path(), &body)?;
    Ok(())
}

/// The `auth.json` entry for a built-in provider whose API key is sealed in the
/// vault: Pi resolves the reference from its spawn environment.
fn auth_key_reference(auth_key: &str) -> Value {
    json!({
        "type": "api_key",
        "key": secret_env::reference(&secret_env::provider_key_env(auth_key)),
    })
}

/// Seal a custom provider's API key in the vault and return the reference that
/// replaces it in `models.json`. Fails closed when the vault is unavailable.
fn seal_custom_provider_key(
    vault: Option<&accounts::AccountVault>,
    provider: &str,
    key: &str,
) -> Result<String> {
    let vault = vault.context(
        "The sealed provider account store is unavailable, so the API key was not saved",
    )?;
    vault_upsert_credential(
        Some(vault),
        &accounts::provider_scope(provider),
        "API key",
        accounts::KIND_API_KEY,
        Value::String(key.to_owned()),
    )?;
    Ok(secret_env::reference(&secret_env::provider_key_env(
        provider,
    )))
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
        .and_then(secret_env::resolve)
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

fn auth_has_oauth(auth_key: &str) -> bool {
    read_auth().get(auth_key).is_some_and(|entry| {
        entry.get("type").and_then(Value::as_str) == Some("oauth")
            && ["access", "refresh"].iter().any(|field| {
                entry
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            })
    })
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

// Serialize legacy import and explicit credential capture to avoid duplicate accounts.
static CREDENTIAL_CAPTURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Capture a credential and make it active, reusing an identical API key in this scope.
/// An initialized vault must accept the credential before its active slot is replaced.
fn vault_upsert_credential(
    vault: Option<&accounts::AccountVault>,
    scope: &str,
    base_label: &str,
    kind: &str,
    credential: Value,
) -> Result<()> {
    let Some(vault) = vault else {
        return Ok(());
    };
    let _capture = CREDENTIAL_CAPTURE_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Provider account storage is unavailable"))?;
    if kind == accounts::KIND_API_KEY {
        if let Some(account_id) = existing_api_key_account(vault, scope, &credential)
            .map_err(|_| anyhow::anyhow!("Could not read saved provider accounts"))?
        {
            if vault
                .set_active(scope, &account_id)
                .map_err(|_| anyhow::anyhow!("Could not select the saved provider account"))?
            {
                return Ok(());
            }
        }
    }
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let label = vault_account_label(vault, scope, base_label);
    vault
        .upsert(scope, &account_id, &label, kind, Some(credential))
        .map_err(|_| anyhow::anyhow!("Could not store the provider account"))
}

fn existing_api_key_account(
    vault: &accounts::AccountVault,
    scope: &str,
    credential: &Value,
) -> Result<Option<String>> {
    let key = credential
        .as_str()
        .or_else(|| credential.get("key").and_then(Value::as_str));
    let Some(key) = key else {
        return Ok(None);
    };
    for account in vault.list(scope)? {
        if account.kind != accounts::KIND_API_KEY {
            continue;
        }
        if let Some(saved) = vault.credential(scope, &account.account_id)? {
            let saved_key = saved
                .as_str()
                .or_else(|| saved.get("key").and_then(Value::as_str));
            if saved_key == Some(key) {
                return Ok(Some(account.account_id));
            }
        }
    }
    Ok(None)
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

fn active_auth_kind(auth_key: &str, kind: &str) -> bool {
    let scope = accounts::provider_scope(auth_key);
    if let Some(active) = accounts::global()
        .and_then(|vault| vault.active_info(&scope).ok())
        .flatten()
    {
        return active.kind == kind;
    }
    if kind == accounts::KIND_OAUTH {
        auth_has_oauth(auth_key)
    } else {
        auth_has_key(auth_key)
    }
}

/// Migrate credentials already sitting in Pi's plaintext files (`auth.json`
/// api-key + oauth entries, `models.json` custom-provider `apiKey`s) into the
/// sealed vault, one account per slot, active. Idempotent: a slot the vault
/// already holds is left alone, so re-running after a partial failure only
/// imports what is missing. Called at boot and before materialization.
pub(crate) fn sync_plaintext_into_vault() {
    let Ok(_capture) = CREDENTIAL_CAPTURE_LOCK.lock() else {
        return;
    };
    let Some(vault) = accounts::global() else {
        return;
    };
    for (auth_key, entry) in read_auth() {
        if auth_key == CHATGPT_PLAN_AUTH_KEY || is_claude_proxy_credential(&auth_key, &entry) {
            continue;
        }
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
                .filter(|s| !s.is_empty() && !secret_env::is_reference(s))
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
    if let Some(key) = entry.get("key").and_then(Value::as_str) {
        // A `${RYU_PI_…}` reference is Ryu's own pointer at the vault, not a
        // credential to import.
        return (!key.is_empty() && !secret_env::is_reference(key)).then(|| entry.clone());
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
    let _guard = ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    materialize_active_accounts_unlocked();
}

fn materialize_active_accounts_unlocked() {
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
        if auth_key == CHATGPT_PLAN_AUTH_KEY
            || auth_key == KIRO_PROVIDER_ID
            || qoder_cli::is_provider(auth_key)
        {
            auth_dirty |= auth.remove(auth_key).is_some();
            continue;
        }
        match vault.active_credential(&scope) {
            Ok(Some((account_id, credential))) => {
                let credential =
                    match materializable_account_credential(vault, &scope, &account_id, credential)
                    {
                        Ok(Some(credential)) => credential,
                        Ok(None) | Err(_) => {
                            auth_dirty |= auth.remove(auth_key).is_some();
                            continue;
                        }
                    };
                // Custom-provider scopes store a bare key string; everything else
                // stores the Pi entry object. A real API key is never copied out:
                // the file gets a `${RYU_PI_KEY_…}` reference and the key reaches
                // Pi in its spawn environment (see [`secret_env`]). Templates and
                // proxy sentinels are not secrets and are written as they are.
                if let Some(key) = credential.as_str() {
                    let stored = if secret_env::api_key_of(&credential).is_some() {
                        secret_env::reference(&secret_env::provider_key_env(auth_key))
                    } else {
                        key.to_owned()
                    };
                    if let Some(providers) = models["providers"].as_object_mut() {
                        if let Some(entry) = providers.get_mut(auth_key) {
                            if let Some(obj) = entry.as_object_mut() {
                                if obj.get("apiKey").and_then(Value::as_str) != Some(&stored) {
                                    obj.insert("apiKey".to_owned(), Value::String(stored));
                                    models_dirty = true;
                                }
                            }
                        }
                    }
                } else {
                    let pi_credential = if auth_key == CLAUDE_AUTH_KEY
                        && credential_kind(&credential) == accounts::KIND_OAUTH
                    {
                        claude_proxy_credential()
                    } else if secret_env::api_key_of(&credential).is_some() {
                        auth_key_reference(auth_key)
                    } else {
                        // OAuth: Pi refreshes it itself and takes no template, so
                        // the entry stays plaintext (owner-only file).
                        credential
                    };
                    auth.insert(auth_key.to_owned(), pi_credential);
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
    // An older build wrote the node bearer literally; rewrite it as a reference.
    models_dirty |= secret_env::template_node_token_headers(&mut models);
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
    if let Err(error) = ensure_claude_models_json() {
        tracing::warn!(error = %error, "materialize: could not update Claude transport");
    }
}

fn materializable_account_credential(
    vault: &accounts::AccountVault,
    scope: &str,
    account_id: &str,
    credential: Value,
) -> Result<Option<Value>> {
    if credential_kind(&credential) == accounts::KIND_OAUTH
        && vault.needs_reauth(scope, account_id)?
    {
        return Ok(None);
    }
    Ok(Some(credential))
}

// ── OAuth subscription token refresh ──────────────────────────────────────────

/// Seconds of skew before an access token's `expires_at` at which we proactively
/// refresh. A turn that starts inside this window would likely 401 partway
/// through, so we mint a fresh token first.
const OAUTH_REFRESH_SKEW_SECS: u64 = 60;

/// Pi-owned OAuth flows that may need a pre-turn refresh. Pi's provider module
/// supplies the actual exchange contract; Core never holds vendor client IDs or
/// refresh URLs. `openai` is retained for an older OAuth auth.json entry.
const OAUTH_REFRESH_KEYS: &[&str] = &[
    KIRO_PROVIDER_ID,
    "anthropic",
    "openai-codex",
    CHATGPT_AUTH_KEY,
    CHATGPT_PLAN_AUTH_KEY,
    "openai",
    "github-copilot",
    "kimi-coding",
    "radius",
    "openrouter",
    "xai",
];

// Refresh tokens may be single-use. Serialize reads and writes so concurrent
// turns cannot exchange the same token twice and then overwrite a rotated one.
pub(crate) static OAUTH_REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACCOUNT_SELECTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn subscription_needs_refresh(auth_key: &str, entry: &Value, now: u64) -> bool {
    let has_refresh = entry
        .get("refresh")
        .and_then(Value::as_str)
        .is_some_and(|refresh| !refresh.trim().is_empty());
    let skew = if auth_key == CHATGPT_PLAN_AUTH_KEY && !has_refresh {
        // OpenAI can issue an access token without a renewable session. Keep
        // that token usable until its actual expiry, rather than requesting
        // another login during the proactive refresh window.
        0
    } else {
        if session_accounts::is_sdk_oauth_auth_key(auth_key) {
            // Pi resolves OAuth with a five-minute minimum validity window.
            // Refresh in Core first so its access-only session projection never
            // rotates the sealed account's refresh token inside the child.
            360
        } else {
            OAUTH_REFRESH_SKEW_SECS
        }
    };
    oauth_expires_at(entry).is_none_or(|expiry| expiry <= now.saturating_add(skew))
}

/// Merge a refreshed `{access, refresh?, expires_at}` into the captured sealed
/// account before updating Pi's `auth.json` (`0600` on Unix), if that account is
/// still active. Other fields (`type`, account id, scopes, …) are retained. A
/// failed vault write cannot resurrect a consumed refresh token on spawn.
fn persist_oauth_refresh(
    auth_key: &str,
    original: &Value,
    account_id: Option<&str>,
    access: &str,
    refresh: Option<&str>,
    expires_at: Option<u64>,
) -> Result<()> {
    persist_oauth_refresh_with_vault(
        auth_key,
        original,
        account_id,
        access,
        refresh,
        expires_at,
        accounts::global(),
    )
}

fn persist_oauth_refresh_with_vault(
    auth_key: &str,
    original: &Value,
    account_id: Option<&str>,
    access: &str,
    refresh: Option<&str>,
    expires_at: Option<u64>,
    vault: Option<&accounts::AccountVault>,
) -> Result<()> {
    ensure_dir()?;
    let _selection_guard = ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    let mut auth = read_auth();
    let refreshed_entry = merged_oauth_credential(original, access, refresh, expires_at)?;
    // Refresh tokens can be single-use. Persist the rotated credential in the
    // sealed source of truth first, so a failed Pi-file write can be repaired by
    // the next materialization instead of resurrecting the consumed token.
    if let (Some(vault), Some(account_id)) = (vault, account_id) {
        let scope = accounts::provider_scope(auth_key);
        if !vault.replace_credential(&scope, account_id, original, refreshed_entry.clone())? {
            anyhow::bail!("OAuth account changed while refreshing; retry with the current account");
        }
        if vault
            .active_info(&scope)?
            .as_ref()
            .map(|info| info.account_id.as_str())
            != Some(account_id)
        {
            return Ok(());
        }
    } else {
        let has_saved_accounts = if let Some(vault) = vault {
            vault.count(&accounts::provider_scope(auth_key))? > 0
        } else {
            false
        };
        if has_saved_accounts || auth.get(auth_key) != Some(original) {
            anyhow::bail!("OAuth login changed while refreshing; retry with the current account");
        }
    }
    auth.insert(auth_key.to_owned(), refreshed_entry);
    let body = serde_json::to_string_pretty(&auth).context("serialize auth.json")?;
    write_secret_file(&auth_path(), &body)?;
    Ok(())
}

fn merged_oauth_credential(
    original: &Value,
    access: &str,
    refresh: Option<&str>,
    expires_at: Option<u64>,
) -> Result<Value> {
    let mut updated = original.clone();
    let obj = updated
        .as_object_mut()
        .context("refresh_oauth: stored auth entry is not a JSON object")?;
    obj.insert("access".to_owned(), Value::String(access.to_owned()));
    if let Some(refresh) = refresh {
        obj.insert("refresh".to_owned(), Value::String(refresh.to_owned()));
    }
    if let Some(expires_at) = expires_at {
        obj.insert("expires_at".to_owned(), json!(expires_at));
        // Pi reads `expires` in milliseconds. Keep both spellings in sync.
        obj.insert("expires".to_owned(), json!(expires_at.saturating_mul(1000)));
    }
    Ok(updated)
}

/// Whether a provider's saved logins have a Pi OAuth refresh flow Core can run.
pub(crate) fn provider_supports_oauth_refresh(provider_id: &str) -> bool {
    provider_meta(provider_id).is_some_and(|meta| OAUTH_REFRESH_KEYS.contains(&meta.auth_key))
}

/// Refresh one sealed OAuth account without changing the active Pi account or
/// writing another account into the shared `auth.json` slot. The returned
/// credential is for an account-bound dispatcher to use directly.
pub async fn refresh_subscription_account(provider_id: &str, account_id: &str) -> Result<Value> {
    let meta = provider_meta(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{provider_id}'"))?;
    if !OAUTH_REFRESH_KEYS.contains(&meta.auth_key) {
        anyhow::bail!("provider '{provider_id}' has no supported OAuth refresh flow");
    }
    let vault = accounts::global()
        .ok_or_else(|| anyhow::anyhow!("the pi-accounts vault is not initialized"))?;
    refresh_subscription_account_with_vault(vault, meta.auth_key, account_id).await
}

/// Capture the currently selected subscription account for one outbound
/// request. Refresh and use that exact account even if another login becomes
/// active while the network exchange is in flight.
pub async fn subscription_request_credential(provider_id: &str) -> Result<Option<Value>> {
    let meta = provider_meta(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{provider_id}'"))?;
    if meta.auth_kind != "subscription" || meta.auth_key.is_empty() {
        anyhow::bail!("provider '{provider_id}' is not a subscription provider");
    }
    if let Some(vault) = accounts::global() {
        return subscription_request_credential_with_vault(vault, meta.auth_key).await;
    }
    // Legacy installations can still have a managed Pi auth file before the
    // sealed account vault is initialized.
    refresh_oauth(meta.auth_key).await?;
    subscription_active_credential(provider_id)
}

/// Resolve one explicit sealed OAuth login for a request-local dispatcher.
/// This never changes the account selected in Pi's shared auth file.
pub async fn subscription_request_credential_for_account(
    provider_id: &str,
    account_id: &str,
) -> Result<Value> {
    let meta = provider_meta(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{provider_id}'"))?;
    if !OAUTH_REFRESH_KEYS.contains(&meta.auth_key) {
        anyhow::bail!("provider '{provider_id}' has no supported OAuth refresh flow");
    }
    let vault = accounts::global()
        .ok_or_else(|| anyhow::anyhow!("the pi-accounts vault is not initialized"))?;
    refresh_subscription_account_with_vault(vault, meta.auth_key, account_id).await
}

async fn subscription_request_credential_with_vault(
    vault: &accounts::AccountVault,
    auth_key: &str,
) -> Result<Option<Value>> {
    let scope = accounts::provider_scope(auth_key);
    let Some(info) = vault.active_info(&scope)? else {
        return Ok(None);
    };
    if info.kind != accounts::KIND_OAUTH {
        return Ok(None);
    }
    refresh_subscription_account_with_vault(vault, auth_key, &info.account_id)
        .await
        .map(Some)
}

async fn refresh_subscription_account_with_vault(
    vault: &accounts::AccountVault,
    auth_key: &str,
    account_id: &str,
) -> Result<Value> {
    refresh_subscription_account_with(vault, auth_key, account_id, |original| async move {
        oauth_login::refresh_credential(auth_key, &original).await
    })
    .await
}

async fn refresh_subscription_account_with<F, Fut>(
    vault: &accounts::AccountVault,
    auth_key: &str,
    account_id: &str,
    refresh: F,
) -> Result<Value>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Option<Value>>>,
{
    let _refresh_guard = OAUTH_REFRESH_LOCK.lock().await;
    let scope = accounts::provider_scope(auth_key);
    let account = vault
        .list(&scope)?
        .into_iter()
        .find(|account| account.account_id == account_id)
        .ok_or_else(|| anyhow::anyhow!("OAuth account is unavailable"))?;
    if account.kind != accounts::KIND_OAUTH {
        anyhow::bail!("account is not an OAuth login");
    }
    let original = vault
        .credential(&scope, account_id)?
        .ok_or_else(|| anyhow::anyhow!("OAuth credential is unavailable"))?;
    if vault.needs_reauth(&scope, account_id)? {
        return Err(accounts::RefreshFailure::Uncertain.into());
    }
    if !subscription_needs_refresh(auth_key, &original, now_unix()) {
        return Ok(original);
    }
    if !OAUTH_REFRESH_KEYS.contains(&auth_key) {
        anyhow::bail!("OAuth refresh is unsupported for this provider");
    }
    if original
        .get("refresh")
        .and_then(Value::as_str)
        .is_none_or(|refresh| refresh.trim().is_empty())
    {
        anyhow::bail!("OAuth account needs a new login");
    }
    let revision = vault.begin_refresh(&scope, account_id, &original)?;
    let refreshed = match refresh(original.clone()).await {
        Ok(Some(refreshed)) => refreshed,
        Ok(None) => anyhow::bail!("OAuth refresh is unavailable"),
        Err(error) => {
            let failure = error
                .downcast_ref::<accounts::RefreshFailure>()
                .copied()
                .unwrap_or(accounts::RefreshFailure::Uncertain);
            // The failure belongs to the dispatched credential generation, even
            // if the user switched to another login meanwhile: `revision` scopes
            // it, so only a newer login of this same account supersedes it.
            vault.record_refresh_failure(&scope, account_id, &revision, failure)?;
            if auth_key == CHATGPT_PLAN_AUTH_KEY && chatgpt_plan::terminal_refresh_error(&error) {
                let registration =
                    chatgpt_plan::StoredAccount::from_value(&original)?.registration();
                let disconnected =
                    serde_json::to_value(chatgpt_plan::StoredAccount::Disconnected(registration))?;
                vault.finish_refresh(&scope, account_id, &original, &revision, disconnected)?;
            }
            return Err(failure.into());
        }
    };
    if auth_key == CHATGPT_PLAN_AUTH_KEY {
        chatgpt_plan::StoredAccount::from_value(&refreshed)?;
        if !vault.finish_refresh(&scope, account_id, &original, &revision, refreshed.clone())? {
            anyhow::bail!("ChatGPT registration changed while refreshing; retry");
        }
        return Ok(refreshed);
    }
    let access = refreshed
        .get("access")
        .and_then(Value::as_str)
        .filter(|access| !access.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("OAuth refresh returned no access token"))?;
    if auth_key == KIRO_PROVIDER_ID {
        if !vault.finish_refresh(&scope, account_id, &original, &revision, refreshed.clone())? {
            anyhow::bail!("Kiro login changed while refreshing; retry with the current account");
        }
        return Ok(refreshed);
    }
    let updated = merged_oauth_credential(
        &original,
        access,
        refreshed.get("refresh").and_then(Value::as_str),
        oauth_expires_at(&refreshed),
    )?;
    if !vault.finish_refresh(&scope, account_id, &original, &revision, updated.clone())? {
        anyhow::bail!("OAuth account changed while refreshing; retry with the current account");
    }
    Ok(updated)
}

#[cfg(test)]
mod oauth_refresh_tests;

/// Refresh the OAuth access token for a Pi subscription login stored in
/// `auth.json`, if one exists and is at/near expiry. Returns `Ok(true)` when a new
/// access token was minted and persisted, `Ok(false)` when nothing needed doing
/// (not an oauth entry, still fresh, or the provider has no known refresh flow).
///
/// Targets only Ryu's private Pi credentials. A renewable legacy slot must be
/// sealed before dispatch. The same nonce-bound durable intent used by request
/// refresh guards proactive refresh across retries, crashes, and newer logins.
pub async fn refresh_oauth(auth_key: &str) -> Result<bool> {
    refresh_oauth_with(
        accounts::global(),
        &auth_path(),
        auth_key,
        |entry| async move { oauth_login::refresh_credential(auth_key, &entry).await },
    )
    .await
}

fn read_refresh_auth(path: &std::path::Path) -> Result<Map<String, Value>> {
    match fs::read_to_string(path) {
        Ok(body) => serde_json::from_str(&body).context("Could not read managed OAuth credentials"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(_) => anyhow::bail!("Could not read managed OAuth credentials"),
    }
}

fn renewable_oauth_needs_refresh(auth_key: &str, entry: &Value) -> bool {
    entry
        .get("refresh")
        .and_then(Value::as_str)
        .is_some_and(|token| !token.trim().is_empty())
        && subscription_needs_refresh(auth_key, entry, now_unix())
}

/// The proactive entrypoint and tests share this exact custody/dispatch path.
/// The exchange closure is injectable; production always uses the OAuth bridge.
async fn refresh_oauth_with<F, Fut>(
    vault: Option<&accounts::AccountVault>,
    path: &std::path::Path,
    auth_key: &str,
    refresh: F,
) -> Result<bool>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Option<Value>>>,
{
    if !OAUTH_REFRESH_KEYS.contains(&auth_key) {
        return Ok(false);
    }
    let scope = accounts::provider_scope(auth_key);
    let (entry, account_id, shared_entry, revision) = {
        let _selection_guard = ACCOUNT_SELECTION_LOCK
            .lock()
            .expect("account selection lock");
        let shared_entry = read_refresh_auth(path)?.get(auth_key).cloned();
        if let Some(vault) = vault {
            // Import only this managed private slot, and only an empty scope.
            // No ordinary vendor CLI stores or another account are consulted.
            let _capture = CREDENTIAL_CAPTURE_LOCK
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider account storage is unavailable"))?;
            if vault.count(&scope)? == 0 {
                if let Some(entry) = shared_entry.as_ref().filter(|entry| {
                    credential_kind(entry) == accounts::KIND_OAUTH
                        && !is_claude_proxy_credential(auth_key, entry)
                }) {
                    if vault
                        .upsert(
                            &scope,
                            &new_account_id(),
                            "Login",
                            accounts::KIND_OAUTH,
                            Some(entry.clone()),
                        )
                        .is_err()
                    {
                        let mut auth = read_refresh_auth(path)?;
                        if auth.get(auth_key) == Some(entry) && auth.remove(auth_key).is_some() {
                            write_secret_file(path, &serde_json::to_string_pretty(&auth)?)?;
                        }
                        anyhow::bail!("OAuth account storage is unavailable; sign in again");
                    }
                }
            }
            let Some(info) = vault.active_info(&scope)? else {
                if shared_entry
                    .as_ref()
                    .is_some_and(|entry| renewable_oauth_needs_refresh(auth_key, entry))
                {
                    let mut auth = read_refresh_auth(path)?;
                    if auth.get(auth_key) == shared_entry.as_ref()
                        && auth.remove(auth_key).is_some()
                    {
                        write_secret_file(path, &serde_json::to_string_pretty(&auth)?)?;
                    }
                    anyhow::bail!("OAuth account is unavailable; sign in again");
                }
                return Ok(false);
            };
            if info.kind != accounts::KIND_OAUTH {
                return Ok(false);
            }
            let entry = vault
                .credential(&scope, &info.account_id)?
                .ok_or_else(|| anyhow::anyhow!("OAuth credential is unavailable"))?;
            let revision = vault.credential_revision(&scope, &info.account_id)?;
            (entry, Some(info.account_id), shared_entry, revision)
        } else {
            let Some(entry) = shared_entry.clone() else {
                return Ok(false);
            };
            (entry, None, shared_entry, None)
        }
    };
    let result = if let (Some(vault), Some(account_id)) = (vault, account_id.as_deref()) {
        // This acquires the OAuth lock itself. Never nest it around this call.
        refresh_subscription_account_with(vault, auth_key, account_id, refresh).await
    } else if renewable_oauth_needs_refresh(auth_key, &entry) {
        Err(anyhow::anyhow!(
            "OAuth account storage is unavailable; sign in again"
        ))
    } else {
        return Ok(false);
    };
    let _selection_guard = ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    let selected = if let (Some(vault), Some(account_id)) = (vault, account_id.as_deref()) {
        vault
            .active_info(&scope)?
            .is_some_and(|info| info.account_id == account_id)
    } else {
        true
    };
    if !selected {
        return result.map(|updated| updated != entry);
    }
    let mut auth = read_refresh_auth(path)?;
    match result {
        Ok(updated) => {
            let vault = vault.expect("guarded refresh requires a vault");
            let account_id = account_id
                .as_deref()
                .expect("guarded refresh requires an account");
            // Never materialize a result superseded by a newer login.
            if vault.credential(&scope, account_id)?.as_ref() != Some(&updated) {
                return Ok(false);
            }
            if auth_key != CHATGPT_PLAN_AUTH_KEY
                && auth_key != KIRO_PROVIDER_ID
                && auth_key != CLAUDE_AUTH_KEY
            {
                auth.insert(auth_key.to_owned(), updated.clone());
                write_secret_file(path, &serde_json::to_string_pretty(&auth)?)?;
            } else if auth
                .get(auth_key)
                .is_some_and(|entry| !is_claude_proxy_credential(auth_key, entry))
                && auth.remove(auth_key).is_some()
            {
                // Native relays use sealed request credentials. Never leave
                // their former renewable plaintext slot available to Pi.
                write_secret_file(path, &serde_json::to_string_pretty(&auth)?)?;
            }
            Ok(updated != entry)
        }
        Err(error) => {
            let unchanged_generation =
                if let (Some(vault), Some(account_id)) = (vault, account_id.as_deref()) {
                    vault.credential_revision(&scope, account_id)? == revision
                } else {
                    true
                };
            // Best-effort callers must not leave a consumed token for Pi's own
            // refresh implementation to replay on the next process spawn.
            if unchanged_generation
                && auth.get(auth_key) == shared_entry.as_ref()
                && auth.remove(auth_key).is_some()
            {
                write_secret_file(path, &serde_json::to_string_pretty(&auth)?)?;
            }
            Err(error)
        }
    }
}

/// Best-effort proactive refresh of every subscription OAuth login the managed Pi
/// might use this turn. Called just before a Ryu/Pi ACP turn is sent (see
/// `acp::run_acp_instance`) so a long-running / long-idle chat whose access token
/// expired since the previous turn gets a fresh one before Pi makes its first model
/// call. Providers are refreshed independently. A failed refresh only blocks the
/// turn if an unsafe renewable credential remains readable by Pi, or its removal
/// cannot be verified. The common case is cheap — a provider with no oauth
/// entry, or a still-fresh token, returns after a single `auth.json` read with no
/// network call.
pub async fn refresh_pi_oauth_logins() -> Result<()> {
    refresh_pi_oauth_logins_with(&auth_path(), refresh_oauth).await
}

async fn refresh_pi_oauth_logins_with<F, Fut>(path: &std::path::Path, mut refresh: F) -> Result<()>
where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    for auth_key in OAUTH_REFRESH_KEYS {
        // Claude's Pi slot is a non-expiring local proxy credential. The real
        // sealed account is refreshed by the request proxy after session binding.
        if *auth_key == CLAUDE_AUTH_KEY {
            let auth = read_refresh_auth(path)?;
            if auth
                .get(*auth_key)
                .is_none_or(|entry| is_claude_proxy_credential(auth_key, entry))
            {
                continue;
            }
        }
        if let Err(e) = refresh(auth_key).await {
            tracing::warn!(
                auth_key,
                error = %e,
                "refresh_pi_oauth_logins: refresh failed"
            );
            let auth = read_refresh_auth(path)?;
            if auth
                .get(*auth_key)
                .is_some_and(|entry| renewable_oauth_needs_refresh(auth_key, entry))
            {
                anyhow::bail!("OAuth credentials could not be safely refreshed; sign in again");
            }
        }
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
    /// Pi `api` type: openai-completions / openai-responses /
    /// openai-codex-responses / anthropic-messages / google-generative-ai.
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
        id: qoder_cli::GLOBAL_ID,
        label: "Qoder Global",
        api: "openai-completions",
        auth_key: qoder_cli::GLOBAL_ID,
        auth_env: "",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: qoder_cli::CN_ID,
        label: "Qoder CN",
        api: "openai-completions",
        auth_key: qoder_cli::CN_ID,
        auth_env: "",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: MANAGED_OPENROUTER_ID,
        // The ONE managed provider users see. Models keep their real names; the
        // supplier that serves one is never shown.
        label: "Ryu Router",
        api: "openai-responses",
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
        api: "openai-responses",
        auth_key: "",
        auth_env: "",
        auth_kind: "none",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    // The per-tier managed rows ("Ryu Fast" … "Ryu Code") were retired: free
    // credit is now spent automatically on Ryu Router picks Ryu can serve from
    // its own supply, so a tier row has nothing left to offer. Saved selections
    // naming one resolve through `canonical_provider_id`.
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
        id: CHATGPT_PROVIDER_ID,
        label: "ChatGPT (native · login)",
        api: "openai-codex-responses",
        auth_key: CHATGPT_AUTH_KEY,
        auth_env: "",
        auth_kind: "subscription",
        credit_pool: "",
        suggested_models: CHATGPT_SUGGESTED_MODELS,
        models_url: "https://chatgpt.com/backend-api/codex/models",
    },
    ProviderMeta {
        id: CHATGPT_PLAN_PROVIDER_ID,
        label: "ChatGPT plan (self-hosted)",
        api: "openai-responses",
        auth_key: CHATGPT_PLAN_AUTH_KEY,
        auth_env: "",
        auth_kind: "subscription",
        credit_pool: "",
        suggested_models: &[],
        models_url: "https://api.openai.com/v1/models",
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
        id: KIRO_PROVIDER_ID,
        label: "Kiro (HTTP · login)",
        api: "openai-completions",
        auth_key: KIRO_PROVIDER_ID,
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
        id: "kimi-coding",
        label: "Kimi Code (login)",
        api: "anthropic-messages",
        auth_key: "kimi-coding",
        auth_env: "",
        auth_kind: "subscription",
        credit_pool: "",
        suggested_models: &["kimi-for-coding", "k3"],
        models_url: "",
    },
    ProviderMeta {
        id: "radius",
        label: "Radius (login)",
        api: "pi-messages",
        auth_key: "radius",
        auth_env: "",
        auth_kind: "subscription",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "ant-ling",
        label: "Ant Ling",
        api: "openai-completions",
        auth_key: "ant-ling",
        auth_env: "ANT_LING_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "baseten",
        label: "Baseten",
        api: "openai-completions",
        auth_key: "baseten",
        auth_env: "BASETEN_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "minimax-cn",
        label: "MiniMax CN",
        api: "anthropic-messages",
        auth_key: "minimax-cn",
        auth_env: "MINIMAX_CN_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "moonshotai-cn",
        label: "Moonshot AI CN",
        api: "openai-completions",
        auth_key: "moonshotai-cn",
        auth_env: "MOONSHOT_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "opencode",
        label: "OpenCode Zen",
        api: "anthropic-messages",
        auth_key: "opencode",
        auth_env: "OPENCODE_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "opencode-go",
        label: "OpenCode Go",
        api: "anthropic-messages",
        auth_key: "opencode-go",
        auth_env: "OPENCODE_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "qwen-token-plan",
        label: "Qwen Token Plan",
        api: "openai-completions",
        auth_key: "qwen-token-plan",
        auth_env: "QWEN_TOKEN_PLAN_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "qwen-token-plan-cn",
        label: "Qwen Token Plan CN",
        api: "openai-completions",
        auth_key: "qwen-token-plan-cn",
        auth_env: "QWEN_TOKEN_PLAN_CN_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "qwen-token-plan-individual",
        label: "Qwen Token Plan Individual",
        api: "openai-completions",
        auth_key: "qwen-token-plan-individual",
        auth_env: "QWEN_TOKEN_PLAN_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "vercel-ai-gateway",
        label: "Vercel AI Gateway",
        api: "anthropic-messages",
        auth_key: "vercel-ai-gateway",
        auth_env: "AI_GATEWAY_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "xiaomi",
        label: "Xiaomi",
        api: "openai-completions",
        auth_key: "xiaomi",
        auth_env: "XIAOMI_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "xiaomi-token-plan-ams",
        label: "Xiaomi Token Plan AMS",
        api: "openai-completions",
        auth_key: "xiaomi-token-plan-ams",
        auth_env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "xiaomi-token-plan-cn",
        label: "Xiaomi Token Plan CN",
        api: "openai-completions",
        auth_key: "xiaomi-token-plan-cn",
        auth_env: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "xiaomi-token-plan-sgp",
        label: "Xiaomi Token Plan SGP",
        api: "openai-completions",
        auth_key: "xiaomi-token-plan-sgp",
        auth_env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "",
    },
    ProviderMeta {
        id: "zai-coding-cn",
        label: "Z.AI Coding CN",
        api: "openai-completions",
        auth_key: "zai-coding-cn",
        auth_env: "ZAI_CODING_CN_API_KEY",
        auth_kind: "api-key",
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
        // Pi 0.99–1.1 ship these with adaptive thinking; listed first so a key
        // whose `/v1/models` discovery fails still offers the current family.
        suggested_models: &[
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "claude-opus-4-20250514",
            "claude-sonnet-4-20250514",
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
        suggested_models: &[
            "gpt-6.1-sol",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-4o",
            "gpt-4o-mini",
        ],
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
    // Named compatible vendors from 9Router's 4a57df8 provider registry.
    ProviderMeta {
        id: "chutes",
        label: "Chutes AI",
        api: "openai-completions",
        auth_key: "chutes",
        auth_env: "CHUTES_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &[],
        models_url: "https://llm.chutes.ai/v1/models",
    },
    ProviderMeta {
        id: "hyperbolic",
        label: "Hyperbolic",
        api: "openai-completions",
        auth_key: "hyperbolic",
        auth_env: "HYPERBOLIC_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &["Qwen/QwQ-32B"],
        models_url: "https://api.hyperbolic.xyz/v1/models",
    },
    ProviderMeta {
        id: "siliconflow",
        label: "SiliconFlow",
        api: "openai-completions",
        auth_key: "siliconflow",
        auth_env: "SILICONFLOW_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &["deepseek-ai/DeepSeek-V4-Pro"],
        models_url: "https://api.siliconflow.com/v1/models",
    },
    ProviderMeta {
        id: "venice",
        label: "Venice AI",
        api: "openai-completions",
        auth_key: "venice",
        auth_env: "VENICE_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &["venice-uncensored-1-2"],
        models_url: "https://api.venice.ai/api/v1/models",
    },
    ProviderMeta {
        id: "featherless",
        label: "Featherless",
        api: "openai-completions",
        auth_key: "featherless",
        auth_env: "FEATHERLESS_API_KEY",
        auth_kind: "api-key",
        credit_pool: "",
        suggested_models: &["deepseek-ai/DeepSeek-V4-Pro"],
        models_url: "https://api.featherless.ai/v1/models",
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

pub(crate) fn provider_meta(id: &str) -> Option<&'static ProviderMeta> {
    PROVIDERS.iter().find(|p| p.id == id)
}

const NAMED_COMPATIBLE_PROVIDERS: &[&str] = &[
    "chutes",
    "hyperbolic",
    "siliconflow",
    "venice",
    "featherless",
];

/// These named vendors use Pi's custom-provider registry rather than assuming
/// the installed SDK ships a built-in model table for every compatible service.
fn ensure_named_compatible_provider(id: &str, model: Option<&str>) -> Result<()> {
    if !NAMED_COMPATIBLE_PROVIDERS.contains(&id) {
        return Ok(());
    }
    let base = ryu_gw_credentials::direct_compatible_provider_url(id)
        .context("Named compatible provider endpoint unavailable")?;
    let existing = read_models();
    let entry = &existing["providers"][id];
    let mut patch = Map::new();
    if entry.get("baseUrl").is_none() {
        patch.insert("baseUrl".into(), json!(base));
    }
    if entry.get("api").is_none() {
        patch.insert("api".into(), json!("openai-completions"));
    }
    let mut rows = entry
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(model) = model {
        append_discovered_model_ids(&mut rows, &[json!({"id":model})]);
    }
    patch.insert("models".into(), json!(rows));
    upsert_provider(id, patch)
}

/// Whether a provider has a usable credential (auth.json key, environment
/// variable, or — for custom providers — an `apiKey` in models.json).
fn provider_configured(meta: &ProviderMeta) -> bool {
    if qoder_cli::is_provider(meta.id) {
        return qoder_cli::capture_token(meta.id).is_ok();
    }
    if meta.id == CHATGPT_PLAN_PROVIDER_ID {
        return matches!(
            chatgpt_plan_connection_state(),
            "authorized" | "identity-only"
        );
    }
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
        return !meta.auth_key.is_empty() && active_auth_kind(meta.auth_key, accounts::KIND_OAUTH);
    }
    let supports_oauth = oauth_login::oauth_provider_id(meta.id).is_some();
    if !meta.auth_key.is_empty()
        && (active_auth_kind(meta.auth_key, accounts::KIND_API_KEY)
            || (supports_oauth && active_auth_kind(meta.auth_key, accounts::KIND_OAUTH)))
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

fn chatgpt_plan_connection_state() -> &'static str {
    let Some(vault) = accounts::global() else {
        return "unavailable";
    };
    match vault.active_credential(&accounts::provider_scope(CHATGPT_PLAN_AUTH_KEY)) {
        Ok(Some((_, value))) => chatgpt_plan::connection_state(&value),
        Ok(None) => "disconnected",
        Err(_) => "unavailable",
    }
}

fn provider_account_views(provider_id: &str) -> Vec<Value> {
    let vault = accounts::global();
    let scope = accounts::provider_scope(CHATGPT_PLAN_AUTH_KEY);
    list_provider_accounts(provider_id)
        .into_iter()
        .map(|info| {
            let mut view = serde_json::to_value(&info).unwrap_or_default();
            if provider_id == CHATGPT_PLAN_PROVIDER_ID {
                let state = vault
                    .and_then(|vault| vault.credential(&scope, &info.account_id).ok())
                    .flatten()
                    .map(|value| chatgpt_plan::connection_state(&value))
                    .unwrap_or("unavailable");
                view["connectionState"] = json!(state);
            }
            view
        })
        .collect()
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
    Some(!meta.auth_key.is_empty() && active_auth_kind(meta.auth_key, accounts::KIND_OAUTH))
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

/// The sealed credential revision used to scope a subscription usage reading.
/// A caller should read this before and after a vendor fetch, and accept the
/// reading only if both revisions match. OAuth refresh can rotate the token
/// while the fetch is in flight.
pub fn subscription_account_credential_revision(
    provider_id: &str,
    account_id: &str,
) -> Result<Option<Vec<u8>>> {
    let meta = provider_meta(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{provider_id}'"))?;
    if meta.auth_kind != "subscription" || meta.auth_key.is_empty() {
        anyhow::bail!("provider '{provider_id}' is not a subscription provider");
    }
    let scope = accounts::provider_scope(meta.auth_key);
    let vault = accounts::global()
        .ok_or_else(|| anyhow::anyhow!("the pi-accounts vault is not initialized"))?;
    vault.credential_revision(&scope, account_id)
}

/// Read the currently selected OAuth credential for a native subscription
/// provider. The value is consumed only by Core's provider proxy; it is never
/// serialized into a response or handed to the desktop.
pub fn subscription_active_credential(provider_id: &str) -> Result<Option<Value>> {
    let meta = provider_meta(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{provider_id}'"))?;
    if meta.auth_kind != "subscription" || meta.auth_key.is_empty() {
        anyhow::bail!("provider '{provider_id}' is not a subscription provider");
    }
    let scope = accounts::provider_scope(meta.auth_key);
    if let Some(vault) = accounts::global() {
        return active_oauth_credential_from_vault(vault, &scope);
    }
    Ok(read_auth()
        .get(meta.auth_key)
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("oauth"))
        .cloned())
}

fn active_oauth_credential_from_vault(
    vault: &accounts::AccountVault,
    scope: &str,
) -> Result<Option<Value>> {
    if !vault
        .active_info(scope)?
        .is_some_and(|info| info.kind == accounts::KIND_OAUTH)
    {
        return Ok(None);
    }
    Ok(vault
        .active_credential(scope)?
        .map(|(_, credential)| credential))
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
    let allowed_kind = provider_meta(provider_id).and_then(|meta| {
        if meta.auth_kind == "subscription" {
            Some(accounts::KIND_OAUTH)
        } else if oauth_login::oauth_provider_id(provider_id).is_none() {
            Some(accounts::KIND_API_KEY)
        } else {
            None
        }
    });
    let accounts = match accounts::global() {
        Some(vault) => vault.list(&scope).unwrap_or_default(),
        None => Vec::new(),
    };
    accounts
        .into_iter()
        .filter(|account| allowed_kind.is_none_or(|kind| account.kind == kind))
        .collect()
}

/// Make `account_id` the active account for a provider and materialize it into
/// Pi's files. Returns the refreshed catalog. Errors when the provider has no
/// such account.
pub fn switch_provider_account(provider_id: &str, account_id: &str) -> Result<Value> {
    let _selection_guard = ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    if !list_provider_accounts(provider_id)
        .iter()
        .any(|account| account.account_id == account_id)
    {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' holds no accounts"))?;
    let switched = with_account_vault(|vault| vault.set_active(&scope, account_id))?;
    if !switched {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    materialize_active_accounts_unlocked();
    Ok(catalog())
}

/// Rename a saved provider account without changing its credential or active
/// selection. Returns the refreshed catalog for the desktop settings cache.
pub fn rename_provider_account(provider_id: &str, account_id: &str, label: &str) -> Result<Value> {
    if !list_provider_accounts(provider_id)
        .iter()
        .any(|account| account.account_id == account_id)
    {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' holds no accounts"))?;
    let renamed = with_account_vault(|vault| vault.set_label(&scope, account_id, label))?;
    if !renamed {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    Ok(catalog())
}

/// Remove `account_id` from a provider. If it was active, the newest remaining
/// account becomes active and is materialized (the slot is cleared otherwise).
/// Returns the refreshed catalog.
pub fn remove_provider_account(provider_id: &str, account_id: &str) -> Result<Value> {
    let _selection_guard = ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    if !list_provider_accounts(provider_id)
        .iter()
        .any(|account| account.account_id == account_id)
    {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    let scope = provider_account_scope(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' holds no accounts"))?;
    // Conversations that ran under this account keep their Pi transcripts in
    // their own account-session folders; they go with the account.
    let session_keys = session_accounts::session_keys_for_account(provider_id, account_id);
    let removed = with_account_vault(|vault| vault.remove(&scope, account_id))?;
    if !removed {
        anyhow::bail!("no account with id '{account_id}' for provider '{provider_id}'");
    }
    transcripts::delete_account_session_transcripts(&config_dir(), &session_keys);
    // Promote a remaining account so a removed active login does not leave the
    // provider with a cleared slot it cannot use.
    with_account_vault(|vault| settle_provider_scope_after_removal(vault, &scope))?;
    materialize_active_accounts_unlocked();
    Ok(catalog())
}

/// Keep a provider usable after one of its accounts was removed from `scope`.
/// Promote a remaining account so a removed active login does not leave the
/// provider with a cleared slot it cannot use; when none remain, remove the
/// legacy slot before materialization can import it again. The caller holds
/// `ACCOUNT_SELECTION_LOCK` and materializes afterwards.
fn settle_provider_scope_after_removal(vault: &accounts::AccountVault, scope: &str) -> Result<()> {
    let remaining = vault.list(scope)?;
    if remaining.is_empty() {
        return clear_provider_active_slot(accounts::scope_key(scope));
    }
    if !remaining.iter().any(|a| a.active) {
        if let Some(next) = remaining.first() {
            let _ = vault.set_active(scope, &next.account_id);
        }
    }
    Ok(())
}

fn clear_provider_active_slot(auth_key: &str) -> Result<()> {
    clear_auth_key(auth_key)?;
    let mut models = read_models();
    if let Some(entry) = models["providers"][auth_key].as_object_mut() {
        if entry.remove("apiKey").is_some() {
            write_models(&models)?;
        }
    }
    Ok(())
}

/// Snapshot every usable credential currently in Pi's `auth.json` into the
/// sealed vault as an account (deduped by credential content), for the managed
/// Pi's ACP login path — after `authenticate` the agent subprocess writes the
/// credential itself, and this is how Ryu captures it as a switchable account.
/// Called on a successful managed-Pi `authenticate` and at boot.
pub fn capture_pi_auth_into_vault() {
    let _selection_guard = ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    let Some(vault) = accounts::global() else {
        return;
    };
    for (auth_key, entry) in read_auth() {
        if auth_key == CHATGPT_PLAN_AUTH_KEY || is_claude_proxy_credential(&auth_key, &entry) {
            continue;
        }
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
    materialize_active_accounts_unlocked();
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
/// other agent this validates the requested opaque record; its own login still
/// needs to complete before the credential identity has changed.
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
        let _selection_guard = ACCOUNT_SELECTION_LOCK
            .lock()
            .expect("account selection lock");
        let switched = vault.set_active(&scope, account_id)?;
        if switched {
            materialize_active_accounts_unlocked();
        }
        return Ok(switched);
    }
    vault.contains(&accounts::acp_scope(spawn_cmd), account_id)
}

/// Remove an account from an ACP agent. Managed Pi → remove from its provider
/// scope (and materialize); any other agent → remove the opaque account.
pub fn remove_acp_account(spawn_cmd: &str, account_id: &str) -> Result<bool> {
    let Some(vault) = accounts::global() else {
        return Ok(false);
    };
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        let _selection_guard = ACCOUNT_SELECTION_LOCK
            .lock()
            .expect("account selection lock");
        return remove_pi_account_from(
            vault,
            account_id,
            settle_provider_scope_after_removal,
            materialize_active_accounts_unlocked,
        );
    }
    let scope = accounts::acp_scope(spawn_cmd);
    vault.remove(&scope, account_id)
}

/// Remove a managed-Pi login from whichever provider scope holds it, then
/// settle that scope and materialize. Once `vault.remove` succeeded the account
/// is gone, so a settle failure is logged rather than returned: returning it
/// would report a removed account as not removed and skip materialization,
/// leaving the removed credential in Pi's `auth.json`. The caller holds
/// `ACCOUNT_SELECTION_LOCK`.
fn remove_pi_account_from(
    vault: &accounts::AccountVault,
    account_id: &str,
    settle: impl Fn(&accounts::AccountVault, &str) -> Result<()>,
    materialize: impl FnOnce(),
) -> Result<bool> {
    let mut removed = false;
    for meta in PROVIDERS {
        if meta.auth_key.is_empty() {
            continue;
        }
        let provider_scope = accounts::provider_scope(meta.auth_key);
        if vault.remove(&provider_scope, account_id)? {
            // Same safeguards as `remove_provider_account`: without them the
            // removed login re-imports from `auth.json`, or a removed active
            // login leaves the remaining accounts with none selected.
            if let Err(error) = settle(vault, &provider_scope) {
                tracing::warn!(
                    scope = %provider_scope,
                    "pi account removed but its provider scope could not be settled: {error:#}"
                );
            }
            removed = true;
            break;
        }
    }
    if removed {
        materialize();
    }
    Ok(removed)
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

/// A built-in provider's suggested models the user has not turned off in
/// models.json (an untoggled model is enabled), in catalog order.
pub(crate) fn enabled_suggested_models(provider_id: &str) -> Vec<String> {
    let Some(meta) = provider_meta(provider_id) else {
        return Vec::new();
    };
    let overrides = model_overrides(&read_models(), provider_id);
    meta.suggested_models
        .iter()
        .filter(|model_id| overrides.get(**model_id).and_then(Value::as_bool) != Some(false))
        .map(|model_id| (*model_id).to_owned())
        .collect()
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
    // Custom (user-added) provider: models.json holds a reference to the sealed
    // vault key (or, before migration, the legacy literal).
    read_models()["providers"]
        .get(id)
        .and_then(|p| p.get("apiKey"))
        .and_then(Value::as_str)
        .and_then(secret_env::resolve)
        .map(|key| key.trim().to_owned())
        .filter(|s| !s.is_empty())
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
                "supportsOAuth": oauth_login::oauth_provider_id(p.id).is_some(),
                "authEnv": p.auth_env,
                "routing": if qoder_cli::is_provider(p.id) { ROUTING_DIRECT } else { provider_routing(p.id) },
                // Managed/gateway providers can't be flipped off Gateway routing.
                "routingLocked": is_managed_or_gateway(p.id) || p.id == CHATGPT_PLAN_PROVIDER_ID || qoder_cli::is_provider(p.id),
                "managed": is_managed(p.id),
                // The credit pool this row's spend attributes to, so the composer
                // can bind the row to the pool catalog and show its balance. Empty
                // for BYOK.
                "creditPool": p.credit_pool,
                // Ryu Router models free credit pays for (the picker's "Free"
                // tag). One source of truth with the Gateway's own-supply
                // routing; empty on every other row.
                "freeModels": if p.id == MANAGED_OPENROUTER_ID { ryu_router_free_models() } else { Vec::new() },
                "configured": provider_configured(p),
                "active": is_active(p.id),
                "custom": false,
                "suggestedModels": p.suggested_models,
                "credentialLabel": if qoder_cli::is_provider(p.id) { Some("Personal access token") } else { None },
                "transport": if qoder_cli::is_provider(p.id) { Some("official-cli") } else { None },
                "cliAvailable": qoder_cli::cli_available(p.id),
                "inputModalities": if qoder_cli::is_provider(p.id) { Some(vec!["text"]) } else { None },
                "supportsDiscovery": !p.models_url.is_empty()
                    || qoder_cli::is_provider(p.id)
                    || oauth_login::builtin_catalog_provider_id(p.id).is_some(),
                // Per-model enabled overrides (absent id ⇒ enabled). Lets the
                // desktop render each model's on/off toggle.
                "modelOverrides": model_overrides(&models_value, p.id),
                // Every account the provider holds in the sealed vault (labels
                // only — never a credential). Lets the picker list + switch.
                "accounts": provider_account_views(p.id),
                "accountRouting": crate::server::oauth_pool_policy::capabilities(p.id),
                "connectionState": if p.id == CHATGPT_PLAN_PROVIDER_ID { Some(chatgpt_plan_connection_state()) } else { None },
            })
        })
        .collect();

    // User-defined custom providers in models.json that aren't built-ins
    // (e.g. a local Ollama/LM Studio/vLLM endpoint the user added).
    for id in custom_ids {
        if provider_meta(&id).is_some() {
            continue;
        }
        let entry = &models_value["providers"][&id];
        let api = entry
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or("openai-completions");
        let has_endpoint = entry
            .get("baseUrl")
            .and_then(Value::as_str)
            .is_some_and(|url| !url.trim().is_empty());
        providers.push(json!({
            "id": id,
            "label": id,
            "api": api,
            "authKind": "api-key",
            "authEnv": "",
            "routing": provider_routing(&id),
            "routingLocked": false,
            "managed": false,
            "configured": has_endpoint,
            "active": is_active(&id),
            "custom": true,
            "suggestedModels": [],
            // Custom providers discover against their own baseUrl + /models.
            "supportsDiscovery": true,
            "modelOverrides": model_overrides(&models_value, &id),
            "accounts": provider_accounts(&accounts::provider_scope(&id)),
            "accountRouting": crate::server::oauth_pool_policy::capabilities(&id),
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
            "openai-codex-responses",
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

/// Whether an incoming `apiKey` means "keep the stored key".
fn is_kept_key_placeholder(key: &str) -> bool {
    ryu_crypto::redact::is_placeholder(key) || secret_env::is_reference(key)
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
    // An older desktop may still send a retired per-tier managed row.
    let provider = canonical_provider_id(input.provider.trim()).to_owned();
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
    // A masked placeholder or Ryu's own reference echoed back by a client keeps
    // the stored key; only a real new key is sealed.
    let api_key = non_empty(&input.api_key).filter(|key| !is_kept_key_placeholder(key));
    let custom_api = non_empty(&input.api);

    if qoder_cli::is_provider(&provider) {
        qoder_cli::validate_selector(&provider, base_url.as_deref(), custom_api.as_deref())?;
        if api_key.is_some() || model.is_none() {
            anyhow::bail!(
                "Configure the Qoder PAT and discover its models before activating a model"
            );
        }
        qoder_cli::capture_token(&provider)?;
        qoder_cli::ensure_models(&provider, model.as_deref())?;
    }

    if NAMED_COMPATIBLE_PROVIDERS.contains(&provider.as_str()) && model.is_none() {
        anyhow::bail!("Choose a model for '{provider}' before activating it");
    }

    if provider == KIRO_PROVIDER_ID
        && (base_url.is_some() || api_key.is_some() || custom_api.is_some() || model.is_none())
    {
        anyhow::bail!("Choose a Kiro account model; its login and local relay route are fixed");
    }

    if provider == CHATGPT_PLAN_PROVIDER_ID {
        if base_url.is_some()
            || api_key.is_some()
            || model.is_none()
            || custom_api
                .as_deref()
                .is_some_and(|api| api != "openai-responses")
        {
            anyhow::bail!(
                "Choose a ChatGPT account model; its API, credential, and direct route are fixed"
            );
        }
    }

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
    let effective_model = if (managed || provider == CHATGPT_PROVIDER_ID) && model.is_none() {
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
        pi_provider_id(&provider).to_owned()
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
        // built-in `gpt-5.5` default) over the Responses API.
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

    if provider == CHATGPT_PLAN_PROVIDER_ID {
        upsert_provider(
            CHATGPT_PLAN_PROVIDER_ID,
            chatgpt_plan_provider_patch(
                effective_model.as_deref().expect("validated ChatGPT model"),
            ),
        )?;
        return Ok(current());
    }
    if provider == CHATGPT_PROVIDER_ID {
        // The ChatGPT provider is a native Core proxy: Pi sends the Responses
        // wire format to Core, and Core resolves/refreshed the selected ChatGPT
        // session immediately before forwarding it upstream. No user bearer is
        // persisted in models.json.
        upsert_provider(
            CHATGPT_PROVIDER_ID,
            chatgpt_provider_patch(effective_model.as_deref()),
        )?;
        return Ok(current());
    }

    if qoder_cli::is_provider(&provider) {
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
            let reference = seal_custom_provider_key(accounts::global(), &provider, key)?;
            patch.insert("apiKey".to_owned(), Value::String(reference));
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

    ensure_named_compatible_provider(&provider, model.as_deref())?;
    if provider == KIRO_PROVIDER_ID {
        ensure_kiro_models_json(model.as_deref())?;
    }
    if pi_provider_id(&provider) == CLAUDE_AUTH_KEY {
        ensure_claude_models_json()?;
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
    if qoder_cli::is_provider(&provider) {
        qoder_cli::validate_selector(
            &provider,
            non_empty(&input.base_url).as_deref(),
            non_empty(&input.api).as_deref(),
        )?;
        if non_empty(&input.routing).is_some_and(|mode| mode != ROUTING_DIRECT) {
            anyhow::bail!("Qoder CLI profiles use direct Core routing");
        }
        if let Some(token) = non_empty(&input.api_key) {
            qoder_cli::store_token(&provider, &token)?;
        } else {
            qoder_cli::capture_token(&provider)?;
            qoder_cli::ensure_models(&provider, None)?;
        }
        set_provider_routing(&provider, ROUTING_DIRECT)?;
        return Ok(catalog());
    }
    if matches!(
        provider.as_str(),
        CHATGPT_PLAN_PROVIDER_ID | KIRO_PROVIDER_ID
    ) && (non_empty(&input.base_url).is_some()
        || non_empty(&input.api_key).is_some()
        || non_empty(&input.api).is_some())
    {
        anyhow::bail!("Use this provider's sign-in flow to configure its saved account");
    }
    if is_managed_or_gateway(&provider) {
        // Managed/gateway providers carry no BYOK credential; only routing (locked
        // to gateway) — nothing to configure. Activation is the only action.
        anyhow::bail!("provider '{provider}' needs no configuration; activate it instead");
    }

    let base_url = non_empty(&input.base_url);
    // A masked placeholder or Ryu's own reference echoed back by a client keeps
    // the stored key; only a real new key is sealed.
    let api_key = non_empty(&input.api_key).filter(|key| !is_kept_key_placeholder(key));
    let custom_api = non_empty(&input.api);
    let is_builtin = provider_meta(&provider).is_some();

    if !is_builtin && base_url.is_none() && !custom_provider_ids().contains(&provider) {
        anyhow::bail!(
            "unknown provider '{provider}'; supply a baseUrl to define a custom provider"
        );
    }

    if base_url.is_some() || (!is_builtin && api_key.is_some()) {
        // Custom OpenAI-compatible provider → models.json entry.
        let mut patch = Map::new();
        if let Some(url) = &base_url {
            patch.insert("baseUrl".to_owned(), Value::String(url.clone()));
            patch.insert(
                "api".to_owned(),
                Value::String(custom_api.unwrap_or_else(|| "openai-completions".to_owned())),
            );
        }
        if let Some(key) = &api_key {
            let reference = seal_custom_provider_key(accounts::global(), &provider, key)?;
            patch.insert("apiKey".to_owned(), Value::String(reference));
        }
        upsert_provider(&provider, patch)?;
    } else if let (Some(meta), Some(key)) = (provider_meta(&provider), &api_key) {
        if !meta.auth_key.is_empty() {
            set_auth_key(meta.auth_key, key)?;
        }
    }

    ensure_named_compatible_provider(&provider, None)?;
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
    /// ChatGPT/Codex model discovery requires the bearer plus the account id
    /// that the Login with ChatGPT session is bound to.
    ChatGpt {
        access: String,
        account_id: String,
    },
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
    if let Some(id) = provider_id
        .as_deref()
        .filter(|id| qoder_cli::is_provider(id))
    {
        if qoder_cli::validate_selector(
            id,
            non_empty(&input.base_url).as_deref(),
            non_empty(&input.api).as_deref(),
        )
        .is_err()
            || non_empty(&input.api_key).is_some()
        {
            return json!({"models":[],"source":"unavailable","error":"Use the selected sealed Qoder PAT and official CLI"});
        }
        return match crate::server::qoder_api::discover_models(id).await {
            Ok(models) => match qoder_cli::persist_discovered_models(id, &models) {
                Ok(()) => json!({"models":models,"source":"discovery"}),
                Err(_) => {
                    json!({"models":[],"source":"unavailable","error":"Could not save Qoder model discovery"})
                }
            },
            Err(_) => {
                json!({"models":[],"source":"unavailable","error":"Qoder CLI discovery is unavailable. Install the official regional CLI and configure a PAT."})
            }
        };
    }
    if provider_id.as_deref() == Some(KIRO_PROVIDER_ID) {
        return match crate::server::kiro_api::discover_models().await {
            Ok(models) => json!({"models": models, "source":"discovery"}),
            Err(_) => {
                json!({"models": [], "source":"unavailable", "error":"Kiro model discovery is unavailable. Check the selected login."})
            }
        };
    }
    if provider_id.as_deref() == Some(CHATGPT_PLAN_PROVIDER_ID) {
        return match crate::server::chatgpt_plan_api::discover_models().await {
            Ok(models) => json!({ "models": models, "source": "discovery" }),
            Err(response) => {
                let status = response.status().as_u16();
                let body =
                    axum::body::to_bytes(response.into_body(), MAX_MODEL_DISCOVERY_RESPONSE_BYTES)
                        .await
                        .ok();
                let error = body.and_then(|body| serde_json::from_slice::<Value>(&body).ok());
                json!({ "models": [], "source": "unavailable", "status": status, "error": error })
            }
        };
    }
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
        let allow_trusted_local = provider_id.as_deref().is_some_and(|id| {
            id == GATEWAY_PROVIDER_ID
                || id == MANAGED_OPENROUTER_ID
                || (provider_meta(id).is_none()
                    && custom_provider_ids().iter().any(|item| item == id))
        });
        if let Ok(models) = fetch_models(&url, auth, allow_trusted_local).await {
            if !models.is_empty() {
                return json!({ "models": models, "source": "discovery" });
            }
        }
    }

    // A custom endpoint can go offline after its last successful discovery.
    // Keep those persisted IDs selectable instead of returning an empty picker.
    if let Some(id) = provider_id
        .as_deref()
        .filter(|id| provider_meta(id).is_none())
    {
        let saved: Vec<Value> = read_models()["providers"][id]["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .map(|model_id| json!({ "id": model_id }))
            })
            .collect();
        if !saved.is_empty() {
            return json!({ "models": saved, "source": "saved" });
        }
    }

    // Tier 2 — the installed Pi catalog for built-in API-key and OAuth providers. These are
    // the model IDs that the managed agent can actually select, even offline.
    if let Some(id) = &provider_id {
        let builtins = oauth_login::builtin_models(id).await;
        if !builtins.is_empty() {
            return json!({ "models": builtins, "source": "pi" });
        }
    }

    // Tier 3 — models.dev, the upstream registry Pi's own table is generated from
    // (covers providers without a live key or without an OpenAI `/v1/models`).
    if let Some(id) = &provider_id {
        let md = models_dev::models_for(id).await;
        if !md.is_empty() {
            return json!({ "models": md, "source": "models.dev" });
        }
    }

    // Tier 4 — the tiny static seed (offline, unknown provider). Free-text entry in
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

/// Populate a saved custom provider's Pi model table from its live `/models`
/// endpoint. A failed or empty probe leaves the user's existing model entries
/// untouched. Existing rows retain their metadata and enabled override; new
/// rows are ID-only, which is Pi's valid static custom-model form.
pub async fn refresh_custom_provider_models(id: &str) -> Result<usize> {
    if provider_meta(id).is_some() || provider_owner(id).is_some() {
        anyhow::bail!("model refresh is only available for user-defined providers");
    }
    let before = read_models();
    let entry = before["providers"]
        .get(id)
        .and_then(Value::as_object)
        .context("custom provider does not exist")?;
    let base = entry
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .context("custom provider has no base URL")?
        .to_owned();
    let api = entry.get("api").and_then(Value::as_str).map(str::to_owned);
    let key = entry
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let discovered = fetch_models(
        &models_url_from_base(&base),
        discovery_auth_for(api.as_deref(), key.as_deref().and_then(secret_env::resolve)),
        true,
    )
    .await?;
    if discovered.is_empty() {
        return Ok(0);
    }

    let mut models = read_models();
    let current = models["providers"]
        .get_mut(id)
        .and_then(Value::as_object_mut)
        .context("custom provider was removed during discovery")?;
    if current.get("baseUrl").and_then(Value::as_str) != Some(base.as_str())
        || current.get("api").and_then(Value::as_str) != api.as_deref()
        || current.get("apiKey").and_then(Value::as_str) != key.as_deref()
    {
        anyhow::bail!("custom provider changed during discovery");
    }
    let rows = current
        .entry("models".to_owned())
        .or_insert_with(|| json!([]));
    let rows = rows
        .as_array_mut()
        .context("custom provider models is not an array")?;
    let added = append_discovered_model_ids(rows, &discovered);
    if added > 0 {
        write_models(&models)?;
    }
    Ok(added)
}

fn append_discovered_model_ids(rows: &mut Vec<Value>, discovered: &[Value]) -> usize {
    const MAX_CUSTOM_MODELS: usize = 1_024;
    let mut seen: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let mut added = 0;
    for model in discovered {
        if rows.len() >= MAX_CUSTOM_MODELS {
            break;
        }
        let Some(id) = model.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            continue;
        }
        if seen.insert(id.to_owned()) {
            rows.push(json!({ "id": id }));
            added += 1;
        }
    }
    added
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
    let allow_trusted_local = provider_id.as_deref().is_some_and(|id| {
        id == GATEWAY_PROVIDER_ID
            || id == MANAGED_OPENROUTER_ID
            || (provider_meta(id).is_none() && custom_provider_ids().iter().any(|item| item == id))
    });
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
        let token = crate::sidecar::gateway::gateway_token().unwrap_or_default();
        return Some((url, DiscoveryAuth::Bearer(token)));
    }

    if id == CHATGPT_PROVIDER_ID {
        let credential = subscription_active_credential(id).ok().flatten()?;
        let access = credential
            .get("access")
            .or_else(|| credential.get("access_token"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .to_owned();
        let account_id = credential
            .get("accountId")
            .or_else(|| credential.get("account_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .to_owned();
        return Some((
            "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1".to_owned(),
            DiscoveryAuth::ChatGpt { access, account_id },
        ));
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
            .and_then(secret_env::resolve)
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
    let trusted_local = allow_trusted_local
        && (is_trusted_gateway_endpoint(&parsed) || is_literal_loopback_endpoint(&parsed));
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none());
    if trusted_local {
        // A local model server must not be sent through an ambient HTTP proxy.
        builder = builder.no_proxy();
        if parsed.host_str() == Some("localhost") {
            let port = parsed.port_or_known_default().unwrap_or(80);
            let addresses = [
                std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
                std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
            ];
            builder = builder.resolve_to_addrs("localhost", &addresses);
        }
    } else {
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
        DiscoveryAuth::ChatGpt { access, account_id } => {
            req = req
                .bearer_auth(access)
                .header("ChatGPT-Account-ID", account_id)
                .header("originator", "codex_cli_rs");
        }
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
    if resp
        .content_length()
        .is_some_and(|length| length > MAX_MODEL_DISCOVERY_RESPONSE_BYTES as u64)
    {
        anyhow::bail!("discovery response exceeds {MAX_MODEL_DISCOVERY_RESPONSE_BYTES} bytes");
    }
    let mut stream = resp.bytes_stream();
    let mut raw = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read discovery response")?;
        if raw.len().saturating_add(chunk.len()) > MAX_MODEL_DISCOVERY_RESPONSE_BYTES {
            anyhow::bail!("discovery response exceeds {MAX_MODEL_DISCOVERY_RESPONSE_BYTES} bytes");
        }
        raw.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&raw).context("parse discovery response")?;
    Ok(parse_discovered_models(&body))
}

/// Whether a discovered row can serve as a Pi chat model. The Gateway labels
/// its media, embedding, and rerank rows with a top-level `modality` (`image`,
/// `tts`, `stt`, `video`, `embedding`, `rerank`, …) and its chat rows with
/// `chat`; an unlabelled row from any other OpenAI-compatible `/models`
/// endpoint is kept. Mirrors the optimizer's chat-only candidate filter.
fn is_chat_discovery_row(row: &Value) -> bool {
    row.get("modality")
        .and_then(Value::as_str)
        .is_none_or(|modality| modality == "chat")
}

/// Parse an OpenAI/Anthropic/OpenRouter-shaped `/models` body into Pi's
/// `[{id, name?}]` rows, keeping only rows that can be picked as a chat model.
fn parse_discovered_models(body: &Value) -> Vec<Value> {
    // OpenAI + Anthropic both use `{ data: [ { id, ... } ] }`; OpenRouter too.
    let mut items = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .or_else(|| body.get("items").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    if let Some(models) = body.get("models").and_then(Value::as_object) {
        items.extend(
            models
                .iter()
                .map(|(id, entry)| json!({ "id": id, "name": entry.get("name") })),
        );
    }
    items
        .into_iter()
        .filter(is_chat_discovery_row)
        .filter_map(|m| {
            let id = m
                .get("slug")
                .or_else(|| m.get("id"))
                .or_else(|| m.get("model"))
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
        .collect()
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

/// A saved custom provider may point at a service on this same machine. Only a
/// literal loopback address or the exact `localhost` name gets this exception;
/// arbitrary private-network names still pass through the pinned egress screen.
fn is_literal_loopback_endpoint(url: &reqwest::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

#[cfg(test)]
pub(crate) mod tests;
