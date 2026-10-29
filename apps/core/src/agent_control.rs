//! Conversation-scoped control requested by a running agent.
//!
//! The normal model router decides a target when a user message arrives. This
//! module is the separate agent-level escape hatch: an active agent can request
//! a target agent, model, or reasoning effort for the next turn. The request is
//! validated and persisted by Core, then consumed once by the next interactive
//! turn. It never mutates an agent card or a node-wide routing preference.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::{AgentLifecycleStatus, AgentRecord, AgentStore};
use crate::server::conversations::ConversationStore;
use crate::sidecar::mcp::RegistryTool;

/// Synthetic built-in MCP server for agent-level target control.
pub const SERVER_NAME: &str = "agent_control";
/// Fully-qualified id of the one control tool.
pub const SET_ACTIVE_TARGET_TOOL_ID: &str = "agent_control.set_active_target";

const MAX_FIELD_LENGTH: usize = 200;
/// Stored in the nullable control columns when a request explicitly clears a
/// field. The control character cannot be entered through `parse_text_field`.
pub(crate) const CLEAR_SENTINEL: &str = "\u{001f}ryu-agent-control-clear";

/// A partial next-turn target requested by an agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentControlPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip)]
    pub clear_agent_id: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip)]
    pub clear_model: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip)]
    pub clear_effort: bool,
}

impl AgentControlPatch {
    pub fn is_empty(&self) -> bool {
        self.agent_id.is_none()
            && !self.clear_agent_id
            && self.model.is_none()
            && !self.clear_model
            && self.effort.is_none()
            && !self.clear_effort
    }
}

/// Persisted pending control, including the caller for audit/debugging.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingAgentControl {
    pub patch: AgentControlPatch,
    pub requested_by: String,
    pub requested_at: i64,
}

/// The accepted control and the effective target chosen for the next turn.
/// This is emitted as `data-ryu-agent-control` for the active desktop tab.
fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentControlApplied {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_effort: Option<String>,
    /// Whether the accepted patch explicitly cleared the model pin.
    #[serde(default, skip_serializing_if = "is_false")]
    pub model_cleared: bool,
    /// Whether the accepted patch explicitly cleared the effort pin.
    #[serde(default, skip_serializing_if = "is_false")]
    pub effort_cleared: bool,
}

/// The descriptor offered to an active agent through the governed MCP bridge.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: SET_ACTIVE_TARGET_TOOL_ID.to_owned(),
        server: SERVER_NAME.to_owned(),
        name: "set_active_target".to_owned(),
        description: Some(
            "Choose the agent, model, or reasoning effort for the next user turn. This is a conversation-scoped request and does not change saved agent defaults.".to_owned(),
        ),
        input_schema: Some(json!({
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": ["string", "null"],
                    "description": "Installed agent id to handle the next user turn; null or 'clear' resumes automatic routing."
                },
                "model": {
                    "type": ["string", "null"],
                    "description": "Model id to use on the next user turn; null or 'clear' resumes automatic selection."
                },
                "effort": {
                    "type": ["string", "null"],
                    "description": "Reasoning effort/config value for the next user turn (for example low, medium, or high); null or 'clear' resumes the default."
                }
            },
            "additionalProperties": false
        })),
        ..RegistryTool::default()
    }]
}

fn parse_text_field(args: &Value, name: &str) -> Result<(Option<String>, bool)> {
    let Some(value) = args.get(name) else {
        return Ok((None, false));
    };
    if value.is_null() {
        return Ok((None, true));
    };
    let Some(value) = value.as_str() else {
        return Err(anyhow!("'{name}' must be a string or null when provided"));
    };
    let value = value.trim();
    if value.eq_ignore_ascii_case("clear") {
        return Ok((None, true));
    }
    if value.is_empty() {
        return Err(anyhow!("'{name}' must not be empty"));
    }
    if value.len() > MAX_FIELD_LENGTH {
        return Err(anyhow!("'{name}' is too long"));
    }
    if value.chars().any(char::is_control) {
        return Err(anyhow!("'{name}' contains a control character"));
    }
    Ok((Some(value.to_owned()), false))
}

