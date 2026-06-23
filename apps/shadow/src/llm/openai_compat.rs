use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{LlmMessage, LlmProvider, LlmRequest, LlmResponse, ToolCall, Usage};

/// OpenAI-compatible HTTP client. Works with Ollama, llama.cpp, vLLM, and OpenAI.
pub struct OpenAICompatClient {
    client: Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl OpenAICompatClient {
    pub fn new(base_url: String, model: String, api_key: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("Failed to create HTTP client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
            api_key,
        }
    }

    fn build_body(&self, req: &LlmRequest, stream: bool) -> serde_json::Value {
        let messages: Vec<serde_json::Value> = req
            .messages
            .iter()
            .map(|m| {
                json!({
                    "role": m.role,
                    "content": m.content.as_str()
                })
            })
            .collect();

        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": stream,
        });

        if !req.tools.is_empty() {
            let tools: Vec<serde_json::Value> = req
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters
                        }
                    })
                })
                .collect();
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
        }

        body
    }
}

// --- Response types for parsing OpenAI JSON ---

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    usage: Option<OaiUsage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<OaiToolCall>,
}

#[derive(Debug, Deserialize)]
struct OaiToolCall {
    id: String,
    function: OaiFunction,
}

#[derive(Debug, Deserialize)]
struct OaiFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OaiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

// --- SSE stream delta types ---

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<StreamToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallDelta {
    index: Option<u32>,
    id: Option<String>,
    function: Option<StreamFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamFunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[async_trait]
impl LlmProvider for OpenAICompatClient {
    async fn generate(&self, req: LlmRequest) -> Result<LlmResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let body = self.build_body(&req, false);

        let mut request = self.client.post(&url).json(&body);
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }

        let resp = request.send().await.context("LLM HTTP request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("LLM API error {}: {}", status, text);
        }

        let chat: ChatResponse = resp.json().await.context("Failed to parse LLM response")?;

        let choice = chat
            .choices
            .into_iter()
            .next()
            .context("No choices in LLM response")?;
        let finish_reason = choice.finish_reason.unwrap_or_else(|| "stop".to_string());

        let tool_calls: Vec<ToolCall> = choice
            .message
            .tool_calls
            .into_iter()
            .map(|tc| {
                let arguments = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::Value::Object(Default::default()));
                ToolCall {
                    id: tc.id,
                    name: tc.function.name,
                    arguments,
                }
            })
            .collect();

        let usage = chat.usage.map(|u| Usage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
        });

        Ok(LlmResponse {
            content: choice.message.content,
            tool_calls,
            finish_reason,
            usage,
        })
    }

    async fn stream(
        &self,
        req: LlmRequest,
        on_token: &mut (dyn FnMut(String) + Send),
    ) -> Result<LlmResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let body = self.build_body(&req, true);

        let mut request = self.client.post(&url).json(&body);
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }

        let resp = request.send().await.context("LLM stream request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("LLM API stream error {}: {}", status, text);
        }

        let mut stream = resp.bytes_stream();
        let mut full_content = String::new();
        let mut finish_reason = "stop".to_string();

        // Accumulate partial tool call deltas indexed by their delta index
        let mut tool_call_accum: std::collections::HashMap<u32, (String, String, String)> =
            std::collections::HashMap::new(); // index -> (id, name, args)

        let mut buf = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.context("Stream read error")?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

            // Process complete SSE lines
            while let Some(newline_pos) = buf.find('\n') {
                let line = buf[..newline_pos].trim().to_string();
                buf = buf[newline_pos + 1..].to_string();

                if line == "data: [DONE]" {
                    break;
                }

                let data = line.strip_prefix("data: ").unwrap_or(&line);
                if data.is_empty() {
                    continue;
                }

                let chunk: StreamChunk = match serde_json::from_str(data) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                for choice in chunk.choices {
                    if let Some(fr) = choice.finish_reason {
                        if fr != "null" {
                            finish_reason = fr;
                        }
                    }

                    if let Some(text) = choice.delta.content {
                        full_content.push_str(&text);
                        on_token(text);
                    }

                    for tc_delta in choice.delta.tool_calls {
                        let idx = tc_delta.index.unwrap_or(0);
                        let entry = tool_call_accum.entry(idx).or_insert_with(|| {
                            (
                                tc_delta.id.clone().unwrap_or_default(),
                                String::new(),
                                String::new(),
                            )
                        });
                        if let Some(id) = &tc_delta.id {
                            if !id.is_empty() {
                                entry.0 = id.clone();
                            }
                        }
                        if let Some(func) = tc_delta.function {
                            if let Some(name) = func.name {
                                entry.1.push_str(&name);
                            }
                            if let Some(args) = func.arguments {
                                entry.2.push_str(&args);
                            }
                        }
                    }
                }
            }
        }

        let tool_calls: Vec<ToolCall> = {
            let mut pairs: Vec<(u32, ToolCall)> = tool_call_accum
                .into_iter()
                .map(|(idx, (id, name, args_str))| {
                    let arguments = serde_json::from_str(&args_str)
                        .unwrap_or(serde_json::Value::Object(Default::default()));
                    (
                        idx,
                        ToolCall {
                            id,
                            name,
                            arguments,
                        },
                    )
                })
                .collect();
            pairs.sort_by_key(|(i, _)| *i);
            pairs.into_iter().map(|(_, tc)| tc).collect()
        };

        Ok(LlmResponse {
            content: if full_content.is_empty() {
                None
            } else {
                Some(full_content)
            },
            tool_calls,
            finish_reason,
            usage: None,
        })
    }
}
