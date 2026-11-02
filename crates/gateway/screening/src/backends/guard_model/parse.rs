//! The two guard output grammars (part of [`super`]): Llama Guard's
//! `safe` / `unsafe` and an `S` code list, and Qwen3Guard-Gen's `Safety:`,
//! `Categories:` and `Refusal:` lines, with first-token logprob confidence.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::{GuardAnswer, GuardDialect, CONTROVERSIAL, FIXED_UNSAFE};
use crate::backend::{
    checked_score, BackendError, CodeSet, ConfidenceSource, ModelSignal, TaxonomyId,
};
use ryu_gw_firewall::taxonomy::taxonomy;

fn llama_guard_grammar() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(safe|unsafe)\n?(S([1-9]|1[0-4])(,\s?S([1-9]|1[0-4]))*)?\s*$")
            .expect("valid regex")
    })
}

/// The first non-blank generated token, from an OpenAI-style
/// `choices[0].logprobs` object, with its top alternatives (the generated
/// token included when it carries a logprob).
struct FirstToken {
    generated: String,
    alternatives: Vec<(String, f64)>,
}

fn first_token(logprobs: Option<&Value>) -> Option<FirstToken> {
    let content = logprobs?.get("content")?.as_array()?;
    let entry = content.iter().find(|e| {
        e.get("token")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty())
    })?;
    let generated = entry
        .get("token")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    let mut out = Vec::new();
    if let Some(lp) = entry.get("logprob").and_then(Value::as_f64) {
        out.push((generated.clone(), lp));
    }
    for alt in entry
        .get("top_logprobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let (Some(token), Some(lp)) = (
            alt.get("token").and_then(Value::as_str),
            alt.get("logprob").and_then(Value::as_f64),
        ) {
            out.push((token.trim().to_string(), lp));
        }
    }
    Some(FirstToken {
        generated,
        alternatives: out,
    })
}

/// A token on the `unsafe` branch: `unsafe` or a proper prefix of it that is
/// not also a prefix of `safe` (such as `un`).
fn is_unsafe_token(token: &str) -> bool {
    let t = token.to_ascii_lowercase();
    !t.is_empty() && "unsafe".starts_with(&t) && !"safe".starts_with(&t)
}

/// A token on the `safe` branch: `safe` or a prefix of it.
fn is_safe_token(token: &str) -> bool {
    let t = token.to_ascii_lowercase();
    !t.is_empty() && "safe".starts_with(&t)
}

/// `p_unsafe` from the first token: the probability of an unsafe-branch
/// token (see [`is_unsafe_token`]), else `1 - p(safe)`.
///
/// - `Ok(None)` makes the caller fall back to `Fixed` confidence: there are no
///   logprobs, or the generated token is on neither branch.
/// - `Err(Malformed)` when the generated token is on the opposite branch from
///   the reply (an `unsafe` reply whose first token is `safe`, or the
///   reverse). The engine contradicts itself, so it is treated as down (spec
///   02.9) and hard codes stay undecided. Trusting either side would let a
///   broken engine read as a confident allow: `unsafe` plus `S9` scoring S9 at
///   0, or a `safe` reply falling back to a fixed 0 on every code.
fn p_unsafe(logprobs: Option<&Value>, reply_unsafe: bool) -> Result<Option<f64>, BackendError> {
    let Some(first) = first_token(logprobs) else {
        return Ok(None);
    };
    let opposite = if reply_unsafe {
        is_safe_token(&first.generated)
    } else {
        is_unsafe_token(&first.generated)
    };
    if opposite {
        return Err(BackendError::Malformed);
    }
    let on_branch = if reply_unsafe {
        is_unsafe_token(&first.generated)
    } else {
        is_safe_token(&first.generated)
    };
    if !on_branch {
        return Ok(None);
    }
    let prob = |lp: f64| lp.exp().clamp(0.0, 1.0);
    let unsafe_branch = first
        .alternatives
        .iter()
        .filter(|(t, _)| is_unsafe_token(t))
        .map(|(_, lp)| prob(*lp))
        .reduce(f64::max);
    if let Some(p) = unsafe_branch {
        return Ok(p.is_finite().then_some(p));
    }
    Ok(first
        .alternatives
        .iter()
        .filter(|(t, _)| is_safe_token(t))
        .map(|(_, lp)| 1.0 - prob(*lp))
        .reduce(f64::min)
        .filter(|p| p.is_finite()))
}

