use super::*;

mod delta;
mod detect;
mod evaluated;
pub(in crate::pipeline) use evaluated::evaluated_text;
mod finish;
mod lanes;
#[cfg(test)]
pub(in crate::pipeline) use detect::envelope_lane;
pub(in crate::pipeline) use detect::{detection_lanes, EnvelopeRuns};
pub(super) use lanes::{
    collect_envelope_lanes, collect_sse_payload_lanes, collect_sse_payload_lanes_where,
    lane_segment, push_pointer_token,
};
mod choice_text;
mod mirrors;
pub(super) use choice_text::{
    choice_scan_texts, primary_scan_text, primary_text_keys, primary_text_lanes, ChoiceTexts,
    TextLane,
};
pub(super) use delta::{
    reasoning_mirror, simple_content_delta, split_boundary, split_boundary_with, sse_scan_text,
    DELTA_TEXT_KEYS, FIELD_SEPARATOR,
};
pub(super) use finish::{protocol_finish_reason, protocol_native_finish_reason};
pub(super) use mirrors::{
    drop_choice_logprobs, has_token_mirrors, redact_with_mirrors, token_ids_ahead,
    token_mirror_lane, token_sequences,
};

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
// Every choice's text, in wire order: the scans read each choice on its own
// (`choice_scan_texts`); this join is for one-choice payloads.
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
                        collect_text_fields(delta, out);
                    }
                }
            }
        }
        _ => collect_text_fields(value, out),
    }
}

/// The text of a delta or message (or a frame without `choices`): below the
/// frame a `choices` key is an ordinary field.
fn collect_text_fields(value: &Value, out: &mut String) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_text_fields(value, out);
            }
        }
        Value::Object(values) => collect_object_fields(values, out, |_| true),
        Value::String(text) => out.push_str(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// [`collect_text_fields`] of an object's members whose key `keep` takes.
fn collect_object_fields(
    values: &serde_json::Map<String, Value>,
    out: &mut String,
    keep: impl Fn(&str) -> bool,
) {
    for (key, value) in values {
        if keep(key) && !skipped_member(values, key, value) {
            collect_text_fields(value, out);
        }
    }
}

/// Whether [`collect_text_fields`] leaves out a member of `values`.
fn skipped_member(values: &serde_json::Map<String, Value>, key: &str, value: &Value) -> bool {
    let reasoning = || values.get("reasoning").and_then(Value::as_str);
    matches!(
        key,
        "id" | "model" | "object" | "role" | "type" | "name" | "finish_reason"
    ) || (key == "reasoning_details" && reasoning_mirror(value, reasoning()))
        // vLLM sends the same text as `reasoning` and `reasoning_content`.
        || (key == "reasoning"
            && reasoning().is_some()
            && reasoning() == values.get("reasoning_content").and_then(Value::as_str))
}

// Used only when a protected value crosses JSON strings. Replacing the held
// payload is conservative, but avoids releasing individually innocuous pieces
// that reconstruct a secret in the receiving client.
/// The lane an array entry joins: its `index` as clients read it (an
/// integer, an integral float such as `0.0`, or a numeric string such as
/// `"0"`), else its position.
pub(in crate::pipeline) fn choice_lane(entry: &Value, position: usize) -> u64 {
    let index = entry.get("index");
    index
        .and_then(Value::as_u64)
        .or_else(|| {
            index
                .and_then(Value::as_f64)
                .filter(|index| *index >= 0.0 && index.fract() == 0.0 && *index < 1e15)
                .map(|index| index as u64)
        })
        .or_else(|| {
            index
                .and_then(Value::as_str)
                .and_then(|index| index.trim().parse().ok())
        })
        .unwrap_or(position as u64)
}

/// Whether an array entry carries an `index` that is not a lane number
/// (`choice_lane` falls back to its position): its lane is keyed by the raw
/// value instead, which the envelope paths cannot match.
pub(in crate::pipeline) fn odd_index(entry: &Value) -> bool {
    entry.get("index").is_some_and(|index| !index.is_null())
        && choice_lane(entry, usize::MAX) == usize::MAX as u64
}

/// A `delta.role` that is null or a protocol role, so it cannot carry part of
/// a value split across frames (the concatenated text leaves roles out).
pub(super) fn protocol_role(value: &Value) -> bool {
    value.is_null()
        || matches!(
            value.as_str(),
            Some("assistant" | "system" | "user" | "tool" | "function" | "developer")
        )
}

pub(super) fn mask_sse_payload_text(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                mask_sse_payload_text(value);
            }
        }
        Value::Object(fields) if fields.contains_key("choices") => {
            // Token mirrors (logprobs, token ids) carry the masked text.
            drop_choice_logprobs(value);
            let Value::Object(values) = value else {
                return;
            };
            match values.get_mut("choices") {
                // Every member a lane reads (`collect_sse_payload_lanes`), not
                // only `delta` / `message` / `text`.
                Some(Value::Array(choices)) => {
                    for choice in choices {
                        let Value::Object(fields) = choice else {
                            mask_text_fields(choice);
                            continue;
                        };
                        for (key, field) in fields.iter_mut() {
                            match key.as_str() {
                                // Already nulled (`drop_choice_logprobs`).
                                "logprobs" | "token_ids" => {}
                                // A lane index a client reads (`choice_lane`);
                                // any other string joins a lane like text.
                                "index"
                                    if field.is_null()
                                        || field.is_number()
                                        || field.as_str().is_some_and(|index| {
                                            index.trim().parse::<u64>().is_ok()
                                        }) => {}
                                "finish_reason" if protocol_finish_reason(field) => {}
                                "native_finish_reason" if protocol_native_finish_reason(field) => {}
                                _ => mask_text_fields(field),
                            }
                        }
                    }
                }
                // Not an array (`{"0": {...}}`): lanes still read it.
                Some(other) => mask_text_fields(other),
                None => {}
            }
        }
        _ => mask_text_fields(value),
    }
}

