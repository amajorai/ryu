use std::sync::{Arc, Mutex};

use anyhow::Result;

use crate::utils::wall_micros;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::UnboundedReceiverStream;

use super::intent_classifier::IntentClassifier;
use super::pattern::{PatternExtractor, PatternStore};
use super::prompt_builder::AgentPromptBuilder;
use super::tool_cache::ToolResultCache;
use super::tools::ax::{
    AXElementAtTool, AXFocusAppTool, AXHotkeyTool, AXInspectTool, AXListAppsTool, AXReadTextTool,
    AXScrollTool, AXWaitTool, CaptureLiveScreenshotTool, ReplayProcedureTool,
};
use super::tools::memory::{GetDirectivesTool, GetKnowledgeTool, SetDirectiveTool};
use super::tools::search::{
    GetActivitySequenceTool, GetDaySummaryTool, InspectScreenshotsTool, ResolveLatestMeetingTool,
    SearchSummariesTool, SearchVisualMemoriesTool,
};
use super::tools::{
    AXClickTool, AXTreeQueryTool, AXTypeTool, AgentTool, GetTimelineContextTool,
    GetTranscriptWindowTool, SearchHybridTool,
};
use crate::llm::{
    orchestrator::LlmOrchestrator, LlmMessage, LlmRequest, LlmResponse, ToolCall, ToolDefinition,
};

/// Maximum tool-calling steps before forcing a final answer.
const MAX_STEPS: usize = 20;

/// Maximum characters of context to inject into the system prompt.
const MAX_CONTEXT_CHARS: usize = 12_000;

/// Events streamed back to the caller during an agent run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentRunEvent {
    TextDelta {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        args: serde_json::Value,
    },
    ToolResult {
        id: String,
        name: String,
        result: serde_json::Value,
        error: Option<String>,
    },
    FinalAnswer {
        text: String,
    },
    Error {
        message: String,
    },
}

pub struct AgentRuntime {
    orchestrator: Arc<LlmOrchestrator>,
    tools: Vec<Arc<dyn AgentTool>>,
    pattern_store: Option<Arc<Mutex<PatternStore>>>,
}

impl AgentRuntime {
    pub fn new(orchestrator: Arc<LlmOrchestrator>) -> Self {
        let tools: Vec<Arc<dyn AgentTool>> = vec![
            // Search tools
            Arc::new(SearchHybridTool),
            Arc::new(GetTranscriptWindowTool),
            Arc::new(GetTimelineContextTool),
            Arc::new(GetDaySummaryTool),
            Arc::new(ResolveLatestMeetingTool),
            Arc::new(GetActivitySequenceTool),
            Arc::new(SearchSummariesTool),
            Arc::new(SearchVisualMemoriesTool),
            Arc::new(InspectScreenshotsTool),
            // AX tools
            Arc::new(AXClickTool),
            Arc::new(AXTypeTool),
            Arc::new(AXTreeQueryTool),
            Arc::new(AXHotkeyTool),
            Arc::new(AXScrollTool),
            Arc::new(AXWaitTool),
            Arc::new(AXFocusAppTool),
            Arc::new(AXReadTextTool),
            Arc::new(AXInspectTool),
            Arc::new(AXElementAtTool),
            Arc::new(AXListAppsTool),
            Arc::new(CaptureLiveScreenshotTool),
            Arc::new(ReplayProcedureTool),
            // Memory tools
            Arc::new(GetKnowledgeTool),
            Arc::new(SetDirectiveTool),
            Arc::new(GetDirectivesTool),
        ];
        Self {
            orchestrator,
            tools,
            pattern_store: None,
        }
    }

    /// Attach a pattern store for pattern-based prompt injection and extraction.
    pub fn with_pattern_store(mut self, store: Arc<Mutex<PatternStore>>) -> Self {
        self.pattern_store = Some(store);
        self
    }

