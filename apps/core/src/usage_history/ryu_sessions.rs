//! Import saved ACP usage parts without reading conversation bodies.
use anyhow::{anyhow, Result};
use serde_json::Value;

use super::{ImportReport, UsageHistoryStore, UsageRecord};

pub(crate) async fn import(
    state: &crate::server::ServerState,
    max_messages: usize,
) -> Result<ImportReport> {
    let store = super::http::store().ok_or_else(|| anyhow!("Usage history unavailable"))?;
    import_from_conversations(&store, &state.conversations, max_messages).await
}

pub(crate) async fn import_from_conversations(
    store: &UsageHistoryStore,
    conversations: &crate::server::conversations::ConversationStore,
    max_messages: usize,
) -> Result<ImportReport> {
    let maximum = max_messages.clamp(1, 10000);
    let cursor = store.get_session_import_cursor()?;
    let rows = conversations
        .usage_metadata_page(cursor, maximum + 1)
        .await?;
    let has_more = rows.len() > maximum;
    let mut report = ImportReport {
        has_more,
        ..ImportReport::default()
    };
    let mut last = cursor;
    for (rowid, message_id, conversation_id, _agent_id, created_at, parts) in
        rows.into_iter().take(maximum)
    {
        report.scanned_files += 1;
        for (index, part) in parts.into_iter().enumerate() {
            let Some(record) = normalize(&part, &message_id, &conversation_id, created_at, index)
            else {
                continue;
            };
            match store.upsert_record(&record) {
                Ok(true) => report.imported_records += 1,
                Ok(false) => report.duplicate_records += 1,
                Err(_) => {
                    report.error_count += 1;
                    if report.errors.len() < 20 {
                        report
                            .errors
                            .push("Saved Ryu usage metadata could not be imported".into());
                    }
                }
            }
        }
        last = rowid;
    }
    // A completed pass resets so a later import observes parts updated on existing message rows.
    // In-progress passes retain their row cursor across restart; event identities make replay safe.
    store.set_session_import_cursor(if has_more { last } else { 0 })?;
    Ok(report)
}

fn identity(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}

