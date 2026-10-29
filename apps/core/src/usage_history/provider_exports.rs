//! Metadata-only normalizers for official provider exports. No network or credential access.
use anyhow::{bail, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::UsageRecord;

const MAX_ROWS: usize = 100_000;
const MAX_TOKENS: u64 = 1_000_000_000_000;

pub(super) fn parse_scoped(
    source: &str,
    value: &Value,
    provenance: &str,
    account_id: &str,
) -> Result<Vec<UsageRecord>> {
    if source == "usage-metadata" {
        return parse(source, value, provenance);
    }
    namespace(parse(source, value, provenance)?, account_id)
}

pub(super) fn parse_csv_scoped(
    source: &str,
    input: &str,
    provenance: &str,
    account_id: &str,
) -> Result<Vec<UsageRecord>> {
    namespace(parse_csv(source, input, provenance)?, account_id)
}

fn namespace(mut records: Vec<UsageRecord>, account_id: &str) -> Result<Vec<UsageRecord>> {
    if account_id.trim() != account_id
        || account_id.is_empty()
        || account_id.len() > 512
        || account_id.chars().any(char::is_control)
    {
        bail!("a stable account identifier is required")
    }
    for record in &mut records {
        record.account_id = Some(account_id.to_owned());
        record.event_id = fingerprint(&json!([account_id, record.event_id]));
        record.session_id = fingerprint(&json!([account_id, record.session_id]));
    }
    Ok(records)
}

pub(super) fn parse_csv(source: &str, input: &str, provenance: &str) -> Result<Vec<UsageRecord>> {
    if source != "cursor-account" {
        bail!("CSV is supported only for Cursor dashboard exports")
    }
    let table = csv_rows(input)?;
    let Some(headers) = table.first() else {
        bail!("CSV export is empty")
    };
    let field = |row: &[String], name: &str| -> Option<String> {
        headers
            .iter()
            .position(|h| h.trim_start_matches('\u{feff}').trim() == name)
            .and_then(|i| row.get(i))
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    };
    if !headers
        .iter()
        .any(|h| h.trim_start_matches('\u{feff}').trim() == "Date")
        || !headers.iter().any(|h| h.trim() == "Model")
    {
        bail!("unrecognized Cursor CSV headers")
    }
    let mut output = Vec::new();
    let mut occurrences = std::collections::HashMap::<String, u64>::new();
    for cells in table
        .iter()
        .skip(1)
        .filter(|r| r.iter().any(|s| !s.is_empty()))
    {
        if cells.len() != headers.len() {
            bail!("CSV row has unexpected field count")
        }
        let date = field(cells, "Date").ok_or_else(|| anyhow::anyhow!("CSV row requires Date"))?;
        let date = if date.len() == 10 {
            format!("{date}T00:00:00Z")
        } else {
            date
        };
        let mut row = record(
            source,
            "cursor",
            timestamp(&Value::String(date), true)?,
            provenance,
        );
        row.scope = "account".to_owned();
        row.model_id = field(cells, "Model");
        let csv_count = |name: &str| -> Result<Option<u64>> {
            let Some(value) = field(cells, name).filter(|s| s != "-") else {
                return Ok(None);
            };
            let number = value
                .replace(',', "")
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_TOKENS);
            number
                .map(Some)
                .ok_or_else(|| anyhow::anyhow!("invalid CSV token count"))
        };
        row.input_tokens = csv_count("Input (w/o Cache Write)")?;
        row.cache_write_tokens = csv_count("Input (w/ Cache Write)")?;
        row.cache_read_tokens = csv_count("Cache Read")?;
        row.output_tokens = csv_count("Output Tokens")?;
        row.request_count = Some(1);
        let cost_to_you = field(cells, "Cost to you");
        let cost = cost_to_you.clone().or_else(|| field(cells, "Cost"));
        if let Some(cost) = cost.filter(|s| !matches!(s.as_str(), "Included" | "-")) {
            row.reported_cost_usd = money(&Value::String(cost.replace(['$', ','], "")))?;
            row.cost_kind = if cost_to_you.is_some() {
                "billed"
            } else {
                "source-reported"
            }
            .to_owned();
        }
        let key = fingerprint(&json!([
            row.timestamp,
            row.model_id,
            field(cells, "Kind"),
            field(cells, "User"),
            field(cells, "Email"),
            field(cells, "Cloud Agent ID"),
            field(cells, "Automation ID"),
            row.input_tokens,
            row.output_tokens,
            row.cache_read_tokens,
            row.cache_write_tokens
        ]));
        let ordinal = occurrences.entry(key.clone()).or_default();
        row.event_id = format!("{key}:{ordinal}");
        *ordinal += 1;
        row.session_id = field(cells, "Conversation ID")
            .or_else(|| field(cells, "Cloud Agent ID"))
            .unwrap_or_else(|| format!("account:{}", row.event_id));
        output.push(row);
    }
    Ok(output)
}

