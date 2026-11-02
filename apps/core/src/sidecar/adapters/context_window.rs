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
//!   `system` message. Older turns are dropped. The cut snaps to stable
//!   checkpoints (see [`stable_drop_count`]) so the replayed prefix stays
//!   byte-identical across turns and provider prompt caches keep hitting.
//! * **compact** (`auto_compact`) — instead of dropping the older turns, send
//!   them to a side model for a concise summary, injected as a leading system
//!   block. The stable cut keeps the dropped set unchanged for many turns, so the
//!   summary memo (keyed by that set) hits and a new summarization round-trip is
//!   paid only when the cut moves, about once per half-budget of new history.
//!
//! With `compact_on_cache_expire` the compact mode also re-cuts deeper on the
//! turn after the thread's provider prompt cache expired
//! (`prompt_cache_warmth`): a cold cache re-sends the whole prefix at full price
//! anyway, so moving the cut then costs no cache hits, and the smaller prefix is
//! what the next warm stretch caches.
//!
//! Both modes are observable and steerable by plugins: whenever turns are about to
//! leave the window the `session_before_compact` phase fires (detached), and a
//! produced summary is offered to `session_compact` (awaited, bounded) before it is
//! merged back. Both fire on BOTH planes — the OpenAI-compat array and the ACP
//! short-term replay — so one plugin governs every agent.
//!
//! Token accounting is a deliberately conservative `len / 3.5` char heuristic
//! (no tokenizer), matching Jan. Base64 image payloads are **not** counted —
//! a flat per-image cost is used so a vision chat does not look like 100k tokens.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

use super::{document_context_block, message_image_parts, UiMessage};

mod compact_hooks;
mod replay;
mod summarize;
#[cfg(test)]
mod tests;

use compact_hooks::{apply_compact_hooks, fire_before_compact_hooks};
#[cfg(test)]
use compact_hooks::{hook_messages, IN_COMPACT_HOOK};
#[allow(unused_imports)]
pub use replay::{apply_openai, budgeted_short_term, budgeted_short_term_replay, ShortTermReplay};
use summarize::summarize;
pub(crate) use summarize::summarize_handoff;
#[cfg(test)]
use summarize::{summary_cache, SummaryKind};

/// Conservative chars-per-token divisor (Jan uses the same 3.5).
const CHARS_PER_TOKEN: f32 = 3.5;
/// Per-message overhead for the role/formatting wrapper (Jan adds 4).
pub(crate) const PER_MESSAGE_OVERHEAD: usize = 4;
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
    /// Compact harder on the turn after a thread's provider prompt cache expired
    /// (`context.compact-on-cache-expire`; needs `auto_compact`). See
    /// [`budgeted_short_term_replay`].
    pub compact_on_cache_expire: bool,
}

impl ContextWindowConfig {
    /// The input-token budget left for conversation history after reserving
    /// space for the reply, the system block, and downstream skill injection.
    pub(crate) fn input_budget(&self, system_tokens: usize) -> usize {
        self.max_tokens
            .saturating_sub(self.reserve_output)
            .saturating_sub(system_tokens)
            .saturating_sub(SKILLS_RESERVE)
    }

    /// Spacing of the stable cut checkpoints (see [`stable_drop_count`]).
    ///
    /// Derived from settings only, never from the per-turn system block: that
    /// block carries recall and memory text whose size changes every turn, and a
    /// step that moved with it would move every checkpoint, which is exactly the
    /// churn the checkpoints exist to prevent. A quarter of the window keeps the
    /// cut moving rarely while leaving room when the system block is large.
    fn checkpoint_step(&self) -> usize {
        (self
            .max_tokens
            .saturating_sub(self.reserve_output)
            .saturating_sub(SKILLS_RESERVE)
            / 4)
        .max(1)
    }
}

/// Estimate the token count of a plain string (`ceil(len / 3.5)`).
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    (text.len() as f32 / CHARS_PER_TOKEN).ceil() as usize
}

/// A message's token estimate split by what produced it, so the context
/// breakdown panel can charge conversation text, attached documents and images
/// to separate segments. The trimmer only ever wants the sum
/// ([`estimate_ui_message_tokens`]); the split exists purely for reporting.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct MessageEstimate {
    /// Attached-document text folded into the prompt verbatim.
    pub documents: usize,
    /// Flat per-image cost (never the base64 payload).
    pub images: usize,
    /// Conversation text plus the per-message role/formatting overhead.
    pub text: usize,
}

impl MessageEstimate {
    pub(crate) fn total(&self) -> usize {
        self.text + self.documents + self.images
    }
}

/// Estimate a UI message's tokens, split by source. See [`MessageEstimate`].
pub(crate) fn estimate_ui_message_parts(msg: &UiMessage) -> MessageEstimate {
    let text = ui_message_text(msg);
    let documents = document_context_block(msg).unwrap_or_default();
    let images = message_image_parts(msg).len();
    MessageEstimate {
        text: estimate_tokens(&text) + PER_MESSAGE_OVERHEAD,
        documents: estimate_tokens(&documents),
        images: images * IMAGE_TOKEN_COST,
    }
}

