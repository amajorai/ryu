use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    pub score: Option<f32>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatRequest {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChunk {
    pub delta: Option<String>,
    #[serde(default)]
    pub done: bool,
    pub metadata: Option<serde_json::Value>,
}

// ── Traits ─────────────────────────────────────────────────────────────────────

/// Universal adapter trait for AI providers (llamacpp, ollama, etc.)
pub trait ProviderAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn is_available(&self) -> bool;
}

// ── Chat stream types (used by the /api/chat/stream endpoint) ─────────────────

/// One server-validated Composio connection selected for a scoped profile run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposioConnectionBinding {
    pub id: String,
    pub toolkit: String,
}

/// Server-owned authorization context carried through the final chat routing
/// choke point. The adapter must re-check the concrete agent after auto-routing,
/// policy fallback, and agent-control handoff have all settled; a collection-level
/// permission check at the HTTP boundary is not sufficient for those late changes.
#[derive(Clone)]
pub(crate) struct AgentResourceAuthorization {
    pub(crate) state: crate::server::ServerState,
    pub(crate) caller: Option<crate::identity_verify::VerifiedCaller>,
}

impl std::fmt::Debug for AgentResourceAuthorization {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentResourceAuthorization")
            .field("caller", &self.caller)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PublicAgentRunPolicy {
    pub(crate) published_agent_id: String,
    pub(crate) agent_id: String,
    pub(crate) capabilities: BTreeSet<String>,
}
