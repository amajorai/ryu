//! Which language model-written background text is written in.
//!
//! Some text a model writes in the background reaches the user verbatim: a
//! Connect suggestion in the inbox, a Mission Control session summary, a Quests
//! verdict. No catalog or DOM localizer can translate model output, so the
//! prompt itself has to name the language. That language is the node's
//! `ui-language` ([`super::locale::node_locale`]): the user reads this text in
//! the app's own surfaces, next to the translated UI.
//!
//! Text that follows its *content* (a News brief follows its headlines, a chat
//! title follows the conversation) does not use this; its prompt says "the same
//! language as …" instead.
//!
//! The instruction is English prompt scaffolding, not user-facing copy, so it is
//! not a catalog message. Machine-parsed parts of a reply (JSON keys, `MET:` /
//! `REASON:` labels, sentinels such as `NO_SUGGESTION`) stay in English: each
//! instruction says so.
//!
//! Satellites reach this through the host completion seam: a
//! `host.sideModel` call (`POST /api/host/model/complete`, `/api/host/rpc`
//! `model.complete`, or the turn-hook sandbox) that passes
//! `"reply_language": "ui"` gets the line appended to its system prompt
//! ([`apply_to_side_model_args`]). The field is opt-in because many side-model
//! callers return machine output (classifications, JSON for code) where a
//! language instruction would only add risk.

use serde_json::Value;

use super::locale;

/// The `host.sideModel` argument that opts a call into the UI language.
pub const REPLY_LANGUAGE_ARG: &str = "reply_language";

/// The value of [`REPLY_LANGUAGE_ARG`] that means "the node's UI language".
pub const UI_LANGUAGE: &str = "ui";

/// `host.sideModel`'s system prompt when the caller passes none. Mirrors the
/// default in `plugin_host::bridge`, so appending a language line to an absent
/// system prompt keeps the same base instruction.
const DEFAULT_SYSTEM: &str = "You are a careful assistant.";

/// English names of the catalog locales, as a model is most reliably told them.
const LANGUAGE_NAMES: &[(&str, &str)] = &[
    ("ar", "Arabic"),
    ("de", "German"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("it", "Italian"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("pt-BR", "Brazilian Portuguese"),
    ("ru", "Russian"),
    ("zh-CN", "Simplified Chinese"),
];

/// The English name of the catalog language a locale tag resolves to
/// (`ja-JP` is `Japanese`; an unsupported tag is `English`).
pub fn english_language_name(tag: &str) -> &'static str {
    let resolved = locale::resolve(tag);
    LANGUAGE_NAMES
        .iter()
        .find(|(code, _)| *code == resolved)
        .map_or("English", |(_, name)| name)
}

/// The prompt line asking for prose in `tag`'s language, or `None` for English
/// (the prompts are already English, so they stay exactly as they were).
pub fn reply_language_instruction(tag: &str) -> Option<String> {
    let name = english_language_name(tag);
    (name != "English").then(|| {
        format!(
            "Write every sentence meant for the user in {name}. Keep JSON keys, field \
             names, labels and fixed keywords the instructions specify exactly as given, in \
             English."
        )
    })
}

/// Pure half of [`apply_to_side_model_args`]: append the instruction for
/// `node_locale` to the system prompt when `args` opts in. A tag in place of
/// `"ui"` names the language explicitly. The opt-in field is removed either
/// way, so the bridge sees only the arguments it already knows.
pub fn with_reply_language(mut args: Value, node_locale: &str) -> Value {
    let Some(map) = args.as_object_mut() else {
        return args;
    };
    let Some(requested) = map.remove(REPLY_LANGUAGE_ARG) else {
        return args;
    };
    let tag = match requested.as_str().map(str::trim) {
        Some(UI_LANGUAGE) => node_locale,
        Some(tag) if !tag.is_empty() => tag,
        _ => return args,
    };
    let Some(instruction) = reply_language_instruction(tag) else {
        return args;
    };
    let system = map
        .get("system")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_SYSTEM);
    let system = format!("{}\n\n{instruction}", system.trim_end());
    map.insert("system".to_owned(), Value::String(system));
    args
}

/// Apply a `host.sideModel` call's `"reply_language"` opt-in. Reads the node's
/// `ui-language` only when the call asks for it.
pub async fn apply_to_side_model_args(args: Value) -> Value {
    let wants_ui = args
        .get(REPLY_LANGUAGE_ARG)
        .and_then(Value::as_str)
        .is_some_and(|value| value.trim() == UI_LANGUAGE);
    let node_locale = if wants_ui {
        locale::node_locale().await
    } else {
        "en"
    };
    with_reply_language(args, node_locale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_follow_the_resolved_catalog_locale() {
        assert_eq!(english_language_name("ja"), "Japanese");
        assert_eq!(english_language_name("ja-JP"), "Japanese");
        assert_eq!(english_language_name("pt-PT"), "Brazilian Portuguese");
        assert_eq!(english_language_name("zh-TW"), "English");
        assert_eq!(english_language_name("xx"), "English");
    }

    #[test]
    fn english_adds_no_instruction() {
        assert_eq!(reply_language_instruction("en"), None);
        assert_eq!(reply_language_instruction("en-GB"), None);
        let ja = reply_language_instruction("ja").unwrap();
        assert!(ja.contains("Japanese"));
        assert!(ja.contains("JSON keys"));
    }

    #[test]
    fn only_an_opted_in_call_gets_the_line() {
        let plain = json!({ "system": "Base.", "prompt": "p" });
        assert_eq!(with_reply_language(plain.clone(), "ja"), plain);

        let opted = json!({ "system": "Base.", "prompt": "p", "reply_language": "ui" });
        let out = with_reply_language(opted, "de");
        assert!(out.get(REPLY_LANGUAGE_ARG).is_none());
        let system = out["system"].as_str().unwrap();
        assert!(system.starts_with("Base.\n\n"));
        assert!(system.contains("German"));
        assert_eq!(out["prompt"], "p");
    }

    #[test]
    fn an_absent_system_prompt_keeps_the_bridge_default() {
        let out = with_reply_language(json!({ "prompt": "p", "reply_language": "ui" }), "ko");
        let system = out["system"].as_str().unwrap();
        assert!(system.starts_with(DEFAULT_SYSTEM));
        assert!(system.contains("Korean"));
    }

    #[test]
    fn english_and_explicit_tags() {
        let english = with_reply_language(json!({ "prompt": "p", "reply_language": "ui" }), "en");
        assert_eq!(english, json!({ "prompt": "p" }));
        let explicit = with_reply_language(
            json!({ "system": "S", "prompt": "p", "reply_language": "fr-CA" }),
            "en",
        );
        assert!(explicit["system"].as_str().unwrap().contains("French"));
        let junk = with_reply_language(json!({ "prompt": "p", "reply_language": 3 }), "ja");
        assert_eq!(junk, json!({ "prompt": "p" }));
    }
}
