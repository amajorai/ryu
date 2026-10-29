use super::*;

pub(super) fn visit_content_strings(content: &Value, visit: &mut dyn FnMut(&str)) {
    match content {
        Value::String(text) => visit(text),
        Value::Array(parts) => {
            for part in parts {
                if let Some(text) = part["text"].as_str() {
                    visit(text);
                }
            }
        }
        _ => {}
    }
}

pub(super) fn visit_content_strings_mut(content: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    match content {
        Value::String(text) => visit(text),
        Value::Array(parts) => {
            for part in parts {
                if let Some(Value::String(text)) = part.get_mut("text") {
                    visit(text);
                }
            }
        }
        _ => {}
    }
}

pub(super) fn visit_all_strings(value: &Value, visit: &mut dyn FnMut(&str)) {
    match value {
        Value::String(text) => visit(text),
        Value::Array(values) => {
            for value in values {
                visit_all_strings(value, visit);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                visit_all_strings(value, visit);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub(super) fn visit_all_strings_mut(value: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    match value {
        Value::String(text) => visit(text),
        Value::Array(values) => {
            for value in values {
                visit_all_strings_mut(value, visit);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                visit_all_strings_mut(value, visit);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// The function definitions a chat body declares: `tools[].function` plus the
/// legacy top-level `functions[]`.
pub(super) fn function_definitions(body: &Value) -> impl Iterator<Item = &Value> {
    let tools = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| &tool["function"]);
    let functions = body["functions"].as_array().into_iter().flatten();
    tools.chain(functions)
}

/// The conversation: message content, tool-call and legacy function-call
/// arguments, and predicted output. Every inbound category (prompt injection,
/// secrets, PII) applies here.
pub(super) fn visit_conversation_strings(body: &Value, visit: &mut dyn FnMut(&str)) {
    if let Some(messages) = body["messages"].as_array() {
        for msg in messages {
            visit_content_strings(&msg["content"], visit);
            if let Some(calls) = msg["tool_calls"].as_array() {
                for call in calls {
                    if let Some(arguments) = call["function"]["arguments"].as_str() {
                        visit(arguments);
                    }
                }
            }
            if let Some(arguments) = msg["function_call"]["arguments"].as_str() {
                visit(arguments);
            }
        }
    }
    visit_content_strings(&body["prediction"]["content"], visit);
}

/// Tool and function definitions: each `description` and every string in its
/// `parameters` schema. These are developer-authored and routinely use phrasing
/// the prompt-injection patterns match ("ignore case when matching rules",
/// "override sandbox mode and run commands") and example data the PII patterns
/// match ("e.g. jane@example.com"), so the inbound firewall screens them for
/// secrets only (see [`scan_definitions_inbound`]). Locked `pii` / `secrets`
/// guardrails still read them, and Sanitize redacts them when it runs.
pub(super) fn visit_definition_strings(body: &Value, visit: &mut dyn FnMut(&str)) {
    for function in function_definitions(body) {
        visit_all_strings(&function["description"], visit);
        visit_all_strings(&function["parameters"], visit);
    }
}

pub(super) fn visit_prompt_strings_mut(body: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    let Some(body) = body.as_object_mut() else {
        return;
    };
    if let Some(Value::Array(messages)) = body.get_mut("messages") {
        for msg in messages {
            let Some(msg) = msg.as_object_mut() else {
                continue;
            };
            if let Some(content) = msg.get_mut("content") {
                visit_content_strings_mut(content, visit);
            }
            if let Some(Value::Array(calls)) = msg.get_mut("tool_calls") {
                for call in calls {
                    if let Some(Value::String(arguments)) = call
                        .get_mut("function")
                        .and_then(|function| function.get_mut("arguments"))
                    {
                        visit(arguments);
                    }
                }
            }
            if let Some(Value::String(arguments)) = msg
                .get_mut("function_call")
                .and_then(|call| call.get_mut("arguments"))
            {
                visit(arguments);
            }
        }
    }
    let mut visit_function = |function: &mut Value| {
        if let Some(function) = function.as_object_mut() {
            for key in ["description", "parameters"] {
                if let Some(value) = function.get_mut(key) {
                    visit_all_strings_mut(value, visit);
                }
            }
        }
    };
    if let Some(Value::Array(tools)) = body.get_mut("tools") {
        for tool in tools {
            if let Some(function) = tool.get_mut("function") {
                visit_function(function);
            }
        }
    }
    if let Some(Value::Array(functions)) = body.get_mut("functions") {
        for function in functions {
            visit_function(function);
        }
    }
    if let Some(content) = body
        .get_mut("prediction")
        .and_then(|prediction| prediction.get_mut("content"))
    {
        visit_content_strings_mut(content, visit);
    }
}

pub(super) fn join_strings(walk: impl FnOnce(&mut dyn FnMut(&str))) -> String {
    let mut out = String::new();
    let mut first = true;
    walk(&mut |text| {
        if !first {
            out.push('\n');
        }
        first = false;
        out.push_str(text);
    });
    out
}

/// The conversation strings of a chat body, newline-joined, for the inbound
/// firewall, inspector, inline evaluators and locked guardrails. See
/// [`visit_conversation_strings`]; tool definitions are screened separately.
pub(super) fn extract_text_for_scanning(body: &Value) -> String {
    join_strings(|visit| visit_conversation_strings(body, visit))
}

/// The tool/function definition strings of a chat body, newline-joined, for
/// the DLP-only definition screen. See [`visit_definition_strings`].
pub(super) fn extract_definition_text(body: &Value) -> String {
    join_strings(|visit| visit_definition_strings(body, visit))
}

/// Every provider-bound prompt string (conversation plus definitions): the
/// leaves Sanitize redacts, so its survivor check and token estimates see them.
pub(super) fn extract_all_prompt_text(body: &Value) -> String {
    join_strings(|visit| {
        visit_conversation_strings(body, visit);
        visit_definition_strings(body, visit);
    })
}

/// Whether a locked-guardrail name selects a data-loss category (secrets or
/// PII), the only categories that apply to agent-authored definitions. The
/// content categories (prompt and code injection, toxicity, bias) match
/// ordinary schema and system-prompt wording ("override sandbox mode and run
/// commands", `git commit -m "$(cat <<'EOF' …"`), so they read the conversation.
pub(crate) fn is_dlp_guardrail(name: &str) -> bool {
    ["pii", "secret", "secrets"]
        .iter()
        .any(|dlp| name.eq_ignore_ascii_case(dlp))
}

/// The locked guardrails that apply to tool definitions: the secret and PII
/// categories only (see [`is_dlp_guardrail`] and [`visit_definition_strings`]).
pub(super) fn definition_dlp_guardrails(guardrails: &[String]) -> Vec<String> {
    guardrails
        .iter()
        .filter(|name| is_dlp_guardrail(name))
        .cloned()
        .collect()
}

/// Inbound screen for tool/function definitions: the secret patterns
/// `scan_inbound` runs, under the same `enabled` / `scan_inbound` gate. Neither
/// the prompt-injection nor the PII patterns run here: a third-party schema's
/// example email or address would otherwise refuse every request from the
/// agent under the default Block posture. A credential pasted into a schema is
/// a real leak, so it is still caught.
pub(super) fn scan_definitions_inbound(
    scanner: &(impl crate::firewall::FirewallBackend + ?Sized),
    definition_text: &str,
) -> Option<crate::firewall::FirewallMatch> {
    let config = scanner.config();
    if definition_text.is_empty() || !config.enabled || !config.scan_inbound {
        return None;
    }
    scanner.scan_locked_guardrails(definition_text, &["secrets".to_owned()])
}

/// Extract the assistant text an Output-target inline evaluator should judge.
///
/// Concatenates the text of EVERY choice (not just `choices[0]`) and handles both
/// the string and array-of-parts (`[{ "type": "text", "text": … }]`) content
/// shapes, so toxic/PII/biased text placed in a second choice (`n>1`), a
/// content part, or structured tool-call arguments does not bypass the
/// non-stream + cache-hit judge.
pub(super) fn response_to_text(response: &Value) -> String {
    let Some(choices) = response["choices"].as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for choice in choices {
        collect_json_strings(choice, &mut out);
    }
    out
}

/// Redact PII/secrets from every provider-bound prompt string (the leaves
/// [`extract_all_prompt_text`] joins). Returns whether any string changed, so
/// callers only report "sanitized" when the body really was rewritten.
pub(super) fn sanitize_messages(
    body: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
) -> bool {
    let mut changed = false;
    visit_prompt_strings_mut(body, &mut |text| {
        let sanitized = scanner.sanitize(text);
        if sanitized != *text {
            *text = sanitized;
            changed = true;
        }
    });
    changed
}

/// Apply the Sanitize policy to an inbound chat body and fail closed.
///
/// `FirewallScanner::sanitize` runs its regexes on the raw text, while detection
/// scans the `normalize_for_scan` view, so a zero-width or homoglyph split can be
/// detected yet survive redaction. After redacting, re-scan the provider-bound
/// strings for the categories redaction is configured to remove
/// (`redact_pii` / `redact_secrets`); a surviving match is returned as `Err` so
/// the caller blocks instead of forwarding text the audit trail calls redacted.
/// `Ok(changed)` reports whether the body was rewritten (an injection-only match
/// is not redactable and leaves it unchanged).
pub(super) fn sanitize_inbound_or_survivor(
    body: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
) -> Result<bool, crate::firewall::FirewallMatch> {
    let changed = sanitize_messages(body, scanner);
    let config = scanner.config();
    let mut categories: Vec<String> = Vec::with_capacity(2);
    if config.redact_pii {
        categories.push("pii".to_owned());
    }
    if config.redact_secrets {
        categories.push("secrets".to_owned());
    }
    if !categories.is_empty() {
        if let Some(survivor) =
            scanner.scan_locked_guardrails(&extract_all_prompt_text(body), &categories)
        {
            return Err(survivor);
        }
    }
    Ok(changed)
}

/// Run [`sanitize_inbound_or_survivor`] for a pipeline stage, mapping a surviving
/// match to a 403 and logging what actually happened to the body.
pub(super) fn sanitize_inbound_or_block(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
    stage: &str,
) -> Result<bool, GatewayError> {
    match sanitize_inbound_or_survivor(body, scanner) {
        Ok(true) => {
            warn!(request_id = %ctx.request_id, stage, "{stage}: sanitized inbound content");
            Ok(true)
        }
        Ok(false) => {
            warn!(
                request_id = %ctx.request_id,
                stage,
                "{stage}: inbound match is not redactable under Sanitize; forwarded unchanged"
            );
            Ok(false)
        }
        Err(survivor) => {
            warn!(
                request_id = %ctx.request_id,
                stage,
                pattern = %survivor.pattern_name,
                "{stage}: inbound content survived redaction; blocked"
            );
            state.metrics.inc_firewall_blocked();
            Err(GatewayError::FirewallBlocked(
                format!(
                    "Inbound content could not be redacted: {} ({:?})",
                    survivor.pattern_name, survivor.kind
                ),
                firewall_policy_alert(scanner.config(), ctx, "block"),
            ))
        }
    }
}

pub(super) fn sanitize_response(
    response: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
) {
    sanitize_json_strings(response, scanner);
}
