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
//! `{ suggestions: [".."] }` (200; an empty array on any failure so the UI
//! degrades to no chips rather than erroring). The chips are derived from the
//! conversation's content, so a caller without read access to a known
//! conversation gets the same 403/404 as any other conversation read.

use axum::{extract::State, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::ServerState;
use crate::sidecar::active_engine::{is_local_engine, local_engine_url, ActiveEngineStore};
use crate::sidecar::gateway::{log_side_usage, side_call_headers, SidePurpose, PRIORITY_HEADER};

/// Preference: override the model used for suggestions. When set (non-empty) the
/// call routes through the Gateway with this model id; when unset the resident
/// local engine is called directly.
const SUGGESTIONS_MODEL_PREF: &str = "chat-suggestions-model";
/// Preference: master toggle for next-prompt suggestions. Defaults on.
const SUGGESTIONS_ENABLED_PREF: &str = "chat-suggestions-enabled";
const PROMPT_SUGGESTIONS_PLUGIN_ID: &str = "@ryu/prompt-suggestions";

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

/// `POST /api/chat/suggestions` — best-effort next-prompt chips. Any generation
/// failure (toggle off, no model, empty reply) returns an empty list; a caller
/// without read access to the conversation is refused before generation.
#[utoipa::path(
    post,
    path = "/api/chat/suggestions",
    tag = "Chat",
    summary = "best-effort next-prompt chips",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Caller cannot read this conversation"),
        (status = 404, description = "Conversation not found")
    )
)]
pub async fn chat_suggestions(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<SuggestionsRequest>,
) -> axum::response::Response {
    // Per-resource ACL: the chips are generated from this conversation's turns,
    // so they are a read of the conversation by another name.
    if let Err(resp) =
        super::require_conversation_access_if_known(&state, &caller, &req.conversation_id, false)
            .await
    {
        return resp;
    }
    let suggestions = generate_suggestions(&state, &req.conversation_id)
        .await
        .unwrap_or_default();
    Json(SuggestionsResponse { suggestions }).into_response()
}

async fn generate_suggestions(state: &ServerState, conversation_id: &str) -> Option<Vec<String>> {
    if !plugin_enabled(&state.app_store, PROMPT_SUGGESTIONS_PLUGIN_ID).await {
        return Some(Vec::new());
    }
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

    let transcript = build_transcript(&messages, MAX_INPUT_CHARS);
    if transcript.trim().is_empty() {
        return Some(Vec::new());
    }

    let raw = side_generate(
        state,
        SideCompletion {
            purpose: SidePurpose::ChatSuggestions,
            model_pref: SUGGESTIONS_MODEL_PREF,
            system_prompt: SYSTEM_PROMPT,
            user_content: &format!("Conversation so far:\n\n{transcript}\nSuggested next prompts:"),
            max_tokens: 128,
        },
    )
    .await?;
    Some(parse_suggestions(&raw))
}

/// True when the plugin `plugin_id` is installed *and* enabled. The installable
/// plugin is the lifecycle gate for each host-owned side-model feature.
pub(super) async fn plugin_enabled(store: &crate::plugins::PluginStore, plugin_id: &str) -> bool {
    store.list().await.ok().is_some_and(|records| {
        records
            .iter()
            .any(|record| record.id == plugin_id && record.enabled)
    })
}

/// Flatten recent messages into a compact role-labelled transcript, capped at
/// `max_chars` so a long thread can't blow the model's context.
pub(super) fn build_transcript(
    messages: &[super::conversations::StoredMessage],
    max_chars: usize,
) -> String {
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
    if out.chars().count() > max_chars {
        let skip = out.chars().count() - max_chars;
        out = out.chars().skip(skip).collect();
    }
    out
}

/// One background side-model completion: a fixed system prompt plus a single
/// user turn, answered by whichever cheap model `model_pref` resolves to.
pub(super) struct SideCompletion<'a> {
    /// What the call is for, sent to the Gateway as `x-ryu-purpose`.
    pub purpose: SidePurpose,
    /// Preference key holding the optional model override.
    pub model_pref: &'a str,
    pub system_prompt: &'a str,
    pub user_content: &'a str,
    pub max_tokens: u32,
}

/// Produce a raw completion string. Resolution: the `model_pref` preference →
/// the node-wide default selection → the resident local engine called
/// directly. The first two route through the Gateway (tagged background); the
/// local path keeps the transcript on the machine and is what an unconfigured
/// node still uses. `None` when none of the three is available.
pub(super) async fn side_generate(
    state: &ServerState,
    request: SideCompletion<'_>,
) -> Option<String> {
    if let Some(resolved) =
        crate::agent_selection::resolve_side_model(&state.preferences, request.model_pref, None)
            .await
    {
        return gateway_generate(state, &resolved.model, &request).await;
    }
    local_generate(state, &request).await
}

