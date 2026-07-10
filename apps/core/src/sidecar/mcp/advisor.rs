//! Built-in **advisor** tool server — let an agent consult a *stronger* reviewer
//! model mid-turn (the model-callable analog of Claude's advisor tool).
//!
//! Unlike the `com.ryuhq.advisor` turn-hook plugin (which auto-reviews each answer
//! when toggled, or runs on `/advisor`), this is a tool the **model itself invokes**
//! when it wants a second opinion: before committing to an approach, when stuck, or
//! before declaring a task done. The agent passes what it wants advice on; the
//! handler routes a one-shot, higher-effort completion to a swappable stronger
//! model through the Gateway and returns the advice as the tool result.
//!
//! Placement: the call is a normal Gateway-governed completion (built from the
//! registry's own `http` client + the `gateway_*` helpers, mirroring
//! [`crate::server::call_side_model`] so the request shape stays in lockstep). The
//! transcript is **not** reachable at tool-dispatch on either plane (ACP and
//! openai-compat both pass `session_id: None`), so the agent supplies the context
//! it wants reviewed — which is exactly how the advisor tool is used in practice.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::server::preferences::PreferencesStore;

/// Reserved registry server name for the built-in advisor provider.
pub const SERVER_NAME: &str = "advisor";

/// Fully-qualified id of the single tool this provider exposes.
pub const CONSULT_TOOL_ID: &str = "advisor__consult";

/// Preference key holding the (stronger) model the advisor uses. Shared with the
/// `com.ryuhq.advisor` turn-hook plugin's settings tab so one picker drives both.
const ADVISOR_MODEL_PREF_KEY: &str = "advisor-model";

/// Reasoning effort requested of the advisor model — it is meant to be the
/// careful, stronger reviewer, so it runs at high effort.
const ADVISOR_EFFORT: &str = "high";

fn consult_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "What you want advice on — your plan, the approach you are about to take, the bug you are stuck on, or the answer you are about to commit to."
            },
            "context": {
                "type": "string",
                "description": "Optional. The relevant details the advisor should review: your current plan, the code or answer in question, key constraints, and anything you have already tried. The advisor only sees what you put here, so include enough to judge."
            },
            "model": {
                "type": "string",
                "description": "Optional explicit advisor model id. Defaults to the configured 'advisor-model' preference, else the node default."
            }
        },
        "required": ["question"]
    })
}

/// The advisor tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: CONSULT_TOOL_ID.to_owned(),
        server: SERVER_NAME.to_owned(),
        name: "consult".to_owned(),
        description: Some(
            "Consult a stronger advisor model for a second opinion. Call this BEFORE \
             substantive work (before committing to an approach), when you are stuck, \
             or before declaring a task done. The advisor reviews the question and \
             context you provide and returns concrete, actionable advice. Give its \
             advice serious weight. Returns { ok, model, advice }."
                .to_owned(),
        ),
        input_schema: Some(consult_schema()),
        ..Default::default()
    }]
}

/// Dispatch an `advisor` tool call.
///
/// `Err` only for a malformed call (unknown tool / missing required arg); a
/// Gateway failure is a structured `Ok({ok:false,...})` so the agent's turn
/// continues rather than aborting (same posture as the `skills` tools).
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    http: &reqwest::Client,
    preferences: Option<&PreferencesStore>,
) -> Result<Value> {
    match tool {
        "consult" => do_consult(arguments, http, preferences).await,
        other => Err(anyhow::anyhow!("unknown advisor tool '{other}'")),
    }
}

async fn do_consult(
    arguments: Value,
    http: &reqwest::Client,
    preferences: Option<&PreferencesStore>,
) -> Result<Value> {
    let question = arguments
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument 'question'"))?;
    let context = arguments
        .get("context")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let explicit = arguments.get("model").and_then(Value::as_str);
    let model = resolve_advisor_model(explicit, preferences).await;

    let system = "You are a stronger reviewer advising a capable assistant. The assistant has \
                  come to you for a second opinion before committing to an approach, while stuck, \
                  or before declaring a task done. Give concrete, actionable advice: flag wrong \
                  assumptions, missing steps, better approaches, and risks. If the direction is \
                  already sound, say so plainly and add the single highest-value improvement. Be \
                  specific and brief. Advise; do not just restate the plan back.";
    let mut user = format!("The assistant is asking for advice.\n\nQuestion:\n{question}");
    if !context.is_empty() {
        user.push_str(&format!("\n\nRelevant context / current plan:\n{context}"));
    }
    user.push_str("\n\nGive your advice now.");

    match call_advisor_model(http, &model, system, &user).await {
        Ok(advice) if !advice.trim().is_empty() => Ok(json!({
            "ok": true,
            "model": model,
            "advice": advice.trim(),
        })),
        Ok(_) => Ok(json!({
            "ok": false,
            "model": model,
            "error": "the advisor model returned no advice",
        })),
        Err(e) => Ok(json!({
            "ok": false,
            "model": model,
            "error": e,
        })),
    }
}

/// Resolve the advisor model id, swappable and never hardcoded to a remote
/// provider: explicit arg → preference `advisor-model` → env
/// `RYU_ADVISOR_MODEL`/`RYU_DEFAULT_LLM_MODEL` → the bundled local default.
async fn resolve_advisor_model(
    explicit: Option<&str>,
    preferences: Option<&PreferencesStore>,
) -> String {
    if let Some(m) = explicit {
        let t = m.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some(prefs) = preferences {
        if let Ok(Some(v)) = prefs.get(ADVISOR_MODEL_PREF_KEY).await {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    for key in ["RYU_ADVISOR_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_string()
}

/// One non-streaming, high-effort completion through the local Gateway. Mirrors
/// [`crate::server::call_side_model`]; kept local so the tool needs only the
/// registry's `http` client, not a full `ServerState`.
async fn call_advisor_model(
    http: &reqwest::Client,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let payload = json!({
        "model": model,
        "stream": false,
        "reasoning_effort": ADVISOR_EFFORT,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let mut req = http
        .post(format!("{base}/v1/chat/completions"))
        .timeout(std::time::Duration::from_secs(90))
        .json(&payload);
    if let Some(t) = gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("gateway unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gateway returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("response was not valid JSON: {e}"))?;
    let text = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_one_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, CONSULT_TOOL_ID);
        assert_eq!(tools[0].server, SERVER_NAME);
        assert_eq!(tools[0].name, "consult");
        // The schema must require `question` and offer optional `context`/`model`.
        let schema = tools[0].input_schema.clone().expect("schema present");
        assert_eq!(schema["required"], json!(["question"]));
        assert!(schema["properties"].get("context").is_some());
        assert!(schema["properties"].get("model").is_some());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let http = reqwest::Client::new();
        assert!(dispatch("nope", json!({}), &http, None).await.is_err());
    }

    #[tokio::test]
    async fn missing_question_is_an_error() {
        let http = reqwest::Client::new();
        let err = dispatch("consult", json!({}), &http, None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("question"), "error: {err}");
    }

    #[tokio::test]
    async fn blank_question_is_an_error() {
        let http = reqwest::Client::new();
        assert!(
            dispatch("consult", json!({ "question": "   " }), &http, None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn resolve_model_prefers_explicit_then_env_default() {
        // Explicit wins over everything.
        assert_eq!(
            resolve_advisor_model(Some("big-model"), None).await,
            "big-model"
        );
        // Blank explicit falls through; with no pref/env we land on the bundled
        // local default (never a hardcoded remote provider).
        let resolved = resolve_advisor_model(Some("   "), None).await;
        assert!(!resolved.is_empty());
    }
}
