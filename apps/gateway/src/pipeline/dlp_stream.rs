use super::*;

/// Decode and rebuild an SSE response so every JSON frame is inspected and the
/// client never receives an unscanned raw frame. Unknown event lines and
/// malformed data frames are rejected instead of being replayed.
pub(super) fn rewrite_sse_for_dlp(
    raw: &str,
    scanner: &dyn crate::firewall::FirewallBackend,
    policy: &FirewallPolicy,
) -> Result<(String, String, Option<(String, String)>), String> {
    let mut frames = Vec::new();
    let mut saw_done = false;
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Err("provider stream contained an unscannable event frame".to_owned());
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            saw_done = true;
            continue;
        }
        frames.push(
            serde_json::from_str::<Value>(data)
                .map_err(|error| format!("provider stream frame is not valid JSON: {error}"))?,
        );
    }

    let mut payload = Value::Array(frames);
    let original_text = {
        let mut text = String::new();
        collect_sse_payload_text(&payload, &mut text);
        text
    };
    let violation = scanner
        .scan_outbound(&original_text)
        .or_else(|| {
            let mut lanes = std::collections::BTreeMap::new();
            if let Some(frames) = payload.as_array() {
                for frame in frames {
                    collect_sse_payload_lanes(frame, "", &mut lanes);
                }
            }
            lanes.values().find_map(|text| scanner.scan_outbound(text))
        })
        .or_else(|| scanner.scan_outbound(&json_string_projection(&payload)))
        .map(|match_| (match_.pattern_name.clone(), format!("{:?}", match_.kind)));
    redact_json_strings(&mut payload, scanner);
    let mut remaining = String::new();
    collect_sse_payload_text(&payload, &mut remaining);
    let mut remaining_lanes = std::collections::BTreeMap::new();
    if let Some(frames) = payload.as_array() {
        for frame in frames {
            collect_sse_payload_lanes(frame, "", &mut remaining_lanes);
        }
    }
    if scanner.redact_outbound(&remaining).0 != remaining
        || remaining_lanes.values().any(|text| {
            scanner.redact_outbound(text).0 != *text
                || (violation.is_some()
                    && matches!(policy, FirewallPolicy::Sanitize)
                    && scanner.sanitize(text) != *text)
        })
        || (violation.is_some()
            && matches!(policy, FirewallPolicy::Sanitize)
            && scanner.sanitize(&remaining) != remaining)
    {
        mask_sse_payload_text(&mut payload);
    }
    let mut assembled = {
        let mut text = String::new();
        collect_json_strings_compact(&payload, &mut text);
        text
    };
    if violation.is_some() && matches!(policy, FirewallPolicy::Sanitize) {
        sanitize_json_strings(&mut payload, scanner);
        drop_choice_logprobs(&mut payload);
        // Values only: the assembled text is what an output evaluator judges
        // and what an evaluator Sanitize replays, so no object keys.
        assembled = String::new();
        collect_json_strings(&payload, &mut assembled);
    }

    let mut rewritten = String::new();
    if let Some(frames) = payload.as_array() {
        for frame in frames {
            let encoded = serde_json::to_string(frame)
                .map_err(|error| format!("provider stream frame could not be encoded: {error}"))?;
            rewritten.push_str("data: ");
            rewritten.push_str(&encoded);
            rewritten.push_str("\n\n");
        }
    }
    if saw_done || !rewritten.is_empty() {
        rewritten.push_str("data: [DONE]\n\n");
    }
    Ok((rewritten, assembled, violation))
}

#[cfg(test)]
pub(super) fn sse_extract_text(raw: &str) -> String {
    let mut out = String::new();
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        collect_json_strings_compact(&json, &mut out);
    }
    out
}

// ─── Streaming outbound firewall ────────────────────────────────────────────────

