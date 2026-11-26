//! The canonical "who runs this" selection — one value shape shared by every
//! setting that names an agent/model, plus the node-wide default they fall back
//! to when unset.
//!
//! Before this module every side feature (auto-title, `/btw`, advisor, the
//! plugin host's `sideModel`, context compaction, chat suggestions, …) read its
//! own `*-model` preference holding a bare model id, and each invented its own
//! last-resort fallback. There was no way to say "use *this* for everything I
//! haven't configured individually".
//!
//! ## The value
//!
//! [`AgentSelection`] mirrors what the chat composer's universal picker can
//! express — agent, provider, model, thinking level, reasoning effort, and ACP
//! access (permission) mode — so a settings field and the composer describe a
//! target the same way. It serializes as a JSON object under a single
//! preference key.
//!
//! **Back-compat is permanent**: every one of these preferences already holds a
//! bare model-id string in the wild, so [`AgentSelection::parse`] accepts either
//! a JSON object *or* a bare string (read as `{ model }`). Nothing needs
//! migrating and an older client that writes a bare id keeps working.
//!
//! ## The two resolvers, and why an agent must degrade
//!
//! Consumers are not interchangeable:
//!
//! - **Model-consuming sites** do a raw non-streaming `/v1/chat/completions`
//!   (`call_side_model`). They need a concrete model id and cannot "run an
//!   agent" — [`resolve_side_model`] serves them.
//! - **Agent-consuming sites** (auto-routing fallback, scheduled automations,
//!   channels) want an agent id — [`resolve_agent`] serves them.
//!
//! So an agent-typed selection reaching a model-consuming site MUST degrade to
//! a model rather than pass `"claude"` off as a model id (the gateway would 400
//! and the setting would look silently ignored). The degrade path is explicit
//! in [`model_for_agent`]: the flagship Pi-backed agent resolves to its
//! configured Pi model; an external ACP agent has no chat-completions model
//! Core can borrow, so it falls through to the next link in the chain instead
//! of poisoning the request.
//!
//! ## The chain
//!
//! Every model-consuming site resolves in this order, stopping at the first hit:
//!
//! 1. the feature's own preference (JSON selection, or a legacy bare model id);
//! 2. the local lane default ([`LOCAL_SELECTION_PREF`]);
//! 3. the caller's existing last-resort fallback (the resident local engine, an
//!    env var, the bundled default — unchanged, so behaviour with nothing
//!    configured is exactly what it was).

use serde::{Deserialize, Serialize};

use crate::server::preferences::{is_secret_preference_key, PreferencesStore};

/// Preference key holding the node-wide default selection, as JSON.
///
/// Edited in the Gateway (node) settings dialog under "Defaults". Node-scoped
/// on purpose: it is the fallback every user and every plugin on this node
/// inherits, not a per-desktop preference.
pub const GLOBAL_SELECTION_PREF: &str = "default-agent-selection";

/// The local lane default. The legacy global key is read only as a migration
/// fallback, never as the cloud lane.
pub const LOCAL_SELECTION_PREF: &str = "default-local-agent-selection";
/// The normal-chat / profile lane default. Empty means "fall back to local".
pub const CLOUD_SELECTION_PREF: &str = "default-cloud-agent-selection";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLane {
    Local,
    Cloud,
}

impl AgentLane {
    pub const fn preference_key(self) -> &'static str {
        match self {
            Self::Local => LOCAL_SELECTION_PREF,
            Self::Cloud => CLOUD_SELECTION_PREF,
        }
    }
}

/// Pi provider id owning the bundled llama.cpp models. The gateway's built-in
/// prefix rules route `gemma*` ids here (see `pi_config::default_gateway_model`),
/// so this is the provider that pairs with [`crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID`].
const LOCAL_PROVIDER_ID: &str = "local";

/// What the node-wide default resolves to when nothing has been written yet: the
/// flagship Pi agent on the bundled local Gemma chat model.
///
/// A READ default, not a seeded preference. Seeding writes a value that is then
/// indistinguishable from a deliberate user choice — it survives a "reset to
/// defaults", and it freezes the model id of the day into every profile ever
/// created. Reading through instead means the pair tracks
/// `DEFAULT_LOCAL_CHAT_MODEL_ID` (and its `RYU_LOCAL_CHAT_MODEL_ID` override)
/// forever, and clearing the preference genuinely returns to the default.
///
/// Safe as a default because both halves are always present on a fresh install:
/// `ryu` is the always-installed flagship, and llama.cpp plus this GGUF are
/// fetched unconditionally on first run (see `mesh_host::MESH_PREINSTALL_DEFAULT`
/// for the same argument stated from the other side).
pub fn builtin_default_selection() -> AgentSelection {
    AgentSelection {
        agent_id: FLAGSHIP_AGENT_ID.to_owned(),
        provider: LOCAL_PROVIDER_ID.to_owned(),
        model: crate::registry::ProviderRegistry::load()
            .local_chat_model
            .id,
        ..Default::default()
    }
}

