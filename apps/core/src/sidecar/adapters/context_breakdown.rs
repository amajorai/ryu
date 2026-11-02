//! Per-category attribution of what fills the model's context window.
//!
//! The composer ring already answers *how full* the window is; this module
//! answers *what filled it* — the breakdown desktop renders in its Context
//! panel (skills, MCP tool definitions, memory, conversation history, …), the
//! same thing `claude`'s `/context` and opencode's context view show.
//!
//! **This is observability only.** Nothing here may change what gets sent.
//! `context_window` owns trimming; this module only measures pieces that
//! module (or the plane adapters) have already decided to send, reusing its
//! `estimate_tokens` heuristic so the two never disagree about what a token is.
//!
//! ## Why the numbers do not always add up
//!
//! Attribution is exact only where Core owns the prompt:
//!
//! * **openai-compat plane** — Core assembles `req.messages`, the system block
//!   and the tool list, so the segments account for essentially the whole
//!   prompt.
//! * **ACP plane** — the agent subprocess (Pi) makes its own provider calls and
//!   serializes its own tool schemas. Core knows the preamble it handed over and
//!   the tools it offered the bridge, and nothing else. With progressive skill
//!   disclosure on, the agent also loads skill bodies mid-turn that Core never
//!   sees.
//!
//! So the segment sum is an **estimate** and the provider-reported prompt token
//! count is the **truth**. [`ContextBreakdown::attributed`] is reported
//! alongside the segments precisely so the panel can show the shortfall as an
//! explicit "unattributed" row rather than silently drawing a bar that does not
//! reach the percentage in the composer.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::context_window::{estimate_tokens, estimate_ui_message_parts};
use super::UiMessage;
use crate::sidecar::mcp::RegistryTool;

mod segment;
use segment::label_key;
pub use segment::{ContextSegment, SegmentDetail};

/// How many conversations keep a remembered breakdown. This is a display cache
/// for the panel, not state anything depends on, so a small bound with
/// oldest-first eviction is enough — a conversation evicted here simply shows no
/// breakdown until its next turn.
const MAX_REMEMBERED: usize = 64;

/// Which plane assembled the prompt. Decides how much of it Core can see, and
/// is surfaced in the panel so a partial ACP breakdown reads as expected rather
/// than broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextPlane {
    /// Agent subprocess owns the final prompt; Core sees the preamble + tools.
    Acp,
    /// Core assembles the whole request.
    Openai,
}

/// The assembled breakdown for one turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    /// Sum of `segments` — what Core could account for.
    pub attributed: usize,
    /// Which plane produced the prompt (see [`ContextPlane`]).
    pub plane: ContextPlane,
    /// Tokens held back for the reply, when a context budget is configured.
    /// `0` means no app-level budget is set (the engine handles overflow).
    pub reserve_output: usize,
    /// Non-empty categories, largest first.
    pub segments: Vec<ContextSegment>,
    /// The model's context window, or `0` when unknown. Kept as the ring's
    /// denominator so both surfaces divide by the same number.
    pub window: usize,
}

/// Accumulates segments as the prompt is layered together.
///
/// The system prompt is built by successive `merge_system_prompt` calls that
/// collapse every layer into one string, so per-layer cost cannot be recovered
/// afterwards — each layer is measured AT its merge site by pushing it here.
/// The plane is NOT a constructor argument: the shared system-prompt layers
/// (memory, persona, auto-recall) are measured before `agent_route` has decided
/// which plane runs, so it is supplied at [`BreakdownBuilder::finish`] instead.
#[derive(Debug, Default)]
pub struct BreakdownBuilder {
    reserve_output: usize,
    segments: Vec<ContextSegment>,
    window: usize,
}

