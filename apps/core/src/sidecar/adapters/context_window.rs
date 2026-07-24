//! App-level context-window management for chat (limited local-model contexts).
//!
//! Local models run with small context windows (often 4k–8k). Without any
//! app-side bounding, Ryu sends the full thread and relies entirely on
//! llama.cpp's *engine* context-shift to drop tokens when the prompt overflows.
//! That shift is a blunt instrument: Ryu never emits `--keep`/`n_keep`, and
//! llama.cpp's server defaults `n_keep` to 0, so on overflow it can evict the
//! **system prompt** (the leading instructions / long-term memory / skills)
//! along with the oldest turns. The genuine value of trimming here is control
//! plus a guarantee the engine doesn't give: the system block is *always kept*,
//! and dropped turns can be summarized instead of silently lost.
//!
//! This mirrors Jan AI's `context-manager` (`trimMessages` + `compactMessages`)
//! and is **opt-in / off by default** — nothing changes unless the user sets a
//! context budget (see `server::resolve_context_window`). Two modes:
//!
//! * **trim** — a token-budgeted sliding window: keep the newest turns that fit
//!   the input budget, always keeping at least the last user turn and every
//!   `system` message. Older turns are dropped.
//! * **compact** (`auto_compact`) — instead of dropping the older turns, send
//!   them to a side model for a concise summary, injected as a leading system
//!   block. Adds one blocking summarization round-trip per over-budget turn
//!   (cached by the dropped-message set so an unchanged tail is not re-summarized).
//!
//! Token accounting is a deliberately conservative `len / 3.5` char heuristic
//! (no tokenizer), matching Jan. Base64 image payloads are **not** counted —
//! a flat per-image cost is used so a vision chat does not look like 100k tokens.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

use serde_json::json;
use tokio::sync::Mutex;

use super::{message_image_parts, UiMessage};
use crate::server::conversations::ConversationStore;

/// Conservative chars-per-token divisor (Jan uses the same 3.5).
const CHARS_PER_TOKEN: f32 = 3.5;
/// Per-message overhead for the role/formatting wrapper (Jan adds 4).
const PER_MESSAGE_OVERHEAD: usize = 4;
/// Flat token cost charged per inline image, instead of measuring its base64
/// payload (which would dwarf the real budget). Roughly a tiled vision frame.
const IMAGE_TOKEN_COST: usize = 768;
/// Slack reserved for skill instructions injected *downstream* of the trim
/// (inside `route_openai_stream`), which we cannot estimate exactly here. A
/// flat margin keeps us under budget for the common case; documented as an
/// approximation, not an exact accounting.
const SKILLS_RESERVE: usize = 512;
/// Upper bound on rows pulled for the ACP short-term window before budgeting,
/// so a very long conversation does not load + estimate unboundedly.
const MAX_SHORT_TERM_FETCH: usize = 400;

/// System prompt for the side-model summarizer (mirrors Jan's COMPACT prompt).
const COMPACT_SYSTEM_PROMPT: &str = "You are a conversation summarizer. Produce a concise summary that preserves key facts, decisions, code snippets, and action items. Use bullet points. Keep the summary under 500 words.";

/// Resolved, ready-to-apply context-window settings. Built by
/// `server::resolve_context_window` from preferences; `None` upstream means the
/// feature is off and none of this runs.
#[derive(Debug, Clone)]
pub struct ContextWindowConfig {
    /// Total context budget in tokens (input + output). When the pref is
    /// `auto`, this is the loaded model's `ctx_size`.
    pub max_tokens: usize,
    /// Tokens reserved for the model's reply (subtracted from the input budget).
    pub reserve_output: usize,
    /// Summarize dropped turns instead of dropping them.
    pub auto_compact: bool,
    /// Model id used for summarization (gateway-routable). Defaults to the chat model.
    pub compact_model: String,
    /// Reasoning effort forwarded to the summarizer (may be empty).
    pub compact_effort: String,
}

impl ContextWindowConfig {
    /// The input-token budget left for conversation history after reserving
    /// space for the reply, the system block, and downstream skill injection.
    fn input_budget(&self, system_tokens: usize) -> usize {
        self.max_tokens
            .saturating_sub(self.reserve_output)
            .saturating_sub(system_tokens)
            .saturating_sub(SKILLS_RESERVE)
    }
}

