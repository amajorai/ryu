//! Per-agent capability detection (tools / reasoning / vision) and user
//! overrides, modelled on Jan's capability system.
//!
//! Jan detects a *model's* capabilities and renders chat-input affordances
//! conditionally on them: tools is read from the GGUF `tokenizer.chat_template`
//! (the template renders a `tools` section iff the model was trained for tool
//! calls), reasoning is inferred from the template, vision from the multimodal
//! projector — and the user can override any of them in the model's edit page
//! (`_userConfiguredCapabilities`). Ryu mirrors that, but capability is resolved
//! **per agent** (an agent is a card whose chat-model slot can repoint) across
//! two planes:
//!
//! * **ACP agents** advertise their session config at `session/new`; a
//!   reasoning-effort / thought-level config option means the agent supports
//!   thinking. Tool calls flow through Ryu's MCP bridge, so an ACP agent always
//!   supports tools.
//! * **local / openai-compat agents** bind a local GGUF; we read its chat
//!   template ([`super::gguf`]) and apply Jan's exact heuristics.
//!
//! The auto-detected result is the *default*; a per-agent [`CapabilityOverrides`]
//! (tri-state, persisted out-of-band so the agents schema is untouched) wins when
//! set — this is the "Show + manual override switch" the edit page exposes.
//!
//! Placement (Core vs Gateway): capability discovery is read-only orchestration
//! metadata that decides which UI controls *can* run — it is not policy, so it
//! lives in Core. The Gateway still governs whether a permitted tool call is
//! *allowed* to execute.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{gguf, installed};

/// Auto-detected capability flags for an agent's bound model.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DetectedCaps {
    pub tools: bool,
    pub reasoning: bool,
    pub vision: bool,
    /// True when the model is a generative image/video diffusion model (not a
    /// chat model). Detected from the GGUF `general.architecture` key.
    /// Unlike the other flags, this is a model *kind* — it changes the entire
    /// interaction surface — and is not user-overridable via [`CapabilityOverrides`].
    pub diffusion: bool,
}

/// User overrides for an agent's capabilities. Each field is tri-state: `None`
/// means "use auto-detection", `Some(true/false)` forces the flag on/off. This
/// is Jan's `_userConfiguredCapabilities` applied per agent.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
}

impl CapabilityOverrides {
    /// Whether every field is `None` (i.e. no override at all → drop the record).
    pub fn is_empty(&self) -> bool {
        self.tools.is_none() && self.reasoning.is_none() && self.vision.is_none()
    }

    /// Apply the overrides on top of detected defaults to get effective flags.
    /// `diffusion` is not user-overridable and passes through unchanged.
    pub fn apply(&self, d: DetectedCaps) -> DetectedCaps {
        DetectedCaps {
            tools: self.tools.unwrap_or(d.tools),
            reasoning: self.reasoning.unwrap_or(d.reasoning),
            vision: self.vision.unwrap_or(d.vision),
            diffusion: d.diffusion,
        }
    }
}

/// The full capability report for one agent, as returned by the API. Carries the
/// effective flags (what the UI gates on), the pre-override detection, the
/// stored overrides, and where the detection came from.
#[derive(Debug, Clone, Serialize)]
pub struct CapabilityReport {
    /// Effective tool-calling support (detected, then override).
    pub tools: bool,
    /// Effective reasoning / extended-thinking support.
    pub reasoning: bool,
    /// Effective vision (image input) support.
    pub vision: bool,
    /// True when this model is a generative diffusion model (text-to-image /
    /// text-to-video). Not user-overridable — taken directly from detection.
    pub diffusion: bool,
    /// Auto-detected flags before overrides.
    pub detected: DetectedCaps,
    /// The user's tri-state overrides.
    pub overrides: CapabilityOverrides,
    /// How detection was performed: `"acp_probe"`, `"gguf"`, or `"default"`.
    pub source: &'static str,
}

impl CapabilityReport {
    /// Build a report from detected flags + the given source, applying overrides.
    pub fn build(
        detected: DetectedCaps,
        overrides: CapabilityOverrides,
        source: &'static str,
    ) -> Self {
        let eff = overrides.apply(detected);
        Self {
            tools: eff.tools,
            reasoning: eff.reasoning,
            vision: eff.vision,
            diffusion: detected.diffusion,
            detected,
            overrides,
            source,
        }
    }
}

// ── Detection heuristics (pure) ───────────────────────────────────────────────

