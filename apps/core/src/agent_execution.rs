//! Shared lifecycle and tool-effect enforcement for configured agents.
//!
//! The desktop uses these values to explain an agent's posture, but this module
//! is the authority that stops a draft/background run or a read-only tool call.
//! Keep the checks small and reusable because chat, the scheduler, workflows,
//! channels, and the ACP bridge all enter the runtime through different seams.

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::agents::{AgentLifecycleStatus, AgentRecord, AgentSafetyProfile, AgentStore};

/// What a tool call does to state. Whether it reads private data or can send
/// data off the machine is a separate axis, kept in
/// [`crate::approvals::exfiltration_guard`] (`web.extract` is a `Read` here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEffect {
    Read,
    Preview,
    Mutate,
    External,
    Unknown,
}

impl ToolEffect {
    pub const fn is_read_only(self) -> bool {
        matches!(self, Self::Read | Self::Preview)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Preview => "preview",
            Self::Mutate => "mutate",
            Self::External => "external",
            Self::Unknown => "unknown",
        }
    }
}

/// Conservative first-line effect classification for tools whose provider does
/// not publish an MCP read-only/destructive annotation. Unknown tools are
/// rejected at the execution gate until a trustworthy effect contract exists.
pub fn classify_tool(tool_id: &str) -> ToolEffect {
    if tool_id == crate::agent_control::SET_ACTIVE_TARGET_TOOL_ID {
        // This changes only the conversation's pending routing state. It is
        // still a mutation, so Trial/ReadOnly agents cannot use it, while an
        // ApprovalRequired agent can pass it through the normal approval gate.
        return ToolEffect::Mutate;
    }
    if tool_id == crate::sidecar::mcp::challenges_tool::SUBMIT_TOOL_ID {
        // Its annotations are deliberately non-destructive and not read-only,
        // which leaves the name heuristic to decide; `submit` is not one of its
        // verbs. It sends an entry to the control plane as the user, so it is an
        // outbound effect: blocked for Trial/ReadOnly agents, approval-gated
        // otherwise.
        return ToolEffect::External;
    }
    if tool_id == crate::sidecar::mcp::treg_tool::CALL_TOOL_ID {
        // A metered call to a third-party API through the Gateway: spends the
        // organization's credits and may write upstream, so it is an outbound
        // effect, approval-gated like other external calls.
        return ToolEffect::External;
    }
    let normalized = tool_id.to_ascii_lowercase();
    let tokens: Vec<&str> = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.is_empty() {
        return ToolEffect::Unknown;
    }

    let preview_index = tokens.iter().position(|token| {
        matches!(
            *token,
            "preview" | "dryrun" | "dry" | "plan" | "validate" | "check"
        )
    });
    let mutation_indices: Vec<usize> = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            matches!(
                *token,
                "create"
                    | "update"
                    | "delete"
                    | "remove"
                    | "destroy"
                    | "write"
                    | "send"
                    | "post"
                    | "put"
                    | "patch"
                    | "execute"
                    | "exec"
                    | "run"
                    | "apply"
                    | "merge"
                    | "deploy"
                    | "publish"
                    | "transfer"
                    | "pay"
                    | "email"
                    | "message"
                    | "upload"
                    | "attach"
                    | "set"
                    | "enable"
                    | "disable"
                    | "configure"
                    | "approve"
                    | "delegate"
                    | "react"
                    | "resume"
            )
            .then_some(index)
        })
        .collect();

    // Conventional `preview_delete`/`delete_preview` names are safe only when
    // there is one adjacent effect token. Compound names stay conservative so a
    // read-only agent cannot reach a side effect merely by naming it a preview.
    let is_unambiguous_preview = preview_index.is_some_and(|preview_index| {
        mutation_indices.len() <= 1
            && mutation_indices
                .first()
                .is_none_or(|mutation_index| mutation_index.abs_diff(preview_index) == 1)
    });
    if preview_index.is_some() && is_unambiguous_preview {
        return ToolEffect::Preview;
    }

    if !mutation_indices.is_empty() {
        return if tokens.iter().any(|token| {
            matches!(
                *token,
                "send"
                    | "post"
                    | "put"
                    | "patch"
                    | "execute"
                    | "exec"
                    | "run"
                    | "deploy"
                    | "publish"
                    | "transfer"
                    | "pay"
                    | "email"
                    | "message"
                    | "upload"
                    | "attach"
            )
        }) {
            ToolEffect::External
        } else {
            ToolEffect::Mutate
        };
    }

    if tokens.iter().any(|token| {
        matches!(
            *token,
            "get"
                | "list"
                | "read"
                | "search"
                | "find"
                | "fetch"
                | "describe"
                | "lookup"
                | "query"
                | "inspect"
                | "status"
                | "history"
                | "discover"
                | "enumerate"
                | "metadata"
                | "view"
                | "contents"
                | "retrieve"
                | "whoami"
        )
    }) {
        return ToolEffect::Read;
    }

    ToolEffect::Unknown
}

