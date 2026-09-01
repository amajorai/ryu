//! Versioned wire contracts for Ryu's agent harness.
//!
//! This crate is deliberately pure data. Core owns execution, Gateway owns
//! policy, and host clients project these shapes into REST, SSE, SDK, and UI
//! surfaces. Keeping the session/run/event vocabulary here prevents each
//! transport from inventing a slightly different lifecycle.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The public protocol version carried by harness responses.
pub const PROTOCOL_VERSION: &str = "ryu.harness.v1";

/// Maximum size of a client idempotency key.
pub const MAX_IDEMPOTENCY_KEY_LEN: usize = 256;
/// Maximum serialized input retained for one run.
pub const MAX_INPUT_BYTES: usize = 1_000_000;

/// Lifecycle shared by sessions and runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Created but not dispatched.
    #[default]
    Pending,
    /// The runtime is actively executing.
    Running,
    /// Execution is parked behind a human decision.
    AwaitingApproval,
    /// The runtime produced a successful terminal result.
    Completed,
    /// The runtime produced a terminal failure.
    Failed,
    /// The caller explicitly canceled the run.
    Canceled,
    /// The runtime stopped unexpectedly and can be inspected or retried.
    Interrupted,
}

impl RunStatus {
    /// Stable wire/storage spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Interrupted => "interrupted",
        }
    }

    /// Whether no future execution is expected without an explicit retry.
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Canceled | Self::Interrupted
        )
    }

    /// Parse a persisted value, preserving fail-closed semantics for unknown
    /// values by treating them as interrupted rather than as a live run.
    pub fn from_str(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "awaiting_approval" => Self::AwaitingApproval,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "canceled" => Self::Canceled,
            _ => Self::Interrupted,
        }
    }
}

/// Where a run executes. Remote and cloud are explicit protocol values even
/// when a node does not currently advertise those adapters; such a request is
/// rejected at the Core boundary instead of silently running locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionProfileKind {
    #[default]
    Local,
    Worktree,
    Remote,
    Cloud,
}

/// Network authority requested by an execution profile. Gateway policy remains
/// authoritative; these values are a request/provenance field, not a bypass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMode {
    #[default]
    Inherit,
    Denied,
    GatewayOnly,
    Allow,
}

/// Process/filesystem isolation requested by an execution profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SandboxMode {
    #[default]
    Inherit,
    Workspace,
    Strict,
}

/// Human-in-the-loop preference requested by an execution profile. The final
/// decision is made by the Core/Gateway approval boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    #[default]
    Inherit,
    OnRisk,
    Always,
    Never,
}

/// Portable execution settings. It intentionally contains no credentials,
/// provider keys, or opaque process handles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProfile {
    #[serde(default)]
    pub kind: ExecutionProfileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub worktree_isolation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(default)]
    pub network: NetworkMode,
    #[serde(default)]
    pub sandbox: SandboxMode,
    #[serde(default)]
    pub approval: ApprovalMode,
}

impl Default for ExecutionProfile {
    fn default() -> Self {
        Self {
            kind: ExecutionProfileKind::Local,
            cwd: None,
            worktree_isolation: false,
            worktree_branch: None,
            network: NetworkMode::Inherit,
            sandbox: SandboxMode::Inherit,
            approval: ApprovalMode::Inherit,
        }
    }
}

impl ExecutionProfile {
    /// The explicitly isolated local profile used by a worktree run.
    pub fn worktree(cwd: Option<String>, branch: Option<String>) -> Self {
        Self {
            kind: ExecutionProfileKind::Worktree,
            cwd,
            worktree_isolation: true,
            worktree_branch: branch,
            ..Self::default()
        }
    }
}

/// A durable session that can own multiple attempts/runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSession {
    pub protocol_version: String,
    pub id: String,
    pub conversation_id: String,
    pub runnable_id: String,
    pub runnable_kind: String,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub execution_profile: ExecutionProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Request to start or resume a run inside a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    /// JSON input interpreted by the selected runnable. Chat adapters commonly
    /// use an object containing `messages`.
    #[serde(default = "empty_object")]
    pub input: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_profile: Option<ExecutionProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_run_id: Option<String>,
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

/// A durable attempt within a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRun {
    pub protocol_version: String,
    pub id: String,
    pub session_id: String,
    pub status: RunStatus,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub execution_profile: ExecutionProfile,
    pub event_cursor: u64,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
}

/// One choice offered by a runtime for an interactive approval request.
///
/// The option id is opaque to the harness; clients send it back through the
/// permission resolver without hard-coding a particular runtime's vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    pub kind: String,
    pub name: String,
    pub option_id: String,
}