/// Bounded RFC 4180 field decoding, including escaped quotes and embedded line breaks.
fn csv_rows(input: &str) -> Result<Vec<Vec<String>>> {
    if input.len() > 32 * 1024 * 1024 {
        bail!("CSV export exceeds size limit")
    }
    let mut table = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut closed = false;
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                field.push(character);
            }
        } else {
            match character {
                '"' if field.is_empty() && !closed => quoted = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                    closed = false;
                }
                '\r' | '\n' => {
                    if character == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    row.push(std::mem::take(&mut field));
                    table.push(std::mem::take(&mut row));
                    closed = false;
                    if table.len() > MAX_ROWS + 1 {
                        bail!("CSV export exceeds row limit")
                    }
                }
                _ if closed || character == '"' => bail!("malformed CSV quoting"),
                _ => field.push(character),
            }
        }
        if row.len() > 100 || field.len() > 16 * 1024 {
            bail!("CSV field exceeds limit")
        }
    }
    if quoted {
        bail!("unterminated CSV quoted field")
    }
    if !row.is_empty() || !field.is_empty() || closed {
        row.push(field);
        table.push(row);
    }
    if table.len() > MAX_ROWS + 1 {
        bail!("CSV export exceeds row limit")
    }
    Ok(table)
}

pub(super) fn parse(source: &str, value: &Value, provenance: &str) -> Result<Vec<UsageRecord>> {
    match source {
        "openai-org-usage" | "openai-org-costs" => buckets(source, value, provenance, true),
        "anthropic-org-usage" | "anthropic-org-costs" => buckets(source, value, provenance, false),
        "cursor-account" => cursor(value, provenance),
        "claude-code-analytics" => claude_analytics(value, provenance),
        "usage-metadata" => metadata(value, provenance),
        _ => bail!("unsupported provider export format"),
    }
}

fn rows<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    let values = value.get(key).unwrap_or(value).as_array();
    let Some(values) = values else {
        bail!("export must contain an array of metadata rows")
    };
    if values.len() > MAX_ROWS {
        bail!("export exceeds metadata row limit")
    }
    Ok(values)
}

fn count(value: &Value, key: &str) -> Result<Option<u64>> {
    let Some(value) = value.get(key).filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let Some(number) = value.as_u64().filter(|n| *n <= MAX_TOKENS) else {
        bail!("invalid token or request count")
    };
    Ok(Some(number))
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}

