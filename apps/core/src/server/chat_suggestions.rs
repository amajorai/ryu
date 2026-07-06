//! Next-prompt suggestions (ChatGPT-style follow-up chips).
//!
//! After the assistant finishes a turn, the desktop asks Core for a few short
//! "what to do next" prompts phrased from the *user's* point of view. Clicking a
//! chip sends it as the next message — one click to drive the agent forward.
//!
//! Placement / privacy: this is Core — it decides *what runs* (a helper turn that
//! proposes the next user step), not policy. It mirrors [`super::auto_title`]
//! exactly for model selection: by **default** the call goes to the resident
//! local engine *directly* so the conversation never leaves the machine; a power
//! user can set the `chat-suggestions-model` preference to route through the
//! Gateway (tagged `x-ryu-priority: background` so it can't starve the reply).
//!
//! Endpoint: `POST /api/chat/suggestions` `{ conversation_id }` →
//! `{ suggestions: [".."] }` (always 200; an empty array on any failure so the
//! UI degrades to no chips rather than erroring).

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::ServerState;
use crate::sidecar::active_engine::{is_local_engine, local_engine_url, ActiveEngineStore};

/// Preference: override the model used for suggestions. When set (non-empty) the
/// call routes through the Gateway with this model id; when unset the resident
/// local engine is called directly.
const SUGGESTIONS_MODEL_PREF: &str = "chat-suggestions-model";
/// Preference: master toggle for next-prompt suggestions. Defaults on.
const SUGGESTIONS_ENABLED_PREF: &str = "chat-suggestions-enabled";

/// How many recent turns we feed the model — enough for continuity without
/// blowing a small local context just to propose three chips.
const RECENT_TURNS: usize = 8;
/// Largest transcript slice (chars) handed to the model.
const MAX_INPUT_CHARS: usize = 4000;
/// Longest a single suggestion may be (chars) — chips must stay one line.
const MAX_SUGGESTION_CHARS: usize = 80;
/// How many chips we return at most.
const MAX_SUGGESTIONS: usize = 3;

const SYSTEM_PROMPT: &str = "You propose what the user might want to do next in their conversation with an AI assistant. Given the conversation so far, output up to 3 short follow-up prompts phrased from the USER's point of view — an imperative or a question the user could send next (e.g. \"Add tests for this\", \"Explain the tradeoffs\"). Rules: one prompt per line; 3 to 10 words each; same language as the conversation; no numbering, no bullets, no quotes, no markdown; each must be a concrete, self-contained next step. Output ONLY the prompts, nothing else.";

#[derive(Deserialize)]
pub struct SuggestionsRequest {
    pub conversation_id: String,
}

#[derive(Serialize)]
pub struct SuggestionsResponse {
    pub suggestions: Vec<String>,
}

/// `POST /api/chat/suggestions` — best-effort next-prompt chips. Never errors:
/// any failure (toggle off, no model, empty reply) returns an empty list.
pub async fn chat_suggestions(
    State(state): State<ServerState>,
    Json(req): Json<SuggestionsRequest>,
) -> Json<SuggestionsResponse> {
    let suggestions = generate_suggestions(&state, &req.conversation_id)
        .await
        .unwrap_or_default();
    Json(SuggestionsResponse { suggestions })
}

async fn generate_suggestions(state: &ServerState, conversation_id: &str) -> Option<Vec<String>> {
    // Master toggle (default on).
    if let Ok(Some(v)) = state.preferences.get(SUGGESTIONS_ENABLED_PREF).await {
        if v.trim() == "false" {
            return Some(Vec::new());
        }
    }

    let messages = state
        .conversations
        .get_recent_messages(conversation_id, RECENT_TURNS)
        .await
        .ok()?;
    // Need at least one assistant reply to suggest a follow-up to.
    if !messages.iter().any(|m| m.role == "assistant") {
        return Some(Vec::new());
    }

    let transcript = build_transcript(&messages);
    if transcript.trim().is_empty() {
        return Some(Vec::new());
    }

    let raw = generate(state, &transcript).await?;
    Some(parse_suggestions(&raw))
}

/// Flatten recent messages into a compact role-labelled transcript, capped so a
/// long thread can't blow the model's context.
fn build_transcript(messages: &[super::conversations::StoredMessage]) -> String {
    let mut out = String::new();
    for m in messages {
        let content = m.content.trim();
        if content.is_empty() {
            continue;
        }
        let speaker = match m.role.as_str() {
            "assistant" => "Assistant",
            "user" => "User",
            _ => continue, // skip system/tool rows — they aren't user-facing turns
        };
        out.push_str(speaker);
        out.push_str(": ");
        out.push_str(content);
        out.push_str("\n\n");
    }
    // Keep the *tail* (most recent turns) when over the cap — the latest exchange
    // is what a follow-up should build on.
    if out.chars().count() > MAX_INPUT_CHARS {
        let skip = out.chars().count() - MAX_INPUT_CHARS;
        out = out.chars().skip(skip).collect();
    }
    out
}

/// Produce a raw suggestions string. Default: the resident local engine, called
/// directly. Override (pref `chat-suggestions-model`): the Gateway with that
/// model id, tagged background. `None` when neither is available.
async fn generate(state: &ServerState, transcript: &str) -> Option<String> {
    if let Ok(Some(pref)) = state.preferences.get(SUGGESTIONS_MODEL_PREF).await {
        let model = pref.trim().to_string();
        if !model.is_empty() {
            return gateway_generate(state, &model, transcript).await;
        }
    }
    local_generate(state, transcript).await
}

