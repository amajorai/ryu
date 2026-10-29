//! Per-agent ACP launch and session settings.
//!
//! Every external ACP agent (a registry agent such as `acp:claude`, or a BYO
//! `acp-exec:` agent) can carry its own launch customizations, in the same shape
//! ACP editors expose them (Zed `agent_servers.<id>`, JetBrains `acp.json`,
//! avante/CodeCompanion adapters): a custom command, launch arguments and
//! environment variables, plus the session defaults Zed keys by config option
//! (default mode / model / config options) and a model allowlist.
//!
//! A few agent-specific knobs are mapped onto the variable or flag the agent
//! itself documents, so the user does not need to know them:
//!
//! | knob | Claude Code (`claude-agent-acp`) | Codex (`codex-acp`) |
//! |---|---|---|
//! | `configDir` | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` (Core-managed, see below) |
//! | `cliPath` | `CLAUDE_CODE_EXECUTABLE` | — (the CLI is built into the adapter) |
//! | `autoCompact = false` | `DISABLE_AUTO_COMPACT=1` | — (no off switch) |
//! | `autoCompactTokens` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100k–1M) | `-c model_auto_compact_token_limit=N` |
//!
//! Precedence: anything Core itself declares in the resolved spawn (Gateway
//! base URLs and credentials, Codex's deletion-safety `CODEX_HOME`, the managed
//! Pi config dir) always wins over a user value of the same name. A user setting
//! can add to an agent's launch, never re-point its governed egress or escape
//! the Codex deletion boundary.
//!
//! Storage: one preference ([`ACP_AGENT_SETTINGS_PREF_KEY`]) holds a JSON
//! object of agent id → settings, seeded at startup and read on the (sync)
//! route-resolution path. Because a value becomes an executable spawn and its
//! environment can hold credentials, the preference is sealed at rest (see
//! `server::preferences`), refused by the generic preference routes, and changed
//! only through `PUT /api/agents/:id/acp-settings`, which requires `agent.edit`
//! and updates one agent's entry atomically ([`merge_entry`]). The flagship
//! `ryu` agent is managed by Ryu's own Pi settings and never consults this map.

use std::collections::{BTreeMap, HashMap};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod config_projection;
mod launch_detection;
mod launch_overrides;

pub use config_projection::*;
pub use launch_detection::*;
pub use launch_overrides::*;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const ACP_AGENT_SETTINGS_PREF_KEY: &str = "acp-agent-settings";

/// Claude Code's documented auto-compact window bounds, in tokens.
const CLAUDE_AUTO_COMPACT_WINDOW_MIN: u64 = 100_000;
const CLAUDE_AUTO_COMPACT_WINDOW_MAX: u64 = 1_000_000;

/// User-configured launch and session settings for one ACP agent. Every field
/// is optional; an all-default value is "launch exactly as Ryu would".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AcpAgentSettings {
    /// Program to launch instead of the agent's default launcher (e.g. a local
    /// `claude-agent-acp` instead of `npx -y …`). When set, `args` are the full
    /// argument list; otherwise `args` are appended to the default ones.
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// The agent's own configuration directory (mapped per agent, see module docs).
    pub config_dir: Option<String>,
    /// Path to the underlying agent CLI the ACP adapter drives.
    pub cli_path: Option<String>,
    /// `Some(false)` disables automatic context compaction where supported.
    pub auto_compact: Option<bool>,
    /// Token threshold for automatic compaction where supported.
    pub auto_compact_tokens: Option<u64>,
    /// Models offered in the composer picker. Empty = everything the agent reports.
    pub allowed_models: Vec<String>,
    /// Model a turn starts with when the user has not picked one.
    pub default_model: Option<String>,
    /// Session mode a turn starts in when the user has not picked one.
    pub default_mode: Option<String>,
    /// Config-option values (`option id → value id`) applied when unset per turn.
    pub default_config_options: BTreeMap<String, String>,
}

impl AcpAgentSettings {
    pub fn normalized(mut self) -> Self {
        self.command = non_empty(self.command);
        self.config_dir = non_empty(self.config_dir);
        self.cli_path = non_empty(self.cli_path);
        self.default_model = non_empty(self.default_model);
        self.default_mode = non_empty(self.default_mode);
        self.args.retain(|arg| !arg.contains('\0'));
        self.env
            .retain(|name, value| valid_env_name(name) && !value.contains('\0'));
        self.allowed_models = self
            .allowed_models
            .into_iter()
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty())
            .collect();
        self.default_config_options
            .retain(|id, value| !id.trim().is_empty() && !value.trim().is_empty());
        self
    }

    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    /// Whether `model_id` may be used under this agent's allowlist.
    pub fn allows_model(&self, model_id: &str) -> bool {
        self.allowed_models.is_empty() || self.allowed_models.iter().any(|m| m == model_id)
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && !value.contains('\0'))
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn settings_map() -> &'static RwLock<HashMap<String, AcpAgentSettings>> {
    static MAP: OnceLock<RwLock<HashMap<String, AcpAgentSettings>>> = OnceLock::new();
    MAP.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Replace the in-process map from the persisted preference value. A blank or
/// unparseable value clears every override (each agent launches as default);
/// an unparseable entry is skipped on its own. Never panics.
pub fn set_from_json(value: &str) {
    let mut next = HashMap::new();
    if let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(value.trim()) {
        for (agent_id, raw) in entries {
            match serde_json::from_value::<AcpAgentSettings>(raw) {
                Ok(settings) => {
                    let settings = settings.normalized();
                    if !settings.is_empty() {
                        next.insert(agent_id, settings);
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, agent_id, "ignoring unreadable ACP agent settings");
                }
            }
        }
    }
    if let Ok(mut guard) = settings_map().write() {
        *guard = next;
    }
}

/// The settings for the first id in `keys` that has any (most specific first:
/// the selected agent, then its engine, then the registry entry id).
pub fn lookup<'a>(keys: impl IntoIterator<Item = &'a str>) -> Option<AcpAgentSettings> {
    lookup_with_source(keys).map(|(_, settings)| settings)
}

/// [`lookup`], also naming which key the settings came from, so an editor can
/// show that a custom agent inherits its engine's or registry entry's settings.
pub fn lookup_with_source<'a>(
    keys: impl IntoIterator<Item = &'a str>,
) -> Option<(String, AcpAgentSettings)> {
    let guard = settings_map().read().ok()?;
    keys.into_iter().find_map(|key| {
        guard
            .get(key)
            .map(|settings| (key.to_owned(), settings.clone()))
    })
}

/// Replace (or, when `settings` is empty, remove) one agent's entry in the
/// stored map `raw`, keeping every other entry exactly as stored. Callers hold
/// a write lock across read → merge → write so concurrent saves for different
/// agents never drop each other.
pub fn merge_entry(
    raw: Option<&str>,
    agent_id: &str,
    settings: &AcpAgentSettings,
) -> anyhow::Result<String> {
    let mut map = match raw.map(str::trim).filter(|raw| !raw.is_empty()) {
        Some(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        },
        None => serde_json::Map::new(),
    };
    if settings.is_empty() {
        map.remove(agent_id);
    } else {
        map.insert(agent_id.to_owned(), serde_json::to_value(settings)?);
    }
    Ok(serde_json::to_string(&Value::Object(map))?)
}

/// Serializes tests that mutate the process-global settings map.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests;