/// Estimate the token count of a plain string (`ceil(len / 3.5)`).
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    (text.len() as f32 / CHARS_PER_TOKEN).ceil() as usize
}

/// Estimate a UI message's tokens: its text parts plus a flat per-image cost
/// and the per-message overhead. Base64 image data is intentionally ignored.
fn estimate_ui_message_tokens(msg: &UiMessage) -> usize {
    let text = ui_message_text(msg);
    let images = message_image_parts(msg).len();
    estimate_tokens(&text) + images * IMAGE_TOKEN_COST + PER_MESSAGE_OVERHEAD
}

/// The plain text of a UI message (content string or joined `text` parts).
fn ui_message_text(msg: &UiMessage) -> String {
    let from_content = msg.content.as_text();
    if !from_content.is_empty() {
        return from_content;
    }
    msg.parts
        .iter()
        .filter_map(|p| p.get("text")?.as_str().map(str::to_owned))
        .collect::<Vec<_>>()
        .join("")
}

/// Given per-message token estimates (chronological), return how many of the
/// **newest** messages fit within `budget`. Always keeps at least one (the last
/// turn must be sent even if it alone exceeds the budget).
fn window_count(estimates: &[usize], budget: usize) -> usize {
    let mut total = 0usize;
    let mut kept = 0usize;
    for &tokens in estimates.iter().rev() {
        if total + tokens > budget && kept > 0 {
            break;
        }
        total += tokens;
        kept += 1;
    }
    kept.clamp(1, estimates.len().max(1)).min(estimates.len())
}

/// Trim the OpenAI-compat message list in place to the input budget.
///
/// Every `system` message is preserved (and moved to the front); the remaining
/// turns are windowed newest-first to `cfg.input_budget(system_tokens)`. When
/// `auto_compact` is on and turns were dropped, the dropped turns are summarized
/// and the summary is returned for the caller to merge into the system prompt
/// (labelled clearly so it does not read as a long-term "memory fact").
/// Returns `None` when nothing was dropped or compaction is off/failed.
pub async fn apply_openai(
    messages: &mut Vec<UiMessage>,
    system_tokens: usize,
    cfg: &ContextWindowConfig,
) -> Option<String> {
    // Split system (always kept) from the windowable conversation turns.
    let mut system_msgs: Vec<UiMessage> = Vec::new();
    let mut turns: Vec<UiMessage> = Vec::new();
    for m in messages.drain(..) {
        if m.role == "system" {
            system_msgs.push(m);
        } else {
            turns.push(m);
        }
    }

    // The budget must also account for any system message the client itself sent
    // (the agent's base prompt), not just the injected `system_tokens`, since
    // those rows are always kept and still consume context.
    let in_msg_system: usize = system_msgs.iter().map(estimate_ui_message_tokens).sum();
    let budget = cfg.input_budget(system_tokens + in_msg_system);

    let estimates: Vec<usize> = turns.iter().map(estimate_ui_message_tokens).collect();
    let keep = window_count(&estimates, budget);
    let drop_count = turns.len().saturating_sub(keep);
    let dropped: Vec<UiMessage> = turns.drain(0..drop_count).collect();

    // Reassemble: system block first, then the kept newest turns.
    messages.extend(system_msgs);
    messages.append(&mut turns);

    if !cfg.auto_compact || dropped.is_empty() {
        return None;
    }
    let convo: Vec<(String, String)> = dropped
        .iter()
        .map(|m| (m.role.clone(), ui_message_text(m)))
        .collect();
    summarize(&convo, cfg).await
}

