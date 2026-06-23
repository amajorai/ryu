//! The **Runnable** data model — the kind discriminant, identity metadata, and
//! per-kind manifest config shapes shared by every Ryu language binding.
//!
//! This is the *pure data* slice of Core's `crate::runnable` and
//! `crate::plugin_manifest::schema` modules. The executable `Runnable` trait and
//! its impls (on `AgentRecord`, `SkillRecord`, `Workflow`) stay in Core because
//! they are coupled to Core's execution types; only the serde shapes that a
//! `plugin.json` author needs are lifted here so they have exactly one
//! definition that every binding (and Core itself, once it depends on this
//! crate) shares.
//!
//! Every shape derives [`schemars::JsonSchema`] so the crate can emit a JSON
//! Schema for languages that validate manifests without an FFI binding (see
//! [`crate::json_schema`]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The kind of a Runnable — the union of every executable thing in Ryu.
///
/// Mirrors `RunnableKind` in `apps/core/src/runnable/mod.rs`, including its
/// `#[serde(rename_all = "snake_case")]` wire form, so a manifest authored
/// against this enum deserialises byte-for-byte the same in Core.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RunnableKind {
    /// A configured agent (system prompt + tools + model/engine binding).
    Agent,
    /// A DAG workflow of typed nodes.
    Workflow,
    /// A callable tool.
    Tool,
    /// An Agent Skill (the Skills standard).
    Skill,
    /// An in-desktop overlay or sidebar Companion surface.
    Companion,
    /// A channel bot adapter (Telegram, Slack, WhatsApp, Discord, …).
    Channel,
    /// A pluggable model/inference engine binding.
    Engine,
    /// A Gateway policy fragment (firewall rule, PII/DLP filter, budget cap, …).
    Policy,
}

impl RunnableKind {
    /// A stable lowercase identifier for the kind (handy for APIs and logs).
    pub const fn as_str(self) -> &'static str {
        match self {
            RunnableKind::Agent => "agent",
            RunnableKind::Workflow => "workflow",
            RunnableKind::Tool => "tool",
            RunnableKind::Skill => "skill",
            RunnableKind::Companion => "companion",
            RunnableKind::Channel => "channel",
            RunnableKind::Engine => "engine",
            RunnableKind::Policy => "policy",
        }
    }
}

/// A kind-agnostic snapshot of a Runnable's identity (`id` + `name` + `kind`).
///
/// Mirrors `RunnableMeta` in `apps/core/src/runnable/mod.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RunnableMeta {
    /// Stable unique identifier (e.g. `"agent-researcher"`).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Which kind of runnable this entry describes.
    pub kind: RunnableKind,
}

// ── Per-kind config structs ───────────────────────────────────────────────────

/// Config for a `kind: "agent"` Runnable. All fields are optional (defaults
/// apply), matching Core's `AgentConfig`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct AgentConfig {
    /// Default system prompt (may be overridden at runtime).
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Model/engine identifier the agent prefers. Routes through the Gateway
    /// registry — never hardcoded.
    #[serde(default)]
    pub model: Option<String>,
    /// MCP tool slugs this agent is granted.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// Config for a `kind: "workflow"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowConfig {
    /// Path (relative to the manifest) to the workflow DAG definition, or an
    /// inline entrypoint node id.
    pub entry: String,
}

/// Config for a `kind: "tool"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ToolConfig {
    /// MCP tool slug this Runnable wraps (e.g. `"web_search"`).
    pub slug: String,
}

/// Config for a `kind: "skill"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SkillConfig {
    /// Skill identifier in the Skills registry (e.g. `"ryu:research/v1"`).
    pub skill_id: String,
}

/// Config for a `kind: "companion"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompanionConfig {
    /// Display label for the companion panel tab or tooltip.
    pub label: String,
    /// Icon identifier (resolved by the desktop shell).
    #[serde(default)]
    pub icon: Option<String>,
    /// Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
    #[serde(default)]
    pub shortcut: Option<String>,
}

/// Config for a `kind: "channel"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChannelConfig {
    /// Platform identifier (e.g. `"telegram"`, `"slack"`, `"whatsapp"`).
    pub platform: String,
}

/// Config for a `kind: "engine"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineConfig {
    /// Engine type identifier (e.g. `"llamacpp"`, `"ollama"`, `"openai_compat"`).
    pub engine_type: String,
    /// Base URL for OpenAI-compatible engines.
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Config for a `kind: "policy"` Runnable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyConfig {
    /// Policy type identifier (e.g. `"firewall"`, `"pii_dlp"`, `"budget"`).
    pub policy_type: String,
    /// Inline policy definition (schema is policy-type-specific).
    pub definition: serde_json::Value,
}

// ── RunnableEntry ─────────────────────────────────────────────────────────────

/// A single Runnable entry inside a `plugin.json` manifest — identity fields
/// plus an optional typed `config` blob whose shape is driven by `kind`.
///
/// Mirrors `RunnableEntry` in `apps/core/src/plugin_manifest/schema.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunnableEntry {
    /// Stable unique identifier within this plugin (e.g. `"tool-web-search"`).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Discriminant that determines which per-kind config struct is required.
    pub kind: RunnableKind,
    /// Per-kind configuration. Required for some kinds (tool/workflow/…),
    /// optional for others (agent). [`validate_runnable`] enforces the rules.
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

