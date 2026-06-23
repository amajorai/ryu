use anyhow::Result;
use async_trait::async_trait;
use serde_json::json;

use super::super::{AgentTool, Tool, ToolResult};

/// Search timeline for apps, windows, OCR, transcripts.
pub struct SearchHybridTool;

#[async_trait]
impl AgentTool for SearchHybridTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "search_hybrid".to_string(),
            description: "Search timeline for apps, windows, OCR text, and transcripts".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 20}
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let query = params["query"].as_str().unwrap_or("");
        let limit = params["limit"].as_u64().unwrap_or(20) as u32;

        let results = shadow_core::search_text(query.to_string(), limit)?;
        let count = results.len();

        Ok(ToolResult {
            tool_name: "search_hybrid".to_string(),
            result: json!({ "results": results, "count": count }),
            error: None,
        })
    }
}

/// Get transcript chunks in time window.
pub struct GetTranscriptWindowTool;

#[async_trait]
impl AgentTool for GetTranscriptWindowTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "get_transcript_window".to_string(),
            description: "Retrieve audio transcript chunks within a time window".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "start_ts": {"type": "integer", "description": "Start timestamp in microseconds"},
                    "end_ts": {"type": "integer", "description": "End timestamp in microseconds"}
                },
                "required": ["start_ts", "end_ts"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let start_ts = params["start_ts"].as_u64().unwrap_or(0);
        let end_ts = params["end_ts"].as_u64().unwrap_or(0);

        let entries = shadow_core::query_time_range(start_ts, end_ts)?;
        let transcript_entries: Vec<_> = entries
            .iter()
            .filter(|e| e.app_name.as_deref().unwrap_or("").contains("transcript") || e.ts > 0)
            .collect();

        Ok(ToolResult {
            tool_name: "get_transcript_window".to_string(),
            result: json!({ "segments": transcript_entries }),
            error: None,
        })
    }
}

/// Get timeline context around timestamp.
pub struct GetTimelineContextTool;

#[async_trait]
impl AgentTool for GetTimelineContextTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "get_timeline_context".to_string(),
            description: "Get app and activity context around a given timestamp".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "ts": {"type": "integer", "description": "Timestamp in microseconds"},
                    "window_seconds": {"type": "integer", "default": 60}
                },
                "required": ["ts"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let ts = params["ts"].as_u64().unwrap_or(0);
        let window_secs = params["window_seconds"].as_u64().unwrap_or(60);
        let half = window_secs * 500_000; // half window in microseconds
        let start_ts = ts.saturating_sub(half);
        let end_ts = ts.saturating_add(half);

        let entries = shadow_core::query_time_range(start_ts, end_ts)?;

        Ok(ToolResult {
            tool_name: "get_timeline_context".to_string(),
            result: json!({ "entries": entries }),
            error: None,
        })
    }
}

/// Get a summary of app usage for a day.
pub struct GetDaySummaryTool;

#[async_trait]
impl AgentTool for GetDaySummaryTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "get_day_summary".to_string(),
            description: "Get a summary of app usage and activity for a specific day".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Date in YYYY-MM-DD format. Omit for today."
                    }
                }
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let date = params["date"].as_str().unwrap_or("").to_string();
        let date = if date.is_empty() {
            chrono::Local::now().format("%Y-%m-%d").to_string()
        } else {
            date
        };

        let blocks = shadow_core::get_day_summary(date.clone())?;

        Ok(ToolResult {
            tool_name: "get_day_summary".to_string(),
            result: json!({
                "date": date,
                "activity_blocks": blocks
            }),
            error: None,
        })
    }
}

/// Resolve the latest meeting window by detecting audio overlap.
pub struct ResolveLatestMeetingTool;

#[async_trait]
impl AgentTool for ResolveLatestMeetingTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "resolve_latest_meeting".to_string(),
            description: "Find the most recent meeting by detecting windows where microphone and system audio overlap".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "lookback_hours": {
                        "type": "integer",
                        "default": 8,
                        "description": "How many hours back to search"
                    }
                }
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let lookback_hours = params["lookback_hours"].as_u64().unwrap_or(8);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;
        let start = now.saturating_sub(lookback_hours * 3600 * 1_000_000);

        let entries = shadow_core::query_time_range(start, now)?;

        // Simple heuristic: look for dense activity blocks (potential meetings)
        let meeting_entries: Vec<_> = entries
            .iter()
            .filter(|e| {
                let app = e.app_name.as_deref().unwrap_or("").to_lowercase();
                app.contains("zoom")
                    || app.contains("meet")
                    || app.contains("teams")
                    || app.contains("webex")
                    || app.contains("skype")
            })
            .collect();

        let result =
            if let (Some(first), Some(last)) = (meeting_entries.first(), meeting_entries.last()) {
                json!({
                    "found": true,
                    "start_ts": first.ts,
                    "end_ts": last.ts,
                    "app": first.app_name.as_deref().unwrap_or(""),
                    "confidence": 0.8
                })
            } else {
                json!({ "found": false })
            };

        Ok(ToolResult {
            tool_name: "resolve_latest_meeting".to_string(),
            result,
            error: None,
        })
    }
}

