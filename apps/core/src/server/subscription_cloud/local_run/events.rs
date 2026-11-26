//! The run's output stream: one line of `claude -p --output-format stream-json` or
//! `codex exec --json` at a time.

use super::super::Provider;
use std::sync::LazyLock;

static SESSION_ID: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_\-]{8,64}$").expect("static pattern"));

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Init {
        session_id: String,
    },
    /// Words for the run log: assistant text, or `→ Tool` for a tool call.
    Log(String),
    /// An agent message that is also the run's answer so far (Codex reports no result
    /// text, so its last message is the summary).
    Reply(String),
    Result {
        is_error: bool,
        text: Option<String>,
    },
    /// An error the CLI may still recover from (Codex retries a dropped stream). Only a
    /// failed turn or a failed exit makes it the run's error.
    StreamError(Option<String>),
    Other,
}

/// One line of the run's output. Anything Ryu does not recognize is ignored, so a newer
/// CLI that adds event types keeps working.
pub(crate) fn parse_event(provider: Provider, line: &str) -> Event {
    match provider {
        Provider::Anthropic => parse_claude_event(line),
        Provider::Openai => parse_codex_event(line),
    }
}

/// One line of `claude -p --output-format stream-json`.
fn parse_claude_event(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Event::Other;
    };
    match value.get("type").and_then(|kind| kind.as_str()) {
        Some("system") if value.get("subtype").and_then(|kind| kind.as_str()) == Some("init") => {
            match value.get("session_id").and_then(|id| id.as_str()) {
                Some(id) if SESSION_ID.is_match(id) => Event::Init {
                    session_id: id.to_owned(),
                },
                _ => Event::Other,
            }
        }
        Some("assistant") => {
            let mut words = Vec::new();
            let content = value
                .pointer("/message/content")
                .and_then(|content| content.as_array());
            for block in content.into_iter().flatten() {
                match block.get("type").and_then(|kind| kind.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
                            words.push(text.trim().to_owned());
                        }
                    }
                    Some("tool_use") => {
                        if let Some(name) = block.get("name").and_then(|name| name.as_str()) {
                            words.push(format!("→ {name}"));
                        }
                    }
                    _ => {}
                }
            }
            if words.is_empty() {
                Event::Other
            } else {
                Event::Log(words.join("\n"))
            }
        }
        Some("result") => Event::Result {
            is_error: value
                .get("is_error")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            text: value
                .get("result")
                .and_then(|text| text.as_str())
                .map(str::to_owned),
        },
        _ => Event::Other,
    }
}

/// One line of `codex exec --json` (`codex-rs/exec/src/exec_events.rs`):
/// `thread.started {thread_id}`, `item.completed {item: {type, …}}`,
/// `turn.completed`, `turn.failed {error: {message}}` and `error {message}`.
fn parse_codex_event(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Event::Other;
    };
    let text_at = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(|text| text.as_str())
            .map(|text| text.trim().to_owned())
    };
    match value.get("type").and_then(|kind| kind.as_str()) {
        Some("thread.started") => match value.get("thread_id").and_then(|id| id.as_str()) {
            Some(id) if SESSION_ID.is_match(id) => Event::Init {
                session_id: id.to_owned(),
            },
            _ => Event::Other,
        },
        Some("item.completed") => {
            let Some(item) = value.get("item") else {
                return Event::Other;
            };
            // Only the item kind and the agent's own words: never a command line, its
            // output or a file's contents.
            match item.get("type").and_then(|kind| kind.as_str()) {
                Some("agent_message") => text_at("/item/text")
                    .filter(|text| !text.is_empty())
                    .map_or(Event::Other, Event::Reply),
                Some("command_execution") => Event::Log("→ shell".into()),
                Some("file_change") => Event::Log("→ edit".into()),
                Some("web_search") => Event::Log("→ web search".into()),
                Some("mcp_tool_call") => {
                    let tool = text_at("/item/tool").filter(|tool| {
                        !tool.is_empty()
                            && tool.len() <= 64
                            && tool
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
                    });
                    Event::Log(format!("→ {}", tool.as_deref().unwrap_or("tool")))
                }
                Some("error") => text_at("/item/message")
                    .filter(|text| !text.is_empty())
                    .map_or(Event::Other, |text| Event::Log(format!("! {text}"))),
                _ => Event::Other,
            }
        }
        Some("turn.completed") => Event::Result {
            is_error: false,
            text: None,
        },
        Some("turn.failed") => Event::Result {
            is_error: true,
            text: text_at("/error/message"),
        },
        // Not the end of the turn: `turn.failed` repeats a fatal one.
        Some("error") => Event::StreamError(text_at("/message")),
        _ => Event::Other,
    }
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
