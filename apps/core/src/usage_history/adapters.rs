use super::UsageRecord;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn string(v: &Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512)
        .map(str::to_owned)
}
pub(super) fn count(v: &Value, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| {
        v.get(*name)
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            })
            .filter(|n| *n <= 1_000_000_000_000)
    })
}
pub(super) fn timestamp(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|t| t.with_timezone(&Utc).to_rfc3339());
    }
    let n = v.as_i64()?;
    DateTime::from_timestamp_millis(n).map(|t| t.to_rfc3339())
}

#[derive(Default)]
pub(super) struct ParseState {
    ordinal: u64,
    session: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    totals: Option<Value>,
    fork_timestamp: Option<String>,
    inherited_history: bool,
    pub pending_records: Vec<UsageRecord>,
}

pub(super) fn parse(
    source: &str,
    v: &Value,
    file_identity: &str,
    state: &mut ParseState,
) -> Option<UsageRecord> {
    let ordinal = state.ordinal;
    state.ordinal = state.ordinal.saturating_add(1);
    // Tokscale's explicit Antigravity sync cache is already usage metadata;
    // reading it never discovers credentials or calls the local language server.
    if source == "antigravity" {
        match v.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                state.model = string(v, "modelId");
                return None;
            }
            Some("usage") => {}
            _ => return None,
        }
        if v.get("timestamp")
            .and_then(Value::as_i64)
            .is_none_or(|n| n <= 0)
        {
            return None;
        }
        let mut r = base(source, v, v, v, file_identity, state)?;
        r.session_id = string(v, "sessionId")?;
        r.model_id = string(v, "modelId").or_else(|| state.model.clone());
        r.provider_id = string(v, "providerId");
        r.input_tokens = count(v, &["input"]);
        let output = count(v, &["output"]);
        r.reasoning_tokens = count(v, &["reasoning"]);
        r.output_tokens = output.map(|n| n.saturating_add(r.reasoning_tokens.unwrap_or(0)));
        r.cache_read_tokens = count(v, &["cacheRead"]);
        // The upstream sync writer currently hardcodes cacheWrite: 0, rather
        // than retaining an authoritative cache-creation counter.
        r.cache_write_tokens = None;
        if r.input_tokens.is_none() && output.is_none() && r.cache_read_tokens.is_none() {
            return None;
        }
        r.event_id = string(v, "responseId")
            .or_else(|| string(v, "messageId"))
            .unwrap_or_else(|| digest(&format!("{}:{}", r.session_id, r.timestamp)));
        return Some(r);
    }
    // Retained Grok JSON-RPC completed updates contain measured request usage.
    // Legacy cumulative totalTokens lacks a split and is deliberately skipped.
    if source == "grok" {
        if v.get("method").and_then(Value::as_str) != Some("session/update")
            || v.pointer("/params/update/sessionUpdate")
                .and_then(Value::as_str)
                != Some("turn_completed")
        {
            return None;
        }
        let usage = v.pointer("/params/update/usage")?;
        let params = v.get("params")?;
        let mut event = serde_json::json!({
            "sessionId": params.get("sessionId")?,
            "timestamp": params.pointer("/_meta/agentTimestampMs")?
        });
        event["model"] = usage.get("model").cloned().unwrap_or(Value::Null);
        let mut record = base(source, &event, &event, usage, file_identity, state)?;
        record.provider_id = Some("xai".to_owned());
        record.model_id = usage
            .get("modelUsage")
            .and_then(Value::as_object)
            .filter(|models| models.len() == 1)
            .and_then(|models| models.keys().next().cloned());
        record.input_tokens = count(usage, &["inputTokens", "input_tokens", "promptTokens"]);
        record.output_tokens = count(
            usage,
            &["outputTokens", "output_tokens", "completionTokens"],
        );
        if record.input_tokens.is_none() && record.output_tokens.is_none() {
            return None;
        }
        record.cache_read_tokens = count(
            usage,
            &[
                "cachedReadTokens",
                "cacheReadTokens",
                "cache_read_input_tokens",
            ],
        );
        record.cache_write_tokens = count(
            usage,
            &[
                "cachedWriteTokens",
                "cacheWriteTokens",
                "cacheCreationTokens",
                "cache_creation_input_tokens",
            ],
        );
        if record
            .input_tokens
            .zip(record.cache_read_tokens)
            .is_some_and(|(input, cache)| cache > input)
        {
            return None;
        }
        record.input_tokens = record
            .input_tokens
            .map(|n| n.saturating_sub(record.cache_read_tokens.unwrap_or(0)));
        record.reasoning_tokens = count(
            usage,
            &["reasoningTokens", "thoughtTokens", "thinkingTokens"],
        );
        record.event_id = string(params.get("_meta")?, "eventId")
            .unwrap_or_else(|| digest(&format!("{}:{}", record.session_id, record.timestamp)));
        return Some(record);
    }
    if source == "copilot" {
        let mut normalized_attrs = serde_json::Map::new();
        let raw_attrs = v.get("attributes")?;
        if let Some(items) = raw_attrs.as_array() {
            for item in items {
                let Some(key) = item.get("key").and_then(Value::as_str) else {
                    continue;
                };
                let value = item.get("value")?;
                let decoded = value
                    .get("stringValue")
                    .cloned()
                    .or_else(|| {
                        value
                            .get("intValue")
                            .and_then(|n| {
                                n.as_u64()
                                    .or_else(|| n.as_str().and_then(|n| n.parse::<u64>().ok()))
                            })
                            .map(Value::from)
                    })
                    .or_else(|| value.get("doubleValue").cloned());
                if let Some(value) = decoded {
                    normalized_attrs.insert(key.to_owned(), value);
                }
            }
        }
        let normalized_attrs = Value::Object(normalized_attrs);
        let attrs = if raw_attrs.is_array() {
            &normalized_attrs
        } else {
            raw_attrs
        };
        if attrs
            .get("gen_ai.operation.name")
            .and_then(Value::as_str)
            .is_some_and(|op| !matches!(op, "chat" | "generate_content" | "text_completion"))
        {
            return None;
        }
        let input = count(attrs, &["gen_ai.usage.input_tokens"]);
        let output = count(attrs, &["gen_ai.usage.output_tokens"]);
        if input.is_none() && output.is_none() {
            return None;
        }
        let mut event = v.clone();
        let nano_time = v
            .get("endTimeUnixNano")
            .and_then(|n| {
                n.as_u64()
                    .or_else(|| n.as_str().and_then(|n| n.parse::<u64>().ok()))
            })
            .map(|n| Value::from(n / 1_000_000));
        let tuple_time = v
            .get("endTime")
            .and_then(Value::as_array)
            .and_then(|t| {
                t.first()?
                    .as_u64()?
                    .checked_mul(1000)?
                    .checked_add(t.get(1)?.as_u64()? / 1_000_000)
            })
            .map(Value::from);
        event["timestamp"] = v
            .get("timestamp")
            .or_else(|| v.get("endTime").filter(|t| !t.is_array()))
            .cloned()
            .or(nano_time)
            .or(tuple_time)?;
        let mut r = base(source, &event, attrs, attrs, file_identity, state)?;
        r.input_tokens = input;
        r.output_tokens = output;
        r.cache_read_tokens = count(
            attrs,
            &[
                "gen_ai.usage.cache_read.input_tokens",
                "gen_ai.usage.cached_input_tokens",
            ],
        );
        r.cache_write_tokens = count(
            attrs,
            &[
                "gen_ai.usage.cache_creation.input_tokens",
                "gen_ai.usage.cache_write.input_tokens",
            ],
        );
        r.input_tokens = r.input_tokens.map(|n| {
            n.saturating_sub(r.cache_read_tokens.unwrap_or(0))
                .saturating_sub(r.cache_write_tokens.unwrap_or(0))
        });
        r.cached_output_tokens = count(attrs, &["gen_ai.usage.cached_output_tokens"]);
        r.reasoning_tokens = count(attrs, &["gen_ai.usage.reasoning_tokens"]);
        r.model_id = string(attrs, "gen_ai.response.model")
            .or_else(|| string(attrs, "gen_ai.request.model"));
        r.provider_id = string(attrs, "gen_ai.provider.name");
        r.session_id = string(attrs, "gen_ai.conversation.id")
            .or_else(|| string(attrs, "session.id"))
            .unwrap_or_else(|| file_identity.to_owned());
        r.event_id = string(v, "spanId").or_else(|| string(v, "span_id"))?;
        return Some(r);
    }
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let payload = v.get("payload").unwrap_or(v);
    if source == "codex" {
        if kind == "session_meta" {
            state.session = string(payload, "id");
            state.provider = string(payload, "model_provider");
            state.inherited_history = string(payload, "parent_thread_id").is_some()
                && payload
                    .get("subagent_history_start_ordinal")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n > 0);
            if payload.get("forked_from_id").is_some_and(|v| !v.is_null()) {
                state.fork_timestamp = v.get("timestamp").and_then(timestamp);
            }
            return None;
        }
        if kind == "turn_context" {
            state.model = string(payload, "model").or_else(|| state.model.clone());
            return None;
        }
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            return None;
        }
        let info = payload.get("info")?;
        let total = info.get("total_token_usage");
        let mut retained_baseline = None;
        let usage = if let Some(total) = total {
            let previous = state.totals.replace(total.clone());
            let mut delta = serde_json::Map::new();
            let first_inherited = previous.is_none() && state.inherited_history;
            let last = if first_inherited {
                info.get("last_token_usage").filter(|last| {
                    [
                        "input_tokens",
                        "output_tokens",
                        "cached_input_tokens",
                        "reasoning_output_tokens",
                    ]
                    .iter()
                    .all(|key| {
                        total.get(*key).and_then(Value::as_u64).is_none_or(|total| {
                            last.get(*key)
                                .and_then(Value::as_u64)
                                .is_some_and(|last| last <= total)
                        })
                    })
                })
            } else {
                None
            };
            let mut baseline = serde_json::Map::new();
            for key in [
                "input_tokens",
                "output_tokens",
                "cached_input_tokens",
                "reasoning_output_tokens",
            ] {
                if let Some(n) = total.get(key).and_then(Value::as_u64) {
                    let before = previous
                        .as_ref()
                        .and_then(|p| p.get(key))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if n < before {
                        state.totals = previous;
                        return None;
                    }
                    delta.insert(key.to_owned(), Value::from(n - before));
                    if first_inherited {
                        // Missing/inconsistent last counters cannot prove a
                        // current request: retain the full observed baseline.
                        let current = last
                            .and_then(|last| last.get(key))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        baseline.insert(key.to_owned(), Value::from(n - current));
                        delta.insert(key.to_owned(), Value::from(current));
                    }
                }
            }
            if baseline.values().any(|n| n.as_u64().is_some_and(|n| n > 0)) {
                retained_baseline = Some(Value::Object(baseline));
            }
            Value::Object(delta)
        } else {
            info.get("last_token_usage")?.clone()
        };
        let mut r = base(source, v, info, &usage, file_identity, state)?;
        if state
            .fork_timestamp
            .as_ref()
            .is_some_and(|t| r.timestamp < *t)
        {
            return None;
        }
        let cache = count(&usage, &["cached_input_tokens", "cache_read_input_tokens"]);
        if count(&usage, &["input_tokens"])
            .zip(cache)
            .is_some_and(|(input, cache)| cache > input)
        {
            tracing::warn!(
                source,
                "Historical cached input exceeded inclusive input; record skipped"
            );
            return None;
        }
        r.cache_read_tokens = cache;
        r.input_tokens =
            count(&usage, &["input_tokens"]).map(|n| n.saturating_sub(cache.unwrap_or(0)));
        let identity_usage = total.unwrap_or(&usage);
        let counters: [Option<u64>; 4] = [
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "reasoning_output_tokens",
        ]
        .map(|key| identity_usage.get(key).and_then(Value::as_u64));
        r.event_id = digest(&format!("{}:{}:{counters:?}", r.session_id, r.timestamp));
        if let Some(baseline) = retained_baseline {
            let mut retained = base(source, v, info, &baseline, file_identity, state)?;
            retained.scope = "unattributed".into();
            retained.provenance = "retainedBaseline".into();
            retained.model_id = None;
            retained.provider_id = None;
            retained.reported_cost_usd = None;
            retained.cost_kind = "unknown".into();
            retained.event_id = r.event_id.clone();
            retained.cache_read_tokens = count(&baseline, &["cached_input_tokens"]);
            if retained
                .input_tokens
                .zip(retained.cache_read_tokens)
                .is_some_and(|(input, cached)| cached > input)
            {
                return None;
            }
            retained.input_tokens = retained
                .input_tokens
                .map(|n| n.saturating_sub(retained.cache_read_tokens.unwrap_or(0)));
            state.pending_records.push(retained);
            r.event_id = digest(&format!("{}:retained-current-delta", r.event_id));
        }
        if r.input_tokens.unwrap_or(0) + r.output_tokens.unwrap_or(0) + cache.unwrap_or(0) == 0 {
            return None;
        }
        return Some(r);
    }
    if kind == "session" {
        state.session = string(v, "id");
        return None;
    }
    if source == "kimi" {
        let payload = v.pointer("/message/payload")?;
        let usage = payload.get("token_usage").or_else(|| v.get("usage"))?;
        let mut normalized = v.clone();
        let seconds = v.get("timestamp")?.as_f64()?;
        normalized["timestamp"] = Value::from((seconds * 1000.0) as i64);
        let mut r = base(source, &normalized, payload, usage, file_identity, state)?;
        r.input_tokens = count(usage, &["input_other"]);
        r.cache_read_tokens = count(usage, &["input_cache_read"]);
        r.cache_write_tokens = count(usage, &["input_cache_creation"]);
        r.event_id = string(payload, "message_id")
            .unwrap_or_else(|| digest(&format!("{}:{ordinal}", r.session_id)));
        return Some(r);
    }
    if matches!(source, "cline" | "roo" | "kilo")
        && v.get("say").and_then(Value::as_str) == Some("api_req_started")
    {
        let text = v.get("text")?.as_str()?;
        if text.len() > 2 * 1024 * 1024 {
            return None;
        }
        let usage: Value = serde_json::from_str(text).ok()?;
        let mut event = v.clone();
        event["timestamp"] = v.get("ts")?.clone();
        let mut r = base(source, &event, &usage, &usage, file_identity, state)?;
        r.input_tokens = count(&usage, &["tokensIn"]);
        r.output_tokens = count(&usage, &["tokensOut"]);
        r.cache_read_tokens = count(&usage, &["cacheReads"]);
        r.cache_write_tokens = count(&usage, &["cacheWrites"]);
        r.model_id = v
            .pointer("/modelInfo/modelId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        r.provider_id = v
            .pointer("/modelInfo/providerId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| string(&usage, "apiProtocol"));
        r.event_id = digest(&format!("{}:{}", r.session_id, r.timestamp));
        return Some(r);
    }
    if source == "cline"
        && v.get("role").and_then(Value::as_str) == Some("assistant")
        && v.get("metrics").is_some()
    {
        let usage = v.get("metrics")?;
        let mut event = v.clone();
        event["timestamp"] = v.get("ts")?.clone();
        let mut r = base(source, &event, usage, usage, file_identity, state)?;
        r.input_tokens = count(usage, &["inputTokens"]);
        r.output_tokens = count(usage, &["outputTokens"]);
        r.cache_read_tokens = count(usage, &["cacheReadTokens"]);
        r.cache_write_tokens = count(usage, &["cacheWriteTokens"]);
        r.input_tokens = r.input_tokens.map(|n| {
            n.saturating_sub(r.cache_read_tokens.unwrap_or(0))
                .saturating_sub(r.cache_write_tokens.unwrap_or(0))
        });
        r.model_id = v
            .pointer("/modelInfo/id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        r.provider_id = v
            .pointer("/modelInfo/provider")
            .and_then(Value::as_str)
            .map(str::to_owned);
        r.event_id =
            string(v, "id").unwrap_or_else(|| digest(&format!("{}:{}", r.session_id, r.timestamp)));
        return Some(r);
    }
    let message = v.get("message").unwrap_or(v);
    if source == "claude-code" && kind != "assistant" {
        return None;
    }
    if matches!(source, "pi" | "openclaw" | "omp" | "senpi")
        && message.get("role").and_then(Value::as_str) != Some("assistant")
    {
        return None;
    }
    if matches!(source, "opencode" | "kilo")
        && v.get("role").and_then(Value::as_str) != Some("assistant")
    {
        return None;
    }
    if source == "gemini" && v.get("type").and_then(Value::as_str) != Some("gemini") {
        return None;
    }
    let usage = message
        .get("usage")
        .or_else(|| message.get("tokens"))
        .or_else(|| message.get("usageMetadata"))?;
    let mut r = base(source, v, message, usage, file_identity, state)?;
    r.event_id = string(message, "responseId")
        .or_else(|| string(message, "id"))
        .or_else(|| string(v, "uuid"))
        .or_else(|| string(v, "id"))
        .unwrap_or_else(|| digest(&format!("{}:{ordinal}", r.session_id)));
    if matches!(source, "gemini" | "qwen") {
        r.input_tokens = count(usage, &["input", "promptTokenCount"]);
        let thoughts = count(usage, &["thoughts", "thoughtsTokenCount"]);
        r.reasoning_tokens = thoughts;
        r.output_tokens = count(usage, &["output", "candidatesTokenCount"])
            .map(|n| n.saturating_add(thoughts.unwrap_or(0)));
        r.cache_read_tokens = count(usage, &["cached", "cachedContentTokenCount"]);
        let inclusive_total = r.input_tokens.zip(r.output_tokens).map(|(input, output)| {
            input
                .saturating_add(output)
                .saturating_add(count(usage, &["tool"]).unwrap_or(0))
        });
        let input_includes_cache = usage.get("promptTokenCount").is_some()
            || count(usage, &["total"])
                .zip(inclusive_total)
                .is_some_and(|(total, inclusive)| total == inclusive);
        if input_includes_cache {
            r.input_tokens = r
                .input_tokens
                .map(|n| n.saturating_sub(r.cache_read_tokens.unwrap_or(0)));
        }
    }
    Some(r)
}

fn base(
    source: &str,
    v: &Value,
    message: &Value,
    usage: &Value,
    file_identity: &str,
    state: &ParseState,
) -> Option<UsageRecord> {
    let time = v
        .get("timestamp")
        .or_else(|| v.get("time").and_then(|t| t.get("created")))
        .or_else(|| message.get("timestamp"))?;
    let cost = message
        .get("cost")
        .or_else(|| usage.get("cost"))
        .and_then(|c| {
            c.as_f64()
                .or_else(|| c.get("total").and_then(Value::as_f64))
        })
        .filter(|n| n.is_finite() && *n >= 0.0);
    Some(UsageRecord {
        account_id: None,
        scope: "session".to_owned(),
        bucket_seconds: None,
        request_count: None,
        source_id: source.to_owned(),
        provider_id: string(message, "providerID")
            .or_else(|| string(message, "provider_id"))
            .or_else(|| string(v, "provider_id"))
            .or_else(|| string(message, "provider"))
            .or_else(|| state.provider.clone())
            .or_else(|| match source {
                "codex" => Some("openai".to_owned()),
                "claude-code" => Some("anthropic".to_owned()),
                "gemini" => Some("google".to_owned()),
                _ => None,
            }),
        model_id: string(message, "modelID")
            .or_else(|| string(message, "model"))
            .or_else(|| state.model.clone()),
        session_id: string(v, "sessionId")
            .or_else(|| string(v, "sessionID"))
            .or_else(|| state.session.clone())
            .unwrap_or_else(|| file_identity.to_owned()),
        event_id: String::new(),
        timestamp: timestamp(time)?,
        input_tokens: count(usage, &["input_tokens", "input"]),
        output_tokens: if source == "opencode" {
            // OpenCode stores text output and reasoning disjointly. Its getUsage
            // subtracts reasoning from SDK output; Ryu output includes both.
            count(usage, &["output_tokens", "output"]).and_then(|output| {
                output.checked_add(
                    count(usage, &["reasoning_output_tokens", "reasoning"]).unwrap_or(0),
                )
            })
        } else {
            count(usage, &["output_tokens", "output"])
        },
        cache_read_tokens: count(
            usage,
            &[
                "cache_read_input_tokens",
                "cacheRead",
                "cacheReadInputTokens",
            ],
        )
        .or_else(|| usage.pointer("/cache/read").and_then(Value::as_u64)),
        cache_write_tokens: count(
            usage,
            &[
                "cache_creation_input_tokens",
                "cacheWrite",
                "cacheCreationInputTokens",
            ],
        )
        .or_else(|| usage.pointer("/cache/write").and_then(Value::as_u64)),
        cached_output_tokens: count(usage, &["cached_output_tokens"]),
        reasoning_tokens: count(usage, &["reasoning_output_tokens", "reasoning"]),
        reported_cost_usd: cost,
        cost_kind: if cost.is_some() {
            "sourceEstimate"
        } else {
            "unknown"
        }
        .to_owned(),
        provenance: "localHistory".to_owned(),
    })
}
