//! Per-kind configuration structs for [`crate::runnable::RunnableKind`].
//!
//! Every Runnable in a `ryu.json` manifest carries an optional `config` field
//! whose shape depends on `kind`. This module defines those shapes and the
//! [`RunnableConfig`] enum that wraps them, plus the [`validate_runnable`]
//! function that checks a [`RunnableEntry`] for required fields.
//!
//! # Extending with a new kind
//!
//! 1. Add a `*Config` struct below (document every field).
//! 2. Add a variant to [`RunnableConfig`] — no wildcard arms anywhere.
//! 3. Add the required-field check in [`validate_runnable`].
//! 4. Update the corresponding [`RunnableKind`] variant doc in
//!    `crate::runnable`.
//!
//! The compiler will flag every exhaustive `match` that needs updating, so
//! "nothing hardcoded" is enforced at compile time — no `_ =>` fallback.

use serde::{Deserialize, Serialize};

use crate::runnable::RunnableKind;

// ── Per-kind config structs ───────────────────────────────────────────────────

/// Config for a `kind: "agent"` Runnable.
///
/// An agent is a "Pokémon card": independently swappable slots for the chat
/// model, tools/MCP, memory/Spaces, persona, and Gateway policy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Default system prompt (may be overridden at runtime).
    #[serde(default)]
    pub system_prompt: Option<String>,

    /// Model/engine identifier the agent prefers (e.g. `"gemma4"`, `"gpt-4o"`).
    /// Routes through the Gateway registry — never hardcoded.
    #[serde(default)]
    pub model: Option<String>,

    /// MCP tool slugs this agent is granted (subset of the app's
    /// `permission_grants`).
    #[serde(default)]
    pub tools: Vec<String>,
}

/// Config for a `kind: "workflow"` Runnable.
///
/// A workflow is a DAG of typed nodes executed by the Core workflow executor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowConfig {
    /// Path (relative to the manifest) to the workflow DAG definition file,
    /// or an inline entrypoint node id.
    pub entry: String,
}

/// Config for a `kind: "tool"` Runnable.
///
/// A tool exposes a callable function to agents and workflows. Today tools live
/// inside workflow graphs as `NodeKind::Tool`; standalone tool-as-Runnable
/// wiring lands with the MCP/tool-registry units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolConfig {
    /// MCP tool slug this Runnable wraps (e.g. `"web_search"`).
    pub slug: String,
}

/// Config for a `kind: "skill"` Runnable.
///
/// A skill is an Agent Skill per the Skills standard: a versioned, shareable
/// capability bundle (prompt + tools + optional sub-workflow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillConfig {
    /// Skill identifier in the Skills registry (e.g. `"ryu:research/v1"`).
    pub skill_id: String,
}

/// Config for a `kind: "companion"` Runnable.
///
/// A Companion surface is an in-desktop overlay or sidebar panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompanionConfig {
    /// Display label for the companion panel tab or tooltip.
    pub label: String,

    /// Icon identifier (resolved by the desktop shell).
    #[serde(default)]
    pub icon: Option<String>,

    /// Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
    #[serde(default)]
    pub shortcut: Option<String>,

    /// Optional path (relative to the manifest) to the companion's sandboxed-UI
    /// entry module. When present, the plugin bundle carries a `ui_code` blob
    /// (built by `ryu pack` from this entry) that the desktop loads into the
    /// null-origin extension-host iframe. Absent for a companion that only
    /// declares a data-driven summary (no third-party code). Lockstep with the
    /// SDK's `RunnableMeta.config.ui_entry`.
    #[serde(default)]
    pub ui_entry: Option<String>,
}

/// Config for a `kind: "channel"` Runnable.
///
/// A channel bot adapter connects a messaging platform (Telegram, Slack,
/// WhatsApp, Discord, …) to Core sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelConfig {
    /// Platform identifier (e.g. `"telegram"`, `"slack"`, `"whatsapp"`).
    pub platform: String,
}

/// Config for a `kind: "engine"` Runnable.
///
/// An engine binding wires a model/inference backend into the Gateway registry.
/// Every model call routes through the Gateway — the engine is never addressed
/// directly by Core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineConfig {
    /// Engine type identifier (e.g. `"llamacpp"`, `"ollama"`, `"openai_compat"`).
    pub engine_type: String,

    /// Base URL for OpenAI-compatible engines.
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Config for a `kind: "policy"` Runnable.
///
/// A policy fragment is a Gateway-enforced rule (firewall, PII/DLP filter,
/// budget cap, …). The *enforcement* lives in the Gateway; this config lets an
/// App declare and bundle a policy that the Gateway activates on install.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyConfig {
    /// Policy type identifier (e.g. `"firewall"`, `"pii_dlp"`, `"budget"`).
    pub policy_type: String,

    /// Inline policy definition as a JSON value (schema is policy-type-specific).
    pub definition: serde_json::Value,
}

