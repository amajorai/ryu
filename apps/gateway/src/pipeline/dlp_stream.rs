use super::*;

mod evaluator_reply;
mod head_split;
mod per_string;
pub(super) use evaluator_reply::evaluator_sanitized;
use evaluator_reply::evaluator_sanitized_reply;
use head_split::redact_head_then_rest;
use per_string::redact_per_string;

/// Decode and rebuild an SSE response so every JSON frame is inspected and the
/// client never receives an unscanned raw frame. Unknown event lines and
/// malformed data frames are rejected instead of being replayed.
pub(super) fn rewrite_sse_for_dlp(
    raw: &str,
    scanner: &dyn crate::firewall::FirewallBackend,
    policy: &FirewallPolicy,
) -> Result<(String, String, Option<(String, String)>), String> {
    rewrite_sse(raw, scanner, policy, false)
}

/// `rewrite_sse_for_dlp`, with every string sanitized when `force_sanitize`
/// (an output evaluator's Sanitize), as under a Sanitize DLP verdict.
fn rewrite_sse(
    raw: &str,
    scanner: &dyn crate::firewall::FirewallBackend,
    policy: &FirewallPolicy,
    force_sanitize: bool,
) -> Result<(String, String, Option<(String, String)>), String> {
    let mut frames = Vec::new();
    // As the provider sent them: a split copies one-shot strings
    // (`stop_reason`) onto both halves, which the lanes must not judge twice.
    let mut provider_frames = Vec::new();
    let mut refusals = Vec::new();
    let mut saw_done = false;
    for line in raw.lines() {
        // `:` lines are SSE comments (keep-alives) and carry no payload.
        if line.trim().is_empty() || line.starts_with(':') {
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
        let mut frame = serde_json::from_str::<Value>(data)
            .map_err(|error| format!("provider stream frame is not valid JSON: {error}"))?;
        // As the stream does: the standing refusal is judged on its own.
        if refusals.is_empty() && crate::standing::refusal_frame_error(&frame).is_some() {
            refusals.push(frame);
            continue;
        }
        super::stream_dlp::envelope::normalize_padding(&mut frame);
        // As the stream does: reasoning and answer in one delta are two frames.
        // The provider frames stay whole for the envelope and lane passes.
        provider_frames.push(frame.clone());
        match split_boundary(&frame) {
            Some([reasoning, answer]) => {
                frames.extend([reasoning, answer]);
            }
            None => {
                frames.push(frame);
            }
        }
    }

    let mut payload = Value::Array(frames);
    // Each choice on its own, as a client merges choices by `index`, and
    // separator-aware: a reasoning-to-answer switch is a text boundary.
    let choice_texts = choice_scan_texts(payload.as_array().map_or(&[], Vec::as_slice));
    let mut envelope = super::stream_dlp::envelope::EnvelopeLanes::default();
    for frame in &provider_frames {
        envelope.observe(frame);
    }
    let violation = choice_texts
        .values()
        .find_map(|text| scanner.scan_outbound(text))
        .or_else(|| {
            detection_lanes(&provider_frames, envelope.judged_by_lanes())
                .values()
                .find_map(|text| scanner.scan_outbound(text))
        })
        // A split candidate in the envelope (`model` changing between
        // frames), judged joined as the stream judges it at its end.
        .or_else(|| envelope.varying().then(|| envelope.scan(scanner)).flatten())
        // Each frame's own strings, as the stream scans them: a newline join
        // across frames is text no client builds.
        .or_else(|| {
            payload.as_array().and_then(|frames| {
                frames
                    .iter()
                    .find_map(|frame| scanner.scan_outbound(&json_string_projection(frame)))
            })
        })
        .map(|match_| (match_.pattern_name.clone(), format!("{:?}", match_.kind)));
    // The standing refusal keeps the DLP's own verdict (`refusal_trailer`).
    let dlp_sanitize = violation.is_some() && matches!(policy, FirewallPolicy::Sanitize);
    let sanitize = force_sanitize || dlp_sanitize;
    // Content deltas are redacted at text level so a value split across deltas
    // is replaced once and the answer around it survives; so are the leading
    // content deltas before a tool call or other lane, when they split
    // cleanly from it. Other payloads keep the per-string path and its
    // fail-closed mask below.
    let text_level = super::stream_dlp::redact::rewrite_frames(
        &mut payload,
        scanner,
        sanitize,
        &provider_frames,
    ) || redact_head_then_rest(&mut payload, scanner, sanitize, &provider_frames);
    if !text_level {
        redact_per_string(&mut payload, scanner, sanitize, &provider_frames);
    }
    // Fail closed: Sanitize rewrites the raw text while detection reads the
    // scan view, and the mask rewrites only text fields, so a match that
    // survives in the payload refuses the stream (the caller replaces it with
    // a block notice) rather than releasing it as sanitized.
    if sanitize {
        if let Some(survivor) = sse_sanitize_survivor(&payload, scanner) {
            return Err(format!(
                "provider stream could not be redacted: {}",
                survivor.pattern_name
            ));
        }
    }
    // What an output evaluator judges: the model's text as a client renders
    // it, each choice on its own (deltas
    // joined across frames, a newline at a reasoning-to-answer switch), never
    // the envelope strings (id, model, object) between two deltas of one
    // phrase, nor another choice's deltas between them (`evaluated_text`).
    let assembled = evaluated_text(payload.as_array().map_or(&[], Vec::as_slice));

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
    let done = saw_done || !rewritten.is_empty();
    rewritten.push_str(&refusal_trailer(refusals, scanner, dlp_sanitize));
    if done {
        rewritten.push_str("data: [DONE]\n\n");
    }
    Ok((rewritten, assembled, violation))
}

/// The model a provider stream names (its first frame's `model`), for the
/// audit record, as the non-stream path reads `response["model"]`.
pub(super) fn stream_model(raw: &str) -> String {
    raw.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        // Azure's first chunk names an empty model.
        .find_map(|frame| {
            frame
                .get("model")?
                .as_str()
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Whether a custom pattern joins the sets outbound DLP reads (PII and
/// secrets); the other kinds are merged into evaluator sets.
pub(super) fn outbound_custom_patterns(scanner: &FirewallScanner) -> bool {
    scanner.config().custom_patterns.iter().any(|pattern| {
        matches!(
            pattern.kind,
            crate::config::CustomPatternKind::Pii | crate::config::CustomPatternKind::Secret
        )
    })
}

/// The standing guard's refusal frames, sent after the model's frames and
/// judged on their own: each string redacted (sanitized under an active
/// Sanitize), never joined with model text or masked as part of a batch.
pub(super) fn refusal_trailer(
    refusals: Vec<Value>,
    scanner: &dyn crate::firewall::FirewallBackend,
    sanitize: bool,
) -> String {
    let mut out = String::new();
    for mut frame in refusals {
        if sanitize {
            sanitize_json_strings(&mut frame, scanner);
        } else {
            redact_json_strings(&mut frame, scanner);
        }
        if let Ok(encoded) = serde_json::to_string(&frame) {
            out.push_str("data: ");
            out.push_str(&encoded);
            out.push_str("\n\n");
        }
    }
    out
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
    let has_output_eval = output_inline_bound(resolved.as_ref(), &state.evaluator_registry());

    // No stream gets a raw-byte fast path around DLP: structured tool calls,
    // error frames and outbound-only secret shapes are always parsed and
    // redacted. With the built-in patterns and no output evaluator, that runs
    // incrementally (see `stream_dlp`), so the client sees text as it is
    // generated. Custom PII and secret patterns (from any scope) may span
    // unbounded whitespace, and output evaluators judge the whole reply, so
    // both keep the fully buffered path. Input evaluators and the other
    // custom pattern kinds (merged into evaluator sets) never read the reply.
    let incremental = !has_output_eval && !outbound_custom_patterns(resolved.as_ref());
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
        let log_let_through = |pattern: &str| {
            super::outbound_detection::log_let_through(
                resolved.config().log_detections,
                &request_id,
                pattern,
                &policy,
                true,
            );
        };
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
            FirewallPolicy::Sanitize if enforce => log_let_through(&pattern),
            FirewallPolicy::WarnAndContinue if outbound_enabled => log_let_through(&pattern),
            _ => {}
        }
    }

    // ── Unified-evaluator OUTPUT inline guardrails (P3) ──
    if has_output_eval {
        let (outcome, evaluator, reason) =
            evaluate_output_inline_stream(&state, &ctx, resolved.as_ref(), &assembled).await;
        // Audited as the non-stream path audits it: the deciding evaluator,
        // and the model the provider named.
        let model = stream_model(&raw);
        match outcome {
            InlineOutcome::Block => {
                warn!(
                    request_id = %request_id,
                    %reason,
                    "inline evaluator: blocked outbound response (streaming)"
                );
                state.metrics.inc_firewall_blocked();
                audit_inline_evaluator(&state, &ctx, &model, &evaluator, "blocked", &reason);
                return (
                    Body::from(sse_content_frames(&format!(
                        "[Ryu firewall] Response blocked by evaluator '{evaluator}': {reason}."
                    ))),
                    crate::concurrency::AdmissionPermit::none(),
                );
            }
            InlineOutcome::Sanitize => {
                let (body, sanitized) = evaluator_sanitized_reply(resolved.as_ref(), &raw, &policy);
                // Fail closed: a Sanitize evaluator whose detector still
                // matches the redacted reply blocks instead of replaying it,
                // and so does a flag (a judge's) that redaction rewrote
                // nothing for.
                let survivor = sanitized.as_deref().and_then(|sanitized| {
                    (sanitized == assembled)
                        .then(|| format!("{reason}: flagged content could not be redacted"))
                        .or_else(|| output_sanitize_survivor(&state, resolved.as_ref(), sanitized))
                });
                if let Some(survivor) = survivor {
                    warn!(
                        request_id = %request_id,
                        %survivor,
                        "inline evaluator: match survived Sanitize; blocked (streaming)"
                    );
                    state.metrics.inc_firewall_blocked();
                    audit_inline_evaluator(&state, &ctx, &model, &evaluator, "blocked", &survivor);
                    return (
                        Body::from(sse_content_frames(&format!(
                            "[Ryu firewall] Response blocked by evaluator: {survivor}."
                        ))),
                        crate::concurrency::AdmissionPermit::none(),
                    );
                }
                warn!(
                    request_id = %request_id,
                    %reason,
                    "inline evaluator: sanitized outbound response (streaming)"
                );
                audit_inline_evaluator(&state, &ctx, &model, &evaluator, "sanitized", &reason);
                return (
                    Body::from(body),
                    crate::concurrency::AdmissionPermit::none(),
                );
            }
            InlineOutcome::Warn => warn!(
                request_id = %request_id,
                evaluator = %evaluator,
                %reason,
                "inline evaluator: outbound flagged (warn-and-continue, streaming)"
            ),
            InlineOutcome::Allow => {}
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