impl BreakdownBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a pre-computed token count. Zero-token categories are dropped —
    /// the panel lists what is actually consuming the window, not every feature
    /// that could have.
    pub fn add(&mut self, kind: &'static str, label: impl Into<String>, tokens: usize) {
        self.add_detailed(kind, label, tokens, None);
    }

    /// Adding the same `kind` twice SUMS into the existing row rather than
    /// appending a second one — the ACP plane charges conversation history from
    /// two places (the replayed window and the current turn), and the panel must
    /// show one "Conversation history" row, not two. First label/detail wins.
    pub fn add_detailed(
        &mut self,
        kind: &'static str,
        label: impl Into<String>,
        tokens: usize,
        detail: Option<SegmentDetail>,
    ) {
        if tokens == 0 {
            return;
        }
        if let Some(existing) = self.segments.iter_mut().find(|s| s.kind == kind) {
            existing.tokens += tokens;
            if existing.detail.is_none() {
                if let Some(detail) = detail {
                    existing.counts = detail.counts();
                    existing.detail = Some(detail.english());
                    existing.detail_key = Some(detail.key());
                }
            }
            return;
        }
        let label = label.into();
        self.segments.push(ContextSegment {
            counts: detail.and_then(SegmentDetail::counts),
            detail: detail.map(SegmentDetail::english),
            detail_key: detail.map(SegmentDetail::key),
            kind,
            label_key: label_key(&label),
            label,
            tokens,
        });
    }

    /// Measure a text layer (skills block, persona prefix, recalled memory …).
    /// `None` / empty is a no-op, so call sites need no `if let`.
    pub fn add_text(&mut self, kind: &'static str, label: impl Into<String>, text: Option<&str>) {
        let tokens = text.map(estimate_tokens).unwrap_or(0);
        self.add(kind, label, tokens);
    }

    /// Charge a message list to the `messages` / `documents` / `images`
    /// segments. Splitting here (rather than one lumped "history" row) is what
    /// makes a chat that is 80% one attached PDF legible at a glance.
    pub fn add_messages(&mut self, label: impl Into<String>, messages: &[UiMessage]) {
        let mut text = 0usize;
        let mut documents = 0usize;
        let mut images = 0usize;
        let mut image_count = 0usize;
        for msg in messages {
            let est = estimate_ui_message_parts(msg);
            text += est.text;
            documents += est.documents;
            images += est.images;
            if est.images > 0 {
                image_count += 1;
            }
        }
        self.add_detailed(
            "messages",
            label,
            text,
            Some(SegmentDetail::Messages(messages.len())),
        );
        self.add("documents", "Attached documents", documents);
        self.add_detailed(
            "images",
            "Images",
            images,
            (image_count > 0).then_some(SegmentDetail::Images(image_count)),
        );
    }

    /// Charge the tool definitions offered to the agent. Costs the serialized
    /// name + description + JSON Schema, which is what a provider bills for a
    /// tool the model never calls.
    pub fn add_tools(&mut self, tools: &[RegistryTool]) {
        if tools.is_empty() {
            return;
        }
        let tokens: usize = tools.iter().map(tool_tokens).sum();
        let mut servers: Vec<&str> = tools.iter().map(|t| t.server.as_str()).collect();
        servers.sort_unstable();
        servers.dedup();
        self.add_detailed(
            "tools",
            "Tool definitions",
            tokens,
            Some(SegmentDetail::Tools {
                servers: servers.len(),
                tools: tools.len(),
            }),
        );
    }

    /// The model's context window (the ring denominator). `0` leaves it unknown.
    pub fn set_window(&mut self, window: usize) {
        self.window = window;
    }

    /// Tokens held back for the reply when an app-level budget is configured.
    pub fn set_reserve_output(&mut self, reserve: usize) {
        self.reserve_output = reserve;
    }

    /// Finish, sorting largest-first so the panel's bar and rows read in the
    /// order that matters. Returns `None` when nothing was attributed, so a turn
    /// with no measurable context records nothing at all.
    pub fn finish(mut self, plane: ContextPlane) -> Option<ContextBreakdown> {
        if self.segments.is_empty() {
            return None;
        }
        self.segments.sort_by(|a, b| b.tokens.cmp(&a.tokens));
        let attributed = self.segments.iter().map(|s| s.tokens).sum();
        Some(ContextBreakdown {
            attributed,
            plane,
            reserve_output: self.reserve_output,
            segments: self.segments,
            window: self.window,
        })
    }
}

/// Estimated prompt cost of one tool definition: its qualified name, its
/// description and its input schema, plus a small per-tool wrapper allowance.
fn tool_tokens(tool: &RegistryTool) -> usize {
    /// Braces/commas/keys around each serialized tool declaration.
    const PER_TOOL_OVERHEAD: usize = 8;
    let schema = tool
        .input_schema
        .as_ref()
        .map(|s| s.to_string())
        .unwrap_or_default();
    estimate_tokens(&tool.id)
        + estimate_tokens(tool.description.as_deref().unwrap_or(""))
        + estimate_tokens(&schema)
        + PER_TOOL_OVERHEAD
}

/// Last breakdown per conversation, plus the insertion order used to evict.
///
/// Deliberately in-memory and process-local: a breakdown describes the prompt
/// Core assembled for one turn, so it is regenerated on the next turn and worth
/// nothing after a restart. Keeping it out of SQLite also keeps this feature
/// unable to affect anything but the panel.
type Store = Mutex<(HashMap<String, ContextBreakdown>, Vec<String>)>;

fn store() -> &'static Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new((HashMap::new(), Vec::new())))
}

/// Remember the breakdown for `conversation_id`, replacing any previous one.
///
/// Called at the end of prompt assembly rather than streamed as a data part:
/// the panel is opened on demand and must work on a cold-loaded chat, which a
/// live-only part cannot do (the composer meter has exactly that gap today).
pub fn record(conversation_id: &str, breakdown: ContextBreakdown) {
    let Ok(mut guard) = store().lock() else {
        return;
    };
    let (map, order) = &mut *guard;
    if map.insert(conversation_id.to_owned(), breakdown).is_none() {
        order.push(conversation_id.to_owned());
    }
    while order.len() > MAX_REMEMBERED {
        let oldest = order.remove(0);
        map.remove(&oldest);
    }
}

/// The remembered breakdown for `conversation_id`, if the conversation has run
/// a turn in this process.
pub fn remembered(conversation_id: &str) -> Option<ContextBreakdown> {
    let guard = store().lock().ok()?;
    guard.0.get(conversation_id).cloned()
}

#[cfg(test)]
mod tests;
