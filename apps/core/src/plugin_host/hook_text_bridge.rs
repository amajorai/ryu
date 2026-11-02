//! `host.t(source, values)`: render a plugin's English ICU sentence through
//! Core's official catalog, the same renderer approval prompts and localized
//! notifications use.
//!
//! The source is the catalog key (`"Goal met. {verdict}"`); `values` fill its
//! `{name}` placeholders. A sentence the catalog has no translation for (a
//! third-party plugin's own copy, or a locale not shipped yet) comes back as
//! the English source with its values filled in, so a hook never shows a
//! broken or empty message.

use serde_json::{json, Map, Value};

use crate::i18n::{locale, Message};
use crate::tool_exec::InvokeOutcome;

use super::{err, ok};

/// Most placeholder values one call may pass (the renderer's own cap).
const MAX_VALUES: usize = 16;

/// Stand-in markers for text values. The catalog renderer clips a text
/// argument to its wire cap, but a hook frames model output of any length
/// ("Advisor: {advice}"), so each string renders as a marker that is swapped
/// for the full value afterwards.
const MARK_OPEN: char = '\u{E000}';
const MARK_CLOSE: char = '\u{E001}';

/// The wire form of one value: strings as a marker into `texts`, numbers with
/// the locale's separators (up to three decimals), anything else as its JSON
/// text.
fn wire_value(value: &Value, texts: &mut Vec<String>) -> Value {
    let text = match value {
        Value::Number(number) if number.is_i64() || number.is_u64() => return value.clone(),
        Value::Number(_) => return json!({ "number": value, "max_fraction": 3 }),
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        other => other.to_string(),
    };
    texts.push(text);
    Value::String(format!("{MARK_OPEN}{}{MARK_CLOSE}", texts.len() - 1))
}

/// Swap every marker in `rendered` for its full text value, in one pass so a
/// value is never itself scanned for markers.
fn restore_texts(rendered: &str, texts: &[String]) -> String {
    let mut out = String::with_capacity(rendered.len());
    let mut rest = rendered;
    while let Some(start) = rest.find(MARK_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + MARK_OPEN.len_utf8()..];
        let value = after.find(MARK_CLOSE).and_then(|end| {
            let text = after[..end]
                .parse::<usize>()
                .ok()
                .and_then(|i| texts.get(i))?;
            Some((text, end))
        });
        match value {
            Some((text, end)) => {
                out.push_str(text);
                rest = &after[end + MARK_CLOSE.len_utf8()..];
            }
            None => {
                out.push(MARK_OPEN);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Render `source` with `values` for `locale` (any tag; unsupported ones fall
/// back to English). A source the renderer refuses (empty or over its length
/// cap) is returned unchanged.
pub(super) fn render_hook_text(source: &str, values: Option<&Value>, locale: &str) -> String {
    let mut texts = Vec::new();
    let args: Map<String, Value> = values
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .take(MAX_VALUES)
                .map(|(name, value)| (name.clone(), wire_value(value, &mut texts)))
                .collect()
        })
        .unwrap_or_default();
    match Message::from_wire(&json!({ "message": source, "args": args })) {
        Some(message) => restore_texts(&message.render(locale), &texts),
        None => source.to_owned(),
    }
}

/// `host.t({ source, values, locale })`. The facade passes `ctx.locale`, the
/// node language Core resolved when it built the hook program; without it the
/// node language is resolved here.
pub(super) async fn translate(args: Value) -> InvokeOutcome {
    let Some(source) = args.get("source").and_then(Value::as_str) else {
        return err("host.t requires a 'source' string".to_owned());
    };
    let locale = match args.get("locale").and_then(Value::as_str) {
        Some(tag) if !tag.trim().is_empty() => locale::resolve(tag),
        _ => locale::node_locale().await,
    };
    ok(Value::String(render_hook_text(
        source,
        args.get("values"),
        locale,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sentence that ships in the Core catalog with a Japanese translation.
    fn catalogued_source() -> &'static str {
        "An agent wants to reply to {recipients}."
    }

    #[tokio::test]
    async fn host_t_returns_the_ja_rendering_when_the_node_locale_is_ja() {
        let english = render_hook_text(
            catalogued_source(),
            Some(&json!({ "recipients": "Ana" })),
            "en",
        );
        assert_eq!(english, "An agent wants to reply to Ana.");
        let outcome = translate(json!({
            "source": catalogued_source(),
            "values": { "recipients": "Ana" },
            "locale": "ja",
        }))
        .await;
        let InvokeOutcome::Result(result) = outcome else {
            panic!("host.t must not suspend");
        };
        assert!(!result.is_error);
        let japanese = result.value.as_str().expect("a rendered string");
        assert_ne!(japanese, english, "ja must use the catalog translation");
        assert!(japanese.contains("Ana"));
    }

    #[test]
    fn a_missing_key_returns_the_english_source_with_values_filled() {
        assert_eq!(
            render_hook_text(
                "Tool Firewall blocked {name} for this chat.",
                Some(&json!({ "name": "rm", "extra": true })),
                "ja",
            ),
            "Tool Firewall blocked rm for this chat."
        );
        assert_eq!(
            render_hook_text("Goal cleared.", None, "de"),
            "Goal cleared."
        );
    }

    #[test]
    fn values_of_any_json_type_render_instead_of_failing_the_message() {
        assert_eq!(
            render_hook_text(
                "{a} {b} {c} {d}",
                Some(&json!({ "a": 2.5, "b": null, "c": false, "d": [1] })),
                "en",
            ),
            "2.5  false [1]"
        );
    }

    #[test]
    fn long_text_values_are_not_clipped_and_repeat_wherever_the_pattern_uses_them() {
        let advice = "a".repeat(5_000);
        let rendered = render_hook_text(
            "Advisor: {advice}",
            Some(&json!({ "advice": advice })),
            "ja",
        );
        assert_eq!(rendered, format!("Advisor: {advice}"));
        assert_eq!(
            render_hook_text(
                "{a}-{b}-{a}",
                Some(&json!({ "a": "x\u{E000}9\u{E001}", "b": 3 })),
                "en"
            ),
            "x\u{E000}9\u{E001}-3-x\u{E000}9\u{E001}"
        );
    }

    #[test]
    fn an_unrenderable_source_comes_back_unchanged() {
        assert_eq!(render_hook_text("", None, "ja"), "");
        let long = "x".repeat(5_000);
        assert_eq!(render_hook_text(&long, None, "ja"), long);
        assert_eq!(render_hook_text("Hi {name}", None, "en"), "Hi {name}");
    }
}
