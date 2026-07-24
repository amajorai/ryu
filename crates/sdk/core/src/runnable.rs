//! The **Runnable** data model — the kind discriminant, identity metadata, and
//! per-kind manifest config shapes shared by every Ryu language binding.
//!
//! These are the *pure data* shapes a `manifest.json` author needs. Their single
//! definition lives in the `ryu-kernel-contracts` crate (which `apps/core` also
//! depends on), so this module is now a thin re-export — ending the historical
//! drift where the SDK carried a hand-maintained subset copy (e.g. a `ToolConfig`
//! that only knew `slug`). Every shape still derives [`schemars::JsonSchema`] so
//! the crate can emit a JSON Schema for languages that validate without FFI.

pub use ryu_kernel_contracts::runnable::{RunnableKind, RunnableMeta};
pub use ryu_kernel_contracts::schema::{
    validate_runnable, AgentConfig, ChannelConfig, CompanionConfig, EngineConfig, PolicyConfig,
    RunnableEntry, SkillConfig, ToolConfig, WorkflowConfig,
};

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

    #[test]
    fn kind_wire_form_is_snake_case() {
        assert_eq!(
            serde_json::to_string(&RunnableKind::Agent).unwrap(),
            "\"agent\""
        );
        assert_eq!(
            serde_json::to_string(&RunnableKind::Policy).unwrap(),
            "\"policy\""
        );
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
        assert!(
            err.contains("kind=workflow") && err.contains("entry"),
            "{err}"
        );
        assert!(validate_runnable(&entry(
            "w",
            RunnableKind::Workflow,
            Some(json!({"entry":"start"}))
        ))
        .is_ok());
        let empty = validate_runnable(&entry(
            "w",
            RunnableKind::Workflow,
            Some(json!({"entry":"  "})),
        ))
        .unwrap_err();
        assert!(empty.contains("'entry' must not be empty"), "{empty}");
    }

    #[test]
    fn tool_skill_channel_engine_companion_required_fields() {
        assert!(validate_runnable(&entry(
            "t",
            RunnableKind::Tool,
            Some(json!({"slug":"web_search"}))
        ))
        .is_ok());
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, None)).is_err());
        assert!(validate_runnable(&entry(
            "s",
            RunnableKind::Skill,
            Some(json!({"skill_id":"ryu:research/v1"}))
        ))
        .is_ok());
        assert!(validate_runnable(&entry(
            "c",
            RunnableKind::Companion,
            Some(json!({"label":"Panel"}))
        ))
        .is_ok());
        assert!(validate_runnable(&entry(
            "ch",
            RunnableKind::Channel,
            Some(json!({"platform":"telegram"}))
        ))
        .is_ok());
        assert!(validate_runnable(&entry(
            "e",
            RunnableKind::Engine,
            Some(json!({"engine_type":"llamacpp"}))
        ))
        .is_ok());
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
