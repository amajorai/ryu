//! Opt-in completed ACP turn metadata. Context occupancy is never treated as consumption.
use super::UsageRecord;
use serde_json::Value;

pub(crate) struct TurnHistory {
    account_id: Option<String>,
    event_id: String,
    source_id: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    session_id: Option<String>,
    conversation_id: Option<String>,
}

impl TurnHistory {
    pub(crate) fn new(
        agent_id: &str,
        provider_id: Option<String>,
        model_id: Option<String>,
        conversation_id: Option<String>,
    ) -> Self {
        let agent = agent_id.strip_prefix("acp:").unwrap_or(agent_id);
        let source_id = match agent {
            "codex" => "codex",
            "claude" | "claude-code" => "claude-code",
            "opencode" => "opencode",
            "gemini" => "gemini",
            "pi" | "ryu" => "pi",
            _ if !agent.is_empty()
                && agent.len() <= 128
                && agent.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                }) =>
            {
                agent
            }
            _ => "ryu-acp",
        }
        .to_owned();
        Self {
            account_id: None,
            event_id: uuid::Uuid::new_v4().to_string(),
            source_id,
            provider_id,
            model_id,
            session_id: None,
            conversation_id,
        }
    }
    pub(crate) fn with_account_id(mut self, account_id: Option<String>) -> Self {
        self.account_id = account_id;
        self
    }
    pub(crate) fn provider_id(&self) -> Option<&str> {
        self.provider_id.as_deref()
    }
    pub(crate) fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
    }
    pub(crate) fn session_info(&mut self, info: &Value) {
        if let Some(id) = info
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 512)
        {
            self.session_id = Some(id.to_owned());
        }
    }
    pub(crate) fn annotate(&self, stats: &mut serde_json::Map<String, Value>) {
        if let Some(id) = &self.account_id {
            stats.insert("historyAccountId".into(), Value::String(id.clone()));
        }
        stats.insert(
            "historyEventId".into(),
            Value::String(format!("ryu-turn:{}", self.event_id)),
        );
        stats.insert(
            "historySourceId".into(),
            Value::String(if self.session_id.is_some() {
                self.source_id.clone()
            } else {
                "ryu-acp".into()
            }),
        );
        if let Some(id) = &self.session_id {
            stats.insert("historySessionId".into(), Value::String(id.clone()));
        }
        if let Some(id) = &self.provider_id {
            stats.insert("historyProviderId".into(), Value::String(id.clone()));
        }
        if let Some(id) = &self.model_id {
            stats.insert("historyModelId".into(), Value::String(id.clone()));
        }
    }
    pub(crate) fn record(&self, usage: &Value) {
        let Some(store) = super::http::store() else {
            return;
        };
        if !store.is_enabled().unwrap_or(false) {
            return;
        }
        let Some(record) = self.usage_record(usage) else {
            return;
        };
        if store.upsert_record(&record).is_err() {
            tracing::warn!("completed ACP usage metadata could not be recorded");
        }
    }
    fn usage_record(&self, usage: &Value) -> Option<UsageRecord> {
        if usage.get("done").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        // Only the final ACP per-turn counters are accepted. `used`, `size`,
        // `sessionTotalTokens` and session costs are cumulative or occupancy.
        let input = usage.get("promptTokens").and_then(Value::as_u64);
        let output = usage.get("completionTokens").and_then(Value::as_u64);
        let read = usage.get("cachedReadTokens").and_then(Value::as_u64);
        let write = usage.get("cachedWriteTokens").and_then(Value::as_u64);
        let cached_output = usage.get("cachedOutputTokens").and_then(Value::as_u64);
        let reasoning = usage.get("thoughtTokens").and_then(Value::as_u64);
        if [input, output, read, write, cached_output, reasoning]
            .iter()
            .all(Option::is_none)
        {
            return None;
        }
        let record = UsageRecord {
            account_id: self.account_id.clone(),
            scope: if self.session_id.is_some() {
                "session"
            } else {
                "unattributed"
            }
            .into(),
            bucket_seconds: None,
            request_count: Some(1),
            source_id: if self.session_id.is_some() {
                self.source_id.clone()
            } else {
                "ryu-acp".into()
            },
            provider_id: self.provider_id.clone(),
            model_id: self.model_id.clone(),
            session_id: self
                .session_id
                .clone()
                .or_else(|| {
                    self.conversation_id
                        .as_ref()
                        .map(|id| format!("ryu-conversation:{id}"))
                })
                .unwrap_or_else(|| format!("unbound-turn:{}", self.event_id)),
            event_id: format!("ryu-turn:{}", self.event_id),
            timestamp: chrono::Utc::now().to_rfc3339(),
            input_tokens: normalize_input(
                input,
                output,
                read,
                write,
                usage.get("totalTokens").and_then(Value::as_u64),
            ),
            output_tokens: output,
            cache_read_tokens: read,
            cache_write_tokens: write,
            cached_output_tokens: cached_output,
            reasoning_tokens: reasoning,
            reported_cost_usd: None,
            cost_kind: "unknown".into(),
            provenance: if self.session_id.is_some() {
                "live-acp-native-session"
            } else {
                "live-acp-unbound-session"
            }
            .into(),
        };
        Some(record)
    }
}

