pub mod ax;
pub mod memory;
pub mod search;

pub use ax::{
    AXClickTool, AXElementAtTool, AXFocusAppTool, AXHotkeyTool, AXInspectTool, AXListAppsTool,
    AXReadTextTool, AXScrollTool, AXTreeQueryTool, AXTypeTool, AXWaitTool,
    CaptureLiveScreenshotTool, ReplayProcedureTool,
};
pub use memory::{GetDirectivesTool, GetKnowledgeTool, SetDirectiveTool};
pub use search::{
    GetActivitySequenceTool, GetDaySummaryTool, GetTimelineContextTool, GetTranscriptWindowTool,
    InspectScreenshotsTool, ResolveLatestMeetingTool, SearchHybridTool, SearchSummariesTool,
    SearchVisualMemoriesTool,
};

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Agent tool definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Tool execution result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_name: String,
    pub result: serde_json::Value,
    pub error: Option<String>,
}

/// Agent tool trait.
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// Get tool definition (name, description, JSON Schema parameters).
    fn definition(&self) -> Tool;

    /// Execute the tool with the given parameters.
    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult>;
}
