//! Built-in **in-chat feedback draft** (`feedback.draft`).
//!
//! When the user asks for something Ryu cannot do (an idea) or hits a defect in
//! Ryu itself (a bug), the agent drafts a report with this tool. The desktop
//! then draws an inline card in the chat: the user reads the draft, edits it,
//! sees exactly what the app would attach, and decides whether to send it.
//!
//! Like the consent tools, this is a **client-rendered, no-op** tool. Core sends
//! nothing anywhere from here. Dispatch only validates the shape and tells the
//! model to stop and wait for the user's reply, which arrives as a normal user
//! message.
//!
//! The model supplies only the title and the text. Versions, system, engine,
//! model and recent errors are collected by the app on the user's device, so a
//! prompt-injected call can neither forge them nor smuggle private data into
//! them.
//!
//! Registered as a reserved registry server (`feedback`) like `consent`, so the
//! `<server>.<tool>` id scheme, per-agent allowlist, and single `call_tool` entry
//! all work for free.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in feedback-draft provider.
pub const SERVER_NAME: &str = "feedback";

/// The two kinds of report the card knows how to show.
const KINDS: &[&str] = &["idea", "bug"];

/// Longest `title` accepted. The card shows it as one line.
const MAX_TITLE_CHARS: usize = 120;

/// Longest `body` accepted.
const MAX_BODY_CHARS: usize = 4000;

/// Longest optional bug detail (`steps`, `expected`, `actual`) accepted.
const MAX_DETAIL_CHARS: usize = 1000;

/// The optional bug details, in the order the card shows them.
const DETAIL_KEYS: &[&str] = &["steps", "expected", "actual"];

/// Returned to the model so it ends its turn instead of assuming the report
/// was sent.
const AWAITING_USER_NOTE: &str = "The draft is now shown to the user as a card in the chat. \
     Nothing has been sent. End your turn and wait: the user's choice arrives as their next \
     message. Do not say the report was sent and do not draft it again in the same turn.";

fn draft_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": KINDS,
                "description": "`idea` for something Ryu cannot do yet that the user wants. `bug` for a defect in Ryu itself, not in the user's own project or code."
            },
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_TITLE_CHARS,
                "description": "One short line naming the idea or the problem, in the user's language."
            },
            "body": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_BODY_CHARS,
                "description": "The report in the user's own voice and language: what they want and why, or what went wrong. Plain text. Leave out secrets, file contents and anything the user did not say."
            },
            "steps": {
                "type": "string",
                "maxLength": MAX_DETAIL_CHARS,
                "description": "Bugs only, optional: the steps that lead to the problem."
            },
            "expected": {
                "type": "string",
                "maxLength": MAX_DETAIL_CHARS,
                "description": "Bugs only, optional: what the user expected to happen."
            },
            "actual": {
                "type": "string",
                "maxLength": MAX_DETAIL_CHARS,
                "description": "Bugs only, optional: what happened instead."
            }
        },
        "required": ["kind", "title", "body"]
    })
}

/// The feedback tool exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}.draft"),
        server: SERVER_NAME.to_owned(),
        name: "draft".to_owned(),
        description: Some(
            "Draft an idea or a bug report about Ryu for the user to review. Shows an inline \
             card in the chat with your draft; the user can edit it, sees what the app would \
             attach (versions, system, model, recent errors), and decides whether to send it. \
             Use `kind: \"idea\"` when the user asks for something Ryu cannot do, and \
             `kind: \"bug\"` when Ryu itself misbehaves. Do not use it for problems in the \
             user's own project. Offer it at most once per conversation unless the user asks \
             again. You write only the title and the text: never add versions, paths, logs or \
             error output yourself, because the app attaches those. You cannot send anything \
             yourself.\n\n\
             After calling this, end your turn. The user's choice (sent, or not now) arrives \
             as their next message."
                .to_owned(),
        ),
        input_schema: Some(draft_schema()),
        ..Default::default()
    }]
}

/// A required, bounded, non-blank string argument.
fn required_text<'a>(arguments: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let value = arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("missing required string argument '{key}'"))?;
    if value.chars().count() > max {
        return Err(anyhow!("'{key}' must be at most {max} characters"));
    }
    Ok(value)
}

/// An optional, bounded string argument. Blank counts as absent; a non-string is
/// an error so a malformed call is reported rather than silently ignored.
fn optional_text<'a>(arguments: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                return Ok(None);
            }
            if s.chars().count() > max {
                return Err(anyhow!("'{key}' must be at most {max} characters"));
            }
            Ok(Some(s))
        }
        Some(_) => Err(anyhow!("'{key}' must be a string")),
    }
}

fn draft_dispatch(arguments: &Value) -> Result<Value> {
    let kind = required_text(arguments, "kind", MAX_TITLE_CHARS)?;
    if !KINDS.contains(&kind) {
        return Err(anyhow!("'kind' must be one of: {}", KINDS.join(", ")));
    }
    required_text(arguments, "title", MAX_TITLE_CHARS)?;
    required_text(arguments, "body", MAX_BODY_CHARS)?;
    for key in DETAIL_KEYS {
        optional_text(arguments, key, MAX_DETAIL_CHARS)?;
    }
    Ok(json!({
        "ok": true,
        "awaitingUser": true,
        "request": "draft",
        "kind": kind,
        "sent": false,
        "note": AWAITING_USER_NOTE,
    }))
}

