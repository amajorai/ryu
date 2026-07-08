//! Auto-rename for chats and meetings (ChatGPT/Claude-style).
//!
//! When a conversation gets its *first* user message, [`ConversationStore`]
//! [`append_message`] hands the id to [`run_auto_title_loop`], which asks the
//! default local model for a concise title and applies it — unless the user has
//! already renamed the chat (`title_custom`).
//!
//! Placement / privacy: this is a Core background task (it decides *what runs* —
//! a title for a chat). The **default** path calls the resident local engine
//! *directly*, because (a) the user asked for "the default local model" and (b)
//! it guarantees the first message never leaves the machine. Routing the call
//! through the Gateway instead risks the request falling through to the cloud
//! `default_provider` when the local model id doesn't match a local-family
//! prefix — so the direct call is the safe default. A power user can set the
//! `auto-title-model` preference to route through the Gateway with any model id
//! (tagged `x-ryu-priority: background` so it can't starve the interactive
//! reply).
//!
//! [`ConversationStore`]: super::conversations::ConversationStore
//! [`append_message`]: super::conversations::ConversationStore::append_message

use serde_json::json;

use super::ServerState;
use crate::sidecar::active_engine::{is_local_engine, local_engine_url, ActiveEngineStore};

/// Preference: override the model used to auto-name chats. When set (non-empty),
/// the title call routes through the Gateway with this model id. When unset, the
/// resident local engine is called directly.
const AUTO_TITLE_MODEL_PREF: &str = "auto-title-model";
/// Preference: reasoning/thinking effort for the override title model. Only
/// forwarded on the Gateway (override) path; empty = the provider default.
const AUTO_TITLE_EFFORT_PREF: &str = "auto-title-effort";
/// Preference: master toggle for chat auto-rename. Defaults on.
const AUTO_TITLE_ENABLED_PREF: &str = "auto-title-enabled";

/// System prompt for titling a chat from its first user message.
const CHAT_SYSTEM_PROMPT: &str = "You write a short, specific title for a chat conversation based on the user's first message. Reply with ONLY the title: 3 to 6 words, in the same language as the message, no surrounding quotes, no trailing punctuation, no markdown. Do not answer or address the message — only title it.";

/// System prompt for titling a meeting from its notes/transcript summary.
const MEETING_SYSTEM_PROMPT: &str = "You write a short, specific title for a meeting based on its summary. Reply with ONLY the title: 3 to 6 words, in the same language as the summary, no surrounding quotes, no trailing punctuation, no markdown.";

/// Largest first-message slice (chars) we feed the titler — a giant paste must
/// not blow the local engine's context just to produce a 5-word title.
const MAX_INPUT_CHARS: usize = 2000;

/// Consume conversation ids that just received their first user message and
/// auto-name them. Runs as a single background task owned by the server.
pub async fn run_auto_title_loop(
    state: ServerState,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    while let Some(conversation_id) = rx.recv().await {
        // Let the interactive turn grab the engine slot first: a short delay
        // keeps a single-slot local engine from serving the title before the
        // user's actual reply. Continuous-batching engines don't need it, but
        // it is cheap insurance and the title isn't time-critical.
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        auto_title_conversation(&state, &conversation_id).await;
    }
}

/// Generate and apply a title for one conversation. Best-effort throughout: any
/// failure (no local model, gateway down, empty reply) just leaves the
/// first-message-derived title in place.
async fn auto_title_conversation(state: &ServerState, conversation_id: &str) {
    // Master toggle (default on).
    if let Ok(Some(v)) = state.preferences.get(AUTO_TITLE_ENABLED_PREF).await {
        if v.trim() == "false" {
            return;
        }
    }
    // Skip if the user already locked a title (raced a manual rename).
    if state
        .conversations
        .title_is_custom(conversation_id)
        .await
        .unwrap_or(false)
    {
        return;
    }
    let Some(first) = state
        .conversations
        .get_first_user_message(conversation_id)
        .await
        .ok()
        .flatten()
    else {
        return;
    };
    let first = first.trim();
    // Too little to title — keep the derived first-message title.
    if first.chars().count() < 3 {
        return;
    }
    let user_input: String = first.chars().take(MAX_INPUT_CHARS).collect();

    let Some(raw) = generate(state, CHAT_SYSTEM_PROMPT, &user_input).await else {
        return; // no local model + no override → keep the derived title
    };
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return;
    }
    match state
        .conversations
        .auto_set_title(conversation_id, &title)
        .await
    {
        Ok(true) => tracing::info!("auto-titled conversation {conversation_id}: {title}"),
        Ok(false) => {} // user renamed in the meantime — leave it
        Err(e) => tracing::warn!("auto-title write failed for {conversation_id}: {e:#}"),
    }
}