/// Parse a Llama Guard reply (SB-1, SB-2).
///
/// Scores are hazard probabilities:
/// - `safe`: every covered code scores `p_unsafe` (0 with `Fixed` confidence);
/// - `unsafe`: each listed code scores `p_unsafe` (0.95 with `Fixed`), and every
///   unlisted code scores 0.
///
/// Anything outside the grammar, an `unsafe` with no codes, a code outside S1
/// to S14, codes after `safe`, or logprobs whose first generated token is on
/// the opposite branch from the reply is `Malformed`.
pub fn parse_llama_guard(
    content: &str,
    logprobs: Option<&Value>,
) -> Result<GuardAnswer, BackendError> {
    let trimmed = content.trim();
    let caps = llama_guard_grammar()
        .captures(trimmed)
        .ok_or(BackendError::Malformed)?;
    let is_unsafe = &caps[1] == "unsafe";
    let listed: CodeSet = match caps.get(2) {
        Some(list) => list
            .as_str()
            .split(',')
            .map(|c| TaxonomyId::from_short(c.trim()).ok_or(BackendError::Malformed))
            .collect::<Result<_, _>>()?,
        None => CodeSet::new(),
    };
    if is_unsafe == listed.is_empty() {
        // `unsafe` needs codes; `safe` must not carry any.
        return Err(BackendError::Malformed);
    }
    let covered = CodeSet::hazards();
    let p = p_unsafe(logprobs, is_unsafe)?;
    let confidence = if p.is_some() {
        ConfidenceSource::Logprob
    } else {
        ConfidenceSource::Fixed
    };
    let mut scores = Vec::with_capacity(covered.len());
    for code in covered.iter() {
        let score = match (is_unsafe, listed.contains(code), p) {
            (false, _, Some(p)) => checked_score(p)?,
            (false, _, None) => 0.0,
            (true, true, Some(p)) => checked_score(p)?,
            (true, true, None) => FIXED_UNSAFE,
            (true, false, _) => 0.0,
        };
        scores.push((code, score));
    }
    Ok(GuardAnswer {
        scores,
        covered,
        model_signal: if is_unsafe {
            ModelSignal::Block
        } else {
            ModelSignal::Allow
        },
        confidence,
    })
}

fn qwen_safety_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*Safety:\s*(Safe|Unsafe|Controversial)\s*$").expect("valid regex")
    })
}

fn qwen_categories_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*Categories:\s*(.*?)\s*$").expect("valid regex"))
}

fn qwen_refusal_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*Refusal:\s*(.*?)\s*$").expect("valid regex"))
}

