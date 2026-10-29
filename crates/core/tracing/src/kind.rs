//! Span kinds and statuses for hierarchical run traces.
//!
//! The v1 store recorded only two flat kinds, `"tool-call"` and `"model-call"`.
//! v2 adds a closed set of hierarchical kinds (Mastra AI tracing / LangSmith
//! run-type parity). Legacy spellings still parse, so rows written before the
//! upgrade, and callers that still use [`crate::TraceStore::open_span`], stay
//! readable in the tree view.

use serde::{Deserialize, Serialize};

/// What a span represents within a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpanKind {
    /// One agent turn: the root of a chat run's trace.
    AgentRun,
    /// One workflow execution: the root of a workflow run's trace.
    WorkflowRun,
    /// One step (node) inside a workflow execution.
    WorkflowStep,
    /// One model (LLM) request.
    ModelCall,
    /// One tool invocation.
    ToolCall,
    /// A retrieval pass (RAG, Spaces, past-chat recall).
    Retrieval,
    /// A memory read or write.
    Memory,
    /// A guardrail / policy check.
    Guardrail,
}

impl SpanKind {
    /// Every kind, in a stable order (used by docs, validation, and tests).
    pub const ALL: [Self; 8] = [
        Self::AgentRun,
        Self::WorkflowRun,
        Self::WorkflowStep,
        Self::ModelCall,
        Self::ToolCall,
        Self::Retrieval,
        Self::Memory,
        Self::Guardrail,
    ];

    /// The canonical stored/wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentRun => "agent_run",
            Self::WorkflowRun => "workflow_run",
            Self::WorkflowStep => "workflow_step",
            Self::ModelCall => "model_call",
            Self::ToolCall => "tool_call",
            Self::Retrieval => "retrieval",
            Self::Memory => "memory",
            Self::Guardrail => "guardrail",
        }
    }

    /// Parse a stored kind, accepting the v1 hyphenated spellings
    /// (`tool-call`, `model-call`) and either separator for every kind.
    pub fn parse(value: &str) -> Option<Self> {
        let normalized = value.trim().to_ascii_lowercase().replace('-', "_");
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == normalized)
    }

    /// Whether this kind starts a trace (a run root).
    pub fn is_root_kind(self) -> bool {
        matches!(self, Self::AgentRun | Self::WorkflowRun)
    }

    /// The OpenInference `openinference.span.kind` value, read by Arize
    /// Phoenix, Langfuse, and LangSmith to classify spans.
    pub fn openinference_kind(self) -> &'static str {
        match self {
            Self::AgentRun => "AGENT",
            Self::WorkflowRun | Self::WorkflowStep => "CHAIN",
            Self::ModelCall => "LLM",
            Self::ToolCall => "TOOL",
            Self::Retrieval | Self::Memory => "RETRIEVER",
            Self::Guardrail => "GUARDRAIL",
        }
    }

    /// The OTel GenAI `gen_ai.operation.name`, where the convention defines one.
    pub fn gen_ai_operation(self) -> Option<&'static str> {
        match self {
            Self::AgentRun => Some("invoke_agent"),
            Self::ModelCall => Some("chat"),
            Self::ToolCall => Some("execute_tool"),
            _ => None,
        }
    }
}

impl std::fmt::Display for SpanKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A span's lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SpanStatus {
    /// Started and not yet ended.
    #[default]
    Running,
    /// Ended successfully.
    Ok,
    /// Ended with an error.
    Error,
    /// Ended because the run was abandoned or superseded.
    Cancelled,
}

impl SpanStatus {
    /// The canonical stored/wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }

    /// Tolerant parse of a stored or query value.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "running" => Some(Self::Running),
            "ok" | "success" | "completed" => Some(Self::Ok),
            "error" | "failed" => Some(Self::Error),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

impl std::fmt::Display for SpanStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip_and_accept_legacy_spellings() {
        for kind in SpanKind::ALL {
            assert_eq!(SpanKind::parse(kind.as_str()), Some(kind));
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
        }
        assert_eq!(SpanKind::parse("tool-call"), Some(SpanKind::ToolCall));
        assert_eq!(SpanKind::parse("model-call"), Some(SpanKind::ModelCall));
        assert_eq!(SpanKind::parse(" Agent-Run "), Some(SpanKind::AgentRun));
        assert_eq!(SpanKind::parse("chain"), None);
    }

    #[test]
    fn kinds_map_to_openinference_and_gen_ai() {
        assert_eq!(SpanKind::AgentRun.openinference_kind(), "AGENT");
        assert_eq!(SpanKind::ModelCall.openinference_kind(), "LLM");
        assert_eq!(SpanKind::Retrieval.openinference_kind(), "RETRIEVER");
        assert_eq!(SpanKind::ToolCall.gen_ai_operation(), Some("execute_tool"));
        assert_eq!(SpanKind::Guardrail.gen_ai_operation(), None);
        assert!(SpanKind::WorkflowRun.is_root_kind());
        assert!(!SpanKind::WorkflowStep.is_root_kind());
    }

    #[test]
    fn statuses_parse_tolerantly() {
        assert_eq!(SpanStatus::parse("OK"), Some(SpanStatus::Ok));
        assert_eq!(SpanStatus::parse("failed"), Some(SpanStatus::Error));
        assert_eq!(SpanStatus::parse("canceled"), Some(SpanStatus::Cancelled));
        assert_eq!(SpanStatus::parse("nope"), None);
        assert_eq!(SpanStatus::default(), SpanStatus::Running);
    }
}