/// The node-wide default selection: what is stored, else
/// [`builtin_default_selection`].
pub async fn load_global(prefs: &PreferencesStore) -> AgentSelection {
    load_local(prefs).await
}

/// Load the local lane, migrating the former one-default preference by read.
/// An explicitly empty new key means the user chose the built-in local default
/// and must not resurrect the legacy value.
pub async fn load_local(prefs: &PreferencesStore) -> AgentSelection {
    let stored = match prefs.get(LOCAL_SELECTION_PREF).await {
        Ok(Some(raw)) => AgentSelection::parse(&raw),
        Ok(None) | Err(_) => AgentSelection::load(prefs, GLOBAL_SELECTION_PREF).await,
    };
    if stored.is_empty() {
        builtin_default_selection()
    } else {
        stored
    }
}

/// Load the cloud lane. It is intentionally empty until onboarding or Settings
/// writes a usable cloud/BYOK target.
pub async fn load_cloud(prefs: &PreferencesStore) -> AgentSelection {
    AgentSelection::load(prefs, CLOUD_SELECTION_PREF).await
}

/// Resolve the selected lane, with an unset cloud lane falling back to local.
pub async fn load_lane(prefs: &PreferencesStore, lane: AgentLane) -> AgentSelection {
    match lane {
        AgentLane::Local => load_local(prefs).await,
        AgentLane::Cloud => {
            let cloud = load_cloud(prefs).await;
            if cloud.is_empty() {
                load_local(prefs).await
            } else {
                cloud
            }
        }
    }
}

/// The flagship agent id (mirrors [`crate::registry::DEFAULT_AGENT_ID`]). It is
/// the one agent Core can resolve to a concrete model, because Core owns its
/// Pi config.
const FLAGSHIP_AGENT_ID: &str = "ryu";

/// A target as the universal picker can express it. Every field is optional —
/// an empty string means "not chosen", and the whole struct empty means "unset"
/// (see [`AgentSelection::is_empty`]), which is what makes the fallback chain
/// work without a sentinel value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSelection {
    /// Agent id (`ryu`, an installed external ACP agent, a custom agent).
    #[serde(default)]
    pub agent_id: String,
    /// Pi provider id that owns `model`. UI/routing hint only — the Gateway
    /// routes by model id alone, exactly as the older `*-provider` prefs did.
    #[serde(default)]
    pub provider: String,
    /// Model id, gateway-routable.
    #[serde(default)]
    pub model: String,
    /// Pi thinking level for the picked provider/model.
    #[serde(default)]
    pub thinking_level: String,
    /// Reasoning effort, forwarded as `reasoning_effort`.
    #[serde(default)]
    pub effort: String,
    /// ACP access (permission) mode for an agent-typed selection, e.g.
    /// `acceptEdits`. Carried so an agent-consuming site can start the session
    /// the user configured; model-consuming sites ignore it.
    #[serde(default)]
    pub access_mode: String,
}