/// Call the resident local engine directly (no Gateway hop), so the transcript
/// never leaves the machine and routing can't fall back to a cloud default.
async fn local_generate(state: &ServerState, request: &SideCompletion<'_>) -> Option<String> {
    let engine = ActiveEngineStore::load().active?;
    if !is_local_engine(&engine) {
        return None;
    }
    let base = local_engine_url(&engine)?; // e.g. http://127.0.0.1:8080/v1
    let model = served_model_id(state, &base)
        .await
        .unwrap_or_else(|| engine.clone());
    let body = post_completion(
        state,
        &format!("{base}/chat/completions"),
        &model,
        request,
        None,
        &[(PRIORITY_HEADER, "background".to_owned())],
    )
    .await?;
    extract_content(&body)
}

/// Route through the Gateway with an explicit model id (power-user override).
async fn gateway_generate(
    state: &ServerState,
    model: &str,
    request: &SideCompletion<'_>,
) -> Option<String> {
    use crate::sidecar::gateway::{gateway_inference_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_inference_token();
    let body = post_completion(
        state,
        &format!("{base}/v1/chat/completions"),
        model,
        request,
        token.as_deref(),
        &side_call_headers(&request.purpose),
    )
    .await?;
    log_side_usage(&request.purpose, model, &body);
    extract_content(&body)
}

/// Non-streaming chat-completion POST. `bearer` is the Gateway token (only the
/// Gateway path needs auth). `headers` carries the Gateway's side-call
/// attribution (purpose, `background` priority); the local engine
/// gets only the priority, which it ignores.
async fn post_completion(
    state: &ServerState,
    url: &str,
    model: &str,
    request: &SideCompletion<'_>,
    bearer: Option<&str>,
    headers: &[(&'static str, String)],
) -> Option<serde_json::Value> {
    let payload = json!({
        "model": model,
        "stream": false,
        "max_tokens": request.max_tokens,
        "messages": [
            { "role": "system", "content": request.system_prompt },
            { "role": "user", "content": request.user_content },
        ],
    });
    let mut req = state
        .client
        .post(url)
        .timeout(std::time::Duration::from_secs(20))
        .json(&payload);
    for (name, value) in headers {
        req = req.header(*name, value);
    }
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        tracing::warn!(
            "side-model completion ({}): model returned HTTP {}",
            request.model_pref,
            resp.status()
        );
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

/// Remove a `<think>…</think>` reasoning block (reasoning local models emit
/// one) and trim. `None` when the block is unclosed — the token cap truncated
/// mid-reasoning, so there is nothing to salvage.
pub(super) fn strip_think(raw: &str) -> Option<String> {
    let text = raw.trim();
    let Some(start) = text.find("<think>") else {
        return Some(text.to_string());
    };
    let rel_end = text[start..].find("</think>")?;
    let after = start + rel_end + "</think>".len();
    Some(
        format!("{}{}", &text[..start], &text[after..])
            .trim()
            .to_string(),
    )
}

/// Clean a raw model reply into up to [`MAX_SUGGESTIONS`] one-line prompts.
/// Local models like to number lines, add bullets, wrap in quotes, or emit a
/// `<think>` preamble — strip all of it and drop anything unusable.
pub fn parse_suggestions(raw: &str) -> Vec<String> {
    let Some(text) = strip_think(raw) else {
        return Vec::new();
    };

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
    use super::{parse_suggestions, plugin_enabled, PROMPT_SUGGESTIONS_PLUGIN_ID};
    use crate::plugins::PluginStore;

    #[tokio::test]
    async fn plugin_lifecycle_gates_the_single_suggestion_generator() {
        let store = PluginStore::open_in_memory().expect("in-memory plugin store");
        assert!(!plugin_enabled(&store, PROMPT_SUGGESTIONS_PLUGIN_ID).await);

        store
            .insert(PROMPT_SUGGESTIONS_PLUGIN_ID, "1.0.0")
            .await
            .expect("install disabled");
        assert!(!plugin_enabled(&store, PROMPT_SUGGESTIONS_PLUGIN_ID).await);

        store
            .set_enabled(PROMPT_SUGGESTIONS_PLUGIN_ID, &[])
            .await
            .expect("enable plugin");
        assert!(plugin_enabled(&store, PROMPT_SUGGESTIONS_PLUGIN_ID).await);
    }

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