/// Estimate a UI message's tokens: its text parts plus a flat per-image cost
/// and the per-message overhead. Base64 image data is intentionally ignored.
///
/// Attached-document text IS counted, because unlike an image's base64 it lands in
/// the prompt verbatim (see [`document_context_block`]). Leaving it out would make a
/// window carrying a 40-page PDF estimate as an empty message, and the trimmer would
/// keep history it has no room for.
fn estimate_ui_message_tokens(msg: &UiMessage) -> usize {
    estimate_ui_message_parts(msg).total()
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
pub(crate) fn window_count(estimates: &[usize], budget: usize) -> usize {
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

/// How many of the **oldest** messages to drop so the rest fit `budget`, with the
/// cut snapped forward to a stable checkpoint.
///
/// A plain sliding window ([`window_count`]) moves the cut by one turn on every
/// over-budget turn, so the replayed history starts somewhere new each request.
/// That defeats provider prompt caching (the cached prefix never matches again),
/// and with `auto_compact` it changes the dropped set every turn, so the
/// summary memo misses and a side-model round-trip is paid per turn.
///
/// Checkpoints are the positions where the running token total, counted from the
/// OLDEST message, crosses a multiple of `step`. Appending new turns never
/// changes an earlier prefix sum, and `step` comes from settings rather than the
/// per-turn budget ([`ContextWindowConfig::checkpoint_step`]), so every checkpoint
/// stays where it is as the conversation grows. The cut is the first checkpoint
/// at or after the minimal drop: it stays put while new turns fill the freed
/// space, and only jumps (by about one step) once that space is used up. The kept
/// history still fits `budget`, because the cut is never earlier than the
/// minimal drop.
fn stable_drop_count(estimates: &[usize], budget: usize, step: usize) -> usize {
    let minimal = estimates.len() - window_count(estimates, budget);
    if minimal == 0 {
        return 0;
    }
    let step = step.max(1);
    let mut before = 0usize;
    // Never drop the newest message: the last turn must always be sent.
    for (index, &tokens) in estimates.iter().enumerate().take(estimates.len() - 1) {
        let after = before + tokens;
        let checkpoint = index + 1;
        if checkpoint >= minimal && after / step > before / step {
            return checkpoint;
        }
        before = after;
    }
    minimal
}

/// Most conversations whose last cut [`hold_cut`] remembers. Past this the memo
/// is cleared: forgetting a cut costs one cache miss, never correctness.
const MAX_HELD_CUTS: usize = 1024;

/// A remembered cut: where it was, a fingerprint of the messages it dropped, and
/// the checkpoint step (settings) it was taken under.
#[derive(Clone, Copy)]
struct HeldCut {
    cut: usize,
    dropped: u64,
    step: usize,
}

/// Last cut per conversation, so a cut never moves backwards.
fn held_cuts() -> &'static std::sync::Mutex<HashMap<u64, HeldCut>> {
    static CUTS: OnceLock<std::sync::Mutex<HashMap<u64, HeldCut>>> = OnceLock::new();
    CUTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Keep the cut for `conversation` at or after where it was last turn.
///
/// Checkpoints alone are stable only while the budget is. The budget is what is
/// left after the system block, and that block carries recall and memory text
/// whose size changes each turn; a budget that grows lowers the minimal drop,
/// which can pull the cut back to an earlier checkpoint (or to nothing at all,
/// when the history hovers at the budget) and then forward again on the next
/// turn. Each flip is a full cache miss. Dropping at least as much as last turn
/// still fits the budget (the cut only ever grows past the minimal drop), so
/// holding the previous cut is always safe.
///
/// `len` is the number of windowable messages, and `fingerprint(n)` hashes the
/// oldest `n` of them. A remembered cut applies only when it still leaves the
/// newest message, the messages it dropped are the same ones as before, and the
/// settings (`step`) have not changed. So a branched or edited conversation, a
/// different one that hashed to the same `conversation` key, or a newly raised
/// context budget all start fresh.
fn hold_cut(
    conversation: u64,
    len: usize,
    cut: usize,
    step: usize,
    fingerprint: impl Fn(usize) -> u64,
) -> usize {
    let Ok(mut cuts) = held_cuts().lock() else {
        return cut;
    };
    let previous = cuts.get(&conversation).copied().filter(|held| {
        held.step == step && held.cut < len && fingerprint(held.cut) == held.dropped
    });
    let held = previous.map_or(cut, |held| cut.max(held.cut));
    if held == 0 {
        // Nothing to remember; keeps short conversations out of the memo.
        cuts.remove(&conversation);
        return 0;
    }
    if cuts.len() >= MAX_HELD_CUTS && !cuts.contains_key(&conversation) {
        cuts.clear();
    }
    cuts.insert(
        conversation,
        HeldCut {
            cut: held,
            dropped: fingerprint(held),
            step,
        },
    );
    held
}

/// Hash `items` in order, for [`hold_cut`] keys and fingerprints.
fn hash_all<'a>(items: impl IntoIterator<Item = &'a str>) -> u64 {
    let mut hasher = DefaultHasher::new();
    for item in items {
        item.hash(&mut hasher);
    }
    hasher.finish()
}
