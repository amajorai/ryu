//! Title generation for meetings, plus the title sanitizer every titler shares.
//!
//! Chat titles are NOT generated here. A chat gets its default title from its
//! first user message when the store persists the turn (`derive_title`), and the
//! LLM rename on top of that lives in the `chat-title` turn-hook plugin
//! (`post_assistant_turn`), which re-titles after the first completed reply and
//! then every N turns via `host.setConversationTitle`. This module owns:
//! - [`sanitize_title`] (shared by the plugin bridge + meetings)
//! - [`generate_meeting_title`] (meetings host)
//!
//! Core used to ALSO run a background chat titler from this module, fed by a
//! channel the conversation store wrote on the first user turn. It was removed
//! because its model resolution ended at "an active *local* engine" — on a
//! cloud-only node it silently produced nothing, so chats sat on their derived
//! placeholder until the plugin's every-N pass finally ran. The plugin resolves
//! through `host.sideModel` (`auto-title-model` → node default → local engine),
//! which is why it is now the single chat titler.
//!
//! Placement / privacy: meeting titles still prefer the resident local engine
//! directly (see [`generate`]), so the notes never leave the machine unless the
//! user configured an explicit override model.
//!
//! [`sanitize_title`]: sanitize_title
//! [`generate_meeting_title`]: generate_meeting_title

use serde_json::json;

use crate::sidecar::active_engine::{is_local_engine, local_engine_url, ActiveEngineStore};
use crate::sidecar::gateway::{log_side_usage, side_call_headers, SidePurpose, PRIORITY_HEADER};

/// Preference: override the model used to auto-name chats. When set (non-empty),
/// the title call routes through the Gateway with this model id. When unset, the
/// resident local engine is called directly.
const AUTO_TITLE_MODEL_PREF: &str = "auto-title-model";
/// Preference: reasoning/thinking effort for the override title model. Only
/// forwarded on the Gateway (override) path; empty = the provider default.
const AUTO_TITLE_EFFORT_PREF: &str = "auto-title-effort";
/// System prompt for titling a meeting from its notes/transcript summary.
const MEETING_SYSTEM_PROMPT: &str = "You write a short, specific title for a meeting based on its summary. Reply with ONLY the title: 3 to 6 words, in the same language as the summary, no surrounding quotes, no trailing punctuation, no markdown.";

/// Largest first-message slice (chars) we feed the titler — a giant paste must
/// not blow the local engine's context just to produce a 5-word title.
const MAX_INPUT_CHARS: usize = 2000;

/// Generate a concise meeting title from its summary (generate + sanitize only;
/// no store write — the extracted `ryu_meetings` crate owns the write, leaving a
/// user-chosen title alone). Best-effort; returns the candidate title or `None`.
/// This is the Core-side implementation the meetings host shim calls: the
/// shared title-model call reaches only preferences + the HTTP client, so it
/// takes those directly instead of the whole `ServerState`.
pub async fn generate_meeting_title(
    preferences: &super::preferences::PreferencesStore,
    client: &reqwest::Client,
    summary: &str,
) -> Option<String> {
    let summary = summary.trim();
    if summary.chars().count() < 3 {
        return None;
    }
    let input: String = summary.chars().take(MAX_INPUT_CHARS).collect();
    let raw = generate(preferences, client, MEETING_SYSTEM_PROMPT, &input).await?;
    let title = sanitize_title(&raw);
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// On-demand chat rename. Background chat titling remains owned by chat-title.
pub async fn retitle_conversation(state: &super::ServerState, id: &str) -> Option<String> {
    let first = state
        .conversations
        .get_first_user_message(id)
        .await
        .ok()
        .flatten()?;
    if first.trim().chars().count() < 3 {
        return None;
    }
    let input: String = first.trim().chars().take(MAX_INPUT_CHARS).collect();
    let raw = generate(&state.preferences, &state.client,
        "Write a short, specific title for this conversation. Reply with only 3 to 6 words in the same language, without quotes, punctuation or markdown.", &input).await?;
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return None;
    }
    state.conversations.force_set_title(id, &title).await.ok()?;
    Some(title)
}

