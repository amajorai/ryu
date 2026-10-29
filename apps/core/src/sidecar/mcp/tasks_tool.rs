//! Built-in **suggested next task** (`tasks.suggest`).
//!
//! While working, an agent sometimes finds a separate piece of work worth doing
//! that is outside what it was asked: a bug noticed in passing, a cleanup it
//! deliberately left alone, a follow-up the change makes possible. This tool
//! lets it hand that to the user as a small card above the composer ("Suggested
//! task") with **Start** and **Save to Drafts**, instead of burying it in prose
//! or quietly widening its own scope.
//!
//! Optional by design: most turns suggest nothing, and the description tells the
//! model so. At most one card shows, for the latest finished turn only.
//!
//! Like `consent.*`, `ui.render` and `artifact.render`, this is a
//! **client-rendered, no-op** tool. Core starts nothing from here. Dispatch only
//! validates the shape. The task runs only when the user clicks Start, as a new
//! chat through the ordinary send path with its usual gates.
//!
//! Registered as a reserved registry server (`tasks`), so the `<server>.<tool>`
//! id scheme, the per-agent allowlist and the single `call_tool` entry all apply.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in task-suggestion provider.
pub const SERVER_NAME: &str = "tasks";

/// Longest `title` accepted. The card shows it as one bold line.
const MAX_TITLE_CHARS: usize = 80;

/// Longest `description` accepted. The card shows it under the title.
const MAX_DESCRIPTION_CHARS: usize = 400;

/// Longest `prompt` accepted. It opens a new chat, so it must stand on its own.
const MAX_PROMPT_CHARS: usize = 4_000;

/// Returned to the model so it finishes the current work instead of starting
/// the suggested task itself.
const SHOWN_NOTE: &str = "The suggestion is shown to the user as a card with a Start button. \
     Do not start that task yourself and do not suggest it again. Finish your reply \
     to the current request.";

fn suggest_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_TITLE_CHARS,
                "description": "Short imperative title, e.g. \"Answer step-up email cooldown with 429, not 500\"."
            },
            "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_DESCRIPTION_CHARS,
                "description": "One to three sentences for the user: what is wrong or missing, and why it is worth doing."
            },
            "prompt": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_PROMPT_CHARS,
                "description": "The full instruction a NEW chat starts with. It will not see this conversation, so name the files, symptoms and expected outcome it needs."
            }
        },
        "required": ["title", "description", "prompt"]
    })
}

/// The task-suggestion tool exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}.suggest"),
        server: SERVER_NAME.to_owned(),
        name: "suggest".to_owned(),
        description: Some(
            "Suggest ONE separate follow-up task to the user, shown as a card above the \
             composer with a Start button that runs it in a new chat. Most turns should \
             NOT call this. Use it only when you found concrete, worthwhile work that is \
             outside what you were asked to do, such as a bug you noticed in passing or \
             a fix you deliberately left out of scope. Do not use it for the work you are \
             already doing, for \"want me to continue?\" style offers, or for vague ideas. \
             At most once per turn. Write `prompt` so it stands on its own, because the new \
             chat does not see this conversation. Calling this does not start anything."
                .to_owned(),
        ),
        input_schema: Some(suggest_schema()),
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

fn suggest_dispatch(arguments: &Value) -> Result<Value> {
    let title = required_text(arguments, "title", MAX_TITLE_CHARS)?;
    required_text(arguments, "description", MAX_DESCRIPTION_CHARS)?;
    required_text(arguments, "prompt", MAX_PROMPT_CHARS)?;
    Ok(json!({
        "ok": true,
        "shown": true,
        "title": title,
        "note": SHOWN_NOTE,
    }))
}

/// Dispatch a task-suggestion call. Client-rendered: nothing is started here.
/// `Err` only for a malformed call.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "suggest" => suggest_dispatch(&arguments),
        other => Err(anyhow!("unknown tasks tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Value {
        json!({
            "title": "Answer step-up email cooldown with 429, not 500",
            "description": "The per-recipient cooldown error escapes as a 500.",
            "prompt": "In the step-up email route, map the cooldown error to a 429 with the wait time."
        })
    }

    #[test]
    fn lists_one_tool_with_a_qualified_id() {
        let tools = tools();
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["tasks.suggest"]);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.input_schema.is_some()));
    }

    #[tokio::test]
    async fn acknowledges_and_tells_the_model_not_to_start_it() {
        let out = dispatch("suggest", valid()).await.unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["shown"], true);
        assert_eq!(
            out["title"],
            "Answer step-up email cooldown with 429, not 500"
        );
        assert!(out["note"]
            .as_str()
            .unwrap()
            .contains("Do not start that task yourself"));
    }

    #[tokio::test]
    async fn requires_every_field() {
        for key in ["title", "description", "prompt"] {
            let mut args = valid();
            args[key] = json!("   ");
            let err = dispatch("suggest", args).await.unwrap_err();
            assert!(err.to_string().contains(&format!("'{key}'")), "{key}");
        }
    }

    #[tokio::test]
    async fn rejects_overlong_fields() {
        for (key, max) in [
            ("title", MAX_TITLE_CHARS),
            ("description", MAX_DESCRIPTION_CHARS),
            ("prompt", MAX_PROMPT_CHARS),
        ] {
            let mut args = valid();
            args[key] = json!("a".repeat(max + 1));
            let err = dispatch("suggest", args).await.unwrap_err();
            assert!(err.to_string().contains("at most"), "{key}");
        }
    }

    #[test]
    fn schema_matches_dispatch_limits() {
        let schema = suggest_schema();
        assert_eq!(schema["properties"]["title"]["maxLength"], MAX_TITLE_CHARS);
        assert_eq!(
            schema["properties"]["description"]["maxLength"],
            MAX_DESCRIPTION_CHARS
        );
        assert_eq!(
            schema["properties"]["prompt"]["maxLength"],
            MAX_PROMPT_CHARS
        );
    }

    #[test]
    fn smart_approval_mode_does_not_gate_the_suggestion() {
        // Suggesting starts nothing; the Start click is the user's decision.
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
        assert!(dispatch("start", json!({})).await.is_err());
    }
}