/// Typed events emitted by every harness transport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunEvent {
    RunStarted {
        execution_profile: ExecutionProfile,
    },
    /// The accepted input boundary for this run. The payload is intentionally
    /// a digest and bounded count rather than raw user content; the sealed run
    /// input remains Core-owned and is never copied into an event projection.
    InputAccepted {
        input_hash: String,
        message_count: u32,
    },
    TextDelta {
        delta: String,
    },
    ToolCallStarted {
        tool_call_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_hash: Option<String>,
    },
    ToolCallCompleted {
        tool_call_id: String,
        name: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_hash: Option<String>,
    },
    ApprovalRequested {
        approval_id: String,
        summary: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<ApprovalOption>,
    },
    Checkpoint {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
    },
    RunCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<serde_json::Value>,
    },
    RunFailed {
        code: String,
        message: String,
    },
    RunCanceled,
    RunInterrupted,
    /// A bounded provider/UI frame retained for adapters that need to replay
    /// richer content parts without inventing a second transport.
    UiFrame {
        frame: String,
    },
}

/// A replayable, strictly ordered event envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunEventEnvelope {
    pub protocol_version: String,
    pub id: String,
    pub run_id: String,
    pub session_id: String,
    pub seq: u64,
    pub created_at: String,
    #[serde(flatten)]
    pub event: RunEvent,
}

/// Validate the client-controlled parts before they reach Core persistence.
pub fn validate_start_request(request: &StartRunRequest) -> Result<(), &'static str> {
    if let Some(key) = request.idempotency_key.as_deref() {
        let trimmed = key.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_IDEMPOTENCY_KEY_LEN {
            return Err("idempotency_key must be 1..=256 bytes");
        }
    }
    if serde_json::to_vec(&request.input)
        .map(|input| input.len() > MAX_INPUT_BYTES)
        .unwrap_or(true)
    {
        return Err("input must be at most 1000000 bytes");
    }
    if let Some(profile) = request.execution_profile.as_ref() {
        if profile.worktree_isolation && profile.kind == ExecutionProfileKind::Local {
            return Err("worktree_isolation requires the worktree execution profile");
        }
        if profile.kind == ExecutionProfileKind::Worktree && !profile.worktree_isolation {
            return Err("the worktree execution profile requires worktree_isolation");
        }
        if profile.cwd.as_deref().is_some_and(|cwd| cwd.len() > 4096) {
            return Err("execution profile cwd is too long");
        }
        if profile
            .worktree_branch
            .as_deref()
            .is_some_and(|branch| branch.len() > 256)
        {
            return Err("execution profile worktreeBranch is too long");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_envelope_is_camel_case_and_replayable() {
        let envelope = RunEventEnvelope {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            id: "evt_1".to_owned(),
            run_id: "run_1".to_owned(),
            session_id: "sess_1".to_owned(),
            seq: 4,
            created_at: "2026-09-01T00:00:00Z".to_owned(),
            event: RunEvent::ToolCallCompleted {
                tool_call_id: "tool_1".to_owned(),
                name: "read_file".to_owned(),
                ok: true,
                duration_ms: Some(12),
                result_hash: Some("abc123".to_owned()),
            },
        };
        let value = serde_json::to_value(&envelope).expect("serialize");
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["toolCallId"], "tool_1");
        assert_eq!(value["type"], "tool_call_completed");
        let round_trip: RunEventEnvelope = serde_json::from_value(value).expect("deserialize");
        assert_eq!(round_trip, envelope);
    }

    #[test]
    fn approval_options_round_trip_with_runtime_option_ids() {
        let event = RunEvent::ApprovalRequested {
            approval_id: "perm_1".to_owned(),
            summary: "Permission is required".to_owned(),
            options: vec![ApprovalOption {
                kind: "allow_once".to_owned(),
                name: "Allow once".to_owned(),
                option_id: "allow-once".to_owned(),
            }],
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["approvalId"], "perm_1");
        assert_eq!(value["options"][0]["optionId"], "allow-once");
        assert_eq!(RunEvent::deserialize(value).expect("deserialize"), event);
    }

    #[test]
    fn input_boundary_is_digest_only() {
        let value = serde_json::to_value(RunEvent::InputAccepted {
            input_hash: "abc123".to_owned(),
            message_count: 2,
        })
        .expect("serialize");
        assert_eq!(value["type"], "input_accepted");
        assert_eq!(value["inputHash"], "abc123");
        assert_eq!(value["messageCount"], 2);
        assert!(value.get("prompt").is_none());
    }

    #[test]
    fn invalid_profile_combinations_fail_closed() {
        let request = StartRunRequest {
            input: serde_json::json!({}),
            idempotency_key: None,
            execution_profile: Some(ExecutionProfile {
                worktree_isolation: true,
                ..ExecutionProfile::default()
            }),
            resume_run_id: None,
        };
        assert_eq!(
            validate_start_request(&request),
            Err("worktree_isolation requires the worktree execution profile")
        );
    }

    #[test]
    fn unknown_status_does_not_become_live() {
        assert_eq!(RunStatus::from_str("future"), RunStatus::Interrupted);
        assert!(RunStatus::from_str("future").is_terminal());
    }

    #[test]
    fn oversized_input_is_rejected_before_persistence() {
        let request = StartRunRequest {
            input: serde_json::json!({ "prompt": "x".repeat(MAX_INPUT_BYTES) }),
            idempotency_key: None,
            execution_profile: None,
            resume_run_id: None,
        };
        assert_eq!(
            validate_start_request(&request),
            Err("input must be at most 1000000 bytes")
        );
    }
}