/// Parse the model-visible tool input without trusting arbitrary JSON values.
pub fn parse_patch(args: &Value) -> Result<AgentControlPatch> {
    let (agent_id, clear_agent_id) = parse_text_field(args, "agent_id")?;
    let (model, clear_model) = parse_text_field(args, "model")?;
    let (effort, clear_effort) = parse_text_field(args, "effort")?;
    let patch = AgentControlPatch {
        agent_id,
        clear_agent_id,
        model,
        clear_model,
        effort,
        clear_effort,
    };
    if patch.is_empty() {
        return Err(anyhow!(
            "set_active_target requires at least one of agent_id, model, or effort"
        ));
    }
    Ok(patch)
}

/// Revalidate a consumed request against the current agent records. The
/// request is one-shot state, so callers should discard it if this fails.
pub async fn validate_pending_control(
    control: &PendingAgentControl,
    effective_agent_id: Option<&str>,
    agent_store: &AgentStore,
) -> Result<()> {
    let caller = agent_store
        .get(&control.requested_by)
        .await
        .context("checking pending control caller")?
        .ok_or_else(|| {
            anyhow!(
                "pending control caller '{}' is no longer installed",
                control.requested_by
            )
        })?;
    if caller.lifecycle_status != AgentLifecycleStatus::Active {
        return Err(anyhow!(
            "pending control caller '{}' is no longer active",
            caller.name
        ));
    }

    let target_agent_id = control
        .patch
        .agent_id
        .as_deref()
        .or(effective_agent_id)
        .ok_or_else(|| anyhow!("pending control has no current target agent"))?;
    let target = agent_store
        .get(target_agent_id)
        .await
        .context("checking pending control target")?
        .ok_or_else(|| anyhow!("target agent '{target_agent_id}' is no longer installed"))?;
    if target.lifecycle_status == AgentLifecycleStatus::Draft {
        return Err(anyhow!(
            "target agent '{}' is still in draft mode",
            target.name
        ));
    }
    if let Some(model) = control.patch.model.as_deref() {
        if !model_is_allowed_for_agent(&target, model) {
            return Err(anyhow!(
                "model '{model}' is no longer available for agent '{}'",
                target.name
            ));
        }
    }
    if let Some(effort) = control.patch.effort.as_deref() {
        if !effort_is_supported(effort) {
            return Err(anyhow!(
                "reasoning effort '{effort}' is no longer supported"
            ));
        }
    }
    Ok(())
}

fn engine_key(value: &str) -> &str {
    value.trim().strip_prefix("acp:").unwrap_or(value.trim())
}