// ── External runtime (manifest-level, #449) ───────────────────────────────────

/// A declarative **external-runtime** spec a plugin may declare at the manifest
/// level (e.g. a Python venv + pip deps + fetched assets, like the
/// `apps/tts-sidecar`). The *provisioner* lives in
/// [`crate::sidecar::external_runtime`]; this is the on-the-wire declaration.
///
/// Everything is swappable (nothing hardcoded): the runtime kind, entry module,
/// dependency set, and assets. Provisioning is gated on the plugin tier (#444)
/// plus a Gateway grant — running `pip install` from a manifest is a network +
/// code surface the Gateway must permit before it runs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ExternalRuntimeConfig {
    /// Runtime kind. `"python"` is the only provisionable kind today; others are
    /// accepted (round-trip) but provisioning returns an "unsupported" error.
    pub kind: String,

    /// The module/entrypoint to run (e.g. `"ryu_tts"` → `python -m ryu_tts`).
    pub entry: String,

    /// Optional Python version hint (e.g. `"3.11"`). Advisory.
    #[serde(default)]
    pub python_version: Option<String>,

    /// pip requirement specs to install into the venv.
    #[serde(default)]
    pub requirements: Vec<String>,

    /// Optional pyproject *extra* to install (`pip install -e ".[<extra>]"`).
    #[serde(default)]
    pub pyproject_extra: Option<String>,

    /// Assets to fetch into `~/.ryu` before first run.
    #[serde(default)]
    pub assets: Vec<AssetSpec>,

    /// Port the runtime's HTTP server binds to (adopt-or-spawn check).
    #[serde(default)]
    pub port: Option<u16>,

    /// Health-check path on the runtime's server (e.g. `"/health"`).
    #[serde(default)]
    pub health_path: Option<String>,
}

/// A single asset an external runtime needs, fetched before first run. Either a
/// direct https URL or an `hf:<owner>/<repo>/<path>` reference; `dest_under_ryu`
/// is the relative directory beneath `~/.ryu` where it lands (Core-owned) — the
/// filename is derived from the source's last path segment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetSpec {
    /// A direct **https** URL, or an `hf:<owner>/<repo>/<path>` reference to a
    /// single file on the Hub. A repo-only `hf:<owner>/<repo>` ref (no file path)
    /// is **not** provisionable yet — full-repo snapshot needs Hub tree-listing
    /// that is not wired into the provisioner. The provisioner
    /// ([`crate::sidecar::external_runtime`]) rejects `http://` and other schemes.
    pub source: String,

    /// Destination directory relative to `~/.ryu` (e.g. `"models/hf"`); the
    /// fetched file lands at `~/.ryu/<dest_under_ryu>/<filename>`. Must be a
    /// traversal-safe relative path (no `..`, not absolute).
    pub dest_under_ryu: String,

    /// Optional SHA-256 for checksum verification (direct-URL assets).
    #[serde(default)]
    pub sha256: Option<String>,
}

// ── RunnableEntry (manifest-level Runnable record) ────────────────────────────

/// A single Runnable entry inside a `ryu.json` manifest.
///
/// Each entry carries the identity fields from [`crate::runnable::RunnableMeta`]
/// plus an optional typed [`RunnableConfig`] blob. The `kind` field drives
/// which config shape is expected; validation via [`validate_runnable`] checks
/// that required-per-kind fields are present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunnableEntry {
    /// Stable unique identifier within this app (e.g. `"tool-web-search"`).
    pub id: String,

    /// Human-readable display name.
    pub name: String,

    /// Discriminant that determines which per-kind config struct is required.
    pub kind: RunnableKind,

    /// Per-kind configuration. Some kinds (e.g. `agent`) treat this as
    /// optional (sensible defaults apply); others (e.g. `tool`, `workflow`)
    /// require it. [`validate_runnable`] enforces the rules.
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

// ── Anti-impersonation ────────────────────────────────────────────────────────

