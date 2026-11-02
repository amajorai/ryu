//! Applying the budgeted window: the OpenAI-compat message trim and the ACP
//! short-term replay, both of which may summarize the dropped turns.

use super::*;
use crate::server::conversations::ConversationStore;

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
    let cut = stable_drop_count(&estimates, budget, cfg.checkpoint_step());
    // A bare message array has no verified conversation identity. Remembering
    // cuts by message content would let unrelated callers affect one another.
    let drop_count = cut;
    let dropped: Vec<UiMessage> = turns.drain(0..drop_count).collect();

    // Reassemble: system block first, then the kept newest turns.
    messages.extend(system_msgs);
    messages.append(&mut turns);

    if dropped.is_empty() {
        return None;
    }
    // Flatten once and reuse: the `session_before_compact` observers, the summarizer
    // and the `session_compact` hooks all want the same `(role, text)` view. Built by
    // consuming `dropped` (it is discarded either way), so this is strictly cheaper
    // than the borrow-and-clone it replaces.
    let convo: Vec<(String, String)> = dropped
        .into_iter()
        .map(|m| {
            let text = ui_message_text(&m);
            (m.role, text)
        })
        .collect();
    // Fired before the `auto_compact` check: in trim mode these turns are dropped
    // outright, and an observer must see that too. No conversation id on this plane
    // — the OpenAI-compat request carries a client-supplied array, not a Ryu
    // conversation, so there is genuinely none to hand the hook.
    fire_before_compact_hooks(None, &convo);
    if !cfg.auto_compact {
        return None;
    }
    let summary = summarize(&convo, cfg).await?;
    // Hook applied OUTSIDE `summarize` on purpose — see `apply_compact_hooks`: the
    // cache stays a pure memo of the model's summary, never a plugin's rewrite.
    Some(apply_compact_hooks(None, &convo, summary).await)
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
    budgeted_short_term_replay(store, conversation_id, system_tokens, cfg, false)
        .await
        .map(|replay| replay.block)
}

/// Share of the input budget the replay keeps verbatim on a cold-cache
/// compaction; the rest is summarized. Half leaves the next stretch of warm
/// turns room to grow before the cut has to move again.
const COLD_CACHE_KEEP_DIVISOR: usize = 2;

/// A budgeted ACP short-term replay.
#[derive(Debug)]
pub struct ShortTermReplay {
    /// The `Conversation so far:` block to fold into the prompt.
    pub block: String,
    /// This turn compacted because the provider cache had expired, and a summary
    /// was produced. The caller should start the agent on this replay instead of
    /// resuming its native session, which still holds the uncompacted history.
    pub compacted_on_cache_expiry: bool,
}

/// [`budgeted_short_term`], told whether the prompt cache this conversation's
/// agent would hit has expired (`prompt_cache_warmth::expired_for_agent`).
///
/// A held cut (see [`hold_cut`]) keeps the replayed prefix byte-identical so a
/// warm cache keeps hitting. Once the cache is cold that protection buys
/// nothing: the next request re-writes the whole prefix at full price whatever
/// it contains. With `compact_on_cache_expire` (and `auto_compact`) on, a cold
/// turn therefore windows to a fraction of the budget and summarizes the rest,
/// and the held cut then keeps that smaller prefix stable while the new cache
/// is warm. The cost is one summarizer call per expiry, paid only when the
/// history is long enough to drop anything.
pub async fn budgeted_short_term_replay(
    store: &ConversationStore,
    conversation_id: &str,
    system_tokens: usize,
    cfg: &ContextWindowConfig,
    cache_expired: bool,
) -> Option<ShortTermReplay> {
    let cold = cache_expired && cfg.auto_compact && cfg.compact_on_cache_expire;
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
    let step = cfg.checkpoint_step();
    let mut cut = stable_drop_count(&estimates, budget, step);
    if cold {
        let cold_cut = stable_drop_count(&estimates, budget / COLD_CACHE_KEEP_DIVISOR, step);
        // Commit the deeper cut only once its summary exists: a failed summarizer
        // must not drop turns the normal budget would have kept. The summary is
        // memoized, so the compaction below reuses it instead of a second call.
        if cold_cut > cut {
            let convo: Vec<(String, String)> = prefix[..cold_cut]
                .iter()
                .map(|m| (m.role.clone(), m.content.clone()))
                .collect();
            if summarize(&convo, cfg).await.is_some() {
                cut = cold_cut;
            }
        }
    }
    let drop_count = hold_cut(hash_all([conversation_id]), prefix.len(), cut, step, |n| {
        hash_all(prefix[..n].iter().map(|m| m.content.as_str()))
    });
    let (dropped, kept) = prefix.split_at(drop_count);

    let mut block = String::from("Conversation so far:\n");
    let mut summarized = false;
    if !dropped.is_empty() {
        let convo: Vec<(String, String)> = dropped
            .iter()
            .map(|m| (m.role.clone(), m.content.clone()))
            .collect();
        // Observers first, and outside the `auto_compact` branch: with compaction off
        // these turns are still dropped from the replay, which is what the phase
        // reports. Detached, so it costs the ACP turn nothing.
        fire_before_compact_hooks(Some(conversation_id.to_string()), &convo);
        if cfg.auto_compact {
            if let Some(summary) = summarize(&convo, cfg).await {
                // Hook applied OUTSIDE `summarize` on purpose — see
                // `apply_compact_hooks`: the cache stays a pure memo of the model's
                // summary, never a plugin's rewrite.
                let summary =
                    apply_compact_hooks(Some(conversation_id.to_string()), &convo, summary).await;
                block.push_str(summary.trim());
                block.push('\n');
                summarized = true;
            }
        }
    }
    for msg in kept {
        block.push_str(&msg.role);
        block.push_str(": ");
        block.push_str(msg.content.trim());
        block.push('\n');
    }
    Some(ShortTermReplay {
        block,
        compacted_on_cache_expiry: cold && summarized,
    })
}