/// Prefer provider-published effect metadata over the name heuristic. The
/// heuristic remains the fallback for older MCP servers that do not advertise
/// hints and for non-HTTP tools without a richer contract.
pub fn classify_tool_with_metadata(
    tool_id: &str,
    annotations: Option<&Value>,
    http_method: Option<&str>,
) -> ToolEffect {
    if let Some(method) = http_method {
        return match method.trim().to_ascii_uppercase().as_str() {
            "GET" | "HEAD" | "OPTIONS" | "TRACE" => ToolEffect::Read,
            "POST" => ToolEffect::External,
            "PUT" | "PATCH" | "DELETE" => ToolEffect::Mutate,
            _ => ToolEffect::Unknown,
        };
    }

    if let Some(annotations) = annotations.and_then(Value::as_object) {
        if annotations.get("destructiveHint").and_then(Value::as_bool) == Some(true) {
            return ToolEffect::Mutate;
        }
        if annotations.get("readOnlyHint").and_then(Value::as_bool) == Some(true) {
            return ToolEffect::Read;
        }
    }

    classify_tool(tool_id)
}

/// Apply an agent record's lifecycle/profile to a tool effect. Approval-required
/// agents return `Ok` for risky effects because the normal gated caller adds the
/// tool to the existing approval flow; direct ungated calls are only available
/// to the already-approved dispatch engine.
pub fn ensure_tool_allowed_for_record(record: &AgentRecord, tool_id: &str) -> Result<ToolEffect> {
    ensure_tool_allowed_for_record_with_metadata(record, tool_id, None, None)
}

pub fn ensure_tool_allowed_for_record_with_metadata(
    record: &AgentRecord,
    tool_id: &str,
    annotations: Option<&Value>,
    http_method: Option<&str>,
) -> Result<ToolEffect> {
    let effect = classify_tool_with_metadata(tool_id, annotations, http_method);
    if record.lifecycle_status == AgentLifecycleStatus::Draft {
        return Err(anyhow!(
            "agent '{}' is in draft mode and cannot run tools",
            record.name
        ));
    }

    if effect == ToolEffect::Unknown {
        return Err(anyhow!(
            "agent '{}' cannot run tool '{}' because its effect is unknown",
            record.name,
            tool_id
        ));
    }

    let read_only = record.lifecycle_status == AgentLifecycleStatus::Trial
        || record.safety_profile == AgentSafetyProfile::ReadOnly;
    if read_only && !effect.is_read_only() {
        return Err(anyhow!(
            "agent '{}' is read-only; tool '{}' is blocked (effect: {})",
            record.name,
            tool_id,
            effect.label()
        ));
    }

    Ok(effect)
}

/// Check a manual foreground run. Drafts are authoring-only; trial is the
/// deliberate manual evaluation state.
pub async fn ensure_foreground_run_allowed(
    store: &AgentStore,
    agent_id: Option<&str>,
) -> Result<()> {
    let Some(agent_id) = agent_id else {
        return Ok(());
    };
    if !crate::fleet::is_agent_available(agent_id) {
        return Err(anyhow!(
            "agent '{agent_id}' is unavailable under the node's organization policy"
        ));
    }
    let Some(record) = store.get(agent_id).await? else {
        return Err(anyhow!("agent '{agent_id}' not found"));
    };
    if record.lifecycle_status == AgentLifecycleStatus::Draft {
        return Err(anyhow!(
            "agent '{}' is in draft mode; finish authoring it before trying it",
            record.name
        ));
    }
    Ok(())
}

/// Check a non-interactive run (automation, delegation, workflow, or channel).
/// Only active agents may enter these paths.
pub async fn ensure_noninteractive_run_allowed(
    store: &AgentStore,
    agent_id: Option<&str>,
) -> Result<()> {
    let Some(agent_id) = agent_id else {
        return Ok(());
    };
    if !crate::fleet::is_agent_available(agent_id) {
        return Err(anyhow!(
            "agent '{agent_id}' is unavailable under the node's organization policy"
        ));
    }
    let Some(record) = store.get(agent_id).await? else {
        return Err(anyhow!("agent '{agent_id}' not found"));
    };
    if record.lifecycle_status != AgentLifecycleStatus::Active {
        return Err(anyhow!(
            "agent '{}' is in {} mode; only active agents may run automations or delegated work",
            record.name,
            record.lifecycle_status.as_str()
        ));
    }
    Ok(())
}

