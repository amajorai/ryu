use super::*;

// ── per-message inference stats (build_stats_part) ────────────────────────

/// Decode the JSON `data` object out of a `data: {…}\n\n` UI-stream frame.
fn decode_stats(bytes: &[u8]) -> Value {
    let s = String::from_utf8(bytes.to_vec()).unwrap();
    let json: Value = serde_json::from_str(s.trim_start_matches("data:").trim()).unwrap();
    assert_eq!(json["type"], "data-ryu-stats");
    json["data"].clone()
}

#[test]
fn stats_prefer_llamacpp_timings() {
    // When the engine reports `timings`, its `predicted_per_second` wins over
    // any wall-clock estimate, and token counts come from `predicted_n` /
    // `prompt_n` (not the streamed-delta count).
    let timings = serde_json::json!({
        "prompt_n": 1024,
        "predicted_n": 200,
        "predicted_per_second": 42.5,
        "prompt_per_second": 350.0
    });
    let open = std::time::Instant::now();
    let first = Some(open + std::time::Duration::from_millis(120));
    let part = build_stats_part(
        open,
        first,
        std::time::Instant::now(),
        7,
        &Some(timings),
        &None,
    )
    .expect("timings produce a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["tokensPerSecond"], 42.5);
    assert_eq!(data["promptPerSecond"], 350.0);
    assert_eq!(data["completionTokens"], 200);
    assert_eq!(data["promptTokens"], 1024);
    assert_eq!(data["totalTokens"], 1224);
}

#[test]
fn stats_time_an_unstreamed_reply_over_the_whole_request() {
    // The gateway's buffered tool loop sends the reply as one chunk at the
    // end: speed must not divide by the ~0 ms between that chunk and "now".
    let usage = serde_json::json!({ "prompt_tokens": 10, "completion_tokens": 400 });
    let open = std::time::Instant::now() - std::time::Duration::from_secs(10);
    let arrived = open + std::time::Duration::from_secs(8);
    let part = build_stats_part(open, Some(arrived), arrived, 1, &None, &Some(usage))
        .expect("usage produces a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["ttftMs"], 8000);
    assert_eq!(data["durationMs"], 8000);
    assert_eq!(data["tokensPerSecond"], 50.0);
}

#[test]
fn acp_generation_time_excludes_tool_runs_and_permission_waits() {
    let start = std::time::Instant::now();
    let at = |secs: u64| start + std::time::Duration::from_secs(secs);
    let mut clock = ToolPauseClock::default();
    // Two overlapping calls 2s–10s, one progress update in between: one pause.
    clock.tool_started("a", at(2));
    clock.tool_started("b", at(3));
    clock.tool_updated("a", "in_progress", at(4));
    clock.tool_updated("a", "completed", at(5));
    clock.tool_updated("b", "failed", at(10));
    assert_eq!(clock.active_between(at(0), at(12)).as_secs(), 4);
    // A pause before the window starts is not subtracted from it.
    assert_eq!(clock.active_between(at(10), at(12)).as_secs(), 2);
    // A call still open at the turn end counts as paused up to now.
    clock.tool_started("c", at(13));
    assert_eq!(clock.active_between(at(0), at(20)).as_secs(), 5);
}

#[test]
fn stats_count_llamacpp_kv_cache_reuse_as_cached_prompt() {
    // `prompt_n` is only the evaluated tail; `cache_n` tokens were reused
    // from the KV cache and are still part of the prompt.
    let timings = serde_json::json!({
        "prompt_n": 24,
        "cache_n": 1000,
        "predicted_n": 10,
        "predicted_per_second": 30.0
    });
    let open = std::time::Instant::now();
    let part = build_stats_part(open, Some(open), open, 1, &Some(timings), &None)
        .expect("timings produce a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["promptTokens"], 1024);
    assert_eq!(data["cacheReadTokens"], 1000);
}

#[test]
fn stats_read_top_level_anthropic_cache_counters() {
    // Kiro reports Anthropic-shaped top-level cache counters.
    let usage = serde_json::json!({
        "prompt_tokens": 500,
        "completion_tokens": 20,
        "cache_read_input_tokens": 400,
        "cache_creation_input_tokens": 50
    });
    let open = std::time::Instant::now();
    let part = build_stats_part(open, Some(open), open, 1, &None, &Some(usage))
        .expect("usage produces a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["cacheReadTokens"], 400);
    assert_eq!(data["cacheWriteTokens"], 50);
}

#[test]
fn stats_time_the_generation_window_to_the_stream_end() {
    // Work after the stream closed (hooks, the transcript write) must not
    // stretch the window: TTFT 1s, generation 2s → 50 tok/s for 100 tokens.
    let usage = serde_json::json!({ "prompt_tokens": 10, "completion_tokens": 100 });
    let open = std::time::Instant::now() - std::time::Duration::from_secs(10);
    let first = open + std::time::Duration::from_secs(1);
    let end = first + std::time::Duration::from_secs(2);
    let part = build_stats_part(open, Some(first), end, 3, &None, &Some(usage))
        .expect("usage produces a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["ttftMs"], 1000);
    assert_eq!(data["durationMs"], 2000);
    assert_eq!(data["tokensPerSecond"], 50.0);
}

#[test]
fn stats_fall_back_to_usage_and_wallclock() {
    // No timings: token counts come from `usage`, speed is
    // completion_tokens / generation_seconds. delta_count is ignored when
    // usage reports a real completion count.
    let usage = serde_json::json!({
        "prompt_tokens": 50,
        "completion_tokens": 100,
        "total_tokens": 150
    });
    let open = std::time::Instant::now();
    // Generation window must be a real elapsed span; sleep 2s would be slow,
    // so we synthesize `first_token_at` 2s in the past relative to "now".
    let first = Some(std::time::Instant::now() - std::time::Duration::from_secs(2));
    let part = build_stats_part(
        open,
        first,
        std::time::Instant::now(),
        3,
        &None,
        &Some(usage),
    )
    .expect("usage produces a stats part");
    let data = decode_stats(&part);
    // ~100 tokens / ~2s ≈ 50 tok/s (allow slack for scheduling jitter).
    let tps = data["tokensPerSecond"].as_f64().unwrap();
    assert!(
        (30.0..=60.0).contains(&tps),
        "tps {tps} not in expected band"
    );
    assert_eq!(data["completionTokens"], 100);
    assert_eq!(data["totalTokens"], 150);
    assert!(data.get("promptPerSecond").is_none());
}

#[test]
fn stats_surface_cached_and_reasoning_tokens() {
    // Providers that report nested usage details (cached prompt tokens,
    // reasoning tokens) get them surfaced as `cachedTokens`/`reasoningTokens`
    // for the context-meter breakdown; llama.cpp/local (no details) omit them.
    let usage = serde_json::json!({
        "prompt_tokens": 200,
        "completion_tokens": 80,
        "total_tokens": 280,
        "prompt_tokens_details": { "cached_tokens": 128, "cache_write_tokens": 32 },
        "completion_tokens_details": { "reasoning_tokens": 32 },
        "context_window": {
            "context_window_size": 128_000,
            "current_usage": { "used": 12_000 }
        }
    });
    let open = std::time::Instant::now();
    let first = Some(std::time::Instant::now() - std::time::Duration::from_secs(2));
    let part = build_stats_part(
        open,
        first,
        std::time::Instant::now(),
        3,
        &None,
        &Some(usage),
    )
    .expect("usage produces a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["cachedTokens"], 128);
    assert_eq!(data["cacheReadTokens"], 128);
    assert_eq!(data["cacheWriteTokens"], 32);
    assert_eq!(data["cacheMissTokens"], 40);
    assert_eq!(data["reasoningTokens"], 32);
    assert_eq!(data["context_window"]["context_window_size"], 128_000);
    assert_eq!(data["context_window"]["current_usage"]["used"], 12_000);

    let incomplete = serde_json::json!({
        "prompt_tokens": 200,
        "completion_tokens": 80,
        "total_tokens": 280,
        "prompt_tokens_details": { "cached_tokens": 128 }
    });
    let part = build_stats_part(
        open,
        first,
        std::time::Instant::now(),
        3,
        &None,
        &Some(incomplete),
    )
    .expect("partial cache usage still produces a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["cacheReadTokens"], 128);
    assert!(data.get("cacheMissTokens").is_none());

    // Absent details → fields omitted entirely (not zero).
    let plain = serde_json::json!({ "prompt_tokens": 10, "completion_tokens": 5 });
    let part = build_stats_part(
        open,
        first,
        std::time::Instant::now(),
        3,
        &None,
        &Some(plain),
    )
    .expect("plain usage still produces a part");
    let data = decode_stats(&part);
    assert!(data.get("cachedTokens").is_none());
    assert!(data.get("cacheMissTokens").is_none());
    assert!(data.get("reasoningTokens").is_none());
    assert_eq!(
        derive_cache_miss_tokens(Some(1680), Some(700), Some(80)),
        Some(900)
    );
    assert_eq!(derive_cache_miss_tokens(Some(1680), Some(700), None), None);
}

#[test]
fn stats_surface_responses_cache_usage() {
    let usage = serde_json::json!({
        "input_tokens": 1680,
        "output_tokens": 80,
        "total_tokens": 1760,
        "input_tokens_details": { "cached_tokens": 700, "cache_write_tokens": 80 },
        "output_tokens_details": { "reasoning_tokens": 32 }
    });
    let open = std::time::Instant::now();
    let first = Some(std::time::Instant::now() - std::time::Duration::from_secs(2));
    let part = build_stats_part(
        open,
        first,
        std::time::Instant::now(),
        3,
        &None,
        &Some(usage),
    )
    .expect("Responses usage produces a stats part");
    let data = decode_stats(&part);
    assert_eq!(data["promptTokens"], 1680);
    assert_eq!(data["completionTokens"], 80);
    assert_eq!(data["cacheReadTokens"], 700);
    assert_eq!(data["cacheWriteTokens"], 80);
    assert_eq!(data["cacheMissTokens"], 900);
    assert_eq!(data["reasoningTokens"], 32);
}

#[test]
fn stats_omitted_when_nothing_generated() {
    // An empty/aborted turn (no tokens, no engine numbers) yields no part,
    // mirroring Jan's "hide when speed and count are both zero".
    let open = std::time::Instant::now();
    assert!(build_stats_part(open, None, std::time::Instant::now(), 0, &None, &None).is_none());
}
