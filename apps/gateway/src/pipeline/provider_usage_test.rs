use super::*;

#[test]
fn cache_usage_is_read_from_both_provider_vocabularies() {
    // OpenAI / OpenRouter shape.
    let oai = json!({ "usage": { "prompt_tokens_details": {
        "cached_tokens": 900, "cache_write_tokens": 100 } } });
    assert_eq!(provider_cached_tokens(&oai), 900);
    assert_eq!(provider_cache_write_tokens(&oai), 100);

    // Anthropic-native shape.
    let ant = json!({ "usage": {
        "cache_read_input_tokens": 42, "cache_creation_input_tokens": 7 } });
    assert_eq!(provider_cached_tokens(&ant), 42);
    assert_eq!(provider_cache_write_tokens(&ant), 7);

    // Uncached responses stay at zero (no phantom counters).
    let plain = json!({ "usage": { "prompt_tokens": 10 } });
    assert_eq!(provider_cached_tokens(&plain), 0);
    assert_eq!(provider_cache_write_tokens(&plain), 0);
    assert_eq!(provider_cache_usage(&plain), None);
    assert_eq!(provider_cached_tokens_reported(&plain), None);
    assert_eq!(provider_cache_write_tokens_reported(&plain), None);

    let reported_miss = json!({ "usage": { "prompt_tokens": 10,
        "prompt_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 } } });
    assert_eq!(
        provider_cache_usage(&reported_miss),
        Some(ProviderCacheUsage {
            read_tokens: 0,
            write_tokens: 0,
            write_1h_tokens: 0,
        })
    );

    // A one-hour write split, in either vocabulary.
    let split = json!({ "usage": { "prompt_tokens_details": {
        "cached_tokens": 0, "cache_write_tokens": 100, "cache_write_1h_tokens": 60 } } });
    assert_eq!(
        provider_cache_usage(&split).map(|u| u.write_1h_tokens),
        Some(60)
    );
    let native = json!({ "usage": { "cache_creation_input_tokens": 100,
        "cache_creation": { "ephemeral_5m_input_tokens": 40,
                            "ephemeral_1h_input_tokens": 60 } } });
    assert_eq!(
        provider_cache_usage(&native),
        Some(ProviderCacheUsage {
            read_tokens: 0,
            write_tokens: 100,
            write_1h_tokens: 60,
        })
    );
}

#[test]
fn stream_cache_usage_is_read_from_the_terminal_frame() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
        "data: {\"usage\":{\"prompt_tokens\":1000,\"prompt_tokens_details\":",
        "{\"cached_tokens\":900,\"cache_write_tokens\":100}}}\n\n",
        "data: [DONE]\n\n",
    );
    assert_eq!(sse_parse_cached_tokens(sse), 900);
    assert_eq!(sse_parse_cache_write_tokens(sse), 100);
    assert_eq!(sse_parse_cached_tokens_reported(sse), Some(900));
    assert_eq!(sse_parse_cache_write_tokens_reported(sse), Some(100));
    assert_eq!(
        sse_parse_cache_usage(sse),
        Some(ProviderCacheUsage {
            read_tokens: 900,
            write_tokens: 100,
            write_1h_tokens: 0,
        })
    );
}

#[test]
fn stream_cache_usage_preserves_reported_zero_as_a_miss() {
    let sse = concat!(
        "data: {\"usage\":{\"prompt_tokens_details\":",
        "{\"cached_tokens\":0,\"cache_write_tokens\":0}}}\n\n",
        "data: [DONE]\n\n",
    );
    assert_eq!(sse_parse_cached_tokens_reported(sse), Some(0));
    assert_eq!(sse_parse_cache_write_tokens_reported(sse), Some(0));
}

/// inject_stream_usage_option adds include_usage=true to the body.
/// A second call must not overwrite an existing value (idempotent).
#[test]
fn inject_stream_usage_option_adds_field_and_is_idempotent() {
    let mut body = json!({ "model": "gpt-4o", "messages": [] });
    inject_stream_usage_option(&mut body);
    assert_eq!(body["stream_options"]["include_usage"], json!(true));

    // Calling again must not change anything.
    inject_stream_usage_option(&mut body);
    assert_eq!(body["stream_options"]["include_usage"], json!(true));
}

/// A client cannot switch the usage frame off: metered streams are billed
/// from it, so a client `false` (or a malformed `stream_options`) is
/// overwritten.
#[test]
fn inject_stream_usage_option_overrides_a_client_opt_out() {
    let mut body = json!({
        "model": "gpt-4o",
        "stream_options": { "include_usage": false, "custom_field": 1 }
    });
    inject_stream_usage_option(&mut body);
    assert_eq!(body["stream_options"]["include_usage"], json!(true));
    assert_eq!(body["stream_options"]["custom_field"], json!(1));

    let mut malformed = json!({ "model": "gpt-4o", "stream_options": "off" });
    inject_stream_usage_option(&mut malformed);
    assert_eq!(malformed["stream_options"]["include_usage"], json!(true));
}

/// Output estimates count generated text, not SSE framing, and never fall
/// to zero for bytes the provider did send.
#[test]
fn sse_estimate_output_tokens_counts_generated_text_only() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"abcdefgh\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"wxyz\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":",
        "{\"name\":\"get\",\"arguments\":\"{\\\"a\\\":1}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
    );
    // 8 content + 4 reasoning + 3 name + 7 arguments = 22 chars -> 6 tokens.
    assert_eq!(sse_estimate_output_tokens(sse), 6);
    assert_eq!(sse_estimate_output_tokens(""), 0);
    // Undecodable output still costs something.
    assert_eq!(sse_estimate_output_tokens("data: not json\n\n"), 4);
}