fn model_is_allowed_for_agent(agent: &AgentRecord, requested: &str) -> bool {
    let requested = requested.trim();
    if requested.is_empty() {
        return false;
    }
    if agent.model.as_deref() == Some(requested)
        || agent
            .chat_model
            .as_ref()
            .and_then(|slot| slot.model_id.as_deref())
            == Some(requested)
    {
        return true;
    }

    let catalog = crate::sidecar::adapters::engine_model_catalog();
    [
        agent
            .chat_model
            .as_ref()
            .and_then(|slot| slot.engine.as_deref()),
        agent.engine.as_deref(),
        Some(agent.id.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(engine_key)
    .any(|engine| {
        catalog
            .get(engine)
            .is_some_and(|models| models.iter().any(|model| model.id == requested))
    })
}

fn effort_is_supported(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "auto" | "default" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

/// Validate and persist an agent request for the current conversation.
pub async fn dispatch(
    args: Value,
    caller_agent_id: Option<&str>,
    conversation_id: Option<&str>,
    agent_store: Option<&AgentStore>,
    conversations: Option<&ConversationStore>,
) -> Result<Value> {
    let caller_agent_id = caller_agent_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("agent-level control requires an active calling agent"))?;
    let conversation_id = conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("agent-level control requires a conversation"))?;
    let conversations =
        conversations.ok_or_else(|| anyhow!("agent-level control is unavailable on this node"))?;
    if !conversations
        .is_conversation_agent(conversation_id, caller_agent_id)
        .await?
    {
        return Err(anyhow!(
            "agent '{caller_agent_id}' is not an active participant in this conversation"
        ));
    }

    let patch = parse_patch(&args)?;
    let agent_store = agent_store
        .ok_or_else(|| anyhow!("agent-level control cannot validate installed agents"))?;
    let caller = agent_store
        .get(caller_agent_id)
        .await
        .context("checking calling agent")?
        .ok_or_else(|| {
            anyhow!("calling agent '{caller_agent_id}' is not installed on this node")
        })?;
    if caller.lifecycle_status != AgentLifecycleStatus::Active {
        return Err(anyhow!(
            "agent '{}' is in {} mode and cannot request agent control",
            caller.name,
            caller.lifecycle_status.as_str()
        ));
    }

    let target_agent_id = patch.agent_id.as_deref().unwrap_or(caller_agent_id);
    let target = agent_store
        .get(target_agent_id)
        .await
        .context("checking requested target agent")?
        .ok_or_else(|| {
            anyhow!("requested agent '{target_agent_id}' is not installed on this node")
        })?;
    if target.lifecycle_status == AgentLifecycleStatus::Draft {
        return Err(anyhow!(
            "requested agent '{}' is still in draft mode",
            target.name
        ));
    }
    // The next turn runs under the target's own record, so a caller with
    // limited account access may only hand the conversation to an agent whose
    // reach into the user's accounts is within its own.
    let caller_policy = crate::agent_access::AgentAccountPolicy::from_record(&caller);
    let caller_profiles = caller_policy.user_identity_profiles(caller.identity_profile_ids.clone());
    if !crate::agent_access::may_delegate_to(&caller_policy, &caller_profiles, &target) {
        return Err(crate::agent_access::delegation_refusal(target_agent_id));
    }
    if let Some(model) = patch.model.as_deref() {
        if !model_is_allowed_for_agent(&target, model) {
            return Err(anyhow!(
                "model '{model}' is not available for agent '{}'",
                target.name
            ));
        }
    }
    if let Some(effort) = patch.effort.as_deref() {
        if !effort_is_supported(effort) {
            return Err(anyhow!("reasoning effort '{effort}' is not supported"));
        }
    }

    let requested = PendingAgentControl {
        patch: patch.clone(),
        requested_by: caller_agent_id.to_owned(),
        requested_at: chrono::Utc::now().timestamp_millis(),
    };
    conversations
        .set_pending_agent_control(conversation_id, &requested)
        .await
        .context("persisting agent-level control")?;

    Ok(json!({
        "ok": true,
        "applies": "next_turn",
        "conversation_id": conversation_id,
        "requested": patch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_partial_target() {
        let patch = parse_patch(&json!({ "model": "  sonnet  ", "effort": "high" }))
            .expect("partial target should parse");
        assert_eq!(patch.model.as_deref(), Some("sonnet"));
        assert_eq!(patch.effort.as_deref(), Some("high"));
        assert!(patch.agent_id.is_none());
    }

    #[test]
    fn rejects_empty_and_malformed_targets() {
        assert!(parse_patch(&json!({})).is_err());
        assert!(parse_patch(&json!({ "model": "" })).is_err());
        assert!(parse_patch(&json!({ "effort": 3 })).is_err());
    }

    #[test]
    fn accepts_null_and_clear_as_explicit_resets() {
        let null_patch = parse_patch(&json!({ "model": null })).expect("null should clear");
        assert!(null_patch.model.is_none());
        assert!(null_patch.clear_model);

        let clear_patch =
            parse_patch(&json!({ "effort": "clear" })).expect("clear should reset the default");
        assert!(clear_patch.effort.is_none());
        assert!(clear_patch.clear_effort);
    }

    #[test]
    fn rejects_control_characters() {
        assert!(parse_patch(&json!({ "model": "gpt\n5" })).is_err());
    }

    #[test]
    fn model_validation_uses_the_target_agent_capabilities() {
        let agent: AgentRecord = serde_json::from_value(json!({
            "id": "acp:claude",
            "name": "Claude",
            "engine": "acp:claude"
        }))
        .expect("test agent should deserialize");
        assert!(model_is_allowed_for_agent(&agent, "sonnet"));
        assert!(!model_is_allowed_for_agent(&agent, "unknown-model"));
    }

    #[test]
    fn effort_validation_rejects_unknown_values() {
        assert!(effort_is_supported("high"));
        assert!(!effort_is_supported("unbounded"));
    }
}
