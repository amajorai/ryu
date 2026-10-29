use super::*;

/// Build the `data-ryu-stats` part carrying per-message inference statistics
/// (tokens/sec, token counts, time-to-first-token), or `None` when there is
/// nothing meaningful to show.
///
/// Mirrors Jan AI's calculation: the token speed is llama.cpp's
/// `timings.predicted_per_second` when present, falling back to
/// `completion_tokens / generation_seconds`. Token counts prefer the engine's
/// reported numbers (`timings.predicted_n`/`usage.completion_tokens`) over a
/// streamed-delta count, which is only a last resort (a delta is not a token).
/// `ttft_ms` is the wall-clock from stream open to the first content delta;
/// `duration_ms` is first delta → completion (the generation window), so the
/// fallback speed excludes prompt-processing time exactly as Jan does.
pub(crate) fn derive_cache_miss_tokens(
    input_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
) -> Option<u64> {
    let (Some(input), Some(read), Some(write)) =
        (input_tokens, cache_read_tokens, cache_write_tokens)
    else {
        return None;
    };
    Some(input.saturating_sub(read.saturating_add(write)))
}

/// Below this, a multi-token reply's generation window means it was not
/// streamed (see `build_stats_part`).
const UNSTREAMED_REPLY_WINDOW: std::time::Duration = std::time::Duration::from_millis(20);

/// Wall-clock an ACP turn spent waiting on its tools — running them and any
/// permission prompt in between — rather than generating. ACP reports tokens
/// for the whole turn, so dividing them by the full turn time made a turn that
/// ran a two-minute build look like a 2 tok/s model.
#[derive(Default)]
pub(crate) struct ToolPauseClock {
    pub(crate) open: std::collections::HashSet<String>,
    paused_since: Option<std::time::Instant>,
    paused: Vec<(std::time::Instant, std::time::Instant)>,
}

impl ToolPauseClock {
    pub(crate) fn tool_started(&mut self, id: &str, now: std::time::Instant) {
        if self.open.is_empty() {
            self.paused_since = Some(now);
        }
        self.open.insert(id.to_owned());
    }

    /// Only terminal statuses close the call; progress updates keep it open.
    pub(crate) fn tool_updated(&mut self, id: &str, status: &str, now: std::time::Instant) {
        if !matches!(status, "completed" | "failed") || !self.open.remove(id) {
            return;
        }
        if self.open.is_empty() {
            if let Some(since) = self.paused_since.take() {
                self.paused.push((since, now));
            }
        }
    }

    /// Generating time inside `[from, now]`: the window minus every tool pause
    /// overlapping it (a still-open call counts up to `now`).
    pub(crate) fn active_between(
        &self,
        from: std::time::Instant,
        now: std::time::Instant,
    ) -> std::time::Duration {
        let window = now.saturating_duration_since(from);
        let paused = self
            .paused
            .iter()
            .copied()
            .chain(self.paused_since.map(|since| (since, now)))
            .map(|(start, end)| end.min(now).saturating_duration_since(start.max(from)))
            .sum::<std::time::Duration>();
        window.saturating_sub(paused)
    }
}

pub(crate) fn build_stats_part(
    stream_open: std::time::Instant,
    first_token_at: Option<std::time::Instant>,
    stream_end: std::time::Instant,
    delta_count: u64,
    last_timings: &Option<Value>,
    last_usage: &Option<Value>,
) -> Option<Vec<u8>> {
    build_stats_value(
        stream_open,
        first_token_at,
        stream_end,
        delta_count,
        last_timings,
        last_usage,
    )
    .map(|stats| ui_data("ryu-stats", &stats))
}