/// Produce a raw title string for `user_input`. Default: the resident local
/// engine, called directly. Override (pref `auto-title-model`): the Gateway with
/// that model id, tagged background. `None` when neither is available. Reaches
/// only preferences + the HTTP client, so both are passed directly (this keeps
/// the meeting-title path callable from the extracted meetings host without a
/// `ServerState`).
async fn generate(
    preferences: &super::preferences::PreferencesStore,
    client: &reqwest::Client,
    system: &str,
    user_input: &str,
) -> Option<String> {
    if let Some(resolved) = crate::agent_selection::resolve_side_model(
        preferences,
        AUTO_TITLE_MODEL_PREF,
        Some(AUTO_TITLE_EFFORT_PREF),
    )
    .await
    {
        let effort = Some(resolved.effort.as_str()).filter(|e| !e.is_empty());
        return gateway_title(client, &resolved.model, effort, system, user_input).await;
    }
    local_title(client, system, user_input).await
}

/// Call the resident local engine directly (no Gateway hop), so the user's text
/// never leaves the machine and routing can't fall back to a cloud default.
async fn local_title(client: &reqwest::Client, system: &str, user_input: &str) -> Option<String> {
    let engine = ActiveEngineStore::load().active?;
    if !is_local_engine(&engine) {
        return None;
    }
    let base = local_engine_url(&engine)?; // e.g. http://127.0.0.1:8080/v1
                                           // The served model id. llama.cpp ignores it; ollama/vllm/DMR need the real
                                           // pulled name, so query `/models` and fall back to the engine name.
    let model = served_model_id(client, &base)
        .await
        .unwrap_or_else(|| engine.clone());
    let body = post_completion(
        client,
        &format!("{base}/chat/completions"),
        &model,
        None,
        system,
        user_input,
        None,
        &[(PRIORITY_HEADER, "background".to_owned())],
    )
    .await?;
    extract_content(&body)
}

/// Route through the Gateway with an explicit model id (power-user override).
/// `effort` is forwarded as `reasoning_effort` (empty = provider default).
async fn gateway_title(
    client: &reqwest::Client,
    model: &str,
    effort: Option<&str>,
    system: &str,
    user_input: &str,
) -> Option<String> {
    use crate::sidecar::gateway::{gateway_inference_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_inference_token();
    let body = post_completion(
        client,
        &format!("{base}/v1/chat/completions"),
        model,
        effort,
        system,
        user_input,
        token.as_deref(),
        &side_call_headers(&SidePurpose::AutoTitle),
    )
    .await?;
    log_side_usage(&SidePurpose::AutoTitle, model, &body);
    extract_content(&body)
}

/// Shared non-streaming chat-completion POST. `bearer` is the Gateway token (only
/// the Gateway path needs auth). `headers` carries the Gateway's side-call
/// attribution (purpose, `background` priority); the local engine
/// gets only the priority, which it ignores.
#[allow(clippy::too_many_arguments)]
async fn post_completion(
    client: &reqwest::Client,
    url: &str,
    model: &str,
    effort: Option<&str>,
    system: &str,
    user_input: &str,
    bearer: Option<&str>,
    headers: &[(&'static str, String)],
) -> Option<serde_json::Value> {
    let mut payload = json!({
        "model": model,
        "stream": false,
        "max_tokens": 256,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user_input },
        ],
    });
    if let Some(effort) = effort {
        payload["reasoning_effort"] = json!(effort);
    }
    let mut req = client
        .post(url)
        .timeout(std::time::Duration::from_secs(30))
        .json(&payload);
    for (name, value) in headers {
        req = req.header(*name, value);
    }
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        tracing::warn!("auto-title: title model returned HTTP {}", resp.status());
        return None;
    }
    resp.json().await.ok()
}

