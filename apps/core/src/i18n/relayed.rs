//! Relayed text: an error a satellite's worker or resolver raised and the app
//! relays as a notification body (`NotifyMessage::relayed` in
//! `ryu-app-events`, `"relay": true` on the wire).
//!
//! The text is often a sentence the i18n extractor already catalogued from the
//! satellite's own source ("dataset has no samples", "The web source returned
//! HTTP {status}."), and `tools/generate-core-i18n.mjs` copies those sentences
//! into Core's catalog. So Core looks the text up before showing it: first as
//! an exact sentence, then as a simple template whose `{placeholder}`s capture
//! the dynamic parts (a status code, an underlying error), which are inserted
//! verbatim. Text that matches nothing is shown as is, exactly as a verbatim
//! message would be.

use super::catalog;
use super::render::{substitute, Arg};

/// The wire source of a relayed (and of a verbatim) message.
pub(super) const SOURCE: &str = "{text}";

/// Fewest letters a template's literal text must have to match relayed text,
/// so a bare `{error}` or `{name}: {detail}` never claims every relay.
const MIN_TEMPLATE_LETTERS: usize = 6;

/// `text` in `locale` (already resolved), or `None` when the catalog has no
/// translation for it.
pub(super) fn render(text: &str, locale: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.contains(['{', '}']) {
        // Braces in the relayed text would be read as placeholders below.
        return None;
    }
    if let Some(pattern) = catalog::lookup(locale, text) {
        return substitute(pattern, locale, &[]);
    }
    let mut best: Option<(usize, &'static str, Vec<(String, Arg)>)> = None;
    for source in catalog::sources().filter(|source| source.contains('{')) {
        let Some(pattern) = catalog::lookup(locale, source) else {
            continue;
        };
        let Some(segments) = segments(source) else {
            continue;
        };
        let letters = literal_letters(&segments);
        if letters < MIN_TEMPLATE_LETTERS || best.as_ref().is_some_and(|(n, ..)| *n >= letters) {
            continue;
        }
        if let Some(captures) = capture(&segments, text) {
            let args = captures
                .into_iter()
                .map(|(name, value)| (name.to_owned(), Arg::Text(value.to_owned())))
                .collect();
            best = Some((letters, pattern, args));
        }
    }
    let (_, pattern, args) = best?;
    substitute(pattern, locale, &args)
}

/// One piece of a template: literal text, or a named placeholder.
#[derive(Debug, PartialEq)]
enum Segment {
    Literal(String),
    Placeholder(String),
}

/// Split an ICU source into segments, honouring ICU quoting (`''` is an
/// apostrophe, `'{…}'` is literal). `None` for a source this matcher cannot
/// use: nested or unbalanced braces (plural/select), or two placeholders side
/// by side, whose boundary the text cannot show.
fn segments(source: &str) -> Option<Vec<Segment>> {
    let mut out = Vec::new();
    let mut literal = String::new();
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => match chars.peek() {
                Some('\'') => {
                    chars.next();
                    literal.push('\'');
                }
                Some('{' | '}') => {
                    for quoted in chars.by_ref() {
                        if quoted == '\'' {
                            break;
                        }
                        literal.push(quoted);
                    }
                }
                _ => literal.push('\''),
            },
            '{' => {
                let mut name = String::new();
                loop {
                    match chars.next()? {
                        '}' => break,
                        ch if ch.is_alphanumeric() || ch == '_' => name.push(ch),
                        _ => return None,
                    }
                }
                if literal.is_empty() && matches!(out.last(), Some(Segment::Placeholder(_))) {
                    return None;
                }
                if !literal.is_empty() {
                    out.push(Segment::Literal(std::mem::take(&mut literal)));
                }
                out.push(Segment::Placeholder(name));
            }
            '}' => return None,
            other => literal.push(other),
        }
    }
    if !literal.is_empty() {
        out.push(Segment::Literal(literal));
    }
    Some(out)
}

fn literal_letters(segments: &[Segment]) -> usize {
    segments
        .iter()
        .map(|segment| match segment {
            Segment::Literal(text) => text.chars().filter(|c| c.is_alphabetic()).count(),
            Segment::Placeholder(_) => 0,
        })
        .sum()
}

/// The placeholder values that make `segments` spell `text` exactly, each one
/// non-empty. Earlier placeholders take the shortest value that lets the rest
/// match.
fn capture<'a, 't>(segments: &'a [Segment], text: &'t str) -> Option<Vec<(&'a str, &'t str)>> {
    match segments.split_first() {
        None => text.is_empty().then(Vec::new),
        Some((Segment::Literal(literal), rest)) => {
            capture(rest, text.strip_prefix(literal.as_str())?)
        }
        Some((Segment::Placeholder(name), [])) => {
            (!text.is_empty()).then(|| vec![(name.as_str(), text)])
        }
        Some((Segment::Placeholder(name), rest)) => {
            let Some(Segment::Literal(next)) = rest.first() else {
                return None;
            };
            for (at, _) in text.match_indices(next.as_str()).filter(|(at, _)| *at > 0) {
                if let Some(mut tail) = capture(rest, &text[at..]) {
                    tail.insert(0, (name.as_str(), &text[..at]));
                    return Some(tail);
                }
            }
            None
        }
    }
}

#[cfg(test)]
#[path = "relayed_tests.rs"]
mod tests;
