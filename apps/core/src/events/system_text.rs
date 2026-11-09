//! Localizes Core's system notifications at publish time.
//!
//! The server call sites (app installed or updated, imports, delegated agents)
//! pass English title and body text to
//! [`publish_system_notification`](super::publish_system_notification). This
//! module recognizes that text against the English sources in
//! `i18n::messages::notifications`, recovers the arguments, and renders the
//! node's `ui-language` (the desktop on this node draws the OS banner and the
//! in-app toast, as for policy alerts). Text it does not recognize is
//! published unchanged.

use crate::i18n::messages::{
    NOTIFY_AGENTS_COMPLETED_MESSAGE, NOTIFY_AGENTS_COMPLETED_ONE_MESSAGE,
    NOTIFY_AGENTS_FINISHED_ISSUES_TITLE_MESSAGE, NOTIFY_AGENTS_FINISHED_TITLE_MESSAGE,
    NOTIFY_APP_INSTALLED_MESSAGE, NOTIFY_APP_INSTALLED_TITLE_MESSAGE,
    NOTIFY_APP_INSTALLED_VERSION_MESSAGE, NOTIFY_APP_UPDATED_MESSAGE,
    NOTIFY_APP_UPDATED_TITLE_MESSAGE, NOTIFY_CHATS_IMPORTED_EXPORT_MESSAGE,
    NOTIFY_CHATS_IMPORTED_PROJECT_MESSAGE, NOTIFY_CHATS_IMPORTED_TITLE_MESSAGE,
    NOTIFY_IMPORT_COMPLETE_MESSAGE, NOTIFY_IMPORT_COMPLETE_TITLE_MESSAGE,
    NOTIFY_THREAD_IMPORTED_MESSAGE, NOTIFY_THREAD_IMPORTED_TITLE_MESSAGE,
    NOTIFY_THREAD_SYNCED_MESSAGE, NOTIFY_THREAD_SYNCED_ONE_MESSAGE,
    NOTIFY_THREAD_SYNCED_TITLE_MESSAGE,
};
use crate::i18n::{AlertText, Join, Message, Template};

/// Placeholders that hold counts: they match digits only and render with the
/// locale's number format.
const COUNT_ARGS: &[&str] = &[
    "count",
    "imported",
    "skipped",
    "failed",
    "created",
    "updated",
    "completed",
    "total",
];

