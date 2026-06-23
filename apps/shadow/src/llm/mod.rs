pub mod ollama;
pub mod openai_compat;
pub mod orchestrator;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A single message in an LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Text(s) => s,
            Self::Parts(_) => "",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPart {
    #[serde(rename = "type")]
    pub part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl LlmMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".to_string(),
            content: MessageContent::text(content),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: MessageContent::text(content),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: MessageContent::text(content),
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".to_string(),
            content: MessageContent::Text(format!(
                "{{\"tool_call_id\":\"{}\",\"content\":{}}}",
                tool_call_id.into(),
                serde_json::to_string(&content.into()).unwrap_or_default()
            )),
        }
    }
}

/// Tool definition passed to the LLM (JSON Schema).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// A tool call returned by the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Request to an LLM provider.
#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub messages: Vec<LlmMessage>,
    pub tools: Vec<ToolDefinition>,
    pub temperature: f32,
    pub max_tokens: u32,
    pub stream: bool,
}

impl Default for LlmRequest {
    fn default() -> Self {
        Self {
            messages: vec![],
            tools: vec![],
            temperature: 0.7,
            max_tokens: 4096,
            stream: false,
        }
    }
}

/// Response from an LLM provider.
#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: String,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// LLM provider trait — implemented by OpenAI-compat client.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn generate(&self, req: LlmRequest) -> anyhow::Result<LlmResponse>;

    /// Stream text tokens; returns the full response at the end.
    async fn stream(
        &self,
        req: LlmRequest,
        on_token: &mut (dyn FnMut(String) + Send),
    ) -> anyhow::Result<LlmResponse>;
}