/// Call the resident local engine directly (no Gateway hop), so the transcript
/// never leaves the machine and routing can't fall back to a cloud default.
async fn local_generate(state: &ServerState, transcript: &str) -> Option<String> {
    let engine = ActiveEngineStore::load().active?;
    if !is_local_engine(&engine) {
        return None;
    }
    let base = local_engine_url(&engine)?; // e.g. http://127.0.0.1:8080/v1
    let model = served_model_id(state, base)
        .await
        .unwrap_or_else(|| engine.clone());
    let body = post_completion(
        state,
        &format!("{base}/chat/completions"),
        &model,
        transcript,
        None,
    )
    .await?;
    extract_content(&body)
}

/// Route through the Gateway with an explicit model id (power-user override).
async fn gateway_generate(state: &ServerState, model: &str, transcript: &str) -> Option<String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();
    let body = post_completion(
        state,
        &format!("{base}/v1/chat/completions"),
        model,
        transcript,
        token.as_deref(),
    )
    .await?;
    extract_content(&body)
}

/// Non-streaming chat-completion POST. `bearer` is the Gateway token (only the
/// Gateway path needs auth); the `x-ryu-priority: background` header is harmless
/// to a local engine and lets the Gateway de-prioritize the call.
async fn post_completion(
    state: &ServerState,
    url: &str,
    model: &str,
    transcript: &str,
    bearer: Option<&str>,
) -> Option<serde_json::Value> {
    let user_input: String = transcript.chars().take(MAX_INPUT_CHARS).collect();
    let payload = json!({
        "model": model,
        "stream": false,
        "max_tokens": 128,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": format!("Conversation so far:\n\n{user_input}\nSuggested next prompts:") },
        ],
    });
    let mut req = state
        .client
        .post(url)
        .timeout(std::time::Duration::from_secs(20))
        .header("x-ryu-priority", "background")
        .json(&payload);
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        tracing::warn!("chat-suggestions: model returned HTTP {}", resp.status());
        return None;
    }
    resp.json().await.ok()
}

/// First served model id from an OpenAI-compatible `/models` listing.
async fn served_model_id(state: &ServerState, base: &str) -> Option<String> {
    let resp = state
        .client
        .get(format!("{base}/models"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("data")?
        .as_array()?
        .first()?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

fn extract_content(body: &serde_json::Value) -> Option<String> {
    body.get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

/// Clean a raw model reply into up to [`MAX_SUGGESTIONS`] one-line prompts.
/// Local models like to number lines, add bullets, wrap in quotes, or emit a
/// `<think>` preamble — strip all of it and drop anything unusable.
pub fn parse_suggestions(raw: &str) -> Vec<String> {
    let mut text = raw.trim().to_string();
    // Strip a <think>…</think> reasoning block (reasoning local models emit one).
    if let Some(start) = text.find("<think>") {
        match text[start..].find("</think>") {
            Some(rel_end) => {
                let after = start + rel_end + "</think>".len();
                text = format!("{}{}", &text[..start], &text[after..]);
            }
            // Unclosed (token cap truncated mid-reasoning) — nothing to salvage.
            None => return Vec::new(),
        }
    }

    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let cleaned = clean_line(line);
        if cleaned.is_empty() || cleaned.chars().count() > MAX_SUGGESTION_CHARS {
            continue;
        }
        // De-dupe case-insensitively so a repeated proposal doesn't fill a slot.
        if out.iter().any(|s| s.eq_ignore_ascii_case(&cleaned)) {
            continue;
        }
        out.push(cleaned);
        if out.len() >= MAX_SUGGESTIONS {
            break;
        }
    }
    out
}

/// Strip list markers, quotes, and trailing punctuation from a single line.
fn clean_line(line: &str) -> String {
    let mut s = line.trim();
    if s.contains("<think") || s.contains("</think") {
        return String::new();
    }
    // Drop a leading list marker: "1.", "1)", "-", "*", "•".
    s = s.trim_start_matches(|c: char| c.is_ascii_digit());
    s = s.trim_start_matches(['.', ')', '-', '*', '•', ' ', '\t']);
    // Strip wrapping quotes / markdown emphasis.
    let s = s
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '*' || c == '#')
        .trim();
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::parse_suggestions;

    #[test]
    fn strips_numbering_and_quotes() {
        let raw = "1. \"Add tests for this\"\n2. Explain the tradeoffs\n3. - Refactor the parser";
        assert_eq!(
            parse_suggestions(raw),
            vec![
                "Add tests for this",
                "Explain the tradeoffs",
                "Refactor the parser"
            ]
        );
    }

    #[test]
    fn caps_at_three_and_dedupes() {
        let raw = "Add tests\nAdd tests\nShip it\nDeploy\nExtra";
        assert_eq!(
            parse_suggestions(raw),
            vec!["Add tests", "Ship it", "Deploy"]
        );
    }

    #[test]
    fn drops_overlong_lines() {
        let long = "word ".repeat(30);
        let raw = format!("Short one\n{long}\nAnother short");
        assert_eq!(parse_suggestions(&raw), vec!["Short one", "Another short"]);
    }

    #[test]
    fn strips_think_preamble() {
        let raw = "<think>the user wants next steps</think>\nAdd error handling\nWrite docs";
        assert_eq!(
            parse_suggestions(raw),
            vec!["Add error handling", "Write docs"]
        );
    }

    #[test]
    fn unclosed_think_bails_empty() {
        assert!(parse_suggestions("<think>\nreasoning cut off").is_empty());
    }

    #[test]
    fn empty_in_empty_out() {
        assert!(parse_suggestions("").is_empty());
        assert!(parse_suggestions("   \n  ").is_empty());
    }
}