/// Get chronological app transition sequence.
pub struct GetActivitySequenceTool;

#[async_trait]
impl AgentTool for GetActivitySequenceTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "get_activity_sequence".to_string(),
            description: "Get chronological app transitions with timestamps for a time range"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "start_ts": {"type": "integer"},
                    "end_ts": {"type": "integer"},
                    "limit": {"type": "integer", "default": 50}
                },
                "required": ["start_ts", "end_ts"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let start_ts = params["start_ts"].as_u64().unwrap_or(0);
        let end_ts = params["end_ts"].as_u64().unwrap_or(0);
        let limit = params["limit"].as_u64().unwrap_or(50) as usize;

        let entries = shadow_core::query_time_range(start_ts, end_ts)?;

        // Deduplicate consecutive same-app entries
        let mut sequence: Vec<serde_json::Value> = vec![];
        let mut last_app = String::new();
        for entry in entries.iter().take(limit * 3) {
            let app = entry.app_name.as_deref().unwrap_or("");
            if app != last_app {
                sequence.push(json!({
                    "ts": entry.ts,
                    "app": app,
                    "window": entry.window_title.as_deref().unwrap_or("")
                }));
                last_app = app.to_string();
                if sequence.len() >= limit {
                    break;
                }
            }
        }

        Ok(ToolResult {
            tool_name: "get_activity_sequence".to_string(),
            result: json!({ "sequence": sequence }),
            error: None,
        })
    }
}

/// Search over stored meeting summaries.
pub struct SearchSummariesTool;

#[async_trait]
impl AgentTool for SearchSummariesTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "search_summaries".to_string(),
            description: "Full-text search over stored meeting summaries".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 10}
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let query = params["query"].as_str().unwrap_or("");
        let limit = params["limit"].as_u64().unwrap_or(10) as usize;

        // Delegate to text search filtered for summaries
        let results = shadow_core::search_text(query.to_string(), limit as u32)?;

        Ok(ToolResult {
            tool_name: "search_summaries".to_string(),
            result: json!({ "summaries": results }),
            error: None,
        })
    }
}

/// Search visual memories using CLIP vector similarity.
pub struct SearchVisualMemoriesTool;

#[async_trait]
impl AgentTool for SearchVisualMemoriesTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "search_visual_memories".to_string(),
            description: "Search screen captures using semantic similarity (CLIP embeddings). Finds screenshots matching a description.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language description of what you're looking for"
                    },
                    "limit": {"type": "integer", "default": 5}
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let query = params["query"].as_str().unwrap_or("");
        let limit = params["limit"].as_u64().unwrap_or(5) as u32;

        // Use vector search via shadow-core
        match shadow_core::vector_search(query.to_string(), limit) {
            Ok(results) => Ok(ToolResult {
                tool_name: "search_visual_memories".to_string(),
                result: json!({ "results": results }),
                error: None,
            }),
            Err(e) => Ok(ToolResult {
                tool_name: "search_visual_memories".to_string(),
                result: json!({ "results": [] }),
                error: Some(e.to_string()),
            }),
        }
    }
}

/// Extract and inspect a screenshot at a specific timestamp.
pub struct InspectScreenshotsTool;

#[async_trait]
impl AgentTool for InspectScreenshotsTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "inspect_screenshot".to_string(),
            description: "Extract a screenshot frame at a specific timestamp from recorded video for analysis".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "timestamp_us": {
                        "type": "integer",
                        "description": "Timestamp in microseconds"
                    },
                    "display_id": {
                        "type": "integer",
                        "default": 0
                    }
                },
                "required": ["timestamp_us"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let timestamp_us = params["timestamp_us"].as_u64().unwrap_or(0);
        let display_id = params["display_id"].as_u64().unwrap_or(0) as u32;

        // Try to find keyframe near timestamp
        match shadow_core::find_nearest_keyframe(display_id, timestamp_us) {
            Ok(Some(path)) => Ok(ToolResult {
                tool_name: "inspect_screenshot".to_string(),
                result: json!({
                    "found": true,
                    "keyframe_path": path,
                    "timestamp_us": timestamp_us
                }),
                error: None,
            }),
            Ok(None) => Ok(ToolResult {
                tool_name: "inspect_screenshot".to_string(),
                result: json!({ "found": false }),
                error: None,
            }),
            Err(e) => Ok(ToolResult {
                tool_name: "inspect_screenshot".to_string(),
                result: json!({ "found": false }),
                error: Some(e.to_string()),
            }),
        }
    }
}