/// A body sentence, the form used when one count is 1, and the call-site
/// English when it differs from the cataloged source.
struct Body {
    other: Template,
    one: Option<(Template, &'static str)>,
    call_site: Option<&'static str>,
}

const fn body(other: Template) -> Body {
    Body {
        other,
        one: None,
        call_site: None,
    }
}

const fn reworded(other: Template, call_site: &'static str) -> Body {
    Body {
        other,
        one: None,
        call_site: Some(call_site),
    }
}

/// Each known title with the body sentences that go with it.
fn known() -> [(Template, Vec<Body>); 7] {
    [
        (
            NOTIFY_APP_UPDATED_TITLE_MESSAGE,
            vec![body(NOTIFY_APP_UPDATED_MESSAGE)],
        ),
        (
            NOTIFY_APP_INSTALLED_TITLE_MESSAGE,
            vec![
                body(NOTIFY_APP_INSTALLED_VERSION_MESSAGE),
                body(NOTIFY_APP_INSTALLED_MESSAGE),
            ],
        ),
        (
            NOTIFY_THREAD_SYNCED_TITLE_MESSAGE,
            vec![Body {
                other: NOTIFY_THREAD_SYNCED_MESSAGE,
                one: Some((NOTIFY_THREAD_SYNCED_ONE_MESSAGE, "count")),
                call_site: None,
            }],
        ),
        (
            NOTIFY_THREAD_IMPORTED_TITLE_MESSAGE,
            vec![reworded(
                NOTIFY_THREAD_IMPORTED_MESSAGE,
                "{thread} is ready from {engine}.",
            )],
        ),
        (
            NOTIFY_IMPORT_COMPLETE_TITLE_MESSAGE,
            vec![body(NOTIFY_IMPORT_COMPLETE_MESSAGE)],
        ),
        (
            NOTIFY_CHATS_IMPORTED_TITLE_MESSAGE,
            // The project sentence first: its name may contain " chats: ".
            vec![
                body(NOTIFY_CHATS_IMPORTED_PROJECT_MESSAGE),
                body(NOTIFY_CHATS_IMPORTED_EXPORT_MESSAGE),
            ],
        ),
        (
            NOTIFY_AGENTS_FINISHED_TITLE_MESSAGE,
            vec![Body {
                other: NOTIFY_AGENTS_COMPLETED_MESSAGE,
                one: Some((NOTIFY_AGENTS_COMPLETED_ONE_MESSAGE, "total")),
                call_site: None,
            }],
        ),
    ]
}

/// The issues title shares the plain title's body sentences.
fn bodies_for(title: &str) -> Option<(Template, Vec<Body>)> {
    if title == source(NOTIFY_AGENTS_FINISHED_ISSUES_TITLE_MESSAGE) {
        let (_, bodies) = known().into_iter().last()?;
        return Some((NOTIFY_AGENTS_FINISHED_ISSUES_TITLE_MESSAGE, bodies));
    }
    known()
        .into_iter()
        .find(|(template, _)| source(*template) == title)
}

/// The localizable form of a system notification, or `None` when the title
/// and body are not one of the known English sentences.
pub(super) fn localize(title: &str, body: &str) -> Option<AlertText> {
    let (title_template, bodies) = bodies_for(title)?;
    bodies.iter().find_map(|candidate| {
        let pattern = candidate
            .call_site
            .map_or_else(|| source(candidate.other), str::to_owned);
        let captures = capture(&pattern, body)?;
        let template = match candidate.one {
            Some((one, name))
                if captures
                    .iter()
                    .any(|(arg, value)| *arg == name && value == "1") =>
            {
                one
            }
            _ => candidate.other,
        };
        let mut message = Message::new(template);
        for (name, value) in captures {
            message = match value.parse::<u64>() {
                Ok(count) if COUNT_ARGS.contains(&name.as_str()) => {
                    message.number(&name, count as f64, 0, 0)
                }
                _ => message.text(&name, value),
            };
        }
        Some(AlertText::new(
            Message::new(title_template),
            vec![message],
            Join::Sentences,
        ))
    })
}

/// A template's English source, with `{name}` placeholders.
fn source(template: Template) -> String {
    template(&|name| format!("{{{name}}}"))
}

enum Part {
    Literal(String),
    Arg(String),
}

fn parts(source: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut rest = source;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|offset| open + offset) else {
            break;
        };
        if open > 0 {
            parts.push(Part::Literal(rest[..open].to_owned()));
        }
        parts.push(Part::Arg(rest[open + 1..close].to_owned()));
        rest = &rest[close + 1..];
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest.to_owned()));
    }
    parts
}

/// The placeholder values that turn `source` into `text`. A text value takes
/// the longest span that still lets the rest match (an app name may contain
/// spaces); a count must be digits.
fn capture(source: &str, text: &str) -> Option<Vec<(String, String)>> {
    let parts = parts(source);
    let mut out = Vec::new();
    capture_from(&parts, text, &mut out).then_some(out)
}

fn capture_from(parts: &[Part], text: &str, out: &mut Vec<(String, String)>) -> bool {
    match parts {
        [] => text.is_empty(),
        [Part::Literal(literal), rest @ ..] => text
            .strip_prefix(literal.as_str())
            .is_some_and(|tail| capture_from(rest, tail, out)),
        [Part::Arg(name), rest @ ..] => {
            let is_count = COUNT_ARGS.contains(&name.as_str());
            let is_version = name == "version";
            let ends: Vec<usize> = match rest.first() {
                None => vec![text.len()],
                Some(Part::Literal(next)) => text
                    .match_indices(next.as_str())
                    .map(|(index, _)| index)
                    .collect(),
                // Two adjacent placeholders cannot be split apart.
                Some(Part::Arg(_)) => return false,
            };
            for end in ends.into_iter().rev() {
                let value = &text[..end];
                let valid = !value.is_empty()
                    && (!is_count || value.bytes().all(|byte| byte.is_ascii_digit()))
                    && (!is_version || looks_like_version(value));
                if !valid {
                    continue;
                }
                let mark = out.len();
                out.push((name.clone(), value.to_owned()));
                if capture_from(rest, &text[end..], out) {
                    return true;
                }
                out.truncate(mark);
            }
            false
        }
    }
}

/// A version is one token that starts with a digit (`1.2.0`, `2026.10`), or
/// `v` and a digit, so the last word of a spaced app name ("My Big App") is not
/// read as its version.
fn looks_like_version(value: &str) -> bool {
    let digits = value.strip_prefix(['v', 'V']).unwrap_or(value);
    digits.starts_with(|c: char| c.is_ascii_digit()) && !value.contains(char::is_whitespace)
}

#[cfg(test)]
#[path = "system_text_tests.rs"]
mod tests;
