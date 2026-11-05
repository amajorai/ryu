//! Where a rewrite replaced raw text: the byte spans of the original that a
//! `[REDACTED…]` placeholder stands for, and the order-free Sanitize rewrite
//! built on them.

use super::redact::PLACEHOLDER;
use crate::firewall::FirewallBackend;

/// Anchor occurrences the alignment tries before failing closed.
const ALIGN_BUDGET: usize = 256;

/// The Sanitize rewrite of `text`, the same on every path (`Transform`,
/// `sanitize_json_strings`). Secrets first keeps a PII rule from splitting a
/// secret (an IP inside a bearer token); PII first keeps a secret rule from
/// splitting a PII value (`secret=` taking a card's first group). When the
/// two orders differ, everything either one replaced is replaced.
pub(in crate::pipeline) fn sanitize_text(scanner: &dyn FirewallBackend, text: &str) -> String {
    let redact = |text: &str| scanner.redact_outbound(text).0;
    let redacted = redact(text);
    // `sanitize` and `redact_outbound` are pure functions of their input (the
    // hit list is ignored): an unchanged secrets pass gives both orders one
    // input, so they agree and the first branch below would return it. A
    // sanitize pass that leaves its input unchanged, or two that agree, feed
    // `redact` a string it already ran on, so that result is reused. (No
    // `redact(redacted) == redacted` shortcut: `redact` is not idempotent.)
    if redacted == text {
        let sanitized = scanner.sanitize(text);
        if sanitized == text {
            debug_assert_eq!(redact(&sanitized), redacted);
            return redacted;
        }
        return redact(&sanitized);
    }
    let sanitized_red = scanner.sanitize(&redacted);
    let secrets_first = redact(&sanitized_red);
    let sanitized_text = scanner.sanitize(text);
    if sanitized_text == sanitized_red {
        // Both orders ran `redact` on one string, so they agree.
        debug_assert_eq!(redact(&sanitized_text), secrets_first);
        return secrets_first;
    }
    let pii_first = if sanitized_text == text {
        debug_assert_eq!(redact(&sanitized_text), redacted);
        redacted
    } else {
        redact(&sanitized_text)
    };
    if secrets_first == pii_first {
        return secrets_first;
    }
    let (Some(secrets), Some(pii)) = (
        replaced_spans(text, &secrets_first),
        replaced_spans(text, &pii_first),
    ) else {
        // The replacements cannot be told apart: fail closed.
        return format!("{PLACEHOLDER}]");
    };
    let union = merge_spans(secrets.iter().chain(&pii).copied());
    if union == merge_spans(secrets.iter().copied()) {
        return secrets_first;
    }
    if union == merge_spans(pii.iter().copied()) {
        return pii_first;
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end) in union {
        out.push_str(&text[cursor..start]);
        out.push_str(PLACEHOLDER);
        out.push(']');
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// The Sanitize rewrite of `text` read through its fold
/// (`fold_for_redaction`, one character at a time): the rewrite runs on the
/// folded text, but only the values it replaces change; every other
/// character keeps the form it was written in (a fullwidth comma, an
/// ideographic full stop). `None` when folding changes nothing or the
/// rewrite cannot be aligned with the folded text.
pub(in crate::pipeline) fn sanitize_folded(
    scanner: &dyn FirewallBackend,
    text: &str,
) -> Option<String> {
    let mut folded = String::with_capacity(text.len());
    // The `text` offset of the character each `folded` byte comes from.
    let mut origin = Vec::with_capacity(text.len() + 1);
    let mut buffer = [0u8; 4];
    for (at, character) in text.char_indices() {
        let one = ryu_gw_firewall::fold_for_redaction(character.encode_utf8(&mut buffer));
        origin.extend(std::iter::repeat_n(at, one.len()));
        folded.push_str(&one);
    }
    origin.push(text.len());
    if folded == text {
        return None;
    }
    let sanitized = sanitize_text(scanner, &folded);
    // Folded offset to `text` offset; characters folding stripped before
    // the first kept one stay with the first stretch.
    let at = |offset: usize| if offset == 0 { 0 } else { origin[offset] };
    let mut out = String::with_capacity(text.len());
    let (mut kept, mut written) = (0, 0);
    for (start, end) in replaced_spans(&folded, &sanitized)? {
        out.push_str(&text[at(kept)..at(start)]);
        written += start - kept;
        // The placeholder run that replaced `folded[start..end]`.
        let mut after = written;
        while sanitized[after..].starts_with(PLACEHOLDER) {
            after += sanitized[after..].find(']')? + 1;
        }
        out.push_str(&sanitized[written..after]);
        (kept, written) = (end, after);
    }
    out.push_str(&text[at(kept)..]);
    Some(out)
}

/// Sorted spans with overlapping or touching ones merged.
fn merge_spans(spans: impl Iterator<Item = (usize, usize)>) -> Vec<(usize, usize)> {
    let mut spans: Vec<_> = spans.collect();
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// One placeholder run whose span end may still move: the span starts at
/// `raw`, ends at `end`, and the alignment resumes at `whole[after..]`, whose
/// unchanged literal ends at `literal_end`.
struct Choice {
    raw: usize,
    end: usize,
    after: usize,
    literal_end: usize,
}

/// Raw byte spans of `region` that `whole` replaced with a placeholder,
/// found by aligning the unchanged text. Every byte of `region` outside the
/// spans is compared, so replacing the spans in `region` gives `whole`
/// exactly. Each span ends at an occurrence of the full literal that follows
/// its placeholder, nearest first; an occurrence inside the replaced value
/// is backtracked when the rest does not align. `None` when no alignment is
/// found within [`ALIGN_BUDGET`] attempts.
pub(super) fn replaced_spans(region: &str, whole: &str) -> Option<Vec<(usize, usize)>> {
    let mut choices: Vec<Choice> = Vec::new();
    let mut budget = ALIGN_BUDGET;
    let (mut raw, mut out) = (0, 0);
    loop {
        let aligned = match align_literal(region, whole, raw, out) {
            Literal::Done(aligned) => aligned,
            Literal::Placeholder(at, after) => {
                raw = at;
                let literal_end = whole[after..]
                    .find(PLACEHOLDER)
                    .map_or(whole.len(), |offset| after + offset);
                // A placeholder replaces at least one character.
                let from = raw + region[raw..].chars().next().map_or(1, char::len_utf8);
                match next_end(region, whole, from, after, literal_end) {
                    Some(end) => {
                        choices.push(Choice {
                            raw,
                            end,
                            after,
                            literal_end,
                        });
                        (raw, out) = (end, after);
                        continue;
                    }
                    None => false,
                }
            }
        };
        if aligned {
            return Some(
                choices
                    .iter()
                    .map(|choice| (choice.raw, choice.end))
                    .collect(),
            );
        }
        // Move the latest span end that still has another occurrence.
        loop {
            let choice = choices.pop()?;
            budget = budget.checked_sub(1)?;
            let from = choice.end
                + region[choice.end..]
                    .chars()
                    .next()
                    .map_or(1, char::len_utf8);
            if let Some(end) = next_end(region, whole, from, choice.after, choice.literal_end) {
                (raw, out) = (end, choice.after);
                choices.push(Choice { end, ..choice });
                break;
            }
        }
    }
}

enum Literal {
    /// The alignment reached the end of `whole`: whether `region` ended too.
    Done(bool),
    /// A placeholder run replaces `region` from the first offset; the
    /// literal after it starts at the second offset of `whole`.
    Placeholder(usize, usize),
}

/// Compare unchanged text from `region[raw..]` and `whole[out..]` up to the
/// next placeholder run.
fn align_literal(region: &str, whole: &str, mut raw: usize, mut out: usize) -> Literal {
    while out < whole.len() {
        let rest = &whole[out..];
        let placeholder = rest.starts_with(PLACEHOLDER);
        if raw < region.len() && region[raw..].chars().next() == rest.chars().next() {
            // A literal `[REDACTED` in the raw text stays literal.
            if !placeholder || region[raw..].starts_with(PLACEHOLDER) {
                let width = rest.chars().next().map_or(1, char::len_utf8);
                raw += width;
                out += width;
                continue;
            }
        }
        if !placeholder {
            return Literal::Done(false);
        }
        // Adjacent placeholders are one replaced run.
        let mut after = out;
        while whole[after..].starts_with(PLACEHOLDER) {
            let Some(close) = whole[after..].find(']') else {
                return Literal::Done(false);
            };
            after += close + 1;
        }
        return Literal::Placeholder(raw, after);
    }
    Literal::Done(raw == region.len())
}

/// The first span end at or after `from` where the literal
/// `whole[after..literal_end]` occurs in `region`. The last literal must end
/// the region.
fn next_end(
    region: &str,
    whole: &str,
    from: usize,
    after: usize,
    literal_end: usize,
) -> Option<usize> {
    let literal = &whole[after..literal_end];
    if literal_end == whole.len() {
        let end = region.len().checked_sub(literal.len())?;
        return (end >= from && region.get(end..) == Some(literal)).then_some(end);
    }
    Some(from + region.get(from..)?.find(literal)?)
}