/// The `data-ryu-stats` payload, or `None` when the turn produced nothing worth
/// showing. Separate from [`build_stats_part`] so the same value can be sealed
/// into the persisted message parts.
pub(crate) fn build_stats_value(
    stream_open: std::time::Instant,
    first_token_at: Option<std::time::Instant>,
    stream_end: std::time::Instant,
    delta_count: u64,
    last_timings: &Option<Value>,
    last_usage: &Option<Value>,
) -> Option<Value> {
    let now = stream_end;
    let timings_f = |key: &str| {
        last_timings
            .as_ref()
            .and_then(|t| t.get(key))
            .and_then(Value::as_f64)
    };
    let usage_u = |key: &str| {
        last_usage
            .as_ref()
            .and_then(|u| u.get(key))
            .and_then(Value::as_u64)
    };
    // Nested OpenAI usage details: cached prompt tokens live under
    // `prompt_tokens_details.cached_tokens`, reasoning tokens under
    // `completion_tokens_details.reasoning_tokens`. Providers that don't report
    // them (llama.cpp, most local engines) simply omit the fields.
    let usage_nested = |outer: &str, inner: &str| {
        last_usage
            .as_ref()
            .and_then(|u| u.get(outer))
            .and_then(|d| d.get(inner))
            .and_then(Value::as_u64)
    };

    // llama.cpp reports prompt tokens reused from its KV cache as `cache_n`;
    // `prompt_n` counts only the tokens it had to evaluate.
    let llama_cache_n = timings_f("cache_n").map(|n| n as u64);
    let cached_tokens = usage_nested("prompt_tokens_details", "cached_tokens")
        .or_else(|| usage_nested("input_tokens_details", "cached_tokens"))
        .or_else(|| usage_u("cached_tokens"))
        // Anthropic-shaped top-level counter (Kiro).
        .or_else(|| usage_u("cache_read_input_tokens"))
        .or(llama_cache_n);
    let cache_write_tokens = usage_nested("prompt_tokens_details", "cache_write_tokens")
        .or_else(|| usage_nested("prompt_tokens_details", "cache_creation_input_tokens"))
        .or_else(|| usage_nested("input_tokens_details", "cache_write_tokens"))
        .or_else(|| usage_u("cache_write_tokens"))
        .or_else(|| usage_u("cache_creation_input_tokens"));
    let reasoning_tokens = usage_nested("completion_tokens_details", "reasoning_tokens")
        .or_else(|| usage_nested("output_tokens_details", "reasoning_tokens"));

    let prompt_tokens = timings_f("prompt_n")
        .map(|n| n as u64 + llama_cache_n.unwrap_or(0))
        .or_else(|| usage_u("prompt_tokens"))
        .or_else(|| usage_u("input_tokens"));
    let completion_tokens = timings_f("predicted_n")
        .map(|n| n as u64)
        .or_else(|| usage_u("completion_tokens"))
        .or_else(|| usage_u("output_tokens"))
        .unwrap_or(delta_count);
    let cache_miss_tokens =
        derive_cache_miss_tokens(prompt_tokens, cached_tokens, cache_write_tokens);
    let total_tokens =
        usage_u("total_tokens").or_else(|| Some(prompt_tokens.unwrap_or(0) + completion_tokens));

    // Generation window: first output token → stream end. TTFT: request sent →
    // first output token (text or reasoning).
    //
    // A reply that arrived in one piece — the gateway's buffered tool loop, or
    // any upstream that does not stream — has a ~0 ms generation window, and
    // dividing by it reported absurd speeds. Its tokens were produced during
    // the wait, so the whole request time is the honest window.
    let ttft_ms = first_token_at.map(|t| t.duration_since(stream_open).as_millis() as u64);
    let duration_ms = first_token_at.map(|t| {
        let streamed = now.duration_since(t);
        let window = if streamed < UNSTREAMED_REPLY_WINDOW && completion_tokens > 1 {
            now.duration_since(stream_open)
        } else {
            streamed
        };
        window.as_millis() as u64
    });

    let round2 = |v: f64| (v * 100.0).round() / 100.0;
    let duration_sec = duration_ms.unwrap_or(0) as f64 / 1000.0;
    let tokens_per_second = match timings_f("predicted_per_second") {
        Some(tps) if tps > 0.0 => round2(tps),
        _ if duration_sec > 0.0 && completion_tokens > 0 => {
            round2(completion_tokens as f64 / duration_sec)
        }
        _ => 0.0,
    };
    let prompt_per_second = timings_f("prompt_per_second")
        .filter(|v| *v > 0.0)
        .map(round2);

    // Nothing worth showing (e.g. an empty/aborted turn): omit the part entirely,
    // mirroring Jan's `if speed === 0 && count === 0 return null`.
    if tokens_per_second == 0.0 && completion_tokens == 0 {
        return None;
    }

    let mut stats = serde_json::Map::new();
    stats.insert(
        "tokensPerSecond".into(),
        serde_json::json!(tokens_per_second),
    );
    if let Some(pps) = prompt_per_second {
        stats.insert("promptPerSecond".into(), serde_json::json!(pps));
    }
    stats.insert(
        "completionTokens".into(),
        serde_json::json!(completion_tokens),
    );
    if let Some(pt) = prompt_tokens {
        stats.insert("promptTokens".into(), serde_json::json!(pt));
        stats.insert("inputTokens".into(), serde_json::json!(pt));
    }
    if let Some(ct) = cached_tokens {
        stats.insert("cachedTokens".into(), serde_json::json!(ct));
        stats.insert("cacheReadTokens".into(), serde_json::json!(ct));
    }
    if let Some(cw) = cache_write_tokens {
        stats.insert("cacheWriteTokens".into(), serde_json::json!(cw));
    }
    if let Some(cm) = cache_miss_tokens {
        stats.insert("cacheMissTokens".into(), serde_json::json!(cm));
    }
    if let Some(rt) = reasoning_tokens {
        stats.insert("reasoningTokens".into(), serde_json::json!(rt));
    }
    if let Some(tt) = total_tokens {
        stats.insert("totalTokens".into(), serde_json::json!(tt));
    }
    stats.insert("outputTokens".into(), serde_json::json!(completion_tokens));
    if let Some(d) = duration_ms {
        stats.insert("durationMs".into(), serde_json::json!(d));
    }
    if let Some(ttft) = ttft_ms {
        stats.insert("ttftMs".into(), serde_json::json!(ttft));
    }
    if let Some(usage) = last_usage.as_ref() {
        for key in [
            "context_window",
            "contextWindow",
            "current_usage",
            "currentUsage",
            "cost",
            "costAmount",
            "costCurrency",
            "currency",
        ] {
            if let Some(value) = usage.get(key) {
                stats.insert(key.to_owned(), value.clone());
            }
        }
        let cost_amount = usage
            .get("costAmount")
            .and_then(Value::as_f64)
            .or_else(|| usage.get("cost_amount").and_then(Value::as_f64))
            .or_else(|| usage.get("cost").and_then(Value::as_f64))
            .or_else(|| {
                usage
                    .get("cost")
                    .and_then(Value::as_object)
                    .and_then(|cost| {
                        cost.get("amount")
                            .or_else(|| cost.get("value"))
                            .and_then(Value::as_f64)
                    })
            });
        if let Some(amount) = cost_amount {
            stats.insert("costAmount".into(), serde_json::json!(amount));
        }
        if let Some(currency) = usage
            .get("costCurrency")
            .and_then(Value::as_str)
            .or_else(|| usage.get("currency").and_then(Value::as_str))
            .or_else(|| {
                usage
                    .get("cost")
                    .and_then(Value::as_object)
                    .and_then(|cost| cost.get("currency"))
                    .and_then(Value::as_str)
            })
        {
            stats.insert("costCurrency".into(), serde_json::json!(currency));
        }
    }
    if let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        stats.insert(
            "observedAt".into(),
            serde_json::json!(elapsed.as_millis() as u64),
        );
    }
    Some(Value::Object(stats))
}
