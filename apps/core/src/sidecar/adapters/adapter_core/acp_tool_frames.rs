use super::*;

/// Resolve one ACP tool call's raw fields into the frame the client renders:
/// the part-type name, its `dynamic` flag, and the input AS EMITTED — which is
/// not the raw input, because a question tool is reshaped into the desktop's
/// Question card and the ACP `locations` ride along under a namespaced key.
///
/// Extracted because this now runs twice per tool call: once when the call
/// opens, and again when a later `tool_call_update` fills in arguments the
/// opening frame did not have yet (pi-acp opens the call while the model is
/// still streaming them). Hand-rolling the second site is how the two frames
/// would drift, and a `tool-input-available` whose `toolName`/`dynamic` differ
/// from the opening one is a NEW part in the AI SDK, not a correction to the
/// existing one.
pub(crate) fn acp_tool_frame(
    kind: &str,
    title: &str,
    input: &Value,
    locations: &[Value],
) -> (String, bool, Value) {
    // Bind the ACP call to the desktop's rich tool UI when the kind/input shape
    // matches a known tool (Bash terminal, Edit diff, Read, search, …);
    // otherwise generic dynamic row.
    let (mut tool_name, mut dynamic) = acp_tool_ui_name(kind, title, input);
    let mut emit_input = input.clone();
    // A structured "ask the user" call (Claude's AskUserQuestion or any ACP
    // agent's question tool): reshape it into the desktop's Question card.
    // Guarded — only overrides when the reshape yields a well-formed question,
    // so unrelated tools are untouched.
    // Ryu's own `ask_user` bridge tool renders its card through a Core-minted
    // QuestionRequest (so Core can register the answer waiter); reshaping the
    // agent's frame for the same call would draw a second, unanswerable card.
    // Agents decorate MCP tool titles differently (`mcp__ryu__ask_user`,
    // `ryu.ask_user`, `ask_user(...)`), so match the name anywhere in it.
    let ryu_ask_user = title
        .to_ascii_lowercase()
        .contains(mcp_bridge::ASK_USER_TOOL);
    if let Some(question) = acp_question_input(title, input).filter(|_| !ryu_ask_user) {
        tool_name = "Question".to_owned();
        dynamic = false;
        emit_input = question;
    }
    // Carry the ACP tool-call `locations` ([{path, line?}]) into the part's
    // input under a namespaced key so the desktop can show which files/lines the
    // tool touched. Namespaced (`_ryuLocations`) so it never collides with a
    // real tool input field.
    if !locations.is_empty() {
        if let Value::Object(ref mut map) = emit_input {
            map.insert("_ryuLocations".to_owned(), Value::Array(locations.to_vec()));
        } else if emit_input.is_null() {
            emit_input = serde_json::json!({ "_ryuLocations": locations });
        }
    }
    (tool_name, dynamic, emit_input)
}

