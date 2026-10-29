use super::*;

/// Run `body` through `observer`, which fires at stream end to:
///  1. Parse real token counts from the terminal usage frame (if any).
///  2. Emit an eval score for sampled requests.
///  3. Write a single audit row with the real counts (defer-to-end pattern).
///
/// The observer sits before the outbound firewall wrapper, so client-visible
/// block/sanitize frames cannot erase original provider usage or reported cost. The SSE frames are passed through
/// byte-for-byte; the terminal usage chunk is NOT stripped (clients that
/// requested `include_usage` should receive it; clients that did not will
/// receive a bonus usage-only chunk that well-behaved parsers ignore).
pub(super) fn observe_stream(body: Body, mut observer: StreamObserverState) -> Body {
    use futures_util::StreamExt;

    observer.inner = body.into_data_stream();
    let init = observer;

    let stream = futures_util::stream::unfold(init, |mut s| async move {
        match s.inner.next().await {
            Some(Ok(bytes)) => {
                if let Some(span) = s.model_span.as_mut() {
                    span.record_first_chunk();
                }
                s.accumulated.push_str(&String::from_utf8_lossy(&bytes));
                Some((Ok(bytes), s))
            }
            Some(Err(e)) => {
                if let Some(span) = s.model_span.as_mut() {
                    span.record_error("stream_error");
                }
                Some((Err(std::io::Error::other(e.to_string())), s))
            }
            None => {
                if !s.done {
                    s.done = true;
                    // Parse real token counts from the assembled SSE; estimate
                    // whichever count the provider did not report (no usage
                    // frame, or a non-conforming provider). Output is never
                    // settled as zero when text was streamed.
                    let usage = s.usage();
                    let (input_tokens, output_tokens) = (usage.input_tokens, usage.output_tokens);
                    let total_tokens = input_tokens.saturating_add(output_tokens);
                    let latency_ms = s.start.elapsed().as_millis() as u64;

                    // Update audit token totals (in-memory, for rate/reporting).
                    s.state.audit.add_tokens(&s.ctx.api_key, total_tokens);
                    s.state.metrics.add_tokens(input_tokens, output_tokens);
                    // Settle the TPM bucket with the stream's real usage. The
                    // pre-admission check consumed only the prompt estimate, so
                    // charge the remainder here (same key derivation as the
                    // non-streaming check). The bytes are already delivered, so
                    // this cannot reject — it carries the overage as bucket debt
                    // that gates subsequent admissions instead.
                    s.settle_token_limits(total_tokens);
                    // Provider-side prompt-cache reads and writes (OpenRouter
                    // cache path). Both come off the terminal usage frame.
                    let cache_read_reported = sse_parse_cached_tokens_reported(&s.accumulated);
                    if let Some(cached_tokens) = cache_read_reported.filter(|tokens| *tokens > 0) {
                        s.state.metrics.add_cached_tokens(cached_tokens);
                    }
                    let cache_write_reported =
                        sse_parse_cache_write_tokens_reported(&s.accumulated);
                    if let Some(cache_write_tokens) =
                        cache_write_reported.filter(|tokens| *tokens > 0)
                    {
                        s.state.metrics.add_cache_write_tokens(cache_write_tokens);
                    }
                    let cache_usage = usage.cache;

                    // Eval scoring at stream end: synthesise a minimal usage
                    // response so the scorer can compute token_efficiency.
                    let eval_score = if s.state.evals.should_sample() {
                        let synthetic = json!({
                            "usage": {
                                "prompt_tokens": input_tokens,
                                "completion_tokens": output_tokens
                            }
                        });
                        // policy_pass=true: outbound firewall already ran on
                        // this stream; if it had blocked, we'd never reach
                        // stream end with content.
                        let eval = s.state.evals.score(latency_ms, &synthetic, true);
                        if let Some(ref e) = eval {
                            s.state
                                .evals
                                .record_provider_score(&s.provider_name, e.overall);
                        }
                        eval.map(|e| e.overall)
                    } else {
                        None
                    };
                    crate::online_evals::maybe_enqueue_stream(
                        &s.state,
                        &s.ctx,
                        s.online_prompt.as_deref(),
                        &s.accumulated,
                        &s.model,
                        &s.provider_name,
                    );
                    let reported_cost = s.reported_cost();
                    let provider_cost_micro_usd = reported_cost.and_then(cost_usd_to_micro);
                    // Budget counters and the (spawned) wallet debit, holding
                    // the credit claim until the debit resolves.
                    s.settle_billing(&usage, reported_cost, latency_ms);

                    info!(
                        request_id = %s.ctx.request_id,
                        provider = %s.provider_name,
                        model = %s.model,
                        input_tokens,
                        output_tokens,
                        cache_read_tokens = ?cache_read_reported,
                        cache_write_tokens = ?cache_write_reported,
                        latency_ms,
                        eval_score = ?eval_score,
                        "streaming request completed"
                    );

                    // Write the audit row once at stream end with real counts
                    // (defer-to-end pattern — no zero row at stream start).
                    s.state.log_audit(AuditRecord {
                        request_id: s.ctx.request_id.clone(),
                        api_key: s.ctx.api_key.clone(),
                        user_name: s.ctx.user_name.clone(),
                        org_id: s.ctx.org_id.clone(),
                        team_id: s.ctx.team_id.clone(),
                        team_ids: s.ctx.audit_team_ids(),
                        key_id: s.ctx.key_id(),
                        project_id: s.ctx.project_id.clone(),
                        provider: s.provider_name.clone(),
                        model: s.model.clone(),
                        input_tokens,
                        output_tokens,
                        cache_read_tokens: cache_usage.map(|usage| usage.read_tokens),
                        cache_write_tokens: cache_usage.map(|usage| usage.write_tokens),
                        cache_hit: false,
                        prompt_cache_outcome: Some(s.prompt_cache_outcome.as_str().to_owned()),
                        prompt_cache_read_tokens: cache_read_reported,
                        prompt_cache_write_tokens: cache_write_reported,
                        cache_write_1h_tokens: cache_usage.map(|usage| usage.write_1h_tokens),
                        latency_ms,
                        eval_score,
                        error: None,
                        skill_ids: s.ctx.skill_ids.clone(),
                        session_id: s.ctx.session_id.clone(),
                        user_id: s.ctx.user_id.clone(),
                        agent_id: s.ctx.agent_id.clone(),
                        feature: s.ctx.feature.clone(),
                        purpose: s.ctx.purpose.clone(),
                        managed_inference: s.ctx.managed_inference,
                        provider_cost_micro_usd,
                        event_type: crate::audit::EventType::ModelCall,
                        backend: None,
                        command: None,
                        duration_ms: None,
                        exit_code: None,
                        widget_instance_id: None,
                    });

                    // OTel GenAI model-call span, streaming path: ends here, at
                    // upstream stream end, with the reported usage and metadata.
                    if let Some(span) = s.model_span.take() {
                        gen_ai_telemetry::finish_stream(span, &s.accumulated);
                    }
                    crate::ryu_analytics::emit_model_call(
                        "chat",
                        &s.provider_name,
                        &s.model,
                        input_tokens,
                        output_tokens,
                        latency_ms,
                        "ok",
                        None,
                    );
                }
                None
            }
        }
    });

    Body::from_stream(stream)
}