impl AgentSelection {
    /// Parse a stored preference value.
    ///
    /// Accepts the JSON object form and — permanently, see the module docs —
    /// a legacy bare model id, which reads as `{ model: <id> }`. Anything
    /// unparseable that is not obviously a model id yields an empty selection
    /// rather than an error: a malformed preference must degrade to "unset",
    /// never break the feature it configures.
    pub fn parse(raw: &str) -> Self {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Self::default();
        }
        if trimmed.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<Self>(trimmed) {
                return parsed.trimmed();
            }
            // A JSON-looking blob we can't read is a corrupt setting, not a
            // model id — treat it as unset so the chain moves on.
            return Self::default();
        }
        Self {
            model: trimmed.to_string(),
            ..Default::default()
        }
    }

    /// Read a selection from `key`, or the empty selection when unset/unreadable.
    ///
    /// A key that names a credential is refused before the store is read, so
    /// its value is never decrypted and can never become a model or agent id.
    /// The key can come from an app (`host.sideModel`'s `model_pref_key`).
    pub async fn load(prefs: &PreferencesStore, key: &str) -> Self {
        if is_secret_preference_key(key) {
            tracing::warn!(key, "agent selection: refused a credential preference key");
            return Self::default();
        }
        match prefs.get(key).await {
            Ok(Some(raw)) => Self::parse(&raw),
            _ => Self::default(),
        }
    }

    /// Whitespace-trim every field, so `" gpt-5 "` and `"gpt-5"` behave alike
    /// and a field holding only spaces counts as unset.
    fn trimmed(self) -> Self {
        Self {
            agent_id: self.agent_id.trim().to_string(),
            provider: self.provider.trim().to_string(),
            model: self.model.trim().to_string(),
            thinking_level: self.thinking_level.trim().to_string(),
            effort: self.effort.trim().to_string(),
            access_mode: self.access_mode.trim().to_string(),
        }
    }

    /// True when nothing at all is chosen (the fallback chain should continue).
    pub fn is_empty(&self) -> bool {
        self.agent_id.is_empty()
            && self.provider.is_empty()
            && self.model.is_empty()
            && self.thinking_level.is_empty()
            && self.effort.is_empty()
            && self.access_mode.is_empty()
    }

    /// Serialize for storage. Always the JSON object form — writers upgrade the
    /// value in place, readers still accept the legacy bare string.
    pub fn to_pref_value(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| String::new())
    }
}

/// A model-consuming site's resolved target: what to send and how hard to think.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSideModel {
    /// Model id for the `/v1/chat/completions` call.
    pub model: String,
    /// `reasoning_effort` (empty = the provider's default).
    pub effort: String,
}

/// The concrete model an agent-typed selection stands for, or `None` when Core
/// cannot know it.
///
/// Only the flagship is resolvable: Core owns its Pi config, so "agent `ryu`"
/// genuinely means "whatever model Pi is pointed at". An external ACP agent
/// runs its own model behind its own protocol — there is no id Core could put
/// in a chat-completions body — so this returns `None` and the caller moves to
/// the next link in the chain. Silently sending the agent id as a model would
/// 400 at the gateway and read to the user as "my setting was ignored".
fn model_for_agent(agent_id: &str) -> Option<String> {
    if agent_id != FLAGSHIP_AGENT_ID {
        return None;
    }
    let view = crate::pi_config::current();
    view.model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
}

/// How hard a model-consuming call should think: the explicit `effort`, else the
/// thinking level.
///
/// These are one vocabulary, not two: the effort picker's options ARE Pi's
/// `thinkingLevels` (see the desktop's `SideModelPicker`), and a raw
/// chat-completions call has exactly one knob for it — `reasoning_effort`. So a
/// thinking level chosen from a provider's submenu has to land here, or it would
/// be collected, stored, shown in the trigger, and silently do nothing.
fn effort_of(selection: &AgentSelection) -> String {
    if selection.effort.is_empty() {
        selection.thinking_level.clone()
    } else {
        selection.effort.clone()
    }
}

/// Turn one selection into a model target, degrading an agent-typed pick.
/// `None` means this link of the chain yielded nothing.
fn side_model_from(selection: &AgentSelection) -> Option<ResolvedSideModel> {
    if !selection.model.is_empty() {
        return Some(ResolvedSideModel {
            model: selection.model.clone(),
            effort: effort_of(selection),
        });
    }
    if !selection.agent_id.is_empty() {
        if let Some(model) = model_for_agent(&selection.agent_id) {
            return Some(ResolvedSideModel {
                model,
                effort: effort_of(selection),
            });
        }
        tracing::debug!(
            agent = %selection.agent_id,
            "agent-typed selection has no chat-completions model; falling through"
        );
    }
    None
}

/// Resolve the model + effort for a model-consuming feature.
///
/// `feature_key` is that feature's own preference (e.g. `auto-title-model`);
/// `legacy_effort_key` is its separate pre-existing effort preference (e.g.
/// `auto-title-effort`), still honoured when the selection carries no effort of
/// its own, so an older config keeps working.
///
/// Returns `None` when neither the feature nor the node default names a usable
/// model — the caller then applies its own last-resort fallback unchanged.
pub async fn resolve_side_model(
    prefs: &PreferencesStore,
    feature_key: &str,
    legacy_effort_key: Option<&str>,
) -> Option<ResolvedSideModel> {
    let feature = AgentSelection::load(prefs, feature_key).await;
    let mut resolved = side_model_from(&feature);
    if resolved.is_none() {
        resolved = side_model_from(&load_local(prefs).await);
    }
    let mut resolved = resolved?;
    if resolved.effort.is_empty() {
        if let Some(key) = legacy_effort_key {
            if let Ok(Some(raw)) = prefs.get(key).await {
                resolved.effort = raw.trim().to_string();
            }
        }
    }
    Some(resolved)
}