/// Assemble a token-budgeted short-term context block for the ACP path (the Pi
/// agent), replacing the fixed last-10 cap. Fetches up to `MAX_SHORT_TERM_FETCH`
/// recent turns, windows them to the input budget, and (when `auto_compact` is
/// on) summarizes the dropped older turns into a leading bullet block. Returns
/// `None` when there is no prior context to replay.
pub async fn budgeted_short_term(
    store: &ConversationStore,
    conversation_id: &str,
    system_tokens: usize,
    cfg: &ContextWindowConfig,
) -> Option<String> {
    let recent = match store
        .get_recent_messages(conversation_id, MAX_SHORT_TERM_FETCH)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("failed to load short-term context: {e:#}");
            return None;
        }
    };
    // The final entry is the just-persisted current user turn; the prefix is the
    // prior context worth replaying. Fewer than 2 messages means no prior turns.
    if recent.len() < 2 {
        return None;
    }
    let prefix = &recent[..recent.len() - 1];

    let estimates: Vec<usize> = prefix
        .iter()
        .map(|m| estimate_tokens(&m.content) + PER_MESSAGE_OVERHEAD)
        .collect();
    let budget = cfg.input_budget(system_tokens);
    let keep = window_count(&estimates, budget);
    let drop_count = prefix.len().saturating_sub(keep);
    let (dropped, kept) = prefix.split_at(drop_count);

    let mut block = String::from("Conversation so far:\n");
    if cfg.auto_compact && !dropped.is_empty() {
        let convo: Vec<(String, String)> = dropped
            .iter()
            .map(|m| (m.role.clone(), m.content.clone()))
            .collect();
        if let Some(summary) = summarize(&convo, cfg).await {
            block.push_str(summary.trim());
            block.push('\n');
        }
    }
    for msg in kept {
        block.push_str(&msg.role);
        block.push_str(": ");
        block.push_str(msg.content.trim());
        block.push('\n');
    }
    Some(block)
}

/// Cache of summaries keyed by `(model, dropped-turn content)` so an unchanged
/// dropped set is not re-summarized on every subsequent over-budget turn.
fn summary_cache() -> &'static Mutex<HashMap<u64, String>> {
    static CACHE: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A reused HTTP client for the side-model summarization call.
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Summarize dropped `(role, text)` turns via the gateway side model. Returns a
/// labelled summary block, or `None` on any failure (caller falls back to a
/// plain drop). Memoized by the dropped-set hash.
async fn summarize(convo: &[(String, String)], cfg: &ContextWindowConfig) -> Option<String> {
    if convo.is_empty() {
        return None;
    }
    let key = {
        let mut hasher = DefaultHasher::new();
        cfg.compact_model.hash(&mut hasher);
        for (role, text) in convo {
            role.hash(&mut hasher);
            text.hash(&mut hasher);
        }
        hasher.finish()
    };
    if let Some(cached) = summary_cache().lock().await.get(&key).cloned() {
        return Some(cached);
    }

    let mut excerpt = convo
        .iter()
        .map(|(role, text)| format!("{role}: {text}"))
        .collect::<Vec<_>>()
        .join("\n");
    // Cap the excerpt to the context budget in chars, keeping the most recent
    // tail when over (older context is the first to go).
    let cap_chars = cfg.max_tokens * CHARS_PER_TOKEN as usize;
    if cap_chars > 0 && excerpt.len() > cap_chars {
        let start = excerpt.len() - cap_chars;
        // Snap to a char boundary so the slice is valid UTF-8.
        let start = (start..excerpt.len())
            .find(|i| excerpt.is_char_boundary(*i))
            .unwrap_or(excerpt.len());
        excerpt = excerpt[start..].to_string();
    }

    let summary = match gateway_summarize(&cfg.compact_model, &cfg.compact_effort, &excerpt).await {
        Ok(s) if !s.trim().is_empty() => s,
        Ok(_) => return None,
        Err(e) => {
            tracing::warn!("context compaction summarize failed, dropping turns instead: {e}");
            return None;
        }
    };
    let block = format!("[Earlier conversation summary]\n{}", summary.trim());
    summary_cache().lock().await.insert(key, block.clone());
    Some(block)
}

