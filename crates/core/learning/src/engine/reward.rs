//! Reading a reward in `[0,1]` out of the PRM judge's free-text answer.
//!
//! The judge reads attacker-reachable conversation text, so its answer is
//! treated as untrusted: an empty answer or a refusal is never a reward, and a
//! stray integer in prose is never read as a percentage. Only a decimal already
//! in `[0,1]`, or a reply that is nothing but a bare percentage, scores. A row
//! with no reward stays unscored and can never enter the training set.

/// Phrases that mark the judge declining to grade. Matched case-insensitively
/// on the reply with typographic apostrophes folded to `'`.
const REFUSAL_MARKERS: &[&str] = &[
    "i can't",
    "i cannot",
    "i can not",
    "i won't",
    "i will not",
    "i'm unable",
    "i am unable",
    "i'm not able",
    "i am not able",
    "i'm sorry",
    "i am sorry",
    "sorry, but",
    "i apologize",
    "i must decline",
    "i decline",
    "i refuse",
    "as an ai",
    "unable to evaluate",
    "unable to rate",
    "unable to score",
    "unable to assist",
    "unable to comply",
    "can't help",
    "cannot help",
    "can't assist",
    "cannot assist",
    "can't comply",
    "cannot comply",
    "not able to help",
    "against my guidelines",
    "against my policy",
    "against my policies",
];

/// Extract a reward in `[0,1]` from a judge's free-text answer, or `None` when
/// the answer carries no trustworthy score.
///
/// - Empty or whitespace-only replies, and replies that read as a refusal, are
///   `None`: a refusal ("I can't rate this, it is 100% against policy") must
///   never turn into a reward.
/// - A reply that is entirely `^(score:\s*)?\d{1,3}%?$` (case-insensitive) is a
///   bare percentage: `0` and `1` are read as-is, `2..=100` are divided by 100,
///   and anything above 100 is off-scale (`None`).
/// - Otherwise the reply must name exactly one decimal in `[0,1]` (for `0.8/1.0`
///   that is the numerator, and for "handles 2 edge cases, I rate it 0.9" the
///   leading integer is skipped). Two different decimals in range, or a
///   negative one, are no verdict. Integers in prose are never percentages.
pub fn parse_reward(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() || looks_like_refusal(trimmed) {
        return None;
    }
    if let Some(percent) = bare_percentage(trimmed) {
        return percent;
    }
    first_unit_decimal(trimmed)
}

/// Whether the reply reads as the judge declining to grade.
fn looks_like_refusal(text: &str) -> bool {
    let folded = text.to_lowercase().replace(
        [
            '\u{2019}', '\u{2018}', '\u{02BC}', '\u{FF07}', '\u{2032}', '`',
        ],
        "'",
    );
    REFUSAL_MARKERS.iter().any(|marker| folded.contains(marker))
}

/// `Some(reward)` when the whole reply is a bare percentage, `Some(None)` when
/// it has that shape but is off-scale, and `None` when it is not that shape.
/// With a `%` sign the value is always a percentage (`1%` is `0.01`); without
/// one, `0` and `1` are already on the unit scale.
fn bare_percentage(text: &str) -> Option<Option<f64>> {
    let mut rest = text;
    if rest.len() >= 6 && rest.is_char_boundary(6) && rest[..6].eq_ignore_ascii_case("score:") {
        rest = rest[6..].trim_start();
    }
    let (digits, percent_sign) = match rest.strip_suffix('%') {
        Some(digits) => (digits, true),
        None => (rest, false),
    };
    if digits.is_empty() || digits.len() > 3 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    Some(match value {
        v if v <= 1.0 && !percent_sign => Some(v),
        v if v <= 100.0 => Some(v / 100.0),
        _ => None,
    })
}

/// A numeric token with a decimal point and a fractional digit.
struct DecimalToken {
    value: f64,
    /// Written with a leading minus sign (`-0.4`).
    negative: bool,
    /// The denominator of a fraction (`/1.0` in `0.8/1.0`).
    denominator: bool,
}

/// The decimal score in `[0,1]` the reply gives, or `None` when it gives none
/// or more than one. A judge that names two different scores ("the reply
/// claims 1.0, I'd say 0.3") or a negative one (`-0.4` must not read as `0.4`)
/// has no single trustworthy verdict. Denominators (`0.8/1.0`) are not scores.
fn first_unit_decimal(text: &str) -> Option<f64> {
    let mut score: Option<f64> = None;
    for token in decimal_tokens(text) {
        if token.denominator || !(0.0..=1.0).contains(&token.value) {
            continue;
        }
        if token.negative {
            return None;
        }
        match score {
            Some(seen) if (seen - token.value).abs() > f64::EPSILON => return None,
            _ => score = Some(token.value),
        }
    }
    score
}

/// Every decimal token in `text`, with the sign and fraction context needed to
/// tell a score from a negative number or a denominator.
fn decimal_tokens(text: &str) -> Vec<DecimalToken> {
    let mut tokens = Vec::new();
    let mut num = String::new();
    let mut had_dot = false;
    // The last non-whitespace character before the current token began.
    let mut before_token: Option<char> = None;
    let mut last_non_space: Option<char> = None;
    let mut flush = |num: &mut String, had_dot: &mut bool, before: Option<char>| {
        // A trailing dot ends a sentence ("Step 1."), it is not a decimal.
        if *had_dot && !num.ends_with('.') {
            if let Ok(value) = num.parse::<f64>() {
                tokens.push(DecimalToken {
                    value,
                    negative: matches!(before, Some('-' | '\u{2212}')),
                    denominator: before == Some('/'),
                });
            }
        }
        num.clear();
        *had_dot = false;
    };
    for c in text.chars() {
        let continues = c.is_ascii_digit() || (c == '.' && !had_dot);
        if continues {
            if num.is_empty() {
                before_token = last_non_space;
            }
            num.push(c);
            had_dot |= c == '.';
        } else {
            flush(&mut num, &mut had_dot, before_token);
        }
        if !c.is_whitespace() {
            last_non_space = Some(c);
        }
    }
    flush(&mut num, &mut had_dot, before_token);
    tokens
}