pub(super) fn normalize_input(
    input: Option<u64>,
    output: Option<u64>,
    read: Option<u64>,
    write: Option<u64>,
    total: Option<u64>,
) -> Option<u64> {
    let input = input?;
    let cache = read.unwrap_or(0).checked_add(write.unwrap_or(0))?;
    if cache == 0 {
        return Some(input);
    }
    let base = input.checked_add(output?)?;
    match total {
        Some(total) if total == base => input.checked_sub(cache),
        Some(total) if total == base.checked_add(cache)? => Some(input),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_account_identity_survives_live_record_and_annotations() {
        let mut history = TurnHistory::new("codex", Some("openai".into()), None, None)
            .with_account_id(Some("account-a".into()));
        history.session_info(&serde_json::json!({"sessionId":"native-session"}));
        let record = history
            .usage_record(&serde_json::json!({"done":true,"promptTokens":10}))
            .unwrap();
        assert_eq!(record.account_id.as_deref(), Some("account-a"));
        let mut stats = serde_json::Map::new();
        history.annotate(&mut stats);
        assert_eq!(stats["historyAccountId"], "account-a");
    }
    #[test]
    fn unbound_turns_keep_known_conversation_ids_out_of_native_totals() {
        let usage = serde_json::json!({"done":true,"promptTokens":10,"completionTokens":2});
        let history = TurnHistory::new("new-tool", None, None, Some("conversation".into()));
        let unbound = history.usage_record(&usage).unwrap();
        assert_eq!(unbound.scope, "unattributed");
        assert_eq!(unbound.session_id, "ryu-conversation:conversation");
        assert_eq!(unbound.provenance, "live-acp-unbound-session");
        let mut bound = history;
        bound.session_info(&serde_json::json!({"sessionId":"native-session"}));
        let record = bound.usage_record(&usage).unwrap();
        assert_eq!(record.scope, "session");
        assert_eq!(record.source_id, "new-tool");
        assert_eq!(record.session_id, "native-session");
    }
    #[test]
    fn reported_cache_only_usage_is_preserved_without_inventing_input_or_output() {
        let history = TurnHistory::new("codex", None, None, None);
        let record = history
            .usage_record(
                &serde_json::json!({"done":true,"cachedReadTokens":100,"cachedOutputTokens":5}),
            )
            .unwrap();
        assert_eq!(record.input_tokens, None);
        assert_eq!(record.output_tokens, None);
        assert_eq!(record.cache_read_tokens, Some(100));
        assert_eq!(record.cached_output_tokens, Some(5));
    }
    #[test]
    fn cache_semantics_are_proven_by_reported_totals() {
        assert_eq!(
            normalize_input(Some(100), Some(10), Some(70), None, Some(110)),
            Some(30)
        );
        assert_eq!(
            normalize_input(Some(100), Some(10), Some(70), None, Some(180)),
            Some(100)
        );
        assert_eq!(
            normalize_input(Some(100), Some(10), Some(70), None, None),
            None
        );
        assert_eq!(
            normalize_input(None, Some(10), Some(70), None, Some(80)),
            None
        );
    }
}