/// Markers in a chat template that indicate the model emits a separate reasoning
/// / thinking channel. Kept data-driven (not hardcoded per model) and matched
/// case-insensitively. Covers the common families: DeepSeek-R1 (`<think>`),
/// Qwen3 (`enable_thinking` / `reasoning`), gpt-oss harmony (`<|channel|>`).
const REASONING_MARKERS: &[&str] = &[
    "<think>",
    "enable_thinking",
    "reasoning_content",
    "reasoning",
    "<|channel|>",
];

/// Detect `(tools, reasoning)` support from a GGUF chat template. Tool support is
/// Jan's exact test — the template references a `tools` variable iff the model
/// renders a tool section. Reasoning is a marker heuristic.
pub fn detect_from_chat_template(template: &str) -> (bool, bool) {
    let tools = template.contains("tools");
    let lower = template.to_lowercase();
    let reasoning = REASONING_MARKERS.iter().any(|m| lower.contains(m));
    (tools, reasoning)
}

/// Detect capabilities for a *local* model identified by a stem or repo id (the
/// value carried in an agent's `chat_model.model_id` / legacy `model`). Returns
/// `None` when no installed GGUF resolves (remote provider, non-GGUF snapshot, or
/// a model the user never downloaded) so the caller can fall back to a default.
pub fn detect_local(model_ref: &str) -> Option<DetectedCaps> {
    let stem = installed::resolve_to_stem(model_ref)?;
    let path = installed::model_file_path(&stem);
    let meta = gguf::read_metadata(&path).ok()?;
    let diffusion = meta.is_diffusion();
    let (tools, reasoning) = meta
        .chat_template()
        .map(detect_from_chat_template)
        .unwrap_or((false, false));
    // Vision is the multimodal projector convention (a model is vision-capable
    // iff its `<stem>.mmproj.gguf` adapter is installed beside the weights) —
    // the same signal the launch path and the catalog badge use.
    let vision = installed::mmproj_file_path(&stem).exists();
    Some(DetectedCaps {
        tools,
        reasoning,
        vision,
        diffusion,
    })
}

/// Detect whether a local GGUF identified by its stem is a diffusion model.
/// Cheaper than [`detect_local`] when only the diffusion flag is needed — reads
/// the GGUF metadata once without needing to resolve via the provenance index.
/// Returns `false` on any read or parse failure.
pub fn detect_local_is_diffusion(stem: &str) -> bool {
    let path = installed::model_file_path(stem);
    gguf::read_metadata(&path)
        .ok()
        .as_ref()
        .map(|m| m.is_diffusion())
        .unwrap_or(false)
}

/// Merge ACP-probed capabilities with a local GGUF model's detection.
///
/// ACP agents (Ryu/Pi, Claude Code, …) always support tools via the MCP bridge,
/// and may advertise reasoning via `session/new` config options. Vision and
/// diffusion are properties of the *bound local model* (mmproj on disk), which
/// the ACP probe never reports — so for flagship/local-hybrid agents we OR in
/// the GGUF flags without clobbering the ACP tool guarantee.
pub fn merge_acp_with_local(acp: DetectedCaps, local: Option<DetectedCaps>) -> DetectedCaps {
    let Some(local) = local else {
        return acp;
    };
    DetectedCaps {
        tools: acp.tools,
        reasoning: acp.reasoning || local.reasoning,
        vision: local.vision,
        diffusion: local.diffusion,
    }
}

/// Detect whether an ACP agent advertises a reasoning / thought-level control in
/// its probed `session/new` response (the `{ modes, models, configOptions }`
/// shape from `probe_acp_config`). A config option whose category/id/name reads
/// like reasoning effort means the agent supports thinking.
pub fn acp_probe_reasoning(probe: &serde_json::Value) -> bool {
    let Some(opts) = probe.get("configOptions").and_then(|v| v.as_array()) else {
        return false;
    };
    opts.iter().any(config_option_is_reasoning)
}