/// Fold a Qwen3Guard label for comparison: case, `&` versus `and`, and spacing.
fn fold_label(label: &str) -> String {
    label
        .to_ascii_lowercase()
        .replace('&', " and ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The taxonomy codes for one Qwen3Guard label. `Ok(None)` for `None`.
fn qwen_label_codes(label: &str) -> Result<Option<&'static [TaxonomyId]>, BackendError> {
    let folded = fold_label(label);
    if folded == "none" {
        return Ok(None);
    }
    let mapping = taxonomy()
        .vendor_mapping("qwen3guard")
        .ok_or(BackendError::Malformed)?;
    mapping
        .into_iter()
        .find(|(known, _)| fold_label(known) == folded)
        .map(|(_, codes)| Some(codes))
        .ok_or(BackendError::Malformed)
}

/// The value of a line that may appear at most once. A second match means the
/// reply holds two answers, which is outside the closed grammar.
fn single_line(re: &Regex, content: &str) -> Result<Option<String>, BackendError> {
    let mut matches = re.captures_iter(content);
    let first = matches.next().map(|c| c[1].to_string());
    if matches.next().is_some() {
        return Err(BackendError::Malformed);
    }
    Ok(first)
}

/// Probability of the generated safety label, when logprobs are present: the
/// first non-blank token after the first token containing `:`.
fn qwen_label_probability(logprobs: Option<&Value>, label: &str) -> Option<f64> {
    let content = logprobs?.get("content")?.as_array()?;
    let mut after_colon = false;
    for entry in content {
        let token = entry.get("token").and_then(Value::as_str)?;
        if !after_colon {
            after_colon = token.contains(':');
            continue;
        }
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        if !label.starts_with(t) {
            return None;
        }
        let lp = entry.get("logprob").and_then(Value::as_f64)?;
        let p = lp.exp();
        return (p.is_finite() && (0.0..=1.0).contains(&p)).then_some(p);
    }
    None
}

/// Parse a Qwen3Guard-Gen reply (SB-3).
///
/// - `Unsafe`: each mapped code of the listed labels scores 0.95, or the
///   probability of the `Unsafe` label token when logprobs are present.
/// - `Controversial`: listed codes score 0.6, the controversial band.
/// - `Safe`: every covered code scores 0, or `1 - p(Safe)` with logprobs.
///
/// An unknown label, a missing `Safety:` line, more than one `Safety:`,
/// `Categories:` or `Refusal:` line, an `Unsafe` or `Controversial` with no
/// category, a `Safe` that names a category, or a `Refusal:` line other than
/// `Yes` or `No` is `Malformed`.
pub fn parse_qwen3guard(
    content: &str,
    logprobs: Option<&Value>,
) -> Result<GuardAnswer, BackendError> {
    let safety = single_line(qwen_safety_line(), content)?.ok_or(BackendError::Malformed)?;
    if let Some(refusal) = single_line(qwen_refusal_line(), content)? {
        if !matches!(refusal.as_str(), "Yes" | "No") {
            return Err(BackendError::Malformed);
        }
    }
    let mut listed = CodeSet::new();
    if let Some(categories) = single_line(qwen_categories_line(), content)? {
        for label in categories
            .split(',')
            .map(str::trim)
            .filter(|l| !l.is_empty())
        {
            if let Some(codes) = qwen_label_codes(label)? {
                for code in codes {
                    listed.insert(*code);
                }
            }
        }
    }
    let covered = GuardDialect::Qwen3Guard.covers();
    let p_label = qwen_label_probability(logprobs, &safety);
    let (signal, listed_score, other_score) = match safety.as_str() {
        "Unsafe" | "Controversial" if listed.is_empty() => return Err(BackendError::Malformed),
        // A category on a safe verdict contradicts it, as codes after `safe`
        // do for Llama Guard.
        "Safe" if !listed.is_empty() => return Err(BackendError::Malformed),
        "Unsafe" => (
            ModelSignal::Block,
            p_label.map_or(Ok(FIXED_UNSAFE), checked_score)?,
            0.0,
        ),
        "Controversial" => (ModelSignal::Flag, CONTROVERSIAL, 0.0),
        _ => {
            let other = p_label.map_or(Ok(0.0), |p| checked_score(1.0 - p))?;
            (ModelSignal::Allow, other, other)
        }
    };
    let scores = covered
        .iter()
        .map(|code| {
            let score = if listed.contains(code) {
                listed_score
            } else {
                other_score
            };
            (code, score)
        })
        .collect();
    let confidence = if p_label.is_some() && safety != "Controversial" {
        ConfidenceSource::Logprob
    } else {
        ConfidenceSource::Fixed
    };
    Ok(GuardAnswer {
        scores,
        covered,
        model_signal: signal,
        confidence,
    })
}