/// Wrap an SSE body so a held [`crate::concurrency::AdmissionPermit`] is released
/// only when the stream finishes (or is dropped — e.g. the client disconnects).
/// This keeps a streaming generation counted against the local engine's slot
/// budget for its entire duration, not just until the response headers arrive.
///
/// Uses the same `stream::unfold` technique as [`attach_stream_observer`] to
/// avoid the `async-stream` macro: the permit lives in the unfold state, so when
/// the stream yields `None` (or the `Body` is dropped) the state — and the permit
/// — drops, freeing the slot for the next waiter.
pub(super) fn hold_admission_until_stream_end(
    body: Body,
    permit: crate::concurrency::AdmissionPermit,
) -> Body {
    hold_until_stream_end(body, permit)
}

/// Keep `held` alive for exactly as long as `body` is being consumed.
///
/// The generic version of the admission-slot hold: the engine slot and a pool
/// lease are claims taken before the first byte and owed back after the last
/// one, and "after the last one" on a streaming response is not when the
/// handler returns.
///
/// The credit reservation is NOT held here. It moves into the stream
/// observer's spawned debit task and is released when that debit resolves, so
/// the claim cannot lapse between the last byte and the debit landing, and a
/// client hang-up cannot cancel the debit.
///
/// Dropping the returned body without draining it (a client disconnect, an axum
/// shutdown) drops `held` too, which is the point: there is no path that keeps
/// the claim.
pub(super) fn hold_until_stream_end<T: Send + 'static>(body: Body, held: T) -> Body {
    use futures_util::StreamExt;

    struct Hold<T> {
        inner: axum::body::BodyDataStream,
        // Dropped with the stream → releases whatever it was holding.
        _held: T,
    }

    let init = Hold {
        inner: body.into_data_stream(),
        _held: held,
    };

    let stream = futures_util::stream::unfold(init, |mut s| async move {
        let item = s.inner.next().await?;
        Some((item, s))
    });

    Body::from_stream(stream)
}