/// Enforce a tool call when an MCP registry has a persisted agent store. A
/// registry may be used in headless tests without one; those agent-less calls
/// preserve their existing behavior.
pub async fn ensure_tool_allowed(
    store: Option<&AgentStore>,
    agent_id: Option<&str>,
    tool_id: &str,
) -> Result<Option<ToolEffect>> {
    ensure_tool_allowed_with_metadata(store, agent_id, tool_id, None, None).await
}

pub async fn ensure_tool_allowed_with_metadata(
    store: Option<&AgentStore>,
    agent_id: Option<&str>,
    tool_id: &str,
    annotations: Option<&Value>,
    http_method: Option<&str>,
) -> Result<Option<ToolEffect>> {
    let (Some(store), Some(agent_id)) = (store, agent_id) else {
        return Ok(None);
    };
    let Some(record) = store.get(agent_id).await? else {
        return Err(anyhow!("agent '{agent_id}' not found"));
    };
    ensure_tool_allowed_for_record_with_metadata(&record, tool_id, annotations, http_method)
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AgentLifecycleStatus, AgentSafetyProfile};

    fn record(status: AgentLifecycleStatus, safety: AgentSafetyProfile) -> AgentRecord {
        AgentRecord {
            lifecycle_status: status,
            safety_profile: safety,
            ..serde_json::from_value(serde_json::json!({
                "id": "agent-1",
                "name": "Test Agent"
            }))
            .unwrap()
        }
    }

    #[test]
    fn classifies_read_preview_and_mutation_effects() {
        assert_eq!(classify_tool("spaces.read_page"), ToolEffect::Read);
        assert_eq!(classify_tool("github.preview_delete"), ToolEffect::Preview);
        assert_eq!(classify_tool("github.delete_issue"), ToolEffect::Mutate);
        assert_eq!(classify_tool("gmail.send_email"), ToolEffect::External);
        assert_eq!(classify_tool("agents.react"), ToolEffect::Mutate);
        assert_eq!(classify_tool("vendor.mystery"), ToolEffect::Unknown);
        assert_eq!(classify_tool("challenges.submit"), ToolEffect::External);
        assert_eq!(classify_tool("vendor.submit"), ToolEffect::Unknown);
    }

    #[test]
    fn provider_metadata_overrides_name_fallback() {
        assert_eq!(
            classify_tool_with_metadata(
                "vendor.mystery",
                Some(&serde_json::json!({ "readOnlyHint": true })),
                None,
            ),
            ToolEffect::Read
        );
        assert_eq!(
            classify_tool_with_metadata("vendor.get_status", None, Some("POST")),
            ToolEffect::External
        );
    }

    #[test]
    fn ambiguous_preview_names_do_not_hide_side_effects() {
        assert_eq!(
            classify_tool("vendor.preview_and_send_email"),
            ToolEffect::External
        );
        assert_eq!(
            classify_tool("vendor.preview_publish_then_send"),
            ToolEffect::External
        );
    }

    #[test]
    fn trial_and_read_only_block_non_read_effects() {
        let trial = record(AgentLifecycleStatus::Trial, AgentSafetyProfile::Autonomous);
        assert!(ensure_tool_allowed_for_record(&trial, "file.write").is_err());
        assert!(ensure_tool_allowed_for_record(&trial, "file.read").is_ok());

        let read_only = record(AgentLifecycleStatus::Active, AgentSafetyProfile::ReadOnly);
        assert!(ensure_tool_allowed_for_record(&read_only, "shell.exec").is_err());
    }

    #[test]
    fn unknown_effects_are_blocked_for_active_agents() {
        let active = record(AgentLifecycleStatus::Active, AgentSafetyProfile::Autonomous);
        assert!(ensure_tool_allowed_for_record(&active, "vendor.mystery").is_err());
    }

    #[test]
    fn draft_blocks_every_tool() {
        let draft = record(AgentLifecycleStatus::Draft, AgentSafetyProfile::ReadOnly);
        assert!(ensure_tool_allowed_for_record(&draft, "file.read").is_err());
    }
}