/// First served model id from an OpenAI-compatible `/models` listing.
async fn served_model_id(client: &reqwest::Client, base: &str) -> Option<String> {
    let resp = client
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

/// Clean a raw model reply into a usable one-line title. Local models in
/// particular like to wrap titles in quotes, prefix "Title:", emit a
/// `<think>` preamble, or add markdown — strip all of it, collapse whitespace,
/// drop trailing punctuation, and cap the length.
pub fn sanitize_title(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip a <think>…</think> reasoning block (reasoning local models emit one
    // before the title). If a block is opened but never closed — which happens
    // when the token cap truncates the reply mid-reasoning — there is no title
    // to salvage, so bail to empty rather than letting "<think>" become the
    // title.
    if let Some(start) = s.find("<think>") {
        match s[start..].find("</think>") {
            Some(rel_end) => {
                let after = start + rel_end + "</think>".len();
                s = format!("{}{}", &s[..start], &s[after..]).trim().to_string();
            }
            None => return String::new(),
        }
    }
    // Any other stray angle-bracket tag fragment means a malformed reply.
    if s.contains("<think") || s.contains("</think") {
        return String::new();
    }
    // First non-empty line only.
    s = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    // Strip a leading "Title:" / "Chat title:" label.
    if let Some(idx) = s.find(':') {
        let label = s[..idx].to_lowercase();
        if label.len() <= 16 && label.contains("title") {
            s = s[idx + 1..].trim().to_string();
        }
    }
    // Strip wrapping quotes / markdown emphasis.
    s = s
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '*' || c == '#')
        .trim()
        .to_string();
    // Titles don't end in punctuation.
    s = s.trim_end_matches(['.', '。', '!', '?']).trim().to_string();
    // Collapse internal whitespace.
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 70;
    if s.chars().count() > MAX {
        s.chars().take(MAX).collect::<String>().trim().to_string()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_title;

    #[test]
    fn strips_quotes_label_and_punctuation() {
        assert_eq!(sanitize_title("\"Centering a div\""), "Centering a div");
        assert_eq!(sanitize_title("Title: CSS layout help."), "CSS layout help");
        assert_eq!(
            sanitize_title("**Deploying to Vercel**"),
            "Deploying to Vercel"
        );
    }

    #[test]
    fn strips_think_preamble_and_keeps_first_line() {
        let raw = "<think>the user wants help</think>\nFixing the build error\nextra";
        assert_eq!(sanitize_title(raw), "Fixing the build error");
    }

    #[test]
    fn unclosed_think_bails_to_empty() {
        // A reasoning model truncated by the token cap mid-<think> must NOT
        // produce "<think>" as the title.
        assert_eq!(
            sanitize_title("<think>\nOkay, the user wants to center a div. The best"),
            ""
        );
        assert_eq!(sanitize_title("<think>"), "");
    }

    #[test]
    fn strips_inline_think_block_then_titles() {
        // The model puts its reasoning first, then the title on the same flow.
        let raw = "<think>reasoning here</think> Centering a div";
        assert_eq!(sanitize_title(raw), "Centering a div");
    }

    #[test]
    fn collapses_whitespace_and_caps_length() {
        assert_eq!(sanitize_title("  hello    world  "), "hello world");
        let long = "word ".repeat(40);
        assert!(sanitize_title(&long).chars().count() <= 70);
    }

    #[test]
    fn empty_in_empty_out() {
        assert_eq!(sanitize_title(""), "");
        assert_eq!(sanitize_title("   \n  "), "");
    }

    /// `extract_content` reads the first choice's message content from an
    /// OpenAI-compatible completion, and returns `None` for any missing hop rather
    /// than panicking on a malformed reply.
    #[test]
    fn extract_content_reads_first_choice_message() {
        use super::extract_content;
        use serde_json::json;

        let body = json!({
            "choices": [
                { "message": { "role": "assistant", "content": "Centering a div" } }
            ]
        });
        assert_eq!(extract_content(&body).as_deref(), Some("Centering a div"));

        // Missing content / empty choices / non-string content / wrong shape → None.
        assert!(extract_content(&json!({ "choices": [] })).is_none());
        assert!(extract_content(&json!({ "choices": [ { "message": {} } ] })).is_none());
        assert!(
            extract_content(&json!({ "choices": [ { "message": { "content": 42 } } ] })).is_none()
        );
        assert!(extract_content(&json!({ "error": "boom" })).is_none());
        assert!(extract_content(&json!(null)).is_none());
    }
}