impl RunnableEntry {
    /// A [`RunnableMeta`] view of this entry (identity only, no config).
    pub fn metadata(&self) -> RunnableMeta {
        RunnableMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
        }
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Require a config blob to be present, parse it as `T`, and run `check` on the
/// parsed value. Centralises the "missing config / invalid shape / empty field"
/// error wording so every kind reports consistently.
fn require_config<T, F>(entry: &RunnableEntry, kind: &str, needs: &str, check: F) -> Result<(), String>
where
    T: for<'de> Deserialize<'de>,
    F: FnOnce(&T) -> Result<(), String>,
{
    let raw = entry.config.as_ref().ok_or_else(|| {
        format!("runnable '{}' (kind={kind}): missing required 'config' (needs {needs})", entry.id)
    })?;
    let cfg: T = serde_json::from_value(raw.clone())
        .map_err(|e| format!("runnable '{}' (kind={kind}): invalid config: {e}", entry.id))?;
    check(&cfg)
}

/// Reject an empty/whitespace-only required string field.
fn non_empty(value: &str, entry_id: &str, kind: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("runnable '{entry_id}' (kind={kind}): '{field}' must not be empty"));
    }
    Ok(())
}

/// Validate a [`RunnableEntry`] against its per-kind contract.
///
/// Returns `Ok(())` when well-formed, else a descriptive error. Mirrors
/// `validate_runnable` in `apps/core/src/plugin_manifest/schema.rs` (same error
/// substrings, so Core's tests and any binding's tests agree).
pub fn validate_runnable(entry: &RunnableEntry) -> Result<(), String> {
    match entry.kind {
        RunnableKind::Agent => {
            // Agent config is fully optional — all fields have defaults.
            if let Some(raw) = &entry.config {
                serde_json::from_value::<AgentConfig>(raw.clone()).map_err(|e| {
                    format!("runnable '{}' (kind=agent): invalid config: {e}", entry.id)
                })?;
            }
            Ok(())
        }
        RunnableKind::Workflow => require_config::<WorkflowConfig, _>(entry, "workflow", "'entry'", |c| {
            non_empty(&c.entry, &entry.id, "workflow", "entry")
        }),
        RunnableKind::Tool => require_config::<ToolConfig, _>(entry, "tool", "'slug'", |c| {
            non_empty(&c.slug, &entry.id, "tool", "slug")
        }),
        RunnableKind::Skill => require_config::<SkillConfig, _>(entry, "skill", "'skill_id'", |c| {
            non_empty(&c.skill_id, &entry.id, "skill", "skill_id")
        }),
        RunnableKind::Companion => require_config::<CompanionConfig, _>(entry, "companion", "'label'", |c| {
            non_empty(&c.label, &entry.id, "companion", "label")
        }),
        RunnableKind::Channel => require_config::<ChannelConfig, _>(entry, "channel", "'platform'", |c| {
            non_empty(&c.platform, &entry.id, "channel", "platform")
        }),
        RunnableKind::Engine => require_config::<EngineConfig, _>(entry, "engine", "'engine_type'", |c| {
            non_empty(&c.engine_type, &entry.id, "engine", "engine_type")
        }),
        RunnableKind::Policy => require_config::<PolicyConfig, _>(
            entry,
            "policy",
            "'policy_type' and 'definition'",
            |c| non_empty(&c.policy_type, &entry.id, "policy", "policy_type"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, kind: RunnableKind, config: Option<serde_json::Value>) -> RunnableEntry {
        RunnableEntry { id: id.to_string(), name: id.to_string(), kind, config }
    }

    #[test]
    fn kind_wire_form_is_snake_case() {
        assert_eq!(serde_json::to_string(&RunnableKind::Agent).unwrap(), "\"agent\"");
        assert_eq!(serde_json::to_string(&RunnableKind::Policy).unwrap(), "\"policy\"");
        assert_eq!(RunnableKind::Workflow.as_str(), "workflow");
    }

    #[test]
    fn agent_config_is_optional_and_typed() {
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, None)).is_ok());
        let cfg = json!({ "system_prompt": "hi", "model": "gemma4", "tools": ["web_search"] });
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).is_ok());
        // tools must be an array
        let bad = json!({ "tools": "not-an-array" });
        let err = validate_runnable(&entry("a", RunnableKind::Agent, Some(bad))).unwrap_err();
        assert!(err.contains("kind=agent"), "{err}");
    }

    #[test]
    fn workflow_requires_non_empty_entry() {
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, None)).unwrap_err();
        assert!(err.contains("kind=workflow") && err.contains("entry"), "{err}");
        assert!(validate_runnable(&entry("w", RunnableKind::Workflow, Some(json!({"entry":"start"})))).is_ok());
        let empty = validate_runnable(&entry("w", RunnableKind::Workflow, Some(json!({"entry":"  "})))).unwrap_err();
        assert!(empty.contains("'entry' must not be empty"), "{empty}");
    }

    #[test]
    fn tool_skill_channel_engine_companion_required_fields() {
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(json!({"slug":"web_search"})))).is_ok());
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, None)).is_err());
        assert!(validate_runnable(&entry("s", RunnableKind::Skill, Some(json!({"skill_id":"ryu:research/v1"})))).is_ok());
        assert!(validate_runnable(&entry("c", RunnableKind::Companion, Some(json!({"label":"Panel"})))).is_ok());
        assert!(validate_runnable(&entry("ch", RunnableKind::Channel, Some(json!({"platform":"telegram"})))).is_ok());
        assert!(validate_runnable(&entry("e", RunnableKind::Engine, Some(json!({"engine_type":"llamacpp"})))).is_ok());
    }

    #[test]
    fn policy_requires_type_and_definition() {
        let ok = json!({ "policy_type": "pii_dlp", "definition": { "block": [] } });
        assert!(validate_runnable(&entry("p", RunnableKind::Policy, Some(ok))).is_ok());
        let empty = json!({ "policy_type": "", "definition": {} });
        let err = validate_runnable(&entry("p", RunnableKind::Policy, Some(empty))).unwrap_err();
        assert!(err.contains("'policy_type' must not be empty"), "{err}");
    }
}