fn config_option_is_reasoning(opt: &serde_json::Value) -> bool {
    let hay = ["category", "id", "name"]
        .iter()
        .filter_map(|k| opt.get(*k).and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    ["thought", "reason", "think", "effort"]
        .iter()
        .any(|m| hay.contains(m))
}

// ── Override store (`~/.ryu/agent-capability-overrides.json`) ─────────────────

/// Serializes writes to the override file to avoid clobbering on concurrent
/// edits (mirrors the installed-models store's lock discipline).
static LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
    crate::ryu_dir().join("agent-capability-overrides.json")
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OverridesFile {
    /// Keyed by agent id.
    #[serde(default)]
    overrides: HashMap<String, CapabilityOverrides>,
}

fn read_file() -> OverridesFile {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Load the stored overrides for an agent (all-`None` when none recorded).
pub fn load_override(agent_id: &str) -> CapabilityOverrides {
    read_file()
        .overrides
        .get(agent_id)
        .copied()
        .unwrap_or_default()
}

/// Persist an agent's overrides. An all-`None` override deletes the record (so
/// "reset to auto" leaves no residue). Atomic write (temp + rename).
pub fn save_override(agent_id: &str, ov: &CapabilityOverrides) -> anyhow::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = store_path();
    let mut file = read_file();
    if ov.is_empty() {
        file.overrides.remove(agent_id);
    } else {
        file.overrides.insert(agent_id.to_string(), *ov);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&file)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_detected_from_template() {
        // A tool-capable template references `tools`.
        let (tools, _) = detect_from_chat_template(
            "{% if tools %}You can call: {{ tools }}{% endif %}{{ messages }}",
        );
        assert!(tools);
        // A plain chat template does not.
        let (tools, _) = detect_from_chat_template("{{ messages }} plain template");
        assert!(!tools);
    }

    #[test]
    fn reasoning_detected_from_markers() {
        let (_, r1) = detect_from_chat_template("... <think> ... </think> ...");
        assert!(r1);
        let (_, r2) = detect_from_chat_template("{% if enable_thinking %}...{% endif %}");
        assert!(r2);
        let (_, r3) = detect_from_chat_template("plain {{ messages }}");
        assert!(!r3);
    }

    #[test]
    fn overrides_win_over_detection() {
        let detected = DetectedCaps {
            tools: false,
            reasoning: true,
            vision: false,
            diffusion: false,
        };
        let ov = CapabilityOverrides {
            tools: Some(true),
            reasoning: Some(false),
            vision: None,
        };
        let eff = ov.apply(detected);
        assert!(eff.tools, "override forces tools on");
        assert!(!eff.reasoning, "override forces reasoning off");
        assert!(!eff.vision, "no override → detected value");
        assert!(!eff.diffusion, "diffusion passes through from detection");
    }

    #[test]
    fn diffusion_not_overridable() {
        let detected = DetectedCaps {
            diffusion: true,
            ..Default::default()
        };
        // No matter what the override says, diffusion stays from detection.
        let ov = CapabilityOverrides::default();
        let eff = ov.apply(detected);
        assert!(eff.diffusion, "diffusion passes through unchanged");
    }

    #[test]
    fn empty_override_is_noop() {
        let ov = CapabilityOverrides::default();
        assert!(ov.is_empty());
        let detected = DetectedCaps {
            tools: true,
            reasoning: false,
            vision: true,
            diffusion: false,
        };
        assert_eq!(ov.apply(detected), detected);
    }

    #[test]
    fn merge_acp_with_local_adds_vision_from_gguf() {
        let acp = DetectedCaps {
            tools: true,
            reasoning: true,
            vision: false,
            diffusion: false,
        };
        let local = DetectedCaps {
            tools: false,
            reasoning: false,
            vision: true,
            diffusion: false,
        };
        let merged = merge_acp_with_local(acp, Some(local));
        assert!(merged.tools, "ACP tool loop preserved");
        assert!(merged.reasoning, "ACP reasoning preserved");
        assert!(merged.vision, "local mmproj adds vision");
    }

    #[test]
    fn acp_reasoning_from_config_option() {
        let probe = serde_json::json!({
            "modes": null,
            "models": null,
            "configOptions": [
                { "id": "thought_level", "name": "Thinking", "category": "thoughtLevel" }
            ]
        });
        assert!(acp_probe_reasoning(&probe));

        let no_reason = serde_json::json!({
            "configOptions": [ { "id": "verbosity", "name": "Verbosity", "category": "other" } ]
        });
        assert!(!acp_probe_reasoning(&no_reason));

        let none = serde_json::json!({ "configOptions": null });
        assert!(!acp_probe_reasoning(&none));
    }

    #[test]
    fn report_applies_overrides_and_keeps_provenance() {
        let detected = DetectedCaps {
            tools: true,
            reasoning: false,
            vision: false,
            diffusion: false,
        };
        let ov = CapabilityOverrides {
            reasoning: Some(true),
            ..Default::default()
        };
        let report = CapabilityReport::build(detected, ov, "gguf");
        assert!(report.tools);
        assert!(report.reasoning);
        assert!(!report.diffusion);
        assert!(
            !report.detected.reasoning,
            "detected snapshot is pre-override"
        );
        assert_eq!(report.source, "gguf");
    }

    #[test]
    fn diffusion_report_is_not_overridable() {
        let detected = DetectedCaps {
            diffusion: true,
            ..Default::default()
        };
        let report = CapabilityReport::build(detected, CapabilityOverrides::default(), "gguf");
        assert!(
            report.diffusion,
            "diffusion surfaces directly in the report"
        );
    }
}