/// Dispatch a feedback tool call. Client-rendered: nothing is sent or stored
/// here. `Err` only for a malformed call.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "draft" => draft_dispatch(&arguments),
        other => Err(anyhow!("unknown feedback tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_draft_tool_with_a_qualified_id() {
        let tools = tools();
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["feedback.draft"]);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.input_schema.is_some()));
    }

    #[tokio::test]
    async fn draft_accepts_both_kinds_and_tells_the_model_to_wait() {
        for kind in ["idea", "bug"] {
            let out = dispatch(
                "draft",
                json!({ "kind": kind, "title": "Dark mode for exports", "body": "I would like it." }),
            )
            .await
            .unwrap();
            assert_eq!(out["ok"], true);
            assert_eq!(out["awaitingUser"], true);
            assert_eq!(out["kind"], kind);
            // The tool never sends: the model must not report otherwise.
            assert_eq!(out["sent"], false);
            assert!(out["note"].as_str().unwrap().contains("End your turn"));
            assert!(out["note"]
                .as_str()
                .unwrap()
                .contains("Nothing has been sent"));
        }
    }

    #[tokio::test]
    async fn draft_rejects_an_unknown_or_missing_kind() {
        let err = dispatch(
            "draft",
            json!({ "kind": "praise", "title": "x", "body": "y" }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("'kind'"));
        let err = dispatch("draft", json!({ "title": "x", "body": "y" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("'kind'"));
    }

    #[tokio::test]
    async fn draft_requires_a_title_and_a_body() {
        let err = dispatch("draft", json!({ "kind": "idea", "body": "y" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("'title'"));
        let err = dispatch(
            "draft",
            json!({ "kind": "idea", "title": "x", "body": "   " }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("'body'"));
    }

    #[tokio::test]
    async fn draft_enforces_the_length_caps() {
        let at_cap = json!({
            "kind": "bug",
            "title": "t".repeat(MAX_TITLE_CHARS),
            "body": "b".repeat(MAX_BODY_CHARS),
            "steps": "s".repeat(MAX_DETAIL_CHARS),
        });
        assert!(dispatch("draft", at_cap).await.is_ok());

        let long_title = json!({
            "kind": "bug",
            "title": "t".repeat(MAX_TITLE_CHARS + 1),
            "body": "y",
        });
        let err = dispatch("draft", long_title).await.unwrap_err();
        assert!(err.to_string().contains("'title' must be at most 120"));

        let long_body = json!({
            "kind": "bug",
            "title": "x",
            "body": "b".repeat(MAX_BODY_CHARS + 1),
        });
        let err = dispatch("draft", long_body).await.unwrap_err();
        assert!(err.to_string().contains("'body' must be at most 4000"));

        for key in DETAIL_KEYS {
            let mut args = json!({ "kind": "bug", "title": "x", "body": "y" });
            args[*key] = json!("d".repeat(MAX_DETAIL_CHARS + 1));
            let err = dispatch("draft", args).await.unwrap_err();
            assert!(err.to_string().contains("at most 1000"), "{key}");
        }
    }

    #[tokio::test]
    async fn draft_counts_characters_not_bytes() {
        // 120 emoji are 480 bytes but 120 characters: within the cap.
        let out = dispatch(
            "draft",
            json!({ "kind": "idea", "title": "😀".repeat(MAX_TITLE_CHARS), "body": "y" }),
        )
        .await;
        assert!(out.is_ok());
    }

    #[tokio::test]
    async fn draft_rejects_non_string_details() {
        let err = dispatch(
            "draft",
            json!({ "kind": "bug", "title": "x", "body": "y", "steps": ["a", "b"] }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("'steps' must be a string"));
        // Blank details count as absent.
        let out = dispatch(
            "draft",
            json!({ "kind": "bug", "title": "x", "body": "y", "expected": "  ", "actual": null }),
        )
        .await;
        assert!(out.is_ok());
    }

    #[test]
    fn schema_matches_dispatch_limits() {
        let schema = draft_schema();
        let props = &schema["properties"];
        assert_eq!(props["kind"]["enum"], json!(["idea", "bug"]));
        assert_eq!(props["title"]["maxLength"], MAX_TITLE_CHARS);
        assert_eq!(props["title"]["minLength"], 1);
        assert_eq!(props["body"]["maxLength"], MAX_BODY_CHARS);
        for key in DETAIL_KEYS {
            assert_eq!(props[*key]["maxLength"], MAX_DETAIL_CHARS, "{key}");
        }
        assert_eq!(schema["required"], json!(["kind", "title", "body"]));
    }

    #[test]
    fn the_model_cannot_supply_attachments() {
        // Versions, system, model and errors come from the app. No schema
        // property may let the model pass them.
        let schema = draft_schema();
        let props = schema["properties"].as_object().expect("properties");
        let mut keys: Vec<&str> = props.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["actual", "body", "expected", "kind", "steps", "title"]
        );
    }

    #[test]
    fn smart_approval_mode_does_not_gate_the_draft_itself() {
        // The card is the approval step. A name the risky-verb heuristic matches
        // would put an approval prompt in front of the draft, asking twice.
        for tool in tools() {
            assert!(
                crate::approvals::policy::classify_risk(&tool.id).is_empty(),
                "{} must not look risky to the smart approval heuristic",
                tool.id
            );
        }
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        assert!(dispatch("send", json!({})).await.is_err());
    }
}