/// True when a companion **label** impersonates first-party Ryu/system chrome.
///
/// Mirrors the desktop `validatePluginRoute` title check (`rpc.ts`): a plugin's
/// visible label may not contain `"ryu"` or `"system"` (case-insensitive), so a
/// third-party companion can never pose as built-in UI in the panel tab. The
/// desktop host also prepends a mandatory, non-removable `"Plugin ·"` attribution
/// prefix (`PluginHostPanel.tsx`) — that prefix is the primary guarantee; this
/// check is defense in depth enforced at the manifest seam, so a hostile label is
/// rejected at load rather than relying on the renderer alone.
pub fn label_impersonates_system_chrome(label: &str) -> bool {
    let lower = label.to_lowercase();
    lower.contains("ryu") || lower.contains("system")
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Validate a [`RunnableEntry`] against its per-kind contract.
///
/// Returns `Ok(())` when the entry is well-formed, or a descriptive
/// [`String`] error when a required field is absent or the config cannot be
/// parsed as the expected shape.
///
/// This function never panics: every error path returns `Err(String)`.
///
/// # Extending
///
/// Add a new `RunnableKind` variant arm here when a new kind is added. The
/// compiler enforces exhaustiveness — there is no `_ =>` fallback.
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

        RunnableKind::Workflow => {
            // `entry` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=workflow): missing required 'config' (needs 'entry')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<WorkflowConfig>(raw.clone()).map_err(|e| {
                format!(
                    "runnable '{}' (kind=workflow): invalid config: {e}",
                    entry.id
                )
            })?;
            if cfg.entry.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=workflow): 'entry' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Tool => {
            // `slug` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=tool): missing required 'config' (needs 'slug')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<ToolConfig>(raw.clone())
                .map_err(|e| format!("runnable '{}' (kind=tool): invalid config: {e}", entry.id))?;
            if cfg.slug.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=tool): 'slug' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Skill => {
            // `skill_id` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=skill): missing required 'config' (needs 'skill_id')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<SkillConfig>(raw.clone()).map_err(|e| {
                format!("runnable '{}' (kind=skill): invalid config: {e}", entry.id)
            })?;
            if cfg.skill_id.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=skill): 'skill_id' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Companion => {
            // `label` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=companion): missing required 'config' (needs 'label')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<CompanionConfig>(raw.clone()).map_err(|e| {
                format!(
                    "runnable '{}' (kind=companion): invalid config: {e}",
                    entry.id
                )
            })?;
            if cfg.label.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=companion): 'label' must not be empty",
                    entry.id
                ));
            }
            // Anti-impersonation: the visible label may not pose as first-party
            // Ryu/system chrome (mirrors the desktop `validatePluginRoute` title
            // gate). The mandatory "Plugin ·" attribution prefix is the primary
            // guarantee; this rejects a hostile label at the manifest seam.
            if label_impersonates_system_chrome(&cfg.label) {
                return Err(format!(
                    "runnable '{}' (kind=companion): 'label' must not impersonate system chrome (must not contain 'ryu' or 'system')",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Channel => {
            // `platform` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=channel): missing required 'config' (needs 'platform')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<ChannelConfig>(raw.clone()).map_err(|e| {
                format!(
                    "runnable '{}' (kind=channel): invalid config: {e}",
                    entry.id
                )
            })?;
            if cfg.platform.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=channel): 'platform' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Engine => {
            // `engine_type` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=engine): missing required 'config' (needs 'engine_type')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<EngineConfig>(raw.clone()).map_err(|e| {
                format!("runnable '{}' (kind=engine): invalid config: {e}", entry.id)
            })?;
            if cfg.engine_type.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=engine): 'engine_type' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Policy => {
            // `policy_type` and `definition` fields are required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=policy): missing required 'config' (needs 'policy_type' and 'definition')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<PolicyConfig>(raw.clone()).map_err(|e| {
                format!("runnable '{}' (kind=policy): invalid config: {e}", entry.id)
            })?;
            if cfg.policy_type.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=policy): 'policy_type' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, kind: RunnableKind, config: Option<serde_json::Value>) -> RunnableEntry {
        RunnableEntry {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            config,
        }
    }

    // ── agent ─────────────────────────────────────────────────────────────────

    #[test]
    fn agent_without_config_is_valid() {
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, None)).is_ok());
    }

    #[test]
    fn agent_with_full_config_is_valid() {
        let cfg = json!({ "system_prompt": "You are helpful.", "model": "gemma4", "tools": ["web_search"] });
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).is_ok());
    }

    #[test]
    fn agent_with_invalid_config_shape_errors() {
        // `tools` must be an array, not a string.
        let cfg = json!({ "tools": "not-an-array" });
        let err = validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).unwrap_err();
        assert!(err.contains("kind=agent"), "error: {err}");
    }

    // ── workflow ──────────────────────────────────────────────────────────────

    #[test]
    fn workflow_requires_config() {
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, None)).unwrap_err();
        assert!(err.contains("kind=workflow"), "error: {err}");
        assert!(err.contains("entry"), "error: {err}");
    }

    #[test]
    fn workflow_with_entry_is_valid() {
        let cfg = json!({ "entry": "step-start" });
        assert!(validate_runnable(&entry("w", RunnableKind::Workflow, Some(cfg))).is_ok());
    }

    #[test]
    fn workflow_with_empty_entry_errors() {
        let cfg = json!({ "entry": "  " });
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, Some(cfg))).unwrap_err();
        assert!(err.contains("'entry' must not be empty"), "error: {err}");
    }

    // ── tool ──────────────────────────────────────────────────────────────────

    #[test]
    fn tool_requires_config() {
        let err = validate_runnable(&entry("t", RunnableKind::Tool, None)).unwrap_err();
        assert!(err.contains("kind=tool"), "error: {err}");
    }

    #[test]
    fn tool_with_slug_is_valid() {
        let cfg = json!({ "slug": "web_search" });
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(cfg))).is_ok());
    }

    // ── skill ─────────────────────────────────────────────────────────────────

    #[test]
    fn skill_requires_skill_id() {
        let err = validate_runnable(&entry("s", RunnableKind::Skill, None)).unwrap_err();
        assert!(err.contains("kind=skill"), "error: {err}");
    }

    #[test]
    fn skill_with_skill_id_is_valid() {
        let cfg = json!({ "skill_id": "ryu:research/v1" });
        assert!(validate_runnable(&entry("s", RunnableKind::Skill, Some(cfg))).is_ok());
    }

    // ── companion ─────────────────────────────────────────────────────────────

    #[test]
    fn companion_requires_label() {
        let err = validate_runnable(&entry("c", RunnableKind::Companion, None)).unwrap_err();
        assert!(err.contains("kind=companion"), "error: {err}");
    }

    #[test]
    fn companion_with_label_is_valid() {
        let cfg = json!({ "label": "Research Panel", "icon": "magnifying-glass" });
        assert!(validate_runnable(&entry("c", RunnableKind::Companion, Some(cfg))).is_ok());
    }

    #[test]
    fn companion_label_impersonating_system_chrome_errors() {
        for bad in ["Ryu Settings", "system tools", "RYU", "My System Panel"] {
            let cfg = json!({ "label": bad });
            let err = validate_runnable(&entry("c", RunnableKind::Companion, Some(cfg)))
                .unwrap_err();
            assert!(
                err.contains("impersonate system chrome"),
                "label '{bad}' should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn label_impersonates_system_chrome_matches_route_title_rule() {
        assert!(label_impersonates_system_chrome("Ryu"));
        assert!(label_impersonates_system_chrome("system"));
        assert!(label_impersonates_system_chrome("A RYU Panel"));
        assert!(!label_impersonates_system_chrome("Research Assistant"));
        assert!(!label_impersonates_system_chrome("Advisor"));
    }

    // ── channel ───────────────────────────────────────────────────────────────

    #[test]
    fn channel_requires_platform() {
        let err = validate_runnable(&entry("ch", RunnableKind::Channel, None)).unwrap_err();
        assert!(err.contains("kind=channel"), "error: {err}");
    }

    #[test]
    fn channel_with_platform_is_valid() {
        let cfg = json!({ "platform": "telegram" });
        assert!(validate_runnable(&entry("ch", RunnableKind::Channel, Some(cfg))).is_ok());
    }

    // ── engine ────────────────────────────────────────────────────────────────

    #[test]
    fn engine_requires_engine_type() {
        let err = validate_runnable(&entry("e", RunnableKind::Engine, None)).unwrap_err();
        assert!(err.contains("kind=engine"), "error: {err}");
    }

    #[test]
    fn engine_with_type_is_valid() {
        let cfg = json!({ "engine_type": "llamacpp", "base_url": "http://localhost:8080" });
        assert!(validate_runnable(&entry("e", RunnableKind::Engine, Some(cfg))).is_ok());
    }

    // ── policy ────────────────────────────────────────────────────────────────

    #[test]
    fn policy_requires_config() {
        let err = validate_runnable(&entry("p", RunnableKind::Policy, None)).unwrap_err();
        assert!(err.contains("kind=policy"), "error: {err}");
    }

    #[test]
    fn policy_with_type_and_definition_is_valid() {
        let cfg = json!({
            "policy_type": "pii_dlp",
            "definition": { "block_patterns": ["\\b\\d{16}\\b"] }
        });
        assert!(validate_runnable(&entry("p", RunnableKind::Policy, Some(cfg))).is_ok());
    }

    #[test]
    fn policy_with_empty_type_errors() {
        let cfg = json!({ "policy_type": "", "definition": {} });
        let err = validate_runnable(&entry("p", RunnableKind::Policy, Some(cfg))).unwrap_err();
        assert!(
            err.contains("'policy_type' must not be empty"),
            "error: {err}"
        );
    }
}
