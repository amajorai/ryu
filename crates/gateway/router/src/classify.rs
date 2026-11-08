//! Classifier ("smart routing") text helpers and the stage-target heuristic.

use super::*;

// ─── Classifier ("smart routing") text helpers ───────────────────────────────

/// Build the classifier prompt: enumerate rule descriptions and ask for a single
/// number.
pub fn build_prompt(rule_descriptions: &[String], user_msg: &str) -> String {
    let mut s = String::from(
        "You are a request router. Read the user's message and choose the ONE rule \
that best matches it. Reply with ONLY the rule number (a single integer). \
Reply 0 if no rule applies. Do not explain.\n\nRules:\n",
    );
    for (i, desc) in rule_descriptions.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, desc));
    }
    s.push_str("\nUser message:\n");
    s.push_str(truncate(user_msg, MAX_CLASSIFIER_INPUT_CHARS));
    s.push_str("\n\nRule number:");
    s
}

/// Parse the classifier's reply into a choice in `0..=num_rules`.
///
/// Returns `Some(0)` for "no rule", `Some(n)` for rule `n`, and `None` when the
/// reply has no integer in range (the caller then fails open). Reads the first
/// run of digits anywhere in the text so it tolerates stray prose.
pub fn parse_choice(text: &str, num_rules: usize) -> Option<usize> {
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    let n: usize = digits.parse().ok()?;
    if n <= num_rules {
        Some(n)
    } else {
        None
    }
}

/// `Keyword` strategy core: the index of the first rule whose description shares
/// a significant word (case-insensitive, length > 2) with the message, or `None`
/// if none match. Zero cost — no LLM, no embedding.
pub fn keyword_match(rule_descriptions: &[String], user_msg: &str) -> Option<usize> {
    let user_msg = user_msg.to_lowercase();
    for (idx, desc) in rule_descriptions.iter().enumerate() {
        let hit = desc
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
            .any(|w| user_msg.contains(&w.to_lowercase()));
        if hit {
            return Some(idx);
        }
    }
    None
}

/// Extract the most recent user message text. Handles both plain-string content
/// and the OpenAI multimodal content-array shape (joining its text parts).
pub fn last_user_message(messages: &Value) -> Option<String> {
    let arr = messages.as_array()?;
    for m in arr.iter().rev() {
        if m["role"].as_str() != Some("user") {
            continue;
        }
        if let Some(s) = m["content"].as_str() {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        } else if let Some(parts) = m["content"].as_array() {
            let text = parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Truncate `s` to at most `max` chars on a char boundary.
pub fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Pick an index from relative non-negative weights using a reproducible ticket.
///
/// The caller owns the random source; keeping this function pure makes weighted
/// routing testable without an RNG dependency and lets the Gateway provide either
/// a configured seed or a process-local seed. Invalid weights are treated as zero,
/// and `None` is returned when no usable weight remains.
pub fn weighted_index(weights: &[f32], ticket: u64) -> Option<usize> {
    let total: f64 = weights
        .iter()
        .copied()
        .filter(|weight| weight.is_finite() && *weight > 0.0)
        .map(f64::from)
        .sum();
    if total <= 0.0 {
        return None;
    }

    let unit = ticket as f64 / u64::MAX as f64;
    let mut cursor = unit * total;
    let mut last_positive = None;
    for (index, weight) in weights.iter().copied().enumerate() {
        if !weight.is_finite() || weight <= 0.0 {
            continue;
        }
        last_positive = Some(index);
        let weight = f64::from(weight);
        if cursor < weight {
            return Some(index);
        }
        cursor -= weight;
    }
    // Protect the upper-bound ticket (`u64::MAX`) from floating-point rounding.
    last_positive
}

/// The model tier selected by the signal-driven stage router.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageTarget {
    Capable,
    Efficient,
}

/// Choose a stage-router tier from recent tool/result history.
///
/// This is intentionally a small, provider-neutral heuristic. It treats errors,
/// recovery, and exploration as evidence for the capable tier, while recent writes
/// and successful tests are evidence for the efficient tier. An ambiguous or empty
/// history returns the configured default. The confidence gate prevents one weak
/// token hit from flipping a quality-first route.
pub fn stage_target(
    messages: &Value,
    recent_message_window: usize,
    confidence_threshold: f32,
    capable_first: bool,
) -> StageTarget {
    let default_target = if capable_first {
        StageTarget::Capable
    } else {
        StageTarget::Efficient
    };
    let Some(history) = messages.as_array() else {
        return default_target;
    };
    if history.is_empty() || recent_message_window == 0 {
        return default_target;
    }

    let start = history
        .len()
        .saturating_sub(recent_message_window.saturating_mul(4).max(1));
    let mut text = String::new();
    for message in &history[start..] {
        if let Ok(serialized) = serde_json::to_string(message) {
            text.push_str(&serialized.to_ascii_lowercase());
            text.push('\n');
        }
    }

    let errors = count_signal_hits(
        &text,
        &[
            "error",
            "failed",
            "failure",
            "panic",
            "traceback",
            "timed out",
            "timeout",
            "invalid",
        ],
    );
    let exploration = count_signal_hits(
        &text,
        &[
            "read", "search", "grep", "find", "list", "inspect", "explore",
        ],
    );
    let production = count_signal_hits(
        &text,
        &[
            "apply_patch",
            "write",
            "wrote",
            "edit",
            "edited",
            "created",
            "test passed",
            "tests passed",
            "success",
        ],
    );

    let signed_score =
        errors.saturating_mul(3) as i32 + exploration as i32 - production.saturating_mul(2) as i32;
    if signed_score == 0 {
        return default_target;
    }

    let confidence = (signed_score.unsigned_abs() as f32 / 3.0).tanh();
    if confidence < confidence_threshold.clamp(0.0, 1.0) {
        return default_target;
    }
    if signed_score > 0 {
        StageTarget::Capable
    } else {
        StageTarget::Efficient
    }
}

fn count_signal_hits(text: &str, signals: &[&str]) -> usize {
    signals
        .iter()
        .map(|signal| text.match_indices(signal).count())
        .sum()
}
