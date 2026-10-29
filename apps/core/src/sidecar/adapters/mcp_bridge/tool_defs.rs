use super::*;

/// Build the locked `tool_search` function-tool schema (Contract 3), the twin of
/// the gateway plane's `tools::tool_search_def`. Returned as a JSON object so
/// `list_tools` can unwrap the `function.parameters` map for rmcp `Tool::new`.
///
/// The two copies are kept in sync by hand. The `kind` enum advertises the full
/// set [`ToolKind::parse_filter`] honors — including `core-api`, `command` and
/// `skill`, the planes `ToolKind` grew after both copies were first written. Both
/// copies previously advertised only the original four, which hid those planes
/// from every agent on this (ACP) plane: an agent cannot ask for a filter it is
/// never told exists, so `core-api`/`command` tools were reachable only by an
/// unfiltered search that had to out-rank every MCP tool to surface them.
///
/// Advertising a value Core does NOT honor would be the worse bug in the other
/// direction: [`ToolKind::parse_filter`] maps anything unrecognized to `None` =
/// "no filter" (see `dispatch_tool_search` below, which feeds its result
/// straight to `McpRegistry::search_scoped`), so the model would believe it filtered and
/// get every plane back. The enum here is therefore exactly `parse_filter`'s
/// accepted set plus the `any` sentinel, and a test asserts that.
pub(super) fn tool_search_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "tool_search",
            "description": "Search the available catalog for tools AND Agent Skills that can accomplish a task. Returns a ranked list of descriptors (id, name, description, kind). Call this FIRST when you need a capability not already provided as a tool. A row whose kind is 'skill' is instruction text, not a function: do NOT call its id — pass the part after the 'skills.' prefix to skills.load and follow what it returns. Every other kind is called directly by its exact id (or describe it first for its argument schema).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language description of the capability you need (e.g. 'send a slack message')." },
                    "kind": { "type": "string", "enum": ["mcp", "builtin", "composio", "app", "core-api", "command", "skill", "ext-api", "any"], "description": "Optional filter by source plane. 'skill' returns only Agent Skills. 'ext-api' returns only tools derived from an installed app's OpenAPI document. 'any' (default) searches all.", "default": "any" },
                    "limit": { "type": "integer", "description": "Max results.", "default": 8, "minimum": 1, "maximum": 25 }
                },
                "required": ["query"]
            }
        }
    })
}

/// The `describe` meta-tool: resolve a tool id to its argument schema. No locked
/// schema in the contracts; a minimal `{ id }` object is sufficient.
pub(super) fn describe_tool_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "describe",
            "description": "Describe a tool returned by tool_search: returns its argument schema (names, types, required flags) so you can call it correctly. Pass the exact tool id (e.g. 'exa.search' or 'composio.SLACK_SEND_MESSAGE').",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Fully-qualified tool id to describe." }
                },
                "required": ["id"]
            }
        }
    })
}

/// Name of the Ryu-owned "ask the user" meta-tool.
pub(crate) const ASK_USER_TOOL: &str = "ask_user";

/// How long a blocking `ask_user` waits before it gives up and leaves the
/// question open as an async one.
pub(super) const ASK_USER_BLOCKING_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(600);

/// How often a blocking `ask_user` re-checks presence, so a user who steps away
/// mid-question releases the agent instead of stalling it for the full timeout.
pub(super) const ASK_USER_PRESENCE_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// The `ask_user` meta-tool. The `async` flag is the agent's way to say "this
/// can wait": the question is shown to the user and the tool returns at once.
pub(super) fn ask_user_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": ASK_USER_TOOL,
            "description": "Ask the user one or more questions through Ryu's question card. Set async=true for anything that is not blocking (preferences, nice-to-have details, confirmations you can proceed without): the question is delivered and the tool returns immediately so you keep working, stating any assumption you make; the answer arrives later as a new user message. Use async=false only when you truly cannot continue without the answer. When the user is away, in do-not-disturb, or gaming, every question is delivered asynchronously regardless of this flag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 6,
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string", "description": "The question to ask." },
                                "description": { "type": "string", "description": "Optional context shown under the question." },
                                "options": {
                                    "type": "array",
                                    "description": "Optional choices. Omit for a free-text answer.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": { "type": "string" },
                                            "description": { "type": "string" }
                                        },
                                        "required": ["label"]
                                    }
                                },
                                "multiSelect": { "type": "boolean", "description": "Allow choosing more than one option.", "default": false }
                            },
                            "required": ["question"]
                        }
                    },
                    "async": { "type": "boolean", "description": "true = do not wait for the answer (non-urgent). false = pause until the user answers.", "default": false }
                },
                "required": ["questions"]
            }
        }
    })
}