/// Wrap a provider SSE stream with the outbound firewall, applying the
/// configured policy. See the call site in `run_stream` for the per-policy
/// rationale. Returns a (possibly buffered) [`Body`] ready to stream to the
/// client.
pub(super) async fn apply_outbound_firewall_stream(
    stream_body: Body,
    state: Arc<AppState>,
    ctx: RequestContext,
    admission_permit: crate::concurrency::AdmissionPermit,
) -> (Body, crate::concurrency::AdmissionPermit) {
    let request_id = ctx.request_id.clone();
    // The tenant-resolved scanner (node -> org -> agent, plus the request
    // overlay), resolved once like the non-stream `apply_outbound_json_dlp`: its
    // enablement, policy and custom patterns govern every stream DLP decision,
    // and it backs the output-target inline evaluators (P3). The `Arc` holds no
    // lock, so it is safe to keep for the whole stream.
    let resolved = state.resolved_scanner(&ctx);
    let outbound_enabled = resolved.outbound_enabled();
    let policy = resolved.policy().clone();
    let enforce = outbound_enabled && !matches!(policy, FirewallPolicy::WarnAndContinue);
    let has_output_eval = resolved.config().evaluators.iter().any(|b| b.enabled);

    // No stream gets a raw-byte fast path around DLP: structured tool calls,
    // error frames and outbound-only secret shapes are always parsed and
    // redacted. With the built-in patterns and no output evaluator, that runs
    // incrementally (see `stream_dlp`), so the client sees text as it is
    // generated. Custom patterns (from any scope) may span unbounded
    // whitespace, and output evaluators judge the whole reply, so both keep the
    // fully buffered path.
    let incremental = !has_output_eval && resolved.config().custom_patterns.is_empty();
    if incremental {
        let body = stream_dlp::dlp_body(
            stream_body,
            Arc::clone(&state),
            ctx,
            resolved,
            policy,
            enforce,
            outbound_enabled,
        );
        // Generation is still running, so the engine slot stays held for the
        // whole client stream (`hold_admission_until_stream_end`).
        return (body, admission_permit);
    }

    const MAX_BUFFERED_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
    let collected = match axum::body::to_bytes(stream_body, MAX_BUFFERED_RESPONSE_BYTES).await {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!(request_id = %request_id, error = %e, "firewall: failed to buffer stream for outbound scan");
            // Surface a clear error rather than silently leaking unscanned text.
            return (
                Body::from(sse_content_frames(
                    "[Ryu firewall] Unable to scan the response stream; request aborted.",
                )),
                crate::concurrency::AdmissionPermit::none(),
            );
        }
    };
    // The provider generation is complete once the upstream body is buffered.
    // Release the engine slot before a re-entrant LLM judge is dispatched; the
    // judge must be admitted independently instead of deadlocking behind its own
    // parent generation. Deterministic evaluators take the same safe path.
    drop(admission_permit);

    let raw = String::from_utf8_lossy(&collected).into_owned();
    let rewritten = rewrite_sse_for_dlp(&raw, resolved.as_ref(), &policy);
    let (rewritten, assembled, violation) = match rewritten {
        Ok(value) => value,
        Err(error) => {
            warn!(request_id = %request_id, %error, "firewall: unscannable response stream");
            state.metrics.inc_firewall_blocked();
            return (
                Body::from(sse_content_frames(
                    "[Ryu firewall] Response blocked because the provider stream could not be scanned.",
                )),
                crate::concurrency::AdmissionPermit::none(),
            );
        }
    };

    if let Some((pattern, kind)) = violation {
        match policy {
            FirewallPolicy::Block if enforce => {
                warn!(
                    request_id = %request_id,
                    pattern = %pattern,
                    "firewall: blocked outbound response (streaming)"
                );
                state.metrics.inc_firewall_blocked();
                audit_stream_dlp_block(&state, &ctx, &pattern, &kind);
                return (
                    Body::from(sse_content_frames(&format!(
                        "[Ryu firewall] Response blocked by policy: {pattern} ({kind})."
                    ))),
                    crate::concurrency::AdmissionPermit::none(),
                );
            }
            FirewallPolicy::Sanitize if enforce => {
                warn!(
                    request_id = %request_id,
                    pattern = %pattern,
                    "firewall: sanitized outbound response (streaming)"
                );
            }
            FirewallPolicy::WarnAndContinue if outbound_enabled => {
                warn!(
                    request_id = %request_id,
                    pattern = %pattern,
                    "firewall: outbound violation (warn-and-continue, streaming)"
                );
            }
            _ => {}
        }
    }

    // ── Unified-evaluator OUTPUT inline guardrails (P3) ──
    if has_output_eval {
        let (outcome, reason) =
            evaluate_output_inline_stream(&state, &ctx, resolved.as_ref(), &assembled).await;
        match outcome {
            InlineOutcome::Block => {
                warn!(
                    request_id = %request_id,
                    %reason,
                    "inline evaluator: blocked outbound response (streaming)"
                );
                state.metrics.inc_firewall_blocked();
                let model = ctx.agent_id.as_deref().unwrap_or("unknown");
                audit_inline_evaluator(&state, &ctx, model, "output", "blocked", &reason);
                return (
                    Body::from(sse_content_frames(&format!(
                        "[Ryu firewall] Response blocked by evaluator: {reason}."
                    ))),
                    crate::concurrency::AdmissionPermit::none(),
                );
            }
            InlineOutcome::Sanitize => {
                warn!(
                    request_id = %request_id,
                    %reason,
                    "inline evaluator: sanitized outbound response (streaming)"
                );
                return (
                    Body::from(sse_content_frames(&resolved.sanitize(&assembled))),
                    crate::concurrency::AdmissionPermit::none(),
                );
            }
            InlineOutcome::Warn | InlineOutcome::Allow => {}
        }
    }

    // Clean: replay the canonical, transformed frames rather than provider bytes.
    (
        Body::from(rewritten),
        crate::concurrency::AdmissionPermit::none(),
    )
}

/// The hazard screener over a buffered chat response, before it returns
/// (`crate::screening::output`). A no-op where no screener binds.
pub(super) async fn screen_buffered_output(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    response: &Value,
) -> Result<(), GatewayError> {
    crate::screening::output::screen_buffered(
        state,
        ctx,
        &crate::screening::output::response_text(response),
        response["model"].as_str(),
    )
    .await
}

/// Render `text` as a minimal OpenAI-compatible SSE transcript: a single
/// content delta chunk followed by the terminating `[DONE]` sentinel. Used to
/// replace a blocked or sanitized streaming response with safe content that
/// downstream OpenAI-SSE parsers (including Core) relay unchanged.
pub(super) fn sse_content_frames(text: &str) -> String {
    let chunk = json!({
        "id": "ryu-firewall",
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant", "content": text },
            "finish_reason": "stop"
        }]
    });
    format!("data: {chunk}\n\ndata: [DONE]\n\n")
}