/// One non-streaming gateway completion used only for summarization. Mirrors the
/// request shape of `server::call_side_model` but lives here so the adapters
/// layer needs no `ServerState` handle.
async fn gateway_summarize(model: &str, effort: &str, excerpt: &str) -> Result<String, String> {
    let base = crate::sidecar::gateway::gateway_url();
    let base = base.trim_end_matches('/');
    let mut payload = json!({
        "model": model,
        "stream": false,
        "max_tokens": 512,
        "messages": [
            { "role": "system", "content": COMPACT_SYSTEM_PROMPT },
            { "role": "user", "content": format!("Summarize this conversation excerpt:\n\n{excerpt}") },
        ],
    });
    let effort = effort.trim();
    if !effort.is_empty() {
        payload["reasoning_effort"] = json!(effort);
    }
    let mut req = http()
        .post(format!("{base}/v1/chat/completions"))
        .timeout(std::time::Duration::from_secs(60))
        .json(&payload);
    if let Some(t) = crate::sidecar::gateway::gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("gateway unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gateway returned HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp
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
    use crate::sidecar::adapters::UiContent;

    fn user(text: &str) -> UiMessage {
        UiMessage {
            role: "user".to_owned(),
            content: UiContent::Text(text.to_owned()),
            parts: vec![],
        }
    }
    fn system(text: &str) -> UiMessage {
        UiMessage {
            role: "system".to_owned(),
            content: UiContent::Text(text.to_owned()),
            parts: vec![],
        }
    }

    fn cfg(max: usize, reserve: usize) -> ContextWindowConfig {
        ContextWindowConfig {
            max_tokens: max,
            reserve_output: reserve,
            auto_compact: false,
            compact_model: "m".to_owned(),
            compact_effort: String::new(),
        }
    }

    #[test]
    fn estimate_is_ceil_len_over_3_5() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 2); // ceil(4/3.5)=2
        assert_eq!(estimate_tokens(&"a".repeat(7)), 2); // ceil(7/3.5)=2
        assert_eq!(estimate_tokens(&"a".repeat(8)), 3); // ceil(8/3.5)=3
    }

    #[test]
    fn window_keeps_newest_within_budget() {
        let est = vec![10, 10, 10, 10]; // oldest..newest
        assert_eq!(window_count(&est, 25), 2); // 10+10 fit, +10 would exceed
        assert_eq!(window_count(&est, 100), 4);
        assert_eq!(window_count(&est, 0), 1); // always keep at least the last
        assert_eq!(window_count(&est, 5), 1);
    }

    #[test]
    fn window_empty_is_zero() {
        assert_eq!(window_count(&[], 100), 0);
    }

    #[tokio::test]
    async fn apply_openai_drops_oldest_keeps_system_and_last() {
        // Big per-message text so each turn is ~many tokens; tiny budget forces
        // a drop. System message must survive regardless and move to the front.
        let big = "x".repeat(350); // ~100 tokens each
        let mut msgs = vec![
            system("you are helpful"),
            user(&big),
            user(&big),
            user("latest"),
        ];
        // budget after reserves is small -> only the last user turn fits.
        let summary = apply_openai(&mut msgs, 0, &cfg(200, 0)).await;
        assert!(summary.is_none()); // auto_compact off
        assert_eq!(msgs.first().map(|m| m.role.as_str()), Some("system"));
        assert_eq!(
            msgs.last().map(|m| ui_message_text(m)),
            Some("latest".to_owned())
        );
        // system + at least the last user turn; oldest big turns dropped.
        assert!(msgs.len() < 4);
    }

    #[tokio::test]
    async fn apply_openai_noop_when_everything_fits() {
        let mut msgs = vec![system("sys"), user("hi"), user("there")];
        let before = msgs.len();
        let summary = apply_openai(&mut msgs, 0, &cfg(100_000, 1024)).await;
        assert!(summary.is_none());
        assert_eq!(msgs.len(), before);
        assert_eq!(
            msgs.last().map(|m| ui_message_text(m)),
            Some("there".to_owned())
        );
    }

    #[test]
    fn images_counted_flat_not_by_payload() {
        // A message whose only content is a giant base64 image part must not be
        // estimated as a huge token count.
        let huge_b64 = "A".repeat(200_000);
        let msg = UiMessage {
            role: "user".to_owned(),
            content: UiContent::Empty,
            parts: vec![json!({
                "type": "file",
                "mediaType": "image/png",
                "url": format!("data:image/png;base64,{huge_b64}")
            })],
        };
        // Whatever message_image_parts detects, the estimate must be small
        // (flat per-image cost), never ~57k tokens from the base64 length.
        assert!(estimate_ui_message_tokens(&msg) <= IMAGE_TOKEN_COST + PER_MESSAGE_OVERHEAD + 8);
    }

    #[test]
    fn input_budget_saturates_when_reserves_exceed_max() {
        // reserve_output + system + SKILLS_RESERVE all subtract from max_tokens;
        // when they exceed it the budget floors at 0 (never underflows/panics).
        let c = cfg(100, 1000); // reserve_output alone dwarfs max_tokens
        assert_eq!(c.input_budget(0), 0);
        // Even a modest max is fully consumed by system_tokens + SKILLS_RESERVE.
        let c2 = cfg(1000, 0);
        assert_eq!(c2.input_budget(10_000), 0);
    }

    #[test]
    fn ui_message_text_joins_text_parts_when_content_empty() {
        // With empty content, the text is reconstructed from the `text` parts.
        let msg = UiMessage {
            role: "user".to_owned(),
            content: UiContent::Empty,
            parts: vec![
                json!({ "type": "text", "text": "foo" }),
                json!({ "type": "image", "url": "x" }), // no `text` key → skipped
                json!({ "type": "text", "text": "bar" }),
            ],
        };
        assert_eq!(ui_message_text(&msg), "foobar");
    }

    #[test]
    fn ui_message_text_prefers_content_over_parts() {
        let msg = UiMessage {
            role: "user".to_owned(),
            content: UiContent::Text("primary".to_owned()),
            parts: vec![json!({ "type": "text", "text": "ignored" })],
        };
        assert_eq!(ui_message_text(&msg), "primary");
    }

    // ── budgeted_short_term (ACP short-term window) ─────────────────────────

    use crate::server::conversations::ConversationStore;

    #[tokio::test]
    async fn budgeted_short_term_none_without_prior_turns() {
        let store = ConversationStore::open_in_memory().unwrap();
        // No messages at all → None.
        assert!(budgeted_short_term(&store, "empty-conv", 0, &cfg(1000, 0))
            .await
            .is_none());
        // A single message is JUST the current turn — no prior context to replay.
        store
            .append_message("one-conv", "user", "only turn", None, None, None)
            .await
            .unwrap();
        assert!(budgeted_short_term(&store, "one-conv", 0, &cfg(1000, 0))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn budgeted_short_term_replays_prefix_excluding_current_turn() {
        let store = ConversationStore::open_in_memory().unwrap();
        for (role, text) in [
            ("user", "remember 42"),
            ("assistant", "noted"),
            ("user", "what number?"), // current turn — must be excluded
        ] {
            store
                .append_message("c", role, text, None, None, None)
                .await
                .unwrap();
        }
        let block = budgeted_short_term(&store, "c", 0, &cfg(100_000, 0))
            .await
            .expect("prior turns replayed");
        assert!(block.starts_with("Conversation so far:\n"));
        assert!(block.contains("user: remember 42"));
        assert!(block.contains("assistant: noted"));
        // The just-persisted current turn is never echoed back into context.
        assert!(!block.contains("what number?"));
    }

    #[tokio::test]
    async fn budgeted_short_term_drops_oldest_when_over_budget() {
        let store = ConversationStore::open_in_memory().unwrap();
        let big = "x".repeat(400); // ~114 tokens each
        for _ in 0..4 {
            store
                .append_message("cb", "user", &big, None, None, None)
                .await
                .unwrap();
        }
        store
            .append_message("cb", "user", "current", None, None, None)
            .await
            .unwrap();
        // Tiny budget (auto_compact off) → only the newest prefix turn survives,
        // older ones are silently dropped rather than summarized.
        let block = budgeted_short_term(&store, "cb", 0, &cfg(200, 0))
            .await
            .expect("some prior context");
        let big_occurrences = block.matches(&big).count();
        assert_eq!(
            big_occurrences, 1,
            "over-budget prefix keeps only the newest turn"
        );
        assert!(!block.contains("current"), "current turn excluded");
    }
}