fn normalize(
    value: &Value,
    message_id: &str,
    conversation_id: &str,
    created_at: i64,
    index: usize,
) -> Option<UsageRecord> {
    if value.get("done").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let input = value.get("promptTokens").and_then(Value::as_u64);
    let output = value.get("completionTokens").and_then(Value::as_u64);
    // Older generic stats used stream-chunk count as an output fallback. That count
    // is not provider token usage; only accept it with actual input or live identity.
    if value.get("usagePartType").and_then(Value::as_str) == Some("data-ryu-stats")
        && input.is_none()
        && identity(value, "historyEventId").is_none()
    {
        return None;
    }
    let read = value
        .get("cachedReadTokens")
        .or_else(|| value.get("cacheReadTokens"))
        .and_then(Value::as_u64);
    let write = value
        .get("cachedWriteTokens")
        .or_else(|| value.get("cacheWriteTokens"))
        .and_then(Value::as_u64);
    let cached_output = value.get("cachedOutputTokens").and_then(Value::as_u64);
    let reasoning = value
        .get("thoughtTokens")
        .or_else(|| value.get("reasoningTokens"))
        .and_then(Value::as_u64);
    if [input, output, read, write, cached_output, reasoning]
        .iter()
        .all(Option::is_none)
    {
        return None;
    }
    let event_id = identity(value, "historyEventId")
        .unwrap_or_else(|| format!("ryu-message:{message_id}:{index}"));
    let native_session = identity(value, "historySessionId");
    let source_id = identity(value, "historySourceId").unwrap_or_else(|| "ryu-acp".to_owned());
    let session_id = native_session
        .clone()
        .unwrap_or_else(|| format!("ryu-conversation:{conversation_id}"));
    let milliseconds = value
        .get("observedAt")
        .and_then(Value::as_i64)
        .unwrap_or(created_at);
    let timestamp = chrono::DateTime::from_timestamp_millis(milliseconds)?.to_rfc3339();
    Some(UsageRecord {
        account_id: identity(value, "historyAccountId"),
        source_id,
        provider_id: identity(value, "historyProviderId")
            .or_else(|| identity(value, "providerId"))
            .or_else(|| identity(value, "provider")),
        model_id: identity(value, "historyModelId")
            .or_else(|| identity(value, "modelId"))
            .or_else(|| identity(value, "model")),
        session_id,
        event_id,
        timestamp,
        input_tokens: super::live::normalize_input(
            input,
            output,
            read,
            write,
            value.get("totalTokens").and_then(Value::as_u64),
        ),
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: write,
        cached_output_tokens: cached_output,
        reasoning_tokens: reasoning,
        reported_cost_usd: None,
        cost_kind: "unknown".to_owned(),
        provenance: if native_session.is_some() {
            "live-acp-native-session"
        } else {
            "live-acp-unbound-session"
        }
        .to_owned(),
        scope: if native_session.is_some() {
            "session"
        } else {
            "unattributed"
        }
        .to_owned(),
        bucket_seconds: None,
        request_count: Some(1),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn captured_account_identity_survives_saved_turn_readback() {
        let row = super::normalize(&serde_json::json!({"done":true,"historyEventId":"ryu-turn:account","historyAccountId":"account-a","historySourceId":"codex","historySessionId":"native","promptTokens":10}), "message", "conversation", 1700000000000, 0).unwrap();
        assert_eq!(row.account_id.as_deref(), Some("account-a"));
        assert_eq!(row.session_id, "native");
    }
    use super::*;
    use serde_json::json;
    #[test]
    fn saved_cache_counters_stay_unattributed_without_native_identity() {
        let row = normalize(&json!({"done":true,"historyEventId":"ryu-turn:cache","cachedReadTokens":10,"cachedOutputTokens":2}), "message", "conversation", 1700000000000, 0).unwrap();
        assert_eq!(row.scope, "unattributed");
        assert_eq!(row.session_id, "ryu-conversation:conversation");
        assert_eq!(row.input_tokens, None);
        assert_eq!(row.output_tokens, None);
        assert_eq!(row.cache_read_tokens, Some(10));
        assert_eq!(row.cached_output_tokens, Some(2));
    }
    #[test]
    fn saved_turn_preserves_live_identity_and_never_imports_session_cost() {
        let row=normalize(&json!({"done":true,"historyEventId":"ryu-turn:abc","historySourceId":"codex","historySessionId":"native","historyProviderId":"openai","promptTokens":100,"completionTokens":10,"cachedReadTokens":70,"totalTokens":110,"sessionCostAmount":99,"observedAt":1700000000000i64}),"m","c",0,0).unwrap();
        assert_eq!(row.event_id, "ryu-turn:abc");
        assert_eq!(row.session_id, "native");
        assert_eq!(row.input_tokens, Some(30));
        assert_eq!(row.reported_cost_usd, None);
        assert_eq!(row.provenance, "live-acp-native-session");
    }
    #[test]
    fn occupancy_and_incomplete_turns_do_not_become_usage() {
        assert!(normalize(
            &json!({"used":100,"size":200,"sessionTotalTokens":400}),
            "m",
            "c",
            0,
            0
        )
        .is_none());
        assert!(normalize(
            &json!({"done":false,"promptTokens":100,"completionTokens":10}),
            "m",
            "c",
            0,
            0
        )
        .is_none());
        let row = normalize(
            &json!({"historyEventId":"ryu-turn:abc","promptTokens":100}),
            "m",
            "c",
            1700000000000,
            0,
        )
        .unwrap();
        assert_eq!(row.session_id, "ryu-conversation:c");
        assert_eq!(row.scope, "unattributed");
        assert_eq!(row.output_tokens, None);
    }

    #[tokio::test]
    async fn bounded_saved_import_resumes_and_replays_without_growth() {
        use crate::server::conversations::{ConversationStore, Tenancy};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let store = UsageHistoryStore::open(&path).unwrap();
        let conversations = ConversationStore::open_in_memory().unwrap();
        conversations
            .ensure_conversation("history-resume", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        for index in 0..2 {
            let id = conversations
                .append_message_as(
                    "history-resume",
                    "assistant",
                    "body excluded",
                    None,
                    None,
                    None,
                    Tenancy::Unattributed,
                )
                .await
                .unwrap();
            conversations.update_message_parts(&id, &json!([{"type":"data-acp-usage","data":{"done":true,"promptTokens":10,"completionTokens":3,"historyEventId":format!("ryu-turn:{index}"),"observedAt":1700000000000i64}}]).to_string()).await.unwrap();
        }
        let first = import_from_conversations(&store, &conversations, 1)
            .await
            .unwrap();
        assert!(first.has_more);
        assert_eq!(first.imported_records, 1);
        drop(store);
        let reopened = UsageHistoryStore::open(&path).unwrap();
        let second = import_from_conversations(&reopened, &conversations, 1)
            .await
            .unwrap();
        assert!(!second.has_more);
        assert_eq!(second.imported_records, 1);
        let replay = import_from_conversations(&reopened, &conversations, 10)
            .await
            .unwrap();
        assert_eq!(replay.imported_records, 0);
        assert_eq!(replay.duplicate_records, 2);
        let summary = reopened
            .summary(
                &super::super::HistoryQuery {
                    scope: Some("unattributed".into()),
                    ..Default::default()
                },
                &std::collections::BTreeMap::new(),
            )
            .unwrap();
        assert_eq!(summary.records, 2);
        assert_eq!(summary.totals.input_tokens, 20);
        assert_eq!(summary.sessions, 1);
        assert_eq!(
            reopened
                .summary(
                    &super::super::HistoryQuery::default(),
                    &std::collections::BTreeMap::new()
                )
                .unwrap()
                .records,
            0
        );
    }
}
