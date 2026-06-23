use anyhow::Result;
use std::sync::Arc;

use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};

// ─── App allowlist decision helper ────────────────────────────────────────────

/// Returns `true` when `app_name` matches at least one entry in `allowlist`
/// (case-insensitive substring match).
///
/// An empty `allowlist` means "allow all" — consistent with the global
/// `is_capture_allowed` function in `server.rs`.
pub fn is_app_allowed(app_name: &str, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    let lower = app_name.to_lowercase();
    allowlist
        .iter()
        .any(|entry| lower.contains(&entry.to_lowercase()))
}

/// Tool name fragments that are considered destructive when combined with file path args.
const DESTRUCTIVE_TOOL_PATTERNS: &[&str] = &["delete", "remove", "drop", "unlink", "rm_"];

/// Argument keywords that indicate financial operations — always hard-blocked.
const FINANCIAL_KEYWORDS: &[&str] = &[
    "payment",
    "transfer",
    "bank account",
    "credit card",
    "wire transfer",
    "paypal",
    "venmo",
    "checkout",
    "purchase",
];

/// System settings app names — hard-blocked as targets.
const SYSTEM_SETTINGS_APPS: &[&str] = &[
    "system preferences",
    "system settings",
    "registry editor",
    "regedit",
    "security center",
    "task manager",
    "group policy",
];

/// Tool call safety classifier.
///
/// `check()` returns `Err` when an action is hard-blocked (no execution allowed),
/// or `Ok(true)` when the action is ambiguous and requires user approval before
/// proceeding, or `Ok(false)` when the action is considered safe.
pub struct SafetyGate {
    orchestrator: Option<Arc<LlmOrchestrator>>,
}

impl SafetyGate {
    pub fn new(orchestrator: Option<Arc<LlmOrchestrator>>) -> Self {
        Self { orchestrator }
    }

    pub async fn check(&self, tool_name: &str, args: &serde_json::Value) -> Result<bool> {
        let tool_lower = tool_name.to_lowercase();
        let args_str = serde_json::to_string(args)
            .unwrap_or_default()
            .to_lowercase();

        // Hard-block: destructive tool name + file path argument
        let is_destructive_name = DESTRUCTIVE_TOOL_PATTERNS
            .iter()
            .any(|p| tool_lower.contains(p));
        let has_file_path = args_str.contains("filepath")
            || args_str.contains("file_path")
            || args_str.contains("\"path\"")
            || (args_str.contains('/') && !args_str.contains("http"))
            || args_str.contains('\\');

        if is_destructive_name && has_file_path {
            anyhow::bail!(
                "Hard blocked: tool '{}' with file path argument is not permitted",
                tool_name
            );
        }

        // Hard-block: financial keywords in args
        if FINANCIAL_KEYWORDS.iter().any(|kw| args_str.contains(kw)) {
            anyhow::bail!("Hard blocked: action contains a financial keyword");
        }

        // Hard-block: system settings apps as targets
        if SYSTEM_SETTINGS_APPS
            .iter()
            .any(|app| args_str.contains(app))
        {
            anyhow::bail!("Hard blocked: action targets a system settings application");
        }

        // LLM classification for ambiguous cases (destructive name without clear file path,
        // or args referencing "system" / "admin" contexts)
        let is_ambiguous = is_destructive_name
            || args_str.contains("\"system\"")
            || args_str.contains("\"admin\"")
            || args_str.contains("\"root\"");

        if is_ambiguous {
            if let Some(orchestrator) = &self.orchestrator {
                let prompt = format!(
                    "Safety check — is this tool call safe to execute automatically without \
                     user approval? Respond with JSON only, no other text.\n\
                     Tool: {}\nArgs: {}\n\
                     Response format: {{\"safe\": true/false, \"reason\": \"one sentence\"}}",
                    tool_name,
                    serde_json::to_string_pretty(args).unwrap_or_default()
                );

                if let Ok(resp) = orchestrator
                    .generate(LlmRequest {
                        messages: vec![LlmMessage::user(prompt)],
                        max_tokens: 80,
                        temperature: 0.1,
                        ..Default::default()
                    })
                    .await
                {
                    if let Some(content) = resp.content {
                        let json_str = extract_json_obj(&content);
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
                            if v["safe"].as_bool() == Some(false) {
                                let reason = v["reason"]
                                    .as_str()
                                    .unwrap_or("LLM classified as unsafe")
                                    .to_string();
                                tracing::warn!(
                                    "Safety gate: LLM flagged '{}' as requiring approval: {}",
                                    tool_name,
                                    reason
                                );
                                return Ok(true); // requires approval
                            }
                        }
                    }
                }
            }
        }

        Ok(false) // safe, no approval needed
    }
}

fn extract_json_obj(s: &str) -> String {
    let start = s.find('{').unwrap_or(0);
    let end = s.rfind('}').map(|i| i + 1).unwrap_or(s.len());
    if end > start {
        s[start..end].to_string()
    } else {
        s.to_string()
    }
}
