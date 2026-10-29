use super::*;

/// Rough prompt-token estimate (~4 chars/token) for the streaming path, where
/// no provider usage block is available to read exact counts from.
pub(super) fn estimate_prompt_tokens(body: &Value) -> u64 {
    let chars = extract_all_prompt_text(body).chars().count() as u64;
    chars.div_ceil(4)
}

/// Collect every string value in a provider response. Unlike the legacy
/// `choices[].message.content` projection, this includes tool/function
/// arguments, error fields, annotations, nested content parts, and every SSE
/// choice/frame that has been decoded into JSON.
pub(super) fn collect_json_strings(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => {
            if !text.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_json_strings(value, out);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_json_strings(value, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub(super) fn collect_json_strings_compact(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => out.push_str(text),
        Value::Array(values) => {
            for value in values {
                collect_json_strings_compact(value, out);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_json_strings_compact(value, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

// Provider envelope strings recur between content deltas. They must not split
// the text being scanned, or a key emitted in two deltas can evade detection.
pub(super) fn collect_sse_payload_text(value: &Value, out: &mut String) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_sse_payload_text(value, out);
            }
        }
        Value::Object(values) if values.contains_key("choices") => {
            if let Some(choices) = values.get("choices").and_then(Value::as_array) {
                for choice in choices {
                    if let Some(delta) = choice.get("delta").or_else(|| choice.get("message")) {
                        collect_sse_payload_text(delta, out);
                    }
                }
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if !matches!(
                    key.as_str(),
                    "id" | "model" | "object" | "role" | "type" | "name" | "finish_reason"
                ) {
                    collect_sse_payload_text(value, out);
                }
            }
        }
        Value::String(text) => out.push_str(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

// Used only when a protected value crosses JSON strings. Replacing the held
// payload is conservative, but avoids releasing individually innocuous pieces
// that reconstruct a secret in the receiving client.
pub(super) fn collect_sse_payload_lanes(
    value: &Value,
    path: &str,
    lanes: &mut std::collections::BTreeMap<String, String>,
) {
    match value {
        Value::Array(values) => {
            for (position, value) in values.iter().enumerate() {
                let index = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(position as u64);
                collect_sse_payload_lanes(value, &format!("{path}/{index}"), lanes);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if !(path.is_empty() && matches!(key.as_str(), "id" | "model" | "object")) {
                    collect_sse_payload_lanes(value, &format!("{path}/{key}"), lanes);
                }
            }
        }
        Value::String(text) => lanes.entry(path.to_owned()).or_default().push_str(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Whether a frame carries text only in `choices[0].delta.content`, so the
/// incremental scanner's concatenated text sees all of it. Any other choice
/// field that holds a string (non-null `logprobs`, `text`, `message`) is
/// another lane a split match could hide in, so the frame is not simple.
pub(super) fn simple_content_delta(value: &Value) -> bool {
    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        return false;
    };
    choices.is_empty()
        || (choices.len() == 1
            && choices[0].get("index").and_then(Value::as_u64).unwrap_or(0) == 0
            && choices[0]
                .get("delta")
                .and_then(Value::as_object)
                .is_some_and(|delta| {
                    delta
                        .keys()
                        .all(|key| matches!(key.as_str(), "content" | "role"))
                })
            && choices[0].as_object().is_some_and(|choice| {
                choice.iter().all(|(key, value)| {
                    matches!(key.as_str(), "index" | "delta" | "finish_reason")
                        || json_string_projection(value).is_empty()
                })
            }))
}

pub(super) fn mask_sse_payload_text(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                mask_sse_payload_text(value);
            }
        }
        Value::Object(values) if values.contains_key("choices") => {
            if let Some(choices) = values.get_mut("choices").and_then(Value::as_array_mut) {
                for choice in choices {
                    for field in ["delta", "message", "text"] {
                        if let Some(value) = choice.get_mut(field) {
                            mask_sse_payload_text(value);
                        }
                    }
                    // Logprob tokens (and their `bytes`) mirror the masked text.
                    if let Some(logprobs) = choice.get_mut("logprobs") {
                        *logprobs = Value::Null;
                    }
                }
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                let protocol_role = key == "role"
                    && matches!(
                        value.as_str(),
                        Some("system" | "user" | "assistant" | "tool" | "function")
                    );
                let protocol_type = key == "type"
                    && matches!(
                        value.as_str(),
                        Some(
                            "function"
                                | "text"
                                | "output_text"
                                | "input_text"
                                | "image_url"
                                | "audio"
                        )
                    );
                if !(protocol_role || protocol_type) {
                    mask_sse_payload_text(value);
                }
            }
        }
        Value::String(text) if !text.is_empty() => *text = "[REDACTED]".to_owned(),
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// The outbound DLP scan view of a response: every string value and every
/// object key, one per line. Keys are included because a provider can forward
/// model-generated keys (object-typed tool arguments), and
/// [`redact_json_strings`] / [`sanitize_json_strings`] rewrite keys too, so the
/// scan covers every leaf redaction touches. Evaluator text uses
/// [`collect_json_strings`], which reads values only.
pub(super) fn json_string_projection(value: &Value) -> String {
    fn walk(value: &Value, out: &mut String) {
        match value {
            Value::Object(values) => {
                for (key, value) in values {
                    if !key.is_empty() {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(key);
                    }
                    walk(value, out);
                }
            }
            Value::Array(values) => {
                for value in values {
                    walk(value, out);
                }
            }
            other => collect_json_strings(other, out),
        }
    }
    let mut out = String::new();
    walk(value, &mut out);
    out
}

/// Rewrite object keys with `rewrite`. A key that two rewrites collapse into
/// one keeps the value of the later key in map order.
pub(super) fn rewrite_object_keys(
    values: &mut serde_json::Map<String, Value>,
    rewrite: &dyn Fn(&str) -> String,
) {
    let renamed: Vec<(String, String)> = values
        .keys()
        .filter_map(|key| {
            let rewritten = rewrite(key);
            (rewritten != *key).then(|| (key.clone(), rewritten))
        })
        .collect();
    if renamed.is_empty() {
        return;
    }
    for (key, value) in std::mem::take(values) {
        let key = renamed
            .iter()
            .find(|(from, _)| *from == key)
            .map_or(key, |(_, to)| to.clone());
        values.insert(key, value);
    }
}

pub(super) fn redact_json_strings(
    value: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
) {
    match value {
        Value::String(text) => {
            *text = scanner.redact_outbound(text).0;
        }
        Value::Array(values) => {
            for value in values {
                redact_json_strings(value, scanner);
            }
        }
        Value::Object(values) => {
            rewrite_object_keys(values, &|key| scanner.redact_outbound(key).0);
            for value in values.values_mut() {
                redact_json_strings(value, scanner);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub(super) fn sanitize_json_strings(
    value: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
) {
    match value {
        Value::String(text) => {
            let sanitized = scanner.sanitize(text);
            *text = scanner.redact_outbound(&sanitized).0;
        }
        Value::Array(values) => {
            for value in values {
                sanitize_json_strings(value, scanner);
            }
        }
        Value::Object(values) => {
            rewrite_object_keys(values, &|key| {
                scanner.redact_outbound(&scanner.sanitize(key)).0
            });
            for value in values.values_mut() {
                sanitize_json_strings(value, scanner);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Drop every choice's `logprobs`. Each token there mirrors a piece of the
/// generated text, so per-string redaction cannot remove a match split across
/// tokens; once a response has been sanitized or masked they must not survive.
pub(super) fn drop_choice_logprobs(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                drop_choice_logprobs(value);
            }
        }
        Value::Object(values) => {
            if let Some(choices) = values.get_mut("choices").and_then(Value::as_array_mut) {
                for choice in choices {
                    if let Some(logprobs) = choice.get_mut("logprobs") {
                        *logprobs = Value::Null;
                    }
                }
            }
        }
        _ => {}
    }
}

/// Note a firewall match on the traffic feed under the policy it met, so the
/// request's later rows name the layer and pattern that decided. A platform
/// floor match is named by its detection kind only.
pub(super) fn note_firewall_match(
    state: &AppState,
    ctx: &RequestContext,
    hit: &crate::firewall::FirewallMatch,
    policy: &FirewallPolicy,
) {
    state.traffic.note_verdict(
        &ctx.request_id,
        crate::traffic::firewall_verdict(
            &hit.pattern_name,
            &hit.kind,
            &state.firewall_layers(ctx),
            crate::traffic::firewall_action(policy),
        ),
    );
}

/// Apply the shared outbound response DLP boundary to every JSON string value.
/// External-token redaction is unconditional; the configured firewall policy
/// still controls whether detected PII/secret content blocks, sanitizes, or is
/// warned through.
pub(super) fn apply_outbound_json_dlp(
    state: &AppState,
    ctx: &RequestContext,
    response: &mut Value,
) -> Result<bool, GatewayError> {
    let scanner = state.resolved_scanner(ctx);
    let response_text = json_string_projection(response);
    let violation = scanner.scan_outbound(&response_text);

    let Some(violation) = violation else {
        redact_json_strings(response, scanner.as_ref());
        return Ok(true);
    };
    note_firewall_match(state, ctx, &violation, &scanner.policy());

    match scanner.policy() {
        FirewallPolicy::Block => {
            state.metrics.inc_firewall_blocked();
            Err(GatewayError::FirewallBlocked(
                format!(
                    "Outbound response blocked: {} ({:?})",
                    violation.pattern_name, violation.kind
                ),
                firewall_policy_alert(scanner.config(), ctx, "block"),
            ))
        }
        FirewallPolicy::Sanitize => {
            sanitize_json_strings(response, scanner.as_ref());
            drop_choice_logprobs(response);
            Ok(false)
        }
        FirewallPolicy::WarnAndContinue => {
            redact_json_strings(response, scanner.as_ref());
            warn!(
                request_id = %ctx.request_id,
                pattern = %violation.pattern_name,
                "firewall: outbound violation (warn-and-continue)"
            );
            Ok(false)
        }
    }
}

// ─── Provider-bound prompt strings ────────────────────────────────────────────
//
// `visit_conversation_strings` + `visit_definition_strings` (scan side) and
// `visit_prompt_strings_mut` (redaction side) are the single definition of which
// chat-body strings the inbound firewall, inspector, inline evaluators and
// locked guardrails scan, and which strings the Sanitize policy redacts. The
// scan side must cover every leaf redaction rewrites: when detection reads a
// field that redaction skips, a request is logged as "sanitized" and still
// egresses the matched text. Definitions are screened for secrets and PII only
// (inbound firewall and locked guardrails alike). Every OpenAI-compatible front
// door (`/v1/chat/completions`, the Anthropic `/v1/messages` and
// `/v1/responses` translations) reaches the pipeline in this shape, so covering
// it here covers all of them.
//
// Visited: message `content` (string, or each `content[].text`), assistant
// `tool_calls[].function.arguments` and legacy `function_call.arguments`, every
// string inside a `tools[].function` / legacy `functions[]` `description` or
// `parameters` schema, and `prediction.content` (string or parts). Roles, types,
// names, ids, image URLs and data URIs are never visited.