    /// Return the definitions of all registered tools.
    pub fn tool_definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .iter()
            .map(|t| {
                let def = t.definition();
                ToolDefinition {
                    name: def.name,
                    description: def.description,
                    parameters: def.parameters,
                }
            })
            .collect()
    }

    /// Run the agent with streaming. Returns a stream of AgentRunEvents.
    pub fn run(
        self: Arc<Self>,
        user_message: String,
        mut conversation_history: Vec<LlmMessage>,
    ) -> UnboundedReceiverStream<AgentRunEvent> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

        tokio::spawn(async move {
            let tx2 = tx.clone();
            if let Err(e) = self.run_inner(user_message, conversation_history, tx).await {
                let _ = tx2.send(AgentRunEvent::Error {
                    message: e.to_string(),
                });
            }
        });

        UnboundedReceiverStream::new(rx)
    }

    async fn run_inner(
        &self,
        user_message: String,
        mut history: Vec<LlmMessage>,
        tx: tokio::sync::mpsc::UnboundedSender<AgentRunEvent>,
    ) -> Result<()> {
        // Classify intent and gather pattern hints
        let intent = IntentClassifier::classify(&user_message, &self.orchestrator).await;
        tracing::debug!("Intent classified as: {:?}", intent.as_str());

        let pattern_hints = if let Some(store) = &self.pattern_store {
            if let Ok(mut s) = store.lock() {
                s.format_for_prompt(&user_message, "")
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Build context-aware system prompt
        let context = self.gather_behavioral_context();
        let system_prompt = AgentPromptBuilder::build_system_prompt(
            chrono::Utc::now(),
            truncate_str(&context, MAX_CONTEXT_CHARS),
            &pattern_hints,
        );

        history.push(LlmMessage::user(&user_message));

        let tool_defs = self.tool_definitions();
        let mut full_response = String::new();
        let mut tool_cache = ToolResultCache::new();
        let mut tools_used: Vec<String> = Vec::new();

        for step in 0..MAX_STEPS {
            let mut messages = vec![LlmMessage::system(&system_prompt)];
            messages.extend(history.clone());

            let mut streaming_text = String::new();
            let tx_clone = tx.clone();

            let response = self
                .orchestrator
                .stream(
                    LlmRequest {
                        messages,
                        tools: tool_defs.clone(),
                        temperature: 0.3,
                        max_tokens: 2048,
                        stream: true,
                    },
                    &mut move |token: String| {
                        streaming_text.push_str(&token);
                        let _ = tx_clone.send(AgentRunEvent::TextDelta { text: token });
                    },
                )
                .await?;

            // If the model produced content (no tool calls), it's done
            if response.tool_calls.is_empty() {
                let final_text = response.content.unwrap_or_default();
                full_response.push_str(&final_text);
                let _ = tx.send(AgentRunEvent::FinalAnswer {
                    text: full_response.clone(),
                });
                return Ok(());
            }

            // Add assistant message with tool calls to history
            let assistant_content = response.content.clone().unwrap_or_default();
            history.push(LlmMessage::assistant(&assistant_content));

            // Execute each tool call
            for tc in &response.tool_calls {
                let _ = tx.send(AgentRunEvent::ToolCall {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    args: tc.arguments.clone(),
                });

                tools_used.push(tc.name.clone());

                // Check cache before executing
                let tool_result = if let Some(cached) = tool_cache.get(&tc.name, &tc.arguments) {
                    Ok(cached)
                } else {
                    let res = self.execute_tool(tc).await;
                    if let Ok(ref val) = res {
                        tool_cache.set(&tc.name, &tc.arguments, val.clone());
                    }
                    res
                };

                match &tool_result {
                    Ok(result) => {
                        let _ = tx.send(AgentRunEvent::ToolResult {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            result: result.clone(),
                            error: None,
                        });
                        // Add tool result to history
                        history.push(LlmMessage {
                            role: "tool".to_string(),
                            content: crate::llm::MessageContent::text(
                                serde_json::to_string(result).unwrap_or_default(),
                            ),
                        });
                    }
                    Err(e) => {
                        let err_str = e.to_string();
                        let _ = tx.send(AgentRunEvent::ToolResult {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            result: serde_json::Value::Null,
                            error: Some(err_str.clone()),
                        });
                        history.push(LlmMessage {
                            role: "tool".to_string(),
                            content: crate::llm::MessageContent::text(format!(
                                "{{\"error\": \"{}\"}}",
                                err_str
                            )),
                        });
                    }
                }
            }

            // Check finish reason
            if response.finish_reason == "stop" {
                break;
            }
        }

        // If we exhausted MAX_STEPS, send whatever we have
        if full_response.is_empty() {
            full_response = "I've completed the requested operations.".to_string();
        }
        let _ = tx.send(AgentRunEvent::FinalAnswer {
            text: full_response,
        });

        // Extract and save a pattern if the run was substantial enough
        if let Some(store) = &self.pattern_store {
            let orch = Arc::clone(&self.orchestrator);
            let desc = user_message.clone();
            let used = tools_used.clone();
            let store_clone = Arc::clone(store);
            tokio::spawn(async move {
                if let Some(pattern) = PatternExtractor::extract(&desc, &used, &orch).await {
                    if let Ok(mut s) = store_clone.lock() {
                        s.save(&pattern);
                    }
                }
            });
        }

        Ok(())
    }

    async fn execute_tool(&self, tc: &ToolCall) -> Result<serde_json::Value> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.definition().name == tc.name)
            .ok_or_else(|| anyhow::anyhow!("Unknown tool: {}", tc.name))?;

        let result = tool.execute(tc.arguments.clone()).await?;
        if let Some(err) = result.error {
            anyhow::bail!("{}", err);
        }
        Ok(result.result)
    }

    fn gather_behavioral_context(&self) -> String {
        let synth = crate::intelligence::context::ContextSynthesizer::new();
        let mut parts: Vec<String> = Vec::new();

        // Episode narratives
        match synth.get_recent_episodes(10) {
            Ok(episodes) if !episodes.is_empty() => {
                let lines: Vec<String> = episodes
                    .iter()
                    .rev()
                    .map(|e| {
                        let ts_secs = (e.start_us / 1_000_000) as i64;
                        let time_str = chrono::DateTime::from_timestamp(ts_secs, 0)
                            .map(|dt| dt.with_timezone(&chrono::Local).format("%H:%M").to_string())
                            .unwrap_or_else(|| format!("t={}", ts_secs));
                        format!("[{}] {} - {}", time_str, e.app_name, e.summary)
                    })
                    .collect();
                parts.push(format!("Recent activity:\n{}", lines.join("\n")));
            }
            _ => {
                // Fallback: raw timestamps when no episodes available
                let now = wall_micros();
                let lookback = now.saturating_sub(10 * 60 * 1_000_000);
                if let Ok(entries) = shadow_core::query_time_range(lookback, now) {
                    if !entries.is_empty() {
                        let lines: Vec<String> = entries
                            .iter()
                            .take(20)
                            .map(|e| {
                                format!("- {} ({})", e.app_name.as_deref().unwrap_or(""), e.ts)
                            })
                            .collect();
                        parts.push(lines.join("\n"));
                    }
                }
            }
        }

        // Active directives
        if let Some(memory_store) = crate::memory::MEMORY_STORE.get() {
            if let Ok(store) = memory_store.lock() {
                if let Ok(directives) = store.list_active(None) {
                    if !directives.is_empty() {
                        let lines: Vec<String> = directives
                            .iter()
                            .take(5)
                            .map(|d| format!("- [{}] {}", d.directive_type, d.content))
                            .collect();
                        parts.push(format!("Active directives:\n{}", lines.join("\n")));
                    }
                }
            }
        }

        parts.join("\n\n")
    }
}

fn truncate_str(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        s
    } else {
        &s[..max_chars]
    }
}