/// Render structured Question answers as text the model can read, resolving
/// option ids back to their labels.
pub(super) fn format_question_answers(questions: &Value, answers: &Value) -> String {
    let questions = questions.as_array().cloned().unwrap_or_default();
    let answers = answers.as_array().cloned().unwrap_or_default();
    let mut lines = Vec::new();
    for (index, answer) in answers.iter().enumerate() {
        let question = questions.get(index);
        let title = question
            .and_then(|q| q.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("Question");
        let kind = answer.get("kind").and_then(Value::as_str).unwrap_or("text");
        let text = if kind == "skip" {
            "(skipped)".to_owned()
        } else {
            let mut parts: Vec<String> = answer
                .get("selectedIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(|id| {
                            question
                                .and_then(|q| q.get("options"))
                                .and_then(Value::as_array)
                                .and_then(|options| {
                                    options
                                        .iter()
                                        .find(|o| o.get("id").and_then(Value::as_str) == Some(id))
                                })
                                .and_then(|o| o.get("label"))
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_owned()
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(extra) = answer.get("text").and_then(Value::as_str) {
                if !extra.trim().is_empty() {
                    parts.push(extra.trim().to_owned());
                }
            }
            if parts.is_empty() {
                "(no answer)".to_owned()
            } else {
                parts.join(", ")
            }
        };
        lines.push(format!("- {title}: {text}"));
    }
    if lines.is_empty() {
        "The user submitted no answers.".to_owned()
    } else {
        format!("The user answered:\n{}", lines.join("\n"))
    }
}

/// Mint a colon-free, process-unique id for an `ask_user` Question card.
pub(super) fn next_ask_user_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("ask-{epoch}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// The text `ask_user` returns when nobody can be asked: no user is attached to
/// the session, or the stream that would carry the question is gone.
pub(super) fn ask_user_unreachable_reply() -> String {
    "No user is attached to this session, so the question could not be asked. \
     Continue with your best judgement and state your assumptions."
        .to_owned()
}

/// The text `ask_user` returns when it does not wait.
pub(super) fn ask_user_async_reply(reason: &str) -> String {
    format!(
        "Question delivered to the user asynchronously ({reason}). Do not wait for it: continue with the work you can do, make a reasonable assumption where you need one and say so, and treat their answer as a new user message when it arrives."
    )
}

/// A shallow Composio function def offered to the agent (the action's full schema
/// is not pre-listed; the model passes a freeform `arguments` object, mirroring
/// `catalog::describe`'s shallow Composio shape).
pub(super) fn composio_def(slug: &str) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": format!("composio__{slug}"),
            "description": format!("Composio action {slug}. Pass the action's parameters as the `arguments` object."),
            "parameters": {
                "type": "object",
                "properties": {
                    "arguments": { "type": "object", "description": "Action-specific parameters for this Composio action." }
                }
            }
        }
    })
}

/// Pull the bare `function.parameters` object map out of a function-tool def for
/// rmcp `Tool::new` (which wants the parameters object, not the whole def).
pub(super) fn params_map(def: &Value) -> Map<String, Value> {
    def.get("function")
        .and_then(|f| f.get("parameters"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Build an rmcp `Tool` from a function-tool def `Value`.
pub(super) fn tool_from_def(def: &Value) -> Tool {
    let name = def
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let description = def
        .get("function")
        .and_then(|f| f.get("description"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut tool = Tool::new(
        Cow::Owned(name),
        description.clone(),
        Arc::new(params_map(def)),
    );
    if !description.is_empty() {
        tool.description = Some(Cow::Owned(description));
    }
    tool
}