/// Generate a concise meeting title from its summary, applying it unless the
/// meeting title is user-chosen. Best-effort; returns the new title when it
/// wrote one. Called from the meeting finalize path once notes exist.
pub async fn auto_title_meeting(
    state: &ServerState,
    meeting_id: &str,
    summary: &str,
) -> Option<String> {
    let summary = summary.trim();
    if summary.chars().count() < 3 {
        return None;
    }
    let input: String = summary.chars().take(MAX_INPUT_CHARS).collect();
    let raw = generate(state, MEETING_SYSTEM_PROMPT, &input).await?;
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return None;
    }
    match state
        .meetings
        .store
        .auto_set_title(meeting_id, &title)
        .await
    {
        Ok(Some(_)) => {
            tracing::info!("auto-titled meeting {meeting_id}: {title}");
            Some(title)
        }
        Ok(None) => None, // user-chosen title — left alone
        Err(e) => {
            tracing::warn!("auto-title write failed for meeting {meeting_id}: {e:#}");
            None
        }
    }
}

/// Produce a raw title string for `user_input`. Default: the resident local
/// engine, called directly. Override (pref `auto-title-model`): the Gateway with
/// that model id, tagged background. `None` when neither is available.
async fn generate(state: &ServerState, system: &str, user_input: &str) -> Option<String> {
    if let Ok(Some(pref)) = state.preferences.get(AUTO_TITLE_MODEL_PREF).await {
        let model = pref.trim().to_string();
        if !model.is_empty() {
            let effort = state
                .preferences
                .get(AUTO_TITLE_EFFORT_PREF)
                .await
                .ok()
                .flatten()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return gateway_title(state, &model, effort.as_deref(), system, user_input).await;
        }
    }
    local_title(state, system, user_input).await
}

/// Call the resident local engine directly (no Gateway hop), so the user's text
/// never leaves the machine and routing can't fall back to a cloud default.
async fn local_title(state: &ServerState, system: &str, user_input: &str) -> Option<String> {
    let engine = ActiveEngineStore::load().active?;
    if !is_local_engine(&engine) {
        return None;
    }
    let base = local_engine_url(&engine)?; // e.g. http://127.0.0.1:8080/v1
                                           // The served model id. llama.cpp ignores it; ollama/vllm/DMR need the real
                                           // pulled name, so query `/models` and fall back to the engine name.
    let model = served_model_id(state, base)
        .await
        .unwrap_or_else(|| engine.clone());
    let body = post_completion(
        state,
        &format!("{base}/chat/completions"),
        &model,
        None,
        system,
        user_input,
        None,
    )
    .await?;
    extract_content(&body)
}

/// Route through the Gateway with an explicit model id (power-user override).
/// `effort` is forwarded as `reasoning_effort` (empty = provider default).
async fn gateway_title(
    state: &ServerState,
    model: &str,
    effort: Option<&str>,
    system: &str,
    user_input: &str,
) -> Option<String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_token();
    let body = post_completion(
        state,
        &format!("{base}/v1/chat/completions"),
        model,
        effort,
        system,
        user_input,
        token.as_deref(),
    )
    .await?;
    extract_content(&body)
}

/// Shared non-streaming chat-completion POST. `bearer` is the Gateway token (only
/// the Gateway path needs auth); the `x-ryu-priority: background` header is
/// harmless to a local engine and lets the Gateway de-prioritize the call.
async fn post_completion(
    state: &ServerState,
    url: &str,
    model: &str,
    effort: Option<&str>,
    system: &str,
    user_input: &str,
    bearer: Option<&str>,
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
    let mut req = state
        .client
        .post(url)
        .timeout(std::time::Duration::from_secs(30))
        .header("x-ryu-priority", "background")
        .json(&payload);
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
}
