//! Forged chat-template turns: a deterministic prompt-injection score.
//!
//! Untrusted text that carries a complete chat-template control token
//! (`<|im_end|><|im_start|>assistant`, `<|eot_id|><|start_header_id|>`,
//! `[INST]`, `<start_of_turn>`, ...) can close the caller's turn and open a
//! forged assistant or system turn for an engine whose tokenizer reads the
//! literal as a special token. A guard model can be derailed by the same
//! tokens, so admission does not rely on it: on chat and tool-result
//! surfaces such text scores [`TaxonomyId::PROMPT_INJECTION`] at
//! [`FORGED_TURN_SCORE`], which the screener's rule then flags or blocks.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use ryu_gw_screening::{contains_template_tokens, LeafClass, TaxonomyId};

use super::{ScreenInput, Surface};

/// The score a forged turn gives prompt injection: above the default flag
/// threshold (0.5), the same weight the inspector gives a flagged injection.
pub(super) const FORGED_TURN_SCORE: f32 = 0.7;
/// The detector the score is attributed to on the verdict.
pub(super) const FORGED_TURN_SOURCE: &str = "template_tokens";

/// Turn and role markers outside the `<|...|>` family. SentencePiece `<s>`
/// and `</s>` (also HTML strikethrough) and `<bos>`/`<eos>` mark no turn, so
/// they are left to the neutraliser rather than scored.
const TURN_MARKERS: &[&str] = &[
    "[INST]",
    "[/INST]",
    "[SYSTEM_PROMPT]",
    "[/SYSTEM_PROMPT]",
    "[AVAILABLE_TOOLS]",
    "[/AVAILABLE_TOOLS]",
    "[TOOL_CALLS]",
    "[TOOL_RESULTS]",
    "[/TOOL_RESULTS]",
    "<<SYS>>",
    "<</SYS>>",
    "<start_of_turn>",
    "<end_of_turn>",
];

/// Whether `text` holds a complete special token that can forge a turn: a
/// whole `<|name|>` (ASCII bars, or the fullwidth bars DeepSeek uses), or a
/// turn marker. A lone `|>` (a pipe operator in code) does not count.
pub(super) fn forges_a_turn(text: &str) -> bool {
    static PIPE_TOKEN: OnceLock<Regex> = OnceLock::new();
    if !contains_template_tokens(text) {
        return false;
    }
    let pipe_token = PIPE_TOKEN.get_or_init(|| {
        Regex::new("<[|\u{FF5C}][^\\s<>|\u{FF5C}]{1,64}[|\u{FF5C}]>").expect("valid token regex")
    });
    pipe_token.is_match(text) || TURN_MARKERS.iter().any(|marker| text.contains(marker))
}

/// Classes whose text the caller does not author as instructions: the end
/// user's turns, tool results, freeform residue and decoded forms. System
/// prompts, prior assistant turns and tool definitions are the tenant's own.
const fn untrusted(class: LeafClass) -> bool {
    matches!(
        class,
        LeafClass::User | LeafClass::ToolResult | LeafClass::Freeform | LeafClass::Decoded
    )
}

/// Whether this input, on this surface, forges a chat-template turn.
pub(super) fn forged_turn(surface: Surface, input: &ScreenInput) -> bool {
    matches!(surface, Surface::Chat | Surface::ToolRound)
        && input
            .segments
            .iter()
            .any(|segment| untrusted(segment.class) && forges_a_turn(&segment.text))
}

/// Raise prompt injection to at least [`FORGED_TURN_SCORE`] in `scores`
/// (the highest score per code across verdicts) when the input forges a
/// turn; a classifier's higher score is kept with its own source.
pub(super) fn score_forged_turns(
    surface: Surface,
    input: &ScreenInput,
    scores: &mut BTreeMap<TaxonomyId, (f32, String)>,
) {
    if !forged_turn(surface, input) {
        return;
    }
    let forged = (FORGED_TURN_SCORE, FORGED_TURN_SOURCE.to_owned());
    let slot = scores
        .entry(TaxonomyId::PROMPT_INJECTION)
        .or_insert_with(|| forged.clone());
    if slot.0 < FORGED_TURN_SCORE {
        *slot = forged;
    }
}

#[cfg(test)]
#[path = "template_tests.rs"]
mod tests;