/// inject_stream_usage_option preserves existing stream_options fields.
#[test]
fn inject_stream_usage_option_preserves_existing_stream_options() {
    let mut body = json!({
        "model": "gpt-4o",
        "stream_options": { "custom_field": 42 }
    });
    inject_stream_usage_option(&mut body);
    assert_eq!(body["stream_options"]["include_usage"], json!(true));
    // Original field must survive.
    assert_eq!(body["stream_options"]["custom_field"], json!(42));
}

/// sse_parse_usage extracts prompt_tokens and completion_tokens from the
/// terminal OpenAI usage frame. This is the recorded SSE fixture for AC2.
#[test]
fn sse_parse_usage_extracts_from_terminal_usage_frame() {
    // Recorded SSE fixture: two content delta chunks + terminal usage chunk
    // + DONE, as emitted by OpenAI when stream_options.include_usage=true.
    let raw = concat!(
        "data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",",
        "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",",
        "\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n",
        // Terminal usage frame: choices is empty, usage carries the real counts.
        "data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",",
        "\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8,\"total_tokens\":20}}\n\n",
        "data: [DONE]\n\n"
    );

    let (input, output) = sse_parse_usage(raw);
    assert_eq!(
        input, 12,
        "prompt_tokens must be parsed from the terminal usage frame"
    );
    assert_eq!(
        output, 8,
        "completion_tokens must be parsed from the terminal usage frame"
    );
}

/// sse_parse_usage returns (0, 0) when the provider emits no usage frame,
/// so the caller can fall back to the prompt estimate.
#[test]
fn sse_parse_usage_returns_zeros_when_no_usage_frame_present() {
    let raw = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (input, output) = sse_parse_usage(raw);
    assert_eq!(input, 0);
    assert_eq!(output, 0);
}

/// sse_parse_usage ignores malformed lines and picks the last usage frame.
#[test]
fn sse_parse_usage_handles_malformed_lines_and_multiple_usage_frames() {
    let raw = concat!(
        ": keep-alive\n\n",
        "data: not-json\n\n",
        // First usage frame with lower counts.
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n",
        // Second usage frame wins (last non-zero wins).
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":10}}\n\n",
        "data: [DONE]\n\n"
    );
    let (input, output) = sse_parse_usage(raw);
    // Last non-zero frame wins.
    assert_eq!(input, 20);
    assert_eq!(output, 10);
}

/// sse_parse_cost pulls OpenRouter's `usage.cost` from the terminal frame.
#[test]
fn sse_parse_cost_extracts_reported_cost() {
    let raw = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8,",
        "\"cost\":0.0023}}\n\n",
        "data: [DONE]\n\n"
    );
    assert_eq!(sse_parse_cost(raw), Some(0.0023));
}

/// No `usage.cost` (non-OpenRouter provider) → None, so the debit falls back
/// to the flat token estimate.
#[test]
fn sse_parse_cost_absent_returns_none() {
    let raw = concat!(
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n",
        "data: [DONE]\n\n"
    );
    assert_eq!(sse_parse_cost(raw), None);
}

#[test]
fn response_upstream_provider_uses_the_selected_openrouter_endpoint() {
    let response = json!({
        "openrouter_metadata": {
            "endpoints": { "available": [
                { "provider": "Azure", "selected": false },
                { "provider": "Google Vertex", "selected": true }
            ]}
        }
    });
    assert_eq!(
        response_upstream_provider(&response).as_deref(),
        Some("Google Vertex")
    );
}

#[test]
fn response_upstream_provider_reads_metadata_from_image_wrapper() {
    let response = json!({
        "raw": {
            "openrouter_metadata": {
                "endpoints": { "available": [
                    { "provider": "Azure", "selected": true }
                ]}
            }
        }
    });
    assert_eq!(
        response_upstream_provider(&response).as_deref(),
        Some("Azure")
    );
}

#[test]
fn stream_upstream_provider_reads_routing_metadata_from_sse() {
    let raw = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
        "data: {\"openrouter_metadata\":{\"endpoints\":{\"available\":[",
        "{\"provider\":\"Azure\",\"selected\":true}]}}}\n\n",
        "data: [DONE]\n\n"
    );
    assert_eq!(sse_parse_openrouter_provider(raw).as_deref(), Some("Azure"));
}

/// cost_usd_to_micro converts dollars to micro-USD and rejects junk values.
#[test]
fn cost_usd_to_micro_converts_and_rejects_negative_or_nonfinite() {
    assert_eq!(cost_usd_to_micro(0.0023), Some(2300));
    assert_eq!(cost_usd_to_micro(1.0), Some(1_000_000));
    assert_eq!(cost_usd_to_micro(0.0), Some(0));
    assert_eq!(cost_usd_to_micro(-1.0), None);
    assert_eq!(cost_usd_to_micro(f64::NAN), None);
    assert_eq!(cost_usd_to_micro(f64::INFINITY), None);
}

#[test]
fn sse_parse_cost_preserves_a_free_provider_transaction() {
    let raw = "data: {\"usage\":{\"cost\":0}}\n\n";
    assert_eq!(sse_parse_cost(raw), Some(0.0));
    assert_eq!(cost_usd_to_micro(sse_parse_cost(raw).unwrap()), Some(0));
}

#[test]
fn usage_frames_skip_token_frames_but_keep_escaped_usage_keys() {
    let raw = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
        "data: {\"choices\":[],\"\\u0075sage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"cost\":0.5}}\n\n",
        "data: [DONE]\n\n",
    );
    assert_eq!(sse_parse_usage(raw), (7, 3));
    assert_eq!(sse_parse_cost(raw), Some(0.5));
    assert_eq!(sse_usage_frames(raw).count(), 1);
}