fn timestamp(value: &Value, milliseconds: bool) -> Result<String> {
    if let Some(string) = value.as_str() {
        if let Ok(time) = DateTime::parse_from_rfc3339(string) {
            return Ok(time
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true));
        }
    }
    let number = value.as_i64().or_else(|| value.as_str()?.parse().ok());
    let Some(time) = number.and_then(|n| {
        if milliseconds {
            DateTime::from_timestamp_millis(n)
        } else {
            DateTime::from_timestamp(n, 0)
        }
    }) else {
        bail!("export row has invalid timestamp")
    };
    Ok(time.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn money(value: &Value) -> Result<Option<f64>> {
    if value.is_null() {
        return Ok(None);
    }
    let amount = value.as_f64().or_else(|| value.as_str()?.parse().ok());
    let Some(amount) = amount.filter(|n| n.is_finite() && *n >= 0.0 && *n < 1_000_000_000.0) else {
        bail!("invalid reported cost")
    };
    Ok(Some(amount))
}

fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn record(source: &str, provider: &str, time: String, provenance: &str) -> UsageRecord {
    UsageRecord {
        account_id: None,
        source_id: source.to_owned(),
        provider_id: Some(provider.to_owned()),
        model_id: None,
        session_id: String::new(),
        event_id: String::new(),
        timestamp: time,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cached_output_tokens: None,
        reasoning_tokens: None,
        reported_cost_usd: None,
        cost_kind: "unknown".to_owned(),
        provenance: provenance.to_owned(),
        scope: "organization".to_owned(),
        bucket_seconds: None,
        request_count: None,
    }
}

fn buckets(
    source: &str,
    value: &Value,
    provenance: &str,
    openai: bool,
) -> Result<Vec<UsageRecord>> {
    let mut output = Vec::new();
    for bucket in rows(value, "data")? {
        let start_key = if openai { "start_time" } else { "starting_at" };
        let end_key = if openai { "end_time" } else { "ending_at" };
        let time = timestamp(&bucket[start_key], false)?;
        let end = timestamp(&bucket[end_key], false)?;
        let duration = DateTime::parse_from_rfc3339(&end)?
            .signed_duration_since(DateTime::parse_from_rfc3339(&time)?)
            .num_seconds();
        if duration <= 0 {
            bail!("invalid export bucket interval")
        }
        for item in rows(bucket, "results")? {
            if output.len() >= MAX_ROWS {
                bail!("export exceeds metadata row limit")
            }
            let mut row = record(
                source,
                if openai { "openai" } else { "anthropic" },
                time.clone(),
                provenance,
            );
            row.bucket_seconds = Some(duration as u64);
            row.model_id = text(item, "model");
            // Only grouping dimensions participate in identity, never raw conversation fields.
            let identity = json!([
                source,
                value.get("scopeId"),
                value.get("organization_id"),
                time,
                end,
                item.get("project_id"),
                item.get("workspace_id"),
                item.get("api_key_id"),
                item.get("user_id"),
                row.model_id,
                item.get("batch"),
                item.get("service_tier"),
                item.get("description"),
                item.get("line_item")
            ]);
            row.event_id = fingerprint(&identity);
            row.session_id = format!("aggregate:{}", row.event_id);
            if source.ends_with("costs") {
                row.reported_cost_usd = if openai {
                    if item["amount"]["currency"].as_str() != Some("usd") {
                        bail!("only USD cost exports are supported")
                    }
                    money(&item["amount"]["value"])?
                } else {
                    money(&item["amount"])?.map(|cents| cents / 100.0)
                };
                row.cost_kind = "billed".to_owned();
            } else if openai {
                let total = count(item, "input_tokens")?;
                let read = count(item, "input_cached_tokens")?;
                let short_write = count(item, "input_cache_write_tokens")?;
                let long_write = count(item, "input_cache_write_12h_tokens")?;
                let write = match (short_write, long_write) {
                    (None, None) => None,
                    (short, long) => Some(short.unwrap_or(0).saturating_add(long.unwrap_or(0))),
                };
                if total.is_some_and(|n| read.unwrap_or(0).saturating_add(write.unwrap_or(0)) > n) {
                    bail!("cached input exceeds total input")
                }
                row.input_tokens = count(item, "input_uncached_tokens")?.or_else(|| {
                    total.map(|n| {
                        n.saturating_sub(read.unwrap_or(0))
                            .saturating_sub(write.unwrap_or(0))
                    })
                });
                row.cache_read_tokens = read;
                row.cache_write_tokens = write;
                row.output_tokens = count(item, "output_tokens")?;
                row.request_count = count(item, "num_model_requests")?;
            } else {
                row.input_tokens = count(item, "uncached_input_tokens")?;
                row.cache_read_tokens = count(item, "cache_read_input_tokens")?;
                row.cache_write_tokens = count(item, "cache_creation_input_tokens")?;
                if row.cache_write_tokens.is_none() {
                    let short = count(&item["cache_creation"], "ephemeral_5m_input_tokens")?;
                    let long = count(&item["cache_creation"], "ephemeral_1h_input_tokens")?;
                    row.cache_write_tokens = short.zip(long).map(|(a, b)| a.saturating_add(b));
                }
                row.output_tokens = count(item, "output_tokens")?;
            }
            output.push(row);
        }
    }
    Ok(output)
}

fn cursor(value: &Value, provenance: &str) -> Result<Vec<UsageRecord>> {
    let mut output = Vec::new();
    for item in rows(value, "usageEvents")? {
        let mut row = record(
            "cursor-account",
            "cursor",
            timestamp(&item["timestamp"], true)?,
            provenance,
        );
        row.scope = "account".to_owned();
        row.model_id = text(item, "model");
        let usage = &item["tokenUsage"];
        row.input_tokens = count(usage, "inputTokens")?;
        row.output_tokens = count(usage, "outputTokens")?;
        row.cache_read_tokens = count(usage, "cacheReadTokens")?;
        row.cache_write_tokens = count(usage, "cacheWriteTokens")?;
        row.request_count = Some(1);
        // totalCents is model cost, chargedCents is the documented reconciliation field.
        row.reported_cost_usd = money(&item["chargedCents"])?.map(|n| n / 100.0);
        row.cost_kind = if item.get("isChargeable").and_then(Value::as_bool) == Some(false) {
            "subscription"
        } else if row.reported_cost_usd.is_some() {
            "billed"
        } else {
            "unknown"
        }
        .to_owned();
        row.event_id = text(item, "id").unwrap_or_else(|| {
            fingerprint(&json!([
                value.get("scopeId"),
                row.timestamp,
                row.model_id,
                item.get("userEmail"),
                item.get("serviceAccountId"),
                item.get("conversationId"),
                usage,
                item.get("kind")
            ]))
        });
        row.session_id =
            text(item, "conversationId").unwrap_or_else(|| format!("account:{}", row.event_id));
        output.push(row);
    }
    Ok(output)
}

fn claude_analytics(value: &Value, provenance: &str) -> Result<Vec<UsageRecord>> {
    let mut output = Vec::new();
    for item in rows(value, "data")? {
        let time = timestamp(&item["date"], false)?;
        for model in rows(item, "model_breakdown")? {
            if output.len() >= MAX_ROWS {
                bail!("export exceeds metadata row limit")
            }
            let mut row = record(
                "claude-code-analytics",
                "anthropic",
                time.clone(),
                provenance,
            );
            row.model_id = text(model, "model");
            row.bucket_seconds = Some(86_400);
            row.event_id = fingerprint(&json!([
                time,
                item.get("actor"),
                item.get("organization_id"),
                item.get("customer_type"),
                item.get("terminal_type"),
                item.get("is_remote"),
                row.model_id
            ]));
            row.session_id = format!("aggregate:{}", row.event_id);
            row.input_tokens = count(&model["tokens"], "input")?;
            row.output_tokens = count(&model["tokens"], "output")?;
            row.cache_read_tokens = count(&model["tokens"], "cache_read")?;
            row.cache_write_tokens = count(&model["tokens"], "cache_creation")?;
            if !model["estimated_cost"].is_null() {
                if model["estimated_cost"]["currency"].as_str() != Some("USD") {
                    bail!("only USD estimates are supported")
                }
                row.reported_cost_usd =
                    money(&model["estimated_cost"]["amount"])?.map(|cents| cents / 100.0);
                row.cost_kind = "estimated".to_owned();
            }
            // num_sessions is per actor/day, not per model. Never duplicate it on each model row.
            output.push(row);
        }
    }
    Ok(output)
}

fn metadata(value: &Value, provenance: &str) -> Result<Vec<UsageRecord>> {
    let values = if value.is_object() && value.get("records").is_none() {
        vec![value.clone()]
    } else {
        rows(value, "records")?.to_vec()
    };
    values
        .iter()
        .map(|item| {
            let mut row = record(
                "usage-metadata",
                &text(item, "providerId").unwrap_or_else(|| "unknown".to_owned()),
                timestamp(&item["timestamp"], true)?,
                provenance,
            );
            row.event_id = text(item, "eventId")
                .ok_or_else(|| anyhow::anyhow!("metadata requires stable eventId"))?;
            row.session_id = text(item, "sessionId")
                .ok_or_else(|| anyhow::anyhow!("metadata requires stable sessionId"))?;
            row.model_id = text(item, "modelId");
            row.account_id = text(item, "accountId");
            if let Some(native_source) = text(item, "sourceId") {
                if native_source.len() > 128
                    || !native_source.bytes().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-')
                    })
                {
                    bail!("invalid normalized native source identity")
                }
                row.source_id = native_source;
            }
            row.scope = text(item, "scope").unwrap_or_else(|| "session".to_owned());
            if !matches!(
                row.scope.as_str(),
                "session" | "account" | "organization" | "unattributed"
            ) {
                bail!("invalid metadata scope")
            }
            row.input_tokens = count(item, "inputTokens")?;
            row.output_tokens = count(item, "outputTokens")?;
            row.cache_read_tokens = count(item, "cacheReadTokens")?;
            row.cache_write_tokens = count(item, "cacheWriteTokens")?;
            row.cached_output_tokens = count(item, "cachedOutputTokens")?;
            row.reasoning_tokens = count(item, "reasoningTokens")?;
            row.bucket_seconds = count(item, "bucketSeconds")?;
            row.request_count = count(item, "requestCount")?;
            row.reported_cost_usd = money(&item["reportedCostUsd"])?;
            row.cost_kind = text(item, "costKind").unwrap_or_else(|| "unknown".to_owned());
            if !matches!(
                row.cost_kind.as_str(),
                "unknown"
                    | "estimated"
                    | "source-reported"
                    | "sourceEstimate"
                    | "apiEquivalent"
                    | "billed"
                    | "subscription"
            ) {
                bail!("invalid metadata cost kind")
            }
            Ok(row)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn openai_normalizes_cache_and_stable_bucket_identity() {
        let value = json!({"data":[{"start_time":1700000000,"end_time":1700086400,"results":[{"model":"gpt","input_tokens":100,"input_cached_tokens":30,"input_cache_write_tokens":10,"output_tokens":9,"num_model_requests":2}]}]});
        let rows = parse("openai-org-usage", &value, "export").unwrap();
        assert_eq!(rows[0].input_tokens, Some(60));
        assert_eq!(rows[0].scope, "organization");
        assert_eq!(rows[0].request_count, Some(2));
        let extended = json!({"data":[{"start_time":1700000000,"end_time":1700086400,"results":[{"input_tokens":1000,"input_uncached_tokens":500,"input_cached_tokens":400,"input_cache_write_tokens":75,"input_cache_write_12h_tokens":25,"output_tokens":500}]}]});
        let extended_rows = parse("openai-org-usage", &extended, "export").unwrap();
        assert_eq!(extended_rows[0].input_tokens, Some(500));
        assert_eq!(extended_rows[0].cache_write_tokens, Some(100));
        let mut refreshed = value.clone();
        refreshed["data"][0]["results"][0]["output_tokens"] = json!(20);
        assert_eq!(
            rows[0].event_id,
            parse("openai-org-usage", &refreshed, "another-file").unwrap()[0].event_id
        );
    }
    #[test]
    fn cursor_uses_charge_not_model_estimate_and_keeps_missing_counters() {
        let rows = parse("cursor-account", &json!({"usageEvents":[{"timestamp":"1750979225854","model":"sonnet","conversationId":"s","chargedCents":21.0,"tokenUsage":{"inputTokens":126,"outputTokens":450,"cacheReadTokens":100,"totalCents":20.0}}]}), "export").unwrap();
        assert_eq!(rows[0].reported_cost_usd, Some(0.21));
        assert_eq!(rows[0].input_tokens, Some(126));
        assert_eq!(rows[0].scope, "account");
        assert_eq!(rows[0].cache_write_tokens, None);
        let included = parse("cursor-account", &json!({"usageEvents":[{"timestamp":"1750979225854","model":"sonnet","chargedCents":8,"isChargeable":false}]}), "export").unwrap();
        assert_eq!(included[0].cost_kind, "subscription");
        assert_eq!(included[0].input_tokens, None);
    }
    #[test]
    fn metadata_extracts_allowlisted_fields_only() {
        let rows = parse("usage-metadata", &json!({"eventId":"e","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","inputTokens":3,"outputTokens":4,"prompt":"secret conversation","credential":"secret key"}), "export").unwrap();
        let encoded = serde_json::to_string(&rows).unwrap();
        assert!(!encoded.contains("secret"));
        let native = parse_scoped("usage-metadata", &json!({"sourceId":"ryu-acp","eventId":"e","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","inputTokens":3}), "export", "").unwrap();
        assert_eq!(native[0].source_id, "ryu-acp");
        assert_eq!(native[0].event_id, "e");
        let added_tool = parse("usage-metadata", &json!({"sourceId":"new-tool.v2:usage","eventId":"native-event","sessionId":"native-session","timestamp":"2026-01-01T00:00:00Z","inputTokens":3,"costKind":"sourceEstimate","prompt":"never retained"}), "export").unwrap();
        assert_eq!(added_tool[0].source_id, "new-tool.v2:usage");
        assert_eq!(added_tool.len(), 1);
        assert!(!serde_json::to_string(&added_tool)
            .unwrap()
            .contains("never retained"));
        assert!(parse(
            "usage-metadata",
            &json!({"eventId":"e","sessionId":"s","timestamp":0,"inputTokens":-1}),
            "export"
        )
        .is_err());
    }
    #[test]
    fn costs_do_not_invent_tokens() {
        let rows = parse("anthropic-org-costs", &json!({"data":[{"starting_at":"2026-01-01T00:00:00Z","ending_at":"2026-01-02T00:00:00Z","results":[{"amount":"123","description":"usage"}]}]}), "export").unwrap();
        assert_eq!(rows[0].reported_cost_usd, Some(1.23));
        assert_eq!(rows[0].input_tokens, None);
        assert_eq!(rows[0].cost_kind, "billed");
    }
    #[test]
    fn claude_analytics_keeps_estimated_cents_and_actor_private() {
        let rows = parse("claude-code-analytics", &json!({"data":[{"date":"2026-01-01T00:00:00Z","actor":{"email_address":"private@example.com"},"core_metrics":{"num_sessions":5},"model_breakdown":[{"model":"sonnet","tokens":{"input":10,"output":5,"cache_read":8,"cache_creation":2},"estimated_cost":{"currency":"USD","amount":25}}]}]}), "export").unwrap();
        assert_eq!(rows[0].reported_cost_usd, Some(0.25));
        assert_eq!(rows[0].cost_kind, "estimated");
        assert_eq!(rows[0].request_count, None);
        assert!(!serde_json::to_string(&rows)
            .unwrap()
            .contains("private@example.com"));
    }
    #[test]
    fn cursor_csv_handles_quotes_and_does_not_call_included_cost_a_bill() {
        let input = "Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost\r\n2026-01-01,\"Errored, No Charge\",gpt,10,5,20,3,-\r\n2026-01-02,Included,gpt,0,5,20,3,Included\r\n2026-01-03,On-Demand,gpt,0,5,20,3,$0.10\r\n";
        let rows = parse_csv("cursor-account", input, "export").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].cache_write_tokens, Some(10));
        assert_eq!(rows[1].reported_cost_usd, None);
        assert_eq!(rows[2].reported_cost_usd, Some(0.1));
        assert_eq!(rows[2].cost_kind, "source-reported");
        assert!(parse_csv("cursor-account", "Date,Model\n\"unclosed", "export").is_err());
    }
    #[test]
    fn account_namespace_separates_identical_provider_buckets() {
        let value = json!({"data":[{"start_time":1700000000,"end_time":1700086400,"results":[{"input_tokens":10,"output_tokens":5}]}]});
        let first = parse_scoped("openai-org-usage", &value, "export", "org-a").unwrap();
        let same = parse_scoped("openai-org-usage", &value, "renamed export", "org-a").unwrap();
        let second = parse_scoped("openai-org-usage", &value, "export", "org-b").unwrap();
        assert_eq!(first[0].event_id, same[0].event_id);
        assert_ne!(first[0].event_id, second[0].event_id);
        assert!(parse_scoped("openai-org-usage", &value, "export", "").is_err());
    }
}
