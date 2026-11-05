//! Config-gated `sanitize` and the unconditional outbound secret scrubber.

use std::borrow::Cow;

use regex::Regex;
use ryu_gw_firewall::{ascii_boundaries_agree, is_credit_card_number, is_public_ipv4};

use super::FirewallScanner;

/// The rewritten text, or `None` when `replace_all` matched nothing (it
/// returns the input borrowed exactly then), so the caller keeps its string
/// instead of copying it.
fn owned(out: Cow<'_, str>) -> Option<String> {
    match out {
        Cow::Owned(text) => Some(text),
        Cow::Borrowed(_) => None,
    }
}

/// `replace_all` with a validating closure, written as a `find_iter` splice:
/// each match becomes `placeholder` when `valid` accepts it and stays as it is
/// otherwise. `None` when nothing matched. `replace_all` with a closure walks
/// `captures_iter`, whose whole-match spans are the `find_iter` spans, and
/// splices the same way.
fn splice_valid(
    re: &Regex,
    text: &str,
    placeholder: &str,
    valid: fn(&str) -> bool,
) -> Option<String> {
    let mut out: Option<String> = None;
    let mut last = 0;
    for found in re.find_iter(text) {
        let buf = out.get_or_insert_with(|| String::with_capacity(text.len()));
        buf.push_str(&text[last..found.start()]);
        buf.push_str(if valid(found.as_str()) {
            placeholder
        } else {
            found.as_str()
        });
        last = found.end();
    }
    out.map(|mut buf| {
        buf.push_str(&text[last..]);
        buf
    })
}

/// The regex to run: the pattern's ASCII-boundary twin when the text passes
/// [`ascii_boundaries_agree`] (the twin then finds exactly the original's
/// matches, and stays on the regex crate's lazy DFA, where a Unicode `\b`
/// on non-ASCII text falls back to a slower engine), otherwise the original.
fn pick<'a>(original: &'a Regex, twin: &'a Option<Regex>, agree: bool) -> &'a Regex {
    match twin {
        Some(twin) if agree => twin,
        _ => original,
    }
}

impl FirewallScanner {
    /// Sanitize text by replacing matched patterns with a placeholder.
    ///
    /// Which categories are redacted is governed by `FirewallConfig.redact_pii`
    /// and `FirewallConfig.redact_secrets`. Both default to `true`, preserving
    /// the previous behaviour. Set either to `false` to suppress that category
    /// independently of the Sanitize policy decision.
    pub fn sanitize(&self, text: &str) -> String {
        let mut result = text.to_string();

        if self.config.redact_pii {
            // A rewrite keeps the gate when its placeholder is ASCII: the text
            // then still holds only ASCII and the input's private-use characters.
            let mut agree = ascii_boundaries_agree(text);
            let patterns = self.pii_patterns.iter().zip(&self.pii_placeholders);
            for (((name, original), placeholder), twin) in patterns.zip(&self.pii_twins) {
                let re = pick(original, twin, agree);
                // The separator-tolerant / range-based kinds redact only genuine
                // matches (Luhn-valid cards, public IPs) so Sanitize does not
                // scrub arbitrary long digit runs or benign private/subnet IPs.
                let next = match name.as_str() {
                    "credit_card" => splice_valid(re, &result, placeholder, is_credit_card_number),
                    "ipv4" => splice_valid(re, &result, placeholder, is_public_ipv4),
                    _ => owned(re.replace_all(&result, placeholder.as_str())),
                };
                if let Some(next) = next {
                    agree &= placeholder.is_ascii();
                    result = next;
                }
            }
        }

        if self.config.redact_secrets {
            for ((_, re), placeholder) in self.secret_patterns.iter().zip(&self.secret_placeholders)
            {
                let next = owned(re.replace_all(&result, placeholder.as_str()));
                if let Some(next) = next {
                    result = next;
                }
            }
        }

        result
    }

    /// Redact secret-like tokens from outbound response/log/error text.
    ///
    /// The scrub reads no config: it ignores `enabled`, `scan_outbound`,
    /// `redact_pii` and `redact_secrets` (`sanitize` honours the last two), and
    /// custom patterns never join it. Callers decide whether it runs: the
    /// OpenAI-compatible chat pipeline (`apply_outbound_json_dlp`,
    /// `apply_outbound_firewall_stream`) applies it to every chat, Messages,
    /// Responses and multimodal reply, streamed or not, and to audit, violation
    /// and error text, whatever the firewall config. Embeddings and rerank
    /// replies do not pass through it. The passthrough's response redactor runs
    /// only when the passthrough's resolved scanner is `enabled`.
    ///
    /// Each pattern, in order, replaces its matches in the previous pattern's
    /// output with a STABLE marker (e.g. `[REDACTED:gh_pat]`), so a secret shape
    /// always gets the same placeholder. Also returns the marker of each pattern
    /// that matched, in pattern order (one entry per pattern, so `gh_pat` can
    /// repeat); production callers currently discard it.
    pub fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        let mut agree = ascii_boundaries_agree(text);
        // Until a pattern hits, the text is unchanged and `agree` holds, so
        // pattern i runs exactly as set member i: a set miss means none hits.
        let gated = self
            .outbound_agree
            .filter(|set| set.len() == self.outbound_patterns.len());
        if agree && gated.is_some_and(|set| !set.is_match(text)) {
            debug_assert!(self
                .outbound_patterns
                .iter()
                .zip(&self.outbound_twins)
                .all(|((_, original), twin)| !pick(original, twin, true).is_match(text)));
            return (text.to_string(), Vec::new());
        }
        let mut result = text.to_string();
        let mut hits: Vec<&'static str> = Vec::new();
        let patterns = self
            .outbound_patterns
            .iter()
            .zip(&self.outbound_placeholders);
        for (((marker, original), placeholder), twin) in patterns.zip(&self.outbound_twins) {
            let re = pick(original, twin, agree);
            // `replace_all` borrows its input exactly when nothing matched,
            // so this one pass decides the hit `is_match` used to.
            let next = owned(re.replace_all(&result, placeholder.as_str()));
            debug_assert_eq!(next.is_some(), re.is_match(&result));
            if let Some(next) = next {
                hits.push(*marker);
                agree &= placeholder.is_ascii();
                result = next;
            }
        }
        (result, hits)
    }
}

#[cfg(test)]
#[path = "redaction_test.rs"]
mod tests;