/// Resolve the agent id for an agent-consuming feature: the feature's own
/// preference, else the node-wide default, else `None` (caller keeps its own
/// default, e.g. the flagship).
///
/// A model-typed selection names no agent, so it contributes nothing here and
/// the chain moves on — the mirror image of [`model_for_agent`]'s degrade.
pub async fn resolve_agent(prefs: &PreferencesStore, feature_key: &str) -> Option<String> {
    let feature = AgentSelection::load(prefs, feature_key).await;
    if !feature.agent_id.is_empty() {
        return Some(feature.agent_id);
    }
    // The snapshot first (it is what a written preference refreshes), then the
    // built-in pair — so an unconfigured node still names the flagship rather
    // than handing every caller back its own ad-hoc default.
    default_agent_id().or_else(|| Some(builtin_default_selection().agent_id))
}

/// In-process snapshot of the node-wide default's `agent_id`.
///
/// Some agent-consuming code runs on a hot, synchronous path with no
/// preference-store handle (agent-auto routing keeps its config in exactly such
/// a snapshot). Rather than thread a store through it, Core seeds this at
/// startup and refreshes it whenever [`LOCAL_SELECTION_PREF`] or the legacy
/// [`GLOBAL_SELECTION_PREF`] is written —
/// the same shape `agent_routing::set_auto_config_from_json` already uses.
fn default_agent_cell() -> &'static std::sync::RwLock<Option<String>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<String>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

/// Hot-path snapshots for the two lane values. Chat routing does not carry a
/// PreferencesStore through every adapter call, so preference writes refresh
/// these cells just as the historical default-agent snapshot did.
fn local_selection_cell() -> &'static std::sync::RwLock<Option<AgentSelection>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<AgentSelection>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

fn cloud_selection_cell() -> &'static std::sync::RwLock<Option<AgentSelection>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<AgentSelection>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

/// Refresh the snapshot from a raw preference value. A blank/unparseable value,
/// or a selection that names only a model, clears it — callers then keep their
/// own default rather than inheriting a stale one.
pub fn set_default_selection_from_json(value: &str) {
    set_local_selection_from_json(value);
}

/// Refresh the local-lane snapshot from a raw preference value.
pub fn set_local_selection_from_json(value: &str) {
    let selection = AgentSelection::parse(value);
    if let Ok(mut guard) = local_selection_cell().write() {
        *guard = (!selection.is_empty()).then_some(selection.clone());
    }
    let agent = selection.agent_id;
    if let Ok(mut guard) = default_agent_cell().write() {
        *guard = Some(agent).filter(|a| !a.is_empty());
    }
}

/// Refresh the cloud-lane snapshot from a raw preference value. Empty means
/// unset, which is intentionally different from the local built-in default.
pub fn set_cloud_selection_from_json(value: &str) {
    let selection = AgentSelection::parse(value);
    if let Ok(mut guard) = cloud_selection_cell().write() {
        *guard = (!selection.is_empty()).then_some(selection);
    }
}

/// The node-wide default agent id, if one is configured. Cheap and sync.
pub fn default_agent_id() -> Option<String> {
    default_agent_cell().read().ok().and_then(|g| g.clone())
}

/// Snapshot used by ordinary interactive Ryu chats. A configured cloud lane
/// wins; an unset cloud lane falls back to the local lane.
pub fn chat_default_selection() -> AgentSelection {
    cloud_selection_cell()
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .or_else(|| {
            local_selection_cell()
                .read()
                .ok()
                .and_then(|guard| guard.clone())
        })
        .unwrap_or_else(builtin_default_selection)
}

/// Snapshot used by programmatic and plugin work. These calls are deliberately
/// local unless they provide an explicit target; unlike an interactive chat,
/// they must never inherit a user's paid cloud lane by accident.
pub fn local_default_selection() -> AgentSelection {
    local_selection_cell()
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(builtin_default_selection)
}

#[cfg(test)]
#[path = "agent_selection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "agent_selection_secret_keys_test.rs"]
mod secret_keys_test;