/// Mask the text of a delta or message (or a frame without `choices`): below
/// the frame a `choices` key is an ordinary field.
fn mask_text_fields(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                mask_text_fields(value);
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
                    mask_text_fields(value);
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
    let mut out = String::new();
    json_string_projection_into(value, &mut out);
    out
}

/// [`json_string_projection`] appended to `out`, which must be empty (a
/// reused buffer, cleared).
pub(super) fn json_string_projection_into(value: &Value, out: &mut String) {
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
    debug_assert!(out.is_empty());
    walk(value, out);
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

mod sanitize_survivor;
pub(super) use sanitize_survivor::*;

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
        redact_with_mirrors(response, scanner.as_ref());
        return Ok(true);
    };
    note_firewall_match(state, ctx, &violation, &scanner.policy());
    // Logged once the response goes out: a survivor logs only its block.
    let log_let_through = || {
        super::outbound_detection::log_let_through(
            scanner.config().log_detections,
            &ctx.request_id,
            &violation.pattern_name,
            scanner.policy(),
            false,
        );
    };

    match scanner.policy() {
        FirewallPolicy::Block => {
            // Always at `warn`: a block is never a let-through match.
            warn!(
                request_id = %ctx.request_id,
                pattern = %violation.pattern_name,
                "firewall: blocked outbound response"
            );
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
            // Fail closed: a match that survives redaction is refused, never
            // released as "sanitized".
            if let Some(survivor) = outbound_sanitize_survivor(response, scanner.as_ref()) {
                note_firewall_match(state, ctx, &survivor, &FirewallPolicy::Block);
                state.metrics.inc_firewall_blocked();
                warn!(
                    request_id = %ctx.request_id,
                    pattern = %survivor.pattern_name,
                    "firewall: outbound match survived Sanitize; blocked"
                );
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Outbound response could not be redacted: {} ({:?})",
                        survivor.pattern_name, survivor.kind
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            log_let_through();
            Ok(false)
        }
        FirewallPolicy::WarnAndContinue => {
            log_let_through();
            redact_with_mirrors(response, scanner.as_ref());
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

#[cfg(test)]
mod sanitize_survivor_tests;