/// Whether a tool call's raw input carries nothing worth re-rendering.
///
/// `null` and `{}` are both "the agent has not told us the arguments yet" — the
/// literal shape pi-acp opens a streaming tool call with — so neither may
/// overwrite arguments a previous frame already carried.
pub(crate) fn is_blank_tool_input(input: &Value) -> bool {
    match input {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

/// Reshape an ACP agent's "ask the user a question" tool call into the desktop's
/// `QuestionConfig` shape so it renders as the rich Question card rather than a
/// generic tool row (the desktop's `tool-Question` renderer). ACP has no single
/// standard question tool, so this is a best-effort adapter over the common
/// shapes: a top-level `questions: [...]` array (e.g. Claude's `AskUserQuestion`)
/// or a single-question `{ question|prompt, options }`. Each question maps to
/// `{ id, title, description?, kind, options:[{ id, label, description? }] }`
/// where `kind` is `multi` when the source is multi-select, `single` when it
/// carries options, else `text`.
///
/// Returns `None` (leaving the call as an ordinary dynamic tool row) unless at
/// least one well-formed question with a non-empty title results — so a tool we
/// misread never renders as a blank/null card.
pub(crate) fn acp_question_input(title: &str, input: &Value) -> Option<Value> {
    let title_hints = {
        let t = title.to_ascii_lowercase();
        t.contains("question") || t.contains("ask")
    };
    let looks_like_question =
        title_hints || input.get("questions").is_some() || input.get("question").is_some();
    if !looks_like_question {
        return None;
    }

    let raw_questions: Vec<&Value> = match input.get("questions").and_then(Value::as_array) {
        Some(arr) => arr.iter().collect(),
        None => vec![input],
    };

    let str_of = |v: &Value, keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(s) = v.get(*k).and_then(Value::as_str) {
                if !s.is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
        None
    };

    let mut questions: Vec<Value> = Vec::new();
    for (qi, q) in raw_questions.iter().enumerate() {
        let Some(q_title) = str_of(q, &["title", "question", "header", "prompt", "text"]) else {
            continue;
        };
        let description = str_of(q, &["description", "subtitle", "detail", "hint"]);
        let multi = q
            .get("multiSelect")
            .or_else(|| q.get("multi_select"))
            .or_else(|| q.get("multiple"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut options: Vec<Value> = Vec::new();
        if let Some(opts) = q.get("options").and_then(Value::as_array) {
            for (oi, o) in opts.iter().enumerate() {
                if let Some(s) = o.as_str() {
                    options.push(serde_json::json!({ "id": s, "label": s }));
                    continue;
                }
                let label = str_of(o, &["label", "title", "name", "value", "text"])
                    .unwrap_or_else(|| format!("Option {}", oi + 1));
                let id = str_of(o, &["id", "value", "label", "name"])
                    .unwrap_or_else(|| format!("opt-{oi}"));
                let odesc = str_of(o, &["description", "subtitle", "detail"]);
                let mut opt = serde_json::json!({ "id": id, "label": label });
                if let Some(d) = odesc {
                    opt["description"] = Value::String(d);
                }
                options.push(opt);
            }
        }
        let kind = if multi {
            "multi"
        } else if options.is_empty() {
            "text"
        } else {
            "single"
        };
        let mut question = serde_json::json!({
            "id": str_of(q, &["id"]).unwrap_or_else(|| format!("q-{qi}")),
            "title": q_title,
            "kind": kind,
        });
        if let Some(d) = description {
            question["description"] = Value::String(d);
        }
        if !options.is_empty() {
            question["options"] = Value::Array(options);
        }
        questions.push(question);
    }

    if questions.is_empty() {
        return None;
    }
    let total = questions.len();
    Some(serde_json::json!({
        "questions": questions,
        "totalQuestions": total,
        "questionIndex": 1,
    }))
}

/// `finish` part — marks the assistant message complete.
/// A complete synthetic assistant message as UI frames: `start` → `text-start` →
/// one `text-delta` → `text-end` → `finish`.
///
/// For a reply Ryu produces WITHOUT calling a model — today, a `pre_user_turn`
/// hook returning [`HookDirective::Handled`], which ends the turn and supplies the
/// answer itself. Such a reply must be indistinguishable on the wire from a
/// streamed one or the client renders a turn that never opens or never closes.
///
/// Lives here, next to the private `ui_*` part builders, rather than at the call
/// site: the frame vocabulary has exactly one definition, so a change to the part
/// shape cannot leave a second hand-rolled copy behind to drift. The terminal
/// `[DONE]` is deliberately NOT included — the caller owns that, because one
/// response may carry several turns but only ever one `[DONE]`.
///
/// [`HookDirective::Handled`]: crate::plugin_host::HookDirective::Handled
pub(crate) fn synthetic_assistant_frames(text: &str) -> Vec<Vec<u8>> {
    // A stable id shared by the three text parts, matching how a real streamed
    // block is framed. Distinct prefix so these are traceable in a capture.
    let id = format!("hook-{}", uuid::Uuid::new_v4());
    vec![
        ui_start(),
        ui_text_start(&id),
        ui_text_delta(&id, text),
        ui_text_end(&id),
        ui_finish(),
    ]
}

pub(crate) fn ui_finish() -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "finish" }))
}
