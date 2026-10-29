use super::*;
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("ryu-history-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn write(&self, path: &str, lines: &[serde_json::Value]) -> PathBuf {
        let p = self.0.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            lines.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
        p
    }
    fn store(&self) -> UsageHistoryStore {
        UsageHistoryStore::open(&self.0.join("history.sqlite")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn claude(id: &str, output: u64) -> serde_json::Value {
    json!({"type":"assistant","timestamp":"2025-01-01T12:00:00Z","sessionId":"old-session","message":{"id":id,"model":"test-model","content":[{"text":"SECRET CONVERSATION"}],"usage":{"input_tokens":100,"output_tokens":output,"cache_read_input_tokens":50,"cache_creation_input_tokens":25}}})
}
#[test]
fn preinstallation_history_is_idempotent_and_private() {
    let f = Fixture::new();
    f.write(
        ".claude/projects/project/session.jsonl",
        &[claude("msg-1", 20)],
    );
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["claude-code".into()],
        ..Default::default()
    };
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .imported_records,
        1
    );
    let second = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(second.skipped_files, 1);
    assert_eq!(second.imported_records, 0);
    let report = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(report.sessions, 1);
    assert_eq!(report.totals.input_tokens, 100);
    assert_eq!(report.totals.cache_read_tokens, 50);
    let serialized =
        serde_json::to_string(&store.records(&HistoryQuery::default()).unwrap()).unwrap();
    assert!(!serialized.contains("SECRET"));
    assert!(!serialized.contains("projects"));
}
#[test]
fn streamed_and_replayed_messages_use_max_counters() {
    let f = Fixture::new();
    f.write(
        ".claude/projects/project/session.jsonl",
        &[claude("msg-1", 5), claude("msg-1", 20), claude("msg-1", 3)],
    );
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["claude-code".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let report = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(report.records, 1);
    assert_eq!(report.totals.output_tokens, 20);
}
fn codex(total: u64, time: &str) -> serde_json::Value {
    json!({"type":"event_msg","timestamp":time,"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":total,"output_tokens":20,"cached_input_tokens":40,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":999999}}}})
}
#[test]
fn codex_cumulative_counts_and_archive_copies_deduplicate() {
    let f = Fixture::new();
    let lines = vec![
        json!({"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"native-codex","model_provider":"openai"}}),
        json!({"type":"turn_context","payload":{"model":"test-model"}}),
        codex(100, "2025-01-01T12:00:00Z"),
        codex(100, "2025-01-01T12:00:01Z"),
        codex(150, "2025-01-01T12:00:02Z"),
    ];
    f.write(".codex/sessions/session.jsonl", &lines);
    f.write(".codex/archived_sessions/session.jsonl", &lines);
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["codex".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let report = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(report.sessions, 1);
    assert_eq!(report.records, 2);
    assert_eq!(report.totals.input_tokens, 110);
    assert_eq!(report.totals.cache_read_tokens, 40);
    assert_eq!(report.totals.output_tokens, 20);
    assert_eq!(report.totals.reasoning_tokens, 5);
}
#[test]
fn fork_replay_is_a_baseline_not_new_usage() {
    let f = Fixture::new();
    let lines = vec![
        json!({"type":"session_meta","timestamp":"2025-01-02T00:00:00Z","payload":{"id":"child","forked_from_id":"parent"}}),
        codex(100, "2025-01-01T12:00:00Z"),
        codex(150, "2025-01-02T12:00:00Z"),
    ];
    f.write(".codex/sessions/child.jsonl", &lines);
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["codex".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let report = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(report.totals.input_tokens, 50);
    assert_eq!(report.records, 1);
}
#[test]
fn scan_can_resume_between_files() {
    let f = Fixture::new();
    f.write(".claude/projects/p/a.jsonl", &[claude("a", 10)]);
    f.write(".claude/projects/p/b.jsonl", &[claude("b", 20)]);
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["claude-code".into()],
        max_files: Some(1),
        ..Default::default()
    };
    assert!(store.import_from_home(&request, &f.0).unwrap().has_more);
    assert!(!store.import_from_home(&request, &f.0).unwrap().has_more);
    assert_eq!(
        store
            .summary(&HistoryQuery::default(), &BTreeMap::new())
            .unwrap()
            .records,
        2
    );
}
#[test]
fn cache_prices_and_missing_rates_are_separate() {
    let f = Fixture::new();
    f.write(".claude/projects/p/a.jsonl", &[claude("a", 20)]);
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["claude-code".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let mut rates = BTreeMap::new();
    rates.insert(
        ("anthropic".into(), "test-model".into()),
        ModelRates {
            input: Some(3.0),
            output: Some(15.0),
            cache_read: Some(0.3),
            cache_write: Some(3.75),
        },
    );
    let summary = store.summary(&HistoryQuery::default(), &rates).unwrap();
    assert!((summary.estimated_cost_usd.unwrap() - 0.00070875).abs() < 1e-10);
    assert!((summary.cache_savings_usd.unwrap() - 0.000135).abs() < 1e-10);
    assert_eq!(summary.unpriced_records, 0);
    assert_eq!(summary.reported_cost_usd, None);
}
#[test]
fn opencode_sqlite_and_legacy_share_native_ids() {
    let f = Fixture::new();
    let p = f.0.join(".local/share/opencode");
    std::fs::create_dir_all(&p).unwrap();
    let data = json!({"role":"assistant","id":"msg-open","sessionID":"ses-open","modelID":"test-model","providerID":"openai","time":{"created":1735732800000i64},"tokens":{"input":100,"output":20,"cache":{"read":30,"write":5}}});
    let db = rusqlite::Connection::open(p.join("opencode.db")).unwrap();
    db.execute_batch("CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)")
        .unwrap();
    db.execute(
        "INSERT INTO message VALUES(?1,?2,?3)",
        rusqlite::params!["msg-open", "ses-open", data.to_string()],
    )
    .unwrap();
    drop(db);
    f.write(
        ".local/share/opencode/storage/message/msg-open.json",
        &[data],
    );
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["opencode".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 1);
    assert_eq!(summary.totals.cache_read_tokens, 30);
}
#[test]
fn opencode_reasoning_is_disjoint_from_saved_text_output() {
    let mut state = super::adapters::ParseState::default();
    let row = super::adapters::parse("opencode", &json!({"role":"assistant","id":"measured-message","sessionID":"session","modelID":"mimo-v2.5","time":{"created":1735732800000i64},"tokens":{"input":46823,"output":42,"reasoning":48,"cache":{"read":3,"write":0}}}), "file", &mut state).unwrap();
    assert_eq!(row.output_tokens, Some(90));
    assert_eq!(row.reasoning_tokens, Some(48));
    let fixture = Fixture::new();
    let store = fixture.store();
    assert!(store.upsert_record(&row).unwrap());
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.totals.output_tokens, 90);
    assert_eq!(summary.totals.reasoning_tokens, 48);
    assert_eq!(summary.records, 1);
}
#[test]
fn missing_explicit_path_reports_failure_without_affecting_default_discovery() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let report = store
        .import_from_home(
            &ImportRequest {
                roots: vec![ScanRoot {
                    source_id: "codex".into(),
                    path: fixture.0.join("missing").to_string_lossy().into_owned(),
                    account_id: None,
                }],
                ..Default::default()
            },
            &fixture.0,
        )
        .unwrap();
    assert_eq!(report.error_count, 1);
    assert_eq!(report.imported_records, 0);
    assert!(!report.has_more);
    assert_eq!(
        store
            .import_from_home(
                &ImportRequest {
                    source_ids: vec!["codex".into()],
                    ..Default::default()
                },
                &fixture.0
            )
            .unwrap()
            .error_count,
        0
    );
}
#[test]
fn unknown_source_and_relative_root_are_rejected() {
    let f = Fixture::new();
    let store = f.store();
    assert!(store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["imaginary".into()],
                ..Default::default()
            },
            &f.0
        )
        .is_err());
    assert!(store
        .import_from_home(
            &ImportRequest {
                roots: vec![ScanRoot {
                    source_id: "codex".into(),
                    path: "relative".into(),
                    account_id: None
                }],
                ..Default::default()
            },
            &f.0
        )
        .is_err());
}
#[test]
fn missing_counters_remain_unknown() {
    let f = Fixture::new();
    let v = json!({"type":"assistant","timestamp":"2025-01-01T00:00:00Z","message":{"id":"missing","usage":{"output_tokens":3}}});
    f.write(".claude/projects/p/a.jsonl", &[v]);
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["claude-code".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.totals.missing_input_records, 1);
    assert_eq!(summary.totals.input_tokens, 0);
    assert_eq!(summary.totals.missing_cache_read_records, 1);
    assert_eq!(summary.totals.missing_cache_write_records, 1);
    assert_eq!(summary.totals.missing_cached_output_records, 1);
    assert_eq!(summary.totals.missing_reasoning_records, 1);
    assert_eq!(summary.estimated_cost_usd, None);
}

#[test]
fn summary_distinguishes_unknown_cache_fields_from_explicit_zero() {
    let f = Fixture::new();
    let old = json!({"type":"assistant","timestamp":"2025-01-01T00:00:00Z","sessionId":"old-native","message":{"id":"unknown-cache","usage":{"input_tokens":1,"output_tokens":2}}});
    let zero = json!({"type":"assistant","timestamp":"2025-01-01T00:00:01Z","sessionId":"zero-native","message":{"id":"zero-cache","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cached_output_tokens":0,"reasoning_output_tokens":0}}});
    f.write(".claude/projects/p/cache.jsonl", &[old, zero]);
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["claude-code".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    for totals in std::iter::once(&summary.totals)
        .chain(summary.daily.iter().map(|b| &b.totals))
        .chain(summary.models.iter().map(|b| &b.totals))
        .chain(summary.sources.iter().map(|b| &b.totals))
    {
        assert_eq!(totals.cache_read_tokens, 0);
        assert_eq!(totals.cache_write_tokens, 0);
        assert_eq!(totals.cached_output_tokens, 0);
        assert_eq!(totals.reasoning_tokens, 0);
        assert_eq!(totals.missing_cache_read_records, 1);
        assert_eq!(totals.missing_cache_write_records, 1);
        assert_eq!(totals.missing_cached_output_records, 1);
        assert_eq!(totals.missing_reasoning_records, 1);
    }
}

#[test]
fn native_history_reconciles_shared_event_identity_in_either_order() {
    for live_first in [true, false] {
        let f = Fixture::new();
        f.write(".claude/projects/p/a.jsonl", &[claude("native-id", 20)]);
        let store = f.store();
        let mut live = adapters::parse(
            "claude-code",
            &claude("native-id", 20),
            "fixture",
            &mut adapters::ParseState::default(),
        )
        .unwrap();
        live.provenance = "live-acp-native-session".into();
        let request = ImportRequest {
            source_ids: vec!["claude-code".into()],
            ..Default::default()
        };
        if live_first {
            store.upsert_record(&live).unwrap();
        }
        store.import_from_home(&request, &f.0).unwrap();
        if !live_first {
            store.upsert_record(&live).unwrap();
        }
        store.import_from_home(&request, &f.0).unwrap();
        store.upsert_record(&live).unwrap();
        assert_eq!(
            store.records(&HistoryQuery::default()).unwrap()[0].provenance,
            "localHistory"
        );
        assert!(store
            .records(&HistoryQuery {
                scope: Some("unreconciled".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .summary(&HistoryQuery::default(), &BTreeMap::new())
                .unwrap()
                .records,
            1
        );
    }
}

#[test]
fn partial_native_history_preserves_distinct_live_turns_in_either_order() {
    for live_first in [true, false] {
        let f = Fixture::new();
        f.write(".claude/projects/p/a.jsonl", &[claude("native-id", 20)]);
        let store = f.store();
        let request = ImportRequest {
            source_ids: vec!["claude-code".into()],
            ..Default::default()
        };
        let mut live = adapters::parse(
            "claude-code",
            &claude("live-id", 20),
            "fixture",
            &mut adapters::ParseState::default(),
        )
        .unwrap();
        live.provenance = "live-acp-native-session".into();
        let mut newer = live.clone();
        newer.event_id = "newer-live-turn".into();
        newer.timestamp = "2025-01-02T12:00:00Z".into();
        newer.output_tokens = Some(30);
        if live_first {
            store.upsert_record(&live).unwrap();
            store.upsert_record(&newer).unwrap();
            assert_eq!(store.records(&HistoryQuery::default()).unwrap().len(), 2);
        }
        store.import_from_home(&request, &f.0).unwrap();
        if !live_first {
            store.upsert_record(&live).unwrap();
            store.upsert_record(&newer).unwrap();
        }
        // Equal session, timestamp and counters do not prove equal event identity.
        // Reimports and live replay must retain all three distinct events.
        for _ in 0..2 {
            store.import_from_home(&request, &f.0).unwrap();
            store.upsert_record(&live).unwrap();
            store.upsert_record(&newer).unwrap();
            let summary = store
                .summary(&HistoryQuery::default(), &BTreeMap::new())
                .unwrap();
            assert_eq!(summary.records, 1);
            assert_eq!(summary.sessions, 1);
            assert_eq!(summary.totals.output_tokens, 20);
            let unresolved = store
                .summary(
                    &HistoryQuery {
                        scope: Some("unreconciled".into()),
                        ..Default::default()
                    },
                    &BTreeMap::new(),
                )
                .unwrap();
            assert_eq!(unresolved.records, 2);
            assert_eq!(unresolved.sessions, 1);
            assert_eq!(unresolved.totals.output_tokens, 50);
        }
        let query = HistoryQuery {
            scope: Some("unreconciled".into()),
            start_date: Some("2025-01-02".into()),
            end_date: Some("2025-01-02".into()),
            source_ids: vec!["claude-code".into()],
            ..Default::default()
        };
        let records = store.records(&query).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].event_id, newer.event_id);
        assert_eq!(records[0].session_id, newer.session_id);
        assert_eq!(records[0].provenance, "unresolvedNativeOverlap");
        assert!(store
            .records(&HistoryQuery {
                scope: Some("session".into()),
                ..query.clone()
            })
            .unwrap()
            .is_empty());
        assert!(store
            .records(&HistoryQuery {
                source_ids: vec!["codex".into()],
                ..query
            })
            .unwrap()
            .is_empty());
    }
}

#[test]
fn native_aggregate_and_account_report_do_not_replace_live_turns() {
    let f = Fixture::new();
    let store = f.store();
    let mut live = adapters::parse(
        "claude-code",
        &claude("live-id", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    live.provenance = "live-acp-native-session".into();
    store.upsert_record(&live).unwrap();
    let mut aggregate = live.clone();
    aggregate.event_id = "partial-native-aggregate".into();
    aggregate.provenance = "localSessionAggregate".into();
    aggregate.output_tokens = Some(40);
    store.upsert_record(&aggregate).unwrap();
    let mut account = aggregate.clone();
    account.event_id = "account-report".into();
    account.scope = "account".into();
    account.output_tokens = Some(1000);
    store.upsert_record(&account).unwrap();
    let session = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(session.records, 1);
    assert_eq!(session.totals.output_tokens, 40);
    let unresolved = store
        .records(&HistoryQuery {
            scope: Some("unreconciled".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].event_id, live.event_id);
    assert_eq!(unresolved[0].output_tokens, Some(20));
    let account = store
        .summary(
            &HistoryQuery {
                scope: Some("account".into()),
                ..Default::default()
            },
            &BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(account.records, 1);
    assert_eq!(account.totals.output_tokens, 1000);
}

#[test]
fn shared_aggregate_identity_stays_native_after_live_replay() {
    let f = Fixture::new();
    let store = f.store();
    let mut live = adapters::parse(
        "claude-code",
        &claude("shared-id", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    live.provenance = "live-acp-native-session".into();
    let mut native = live.clone();
    native.provenance = "localSessionAggregate".into();
    native.output_tokens = Some(40);
    store.upsert_record(&native).unwrap();
    let mut other_native = native.clone();
    other_native.event_id = "other-native-event".into();
    other_native.provenance = "localHistory".into();
    store.upsert_record(&other_native).unwrap();
    for _ in 0..2 {
        store.upsert_record(&live).unwrap();
        let rows = store.records(&HistoryQuery::default()).unwrap();
        assert_eq!(rows.len(), 2);
        let shared = rows
            .iter()
            .find(|row| row.event_id == live.event_id)
            .unwrap();
        assert_eq!(shared.provenance, "localSessionAggregate");
        assert_eq!(shared.output_tokens, Some(40));
        assert!(store
            .records(&HistoryQuery {
                scope: Some("unreconciled".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty());
    }
}

#[test]
fn known_accounts_namespace_identical_events_and_native_matching() {
    let f = Fixture::new();
    let store = f.store();
    let mut a = adapters::parse(
        "claude-code",
        &claude("shared-event", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    a.provenance = "live-acp-native-session".into();
    a.account_id = Some("account-a".into());
    let mut b = a.clone();
    b.account_id = Some("account-b".into());
    b.output_tokens = Some(30);
    for _ in 0..2 {
        store.upsert_record(&a).unwrap();
        store.upsert_record(&b).unwrap();
    }
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.sessions, 2);
    assert_eq!(summary.totals.output_tokens, 50);
    assert_eq!(summary.accounts.len(), 2);
    assert_eq!(summary.accounts[0].account_id.as_deref(), Some("account-a"));
    assert_eq!(summary.accounts[1].account_id.as_deref(), Some("account-b"));
    let mut native = a.clone();
    native.provenance = "localHistory".into();
    store.upsert_record(&native).unwrap();
    store.upsert_record(&a).unwrap();
    // Native account A cannot make distinct account B unresolved.
    assert_eq!(store.records(&HistoryQuery::default()).unwrap().len(), 2);
    assert!(store
        .records(&HistoryQuery {
            scope: Some("unreconciled".into()),
            ..Default::default()
        })
        .unwrap()
        .is_empty());
    drop(store);
    let reopened = f.store();
    let summary = reopened
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.sessions, 2);
    assert_eq!(summary.accounts.len(), 2);
}

#[test]
fn unknown_native_account_preserves_known_live_account_as_unreconciled() {
    for live_first in [true, false] {
        let f = Fixture::new();
        let store = f.store();
        let native = adapters::parse(
            "claude-code",
            &claude("native-event", 20),
            "fixture",
            &mut adapters::ParseState::default(),
        )
        .unwrap();
        let mut live = native.clone();
        live.event_id = "live-event".into();
        live.account_id = Some("account-a".into());
        live.provenance = "live-acp-native-session".into();
        live.timestamp = "2025-01-02T12:00:00Z".into();
        if live_first {
            store.upsert_record(&live).unwrap();
        }
        store.upsert_record(&native).unwrap();
        if !live_first {
            store.upsert_record(&live).unwrap();
        }
        for _ in 0..2 {
            store.upsert_record(&native).unwrap();
            store.upsert_record(&live).unwrap();
            let query = HistoryQuery {
                scope: Some("unreconciled".into()),
                start_date: Some("2025-01-02".into()),
                ..Default::default()
            };
            let rows = store.records(&query).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].account_id.as_deref(), Some("account-a"));
            assert_eq!(rows[0].session_id, native.session_id);
            assert_eq!(rows[0].provenance, "unresolvedNativeOverlap");
            let summary = store.summary(&query, &BTreeMap::new()).unwrap();
            assert_eq!(summary.accounts[0].account_id.as_deref(), Some("account-a"));
            assert_eq!(store.records(&HistoryQuery::default()).unwrap().len(), 1);
        }
        // Projection keeps original live provenance and scope in durable metadata.
        let c = rusqlite::Connection::open(f.0.join("history.sqlite")).unwrap();
        let json: String = c.query_row("SELECT data FROM usage_history_records WHERE json_extract(data,'$.accountId')='account-a'", [], |row| row.get(0)).unwrap();
        let retained: UsageRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(retained.scope, "session");
        assert_eq!(retained.provenance, "live-acp-native-session");
        assert_eq!(retained.account_id, live.account_id);
    }
}

#[test]
fn legacy_records_keep_unknown_account_and_reject_invalid_new_identity() {
    let f = Fixture::new();
    let store = f.store();
    let record = adapters::parse(
        "claude-code",
        &claude("legacy-event", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    let json = serde_json::to_value(&record).unwrap();
    assert!(json.get("accountId").is_none());
    let legacy: UsageRecord = serde_json::from_value(json).unwrap();
    assert!(legacy.account_id.is_none());
    store.upsert_record(&legacy).unwrap();
    assert!(store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap()
        .accounts
        .is_empty());
    let mut invalid = legacy;
    invalid.account_id = Some(" account-a ".into());
    assert!(store.upsert_record(&invalid).is_err());
}

#[test]
fn account_switches_do_not_invent_extra_unattributed_ryu_conversations() {
    let f = Fixture::new();
    let store = f.store();
    let mut a = adapters::parse(
        "claude-code",
        &claude("turn-a", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    a.source_id = "ryu-acp".into();
    a.scope = "unattributed".into();
    a.provenance = "live-acp-unbound-session".into();
    a.session_id = "ryu-conversation:shared".into();
    a.account_id = Some("account-a".into());
    let mut b = a.clone();
    b.event_id = "turn-b".into();
    b.account_id = Some("account-b".into());
    store.upsert_record(&a).unwrap();
    store.upsert_record(&b).unwrap();
    let summary = store
        .summary(
            &HistoryQuery {
                scope: Some("unattributed".into()),
                ..Default::default()
            },
            &BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.sessions, 1);
    assert_eq!(summary.sources[0].sessions, 1);
    assert_eq!(summary.accounts.len(), 2);
}

#[test]
fn billing_route_aliases_do_not_make_unresolved_native_turns_additive() {
    let f = Fixture::new();
    let store = f.store();
    let mut native = adapters::parse(
        "claude-code",
        &claude("native-event", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    native.source_id = "codex".into();
    native.provider_id = Some("openai".into());
    let mut live = native.clone();
    live.event_id = "live-event".into();
    live.provenance = "live-acp-native-session".into();
    live.provider_id = Some("openai-codex".into());
    live.account_id = Some("account-a".into());
    store.upsert_record(&native).unwrap();
    store.upsert_record(&live).unwrap();
    assert_eq!(store.records(&HistoryQuery::default()).unwrap().len(), 1);
    let rows = store
        .records(&HistoryQuery {
            scope: Some("unreconciled".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].provider_id.as_deref(), Some("openai-codex"));
    assert_eq!(rows[0].account_id.as_deref(), Some("account-a"));
}

#[test]
fn pi_qwen_and_kimi_preserve_measured_usage() {
    let f = Fixture::new();
    f.write(".pi/agent/sessions/p/session.jsonl",&[json!({"type":"session","id":"pi-native"}),json!({"type":"message","id":"entry","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","responseId":"resp-native","provider":"openai","model":"model","usage":{"input":10,"output":20,"cacheRead":30,"cacheWrite":5}}})]);
    f.write(".qwen/projects/p/chats/session.jsonl",&[json!({"type":"assistant","sessionId":"qwen-native","timestamp":"2025-01-01T00:00:00Z","model":"model","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":3,"cachedContentTokenCount":40}})]);
    f.write(".kimi/sessions/p/wire.jsonl",&[json!({"timestamp":1735689600.0,"message":{"type":"StatusUpdate","payload":{"message_id":"kimi-native","token_usage":{"input_other":20,"output":30,"input_cache_read":40,"input_cache_creation":10}}}})]);
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["pi".into(), "qwen".into(), "kimi".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 3);
    assert_eq!(summary.totals.input_tokens, 90);
    assert_eq!(summary.totals.output_tokens, 73);
    assert_eq!(summary.totals.cache_read_tokens, 110);
}

#[test]
fn rust_summary_matches_shared_desktop_contract_fixture() {
    let f = Fixture::new();
    let store = f.store();
    let mut r = adapters::parse(
        "claude-code",
        &claude("fixture-event", 500_000),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    r.source_id = "codex".into();
    r.provider_id = Some("openai".into());
    r.model_id = Some("fixture-model".into());
    r.session_id = "fixture-session".into();
    r.timestamp = "2026-01-01T00:00:00Z".into();
    r.input_tokens = Some(1_000_000);
    r.cache_read_tokens = Some(2_000_000);
    r.cache_write_tokens = Some(0);
    r.cached_output_tokens = Some(0);
    r.reasoning_tokens = Some(100_000);
    store.upsert_record(&r).unwrap();
    let mut rates = BTreeMap::new();
    rates.insert(
        ("openai".into(), "fixture-model".into()),
        ModelRates {
            input: Some(1.0),
            output: Some(2.0),
            cache_read: Some(0.5),
            cache_write: Some(1.0),
        },
    );
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/contract.json")).unwrap();
    assert_eq!(
        serde_json::to_value(store.summary(&HistoryQuery::default(), &rates).unwrap()).unwrap(),
        fixture["summary"]
    );
}

#[test]
fn provider_correction_can_reduce_counts_and_scopes_cannot_change() {
    let f = Fixture::new();
    let store = f.store();
    let mut r = adapters::parse(
        "claude-code",
        &claude("organization-event", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    r.scope = "organization".into();
    r.source_id = "openai-org-usage".into();
    r.input_tokens = Some(100);
    store.upsert_record(&r).unwrap();
    r.input_tokens = Some(50);
    store.upsert_record(&r).unwrap();
    let query = HistoryQuery {
        scope: Some("organization".into()),
        ..Default::default()
    };
    let summary = store.summary(&query, &BTreeMap::new()).unwrap();
    assert_eq!(summary.totals.input_tokens, 50);
    assert_eq!(summary.sessions, 0);
    r.scope = "session".into();
    assert!(store.upsert_record(&r).is_err());
}

#[test]
fn roo_requests_and_copilot_otel_spans_keep_native_metadata() {
    let f = Fixture::new();
    let root = f.0.join("roo-task");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("ui_messages.json"),json!([{"type":"say","say":"api_req_started","ts":1735689600000i64,"modelInfo":{"modelId":"fixture","providerId":"anthropic"},"text":json!({"tokensIn":100,"tokensOut":20,"cacheReads":40,"cacheWrites":10,"cost":0.5}).to_string()}]).to_string()).unwrap();
    let span = json!({"spanId":"native-span","endTimeUnixNano":"1735689600000000000","attributes":[{"key":"gen_ai.operation.name","value":{"stringValue":"chat"}},{"key":"gen_ai.conversation.id","value":{"stringValue":"native-copilot-session"}},{"key":"gen_ai.usage.input_tokens","value":{"intValue":"100"}},{"key":"gen_ai.usage.output_tokens","value":{"intValue":"20"}},{"key":"gen_ai.usage.cached_input_tokens","value":{"intValue":"40"}}]});
    let otel = f.0.join("otel.json");
    std::fs::write(
        &otel,
        json!({"resourceSpans":[{"scopeSpans":[{"spans":[span.clone(),span]}]}]}).to_string(),
    )
    .unwrap();
    let store = f.store();
    let report = store
        .import_from_home(
            &ImportRequest {
                roots: vec![
                    ScanRoot {
                        source_id: "roo".into(),
                        path: root.to_string_lossy().into_owned(),
                        account_id: None,
                    },
                    ScanRoot {
                        source_id: "copilot".into(),
                        path: otel.to_string_lossy().into_owned(),
                        account_id: None,
                    },
                ],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    assert_eq!(report.error_count, 0);
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.totals.input_tokens, 160);
    assert_eq!(summary.source_estimated_cost_usd, Some(0.5));
    assert_eq!(summary.billed_cost_usd, None);
}

#[test]
fn unchanged_failures_do_not_starve_resume_and_can_be_retried() {
    let f = Fixture::new();
    let p = f.0.join(".claude/projects/p");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join("a.json"), "broken json").unwrap();
    f.write(".claude/projects/p/b.jsonl", &[claude("valid", 10)]);
    let store = f.store();
    let mut request = ImportRequest {
        source_ids: vec!["claude-code".into()],
        max_files: Some(1),
        ..Default::default()
    };
    let first = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(first.error_count, 1);
    assert!(first.has_more);
    let second = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(second.imported_records, 1);
    assert_eq!(second.error_count, 0);
    request.retry_failed = true;
    assert_eq!(
        store.import_from_home(&request, &f.0).unwrap().error_count,
        1
    );
}

#[test]
fn database_migration_repeats_without_losing_records_and_rejects_future_version() {
    let f = Fixture::new();
    let path = f.0.join("ledger.db");
    let store = UsageHistoryStore::open(&path).unwrap();
    let r = adapters::parse(
        "claude-code",
        &claude("stable", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    store.upsert_record(&r).unwrap();
    drop(store);
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy.pragma_update(None, "user_version", 1).unwrap();
    drop(legacy);
    for _ in 0..2 {
        let store = UsageHistoryStore::open(&path).unwrap();
        assert_eq!(
            store.records(&HistoryQuery::default()).unwrap(),
            vec![r.clone()]
        );
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
    conn.pragma_update(None, "user_version", 3).unwrap();
    drop(conn);
    assert!(UsageHistoryStore::open(&path).is_err());
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_history_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn version_two_migrates_unbound_acp_out_of_native_session_totals() {
    let f = Fixture::new();
    let path = f.0.join("legacy-ledger.db");
    let mut old = adapters::parse(
        "claude-code",
        &claude("legacy-unbound", 20),
        "fixture",
        &mut adapters::ParseState::default(),
    )
    .unwrap();
    old.provenance = "live-acp-unbound-session".into();
    old.session_id = "unbound-turn:legacy".into();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE usage_history_records(source TEXT NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,event)); PRAGMA user_version=1").unwrap();
    conn.execute(
        "INSERT INTO usage_history_records VALUES(?1,?2,?3)",
        rusqlite::params![
            old.source_id,
            old.event_id,
            serde_json::to_string(&old).unwrap()
        ],
    )
    .unwrap();
    drop(conn);
    for _ in 0..2 {
        let store = UsageHistoryStore::open(&path).unwrap();
        assert!(store.records(&HistoryQuery::default()).unwrap().is_empty());
        let query = HistoryQuery {
            scope: Some("unattributed".into()),
            ..Default::default()
        };
        let rows = store.records(&query).unwrap();
        let mut expected = old.clone();
        expected.scope = "unattributed".into();
        assert_eq!(rows, vec![expected]);
        let summary = store.summary(&query, &BTreeMap::new()).unwrap();
        assert_eq!(summary.records, 1);
        assert_eq!(summary.sessions, 0);
        assert_eq!(summary.sources[0].sessions, 0);
        assert_eq!(summary.totals.input_tokens, 100);
        assert_eq!(summary.totals.output_tokens, 20);
    }
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn unattributed_counts_only_persisted_ryu_conversation_identities_as_sessions() {
    let f = Fixture::new();
    let store = f.store();
    for (event, session) in [
        ("unbound-placeholder", "unbound-turn:turn-1"),
        ("unbound-conversation", "ryu-conversation:real-id"),
        ("unbound-empty", "ryu-conversation:"),
    ] {
        let mut record = adapters::parse(
            "claude-code",
            &claude(event, 20),
            "fixture",
            &mut adapters::ParseState::default(),
        )
        .unwrap();
        record.scope = "unattributed".into();
        record.provenance = "live-acp-unbound-session".into();
        record.session_id = session.into();
        store.upsert_record(&record).unwrap();
    }
    assert!(store.records(&HistoryQuery::default()).unwrap().is_empty());
    let query = HistoryQuery {
        scope: Some("unattributed".into()),
        ..Default::default()
    };
    let summary = store.summary(&query, &BTreeMap::new()).unwrap();
    assert_eq!(summary.records, 3);
    assert_eq!(summary.sessions, 1);
    assert_eq!(summary.sources[0].sessions, 1);
    assert_eq!(summary.daily[0].sessions, 1);
    assert_eq!(summary.models[0].sessions, 1);
    assert_eq!(summary.totals.input_tokens, 300);
}

#[test]
fn codex_large_cumulative_cache_counts_remain_exact() {
    let f = Fixture::new();
    let mut first = codex(35_000_000_000, "2025-01-01T12:00:00Z");
    first["payload"]["info"]["total_token_usage"]["cached_input_tokens"] = json!(30_000_000_000u64);
    let mut second = codex(35_000_000_100, "2025-01-01T12:00:01Z");
    second["payload"]["info"]["total_token_usage"]["cached_input_tokens"] =
        json!(30_000_000_040u64);
    f.write(
        ".codex/sessions/large.jsonl",
        &[
            json!({"type":"session_meta","payload":{"id":"large-session"}}),
            first,
            second,
        ],
    );
    let store = f.store();
    store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["codex".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.totals.input_tokens, 5_000_000_060);
    assert_eq!(summary.totals.cache_read_tokens, 30_000_000_040);
    assert_eq!(summary.totals.missing_input_records, 0);
}

#[test]
fn gemini_cache_conventions_amp_ledger_and_cline_cli_metrics_are_normalized() {
    let f = Fixture::new();
    let gemini = json!({"sessionId":"gemini-session","messages":[{"type":"gemini","id":"g1","timestamp":"2025-01-01T00:00:00Z","model":"gemini","tokens":{"input":100,"output":20,"thoughts":3,"cached":40,"total":123}},{"type":"gemini","id":"g2","timestamp":"2025-01-01T00:00:01Z","model":"gemini","tokens":{"input":100,"output":20,"thoughts":3,"cached":40,"total":163}}]});
    f.write(".gemini/tmp/p/chats/session.json", &[gemini]);
    f.write(".local/share/amp/threads/thread.json",&[json!({"id":"amp-native","usageLedger":{"events":[{"timestamp":"2025-01-01T00:00:00Z","model":"model","credits":500.0,"tokens":{"input":10,"output":20,"cacheReadInputTokens":5,"cacheCreationInputTokens":3}}]}})]);
    f.write(".cline/data/sessions/s/s.messages.json",&[json!({"sessionId":"cline-native","messages":[{"role":"assistant","id":"c1","ts":1735689600000i64,"modelInfo":{"id":"model","provider":"anthropic"},"metrics":{"inputTokens":"100","outputTokens":20,"cacheReadTokens":30,"cacheWriteTokens":10,"cost":0.2}}]})]);
    let store = f.store();
    let report = store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["gemini".into(), "amp".into(), "cline".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    assert_eq!(report.error_count, 0);
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 4);
    assert_eq!(summary.totals.input_tokens, 230);
    assert_eq!(summary.totals.output_tokens, 86);
    assert_eq!(summary.totals.cache_read_tokens, 115);
    assert_eq!(summary.source_estimated_cost_usd, Some(0.2));
    assert_eq!(summary.billed_cost_usd, None);
}

#[test]
fn goose_uses_measured_session_totals_without_inventing_cache_or_reasoning() {
    let f = Fixture::new();
    let path = f.0.join(".local/share/goose/sessions/sessions.db");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE sessions(id TEXT,model_config_json TEXT,provider_name TEXT,created_at TEXT,input_tokens INTEGER,output_tokens INTEGER,accumulated_input_tokens INTEGER,accumulated_output_tokens INTEGER)").unwrap();
    conn.execute(
        "INSERT INTO sessions VALUES(?1,?2,?3,?4,10,20,100,200)",
        rusqlite::params![
            "goose-native",
            json!({"model_name":"model"}).to_string(),
            "openai",
            "2025-01-01 12:00:00"
        ],
    )
    .unwrap();
    drop(conn);
    let store = f.store();
    assert_eq!(
        store
            .import_from_home(
                &ImportRequest {
                    source_ids: vec!["goose".into()],
                    ..Default::default()
                },
                &f.0
            )
            .unwrap()
            .error_count,
        0
    );
    let rows = store.records(&HistoryQuery::default()).unwrap();
    assert_eq!(rows[0].input_tokens, Some(100));
    assert_eq!(rows[0].output_tokens, Some(200));
    assert_eq!(rows[0].cache_read_tokens, None);
    assert_eq!(rows[0].reasoning_tokens, None);
    assert_eq!(rows[0].provenance, "localSessionAggregate");
}

#[test]
fn grok_completed_native_usage_skips_legacy_unsplit_and_partial_updates() {
    let f = Fixture::new();
    let completed = json!({"method":"session/update","params":{"sessionId":"grok-native","update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":100,"outputTokens":25,"reasoningTokens":5,"cachedReadTokens":60,"modelUsage":{"grok-build":{"inputTokens":100}}}},"_meta":{"eventId":"turn-1","agentTimestampMs":1735689600000i64}}});
    let mut partial = completed.clone();
    partial["params"]["update"]["sessionUpdate"] = json!("agent_message_chunk");
    let mut legacy = completed.clone();
    legacy["params"]["update"]["usage"] = json!({"totalTokens":500});
    f.write(
        ".grok/sessions/project/native/updates.jsonl",
        &[completed.clone(), partial, legacy, completed],
    );
    let store = f.store();
    let report = store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["grok".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    assert_eq!(report.error_count, 0);
    let rows = store.records(&HistoryQuery::default()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].event_id, "turn-1");
    assert_eq!(rows[0].input_tokens, Some(40));
    assert_eq!(rows[0].cache_read_tokens, Some(60));
    assert_eq!(rows[0].output_tokens, Some(25));
    assert_eq!(rows[0].reasoning_tokens, Some(5));
    assert_eq!(rows[0].timestamp, "2025-01-01T00:00:00+00:00");
}

#[test]
fn droid_aggregate_requires_transcript_date_and_accepts_downward_corrections() {
    let f = Fixture::new();
    let settings = json!({"model":"test-model","providerLock":"anthropic","providerLockTimestamp":"2020-01-01T00:00:00Z","tokenUsage":{"inputTokens":100,"outputTokens":30,"cacheReadTokens":60,"cacheCreationTokens":4,"thinkingTokens":10}});
    let path = f.write(
        ".factory/sessions/project/native.settings.json",
        &[settings.clone()],
    );
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["droid".into()],
        ..Default::default()
    };
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .imported_records,
        0
    );
    f.write(".factory/sessions/project/native.jsonl", &[json!({"type":"message","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"private content has no relation to token totals"}}),json!({"type":"message","timestamp":"2025-01-02T00:00:00Z","message":{"role":"assistant","content":"secret"}})]);
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .imported_records,
        1
    );
    let mut correction = settings;
    correction["tokenUsage"]["inputTokens"] = json!(9);
    std::fs::write(path, correction.to_string()).unwrap();
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .updated_records,
        1
    );
    let rows = store.records(&HistoryQuery::default()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].input_tokens, Some(9));
    assert_eq!(rows[0].output_tokens, Some(40));
    assert_eq!(rows[0].reasoning_tokens, Some(10));
    assert_eq!(rows[0].timestamp, "2025-01-02T00:00:00+00:00");
    assert_eq!(rows[0].provenance, "localSessionAggregate");
    assert!(!serde_json::to_string(&rows).unwrap().contains("secret"));
}

#[test]
fn zed_hosted_json_and_zstd_ignore_external_agents_and_cumulative_overlap() {
    let f = Fixture::new();
    let path = f.0.join(".local/share/zed/threads/threads.db");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE threads(id TEXT,updated_at TEXT,data_type TEXT,data BLOB)")
        .unwrap();
    let hosted = json!({"model":{"provider":"zed.dev","model":"test-model"},"request_token_usage":{"request-1":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":4},"request-2":{"input_tokens":5,"output_tokens":6,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"cumulative_token_usage":{"input_tokens":999,"output_tokens":999}});
    for (id, kind) in [("json-native", "json"), ("zstd-native", "zstd")] {
        let data = hosted.to_string().into_bytes();
        let data = if kind == "zstd" {
            zstd::encode_all(data.as_slice(), 1).unwrap()
        } else {
            data
        };
        conn.execute(
            "INSERT INTO threads VALUES(?1,?2,?3,?4)",
            rusqlite::params![id, "2025-01-01T00:00:00Z", kind, data],
        )
        .unwrap();
    }
    let external = json!({"model":{"provider":"anthropic","model":"test-model"},"cumulative_token_usage":{"input_tokens":999,"output_tokens":999}});
    conn.execute(
        "INSERT INTO threads VALUES(?1,?2,'json',?3)",
        rusqlite::params![
            "external",
            "2025-01-01T00:00:00Z",
            external.to_string().into_bytes()
        ],
    )
    .unwrap();
    drop(conn);
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["zed".into()],
        ..Default::default()
    };
    let report = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(report.error_count, 0);
    assert_eq!(report.imported_records, 2);
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.totals.input_tokens, 30);
    assert_eq!(summary.totals.output_tokens, 52);
    assert_eq!(summary.totals.cache_read_tokens, 6);
    assert_eq!(summary.totals.cache_write_tokens, 8);
    assert_eq!(
        store.records(&HistoryQuery::default()).unwrap()[0].reasoning_tokens,
        None
    );
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .skipped_files,
        1
    );
}

#[test]
fn antigravity_reads_existing_synced_metadata_without_inventing_cache_writes() {
    let f = Fixture::new();
    let usage = json!({"type":"usage","sessionId":"antigravity-native","timestamp":1735689600000i64,"input":12,"output":4,"cacheRead":2,"cacheWrite":0,"reasoning":1,"responseId":"resp-1"});
    let mut undated = usage.clone();
    undated["timestamp"] = json!(null);
    let mut negative = usage.clone();
    negative["timestamp"] = json!(-1);
    f.write(".config/tokscale/antigravity-cache/sessions/native.jsonl", &[json!({"type":"session_meta","sessionId":"antigravity-native","modelId":"claude-sonnet-4.6"}), usage.clone(), undated, negative, usage]);
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["antigravity".into()],
        ..Default::default()
    };
    let report = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(report.error_count, 0);
    assert_eq!(report.imported_records, 1);
    let rows = store.records(&HistoryQuery::default()).unwrap();
    assert_eq!(rows[0].event_id, "resp-1");
    assert_eq!(rows[0].model_id.as_deref(), Some("claude-sonnet-4.6"));
    assert_eq!(rows[0].input_tokens, Some(12));
    assert_eq!(rows[0].output_tokens, Some(5));
    assert_eq!(rows[0].reasoning_tokens, Some(1));
    assert_eq!(rows[0].cache_read_tokens, Some(2));
    assert_eq!(rows[0].cache_write_tokens, None);
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .skipped_files,
        1
    );
}

#[test]
fn codex_retains_usage_around_oversized_prompt_and_invalid_frames() {
    let f = Fixture::new();
    let path = f.write(
        ".codex/sessions/large-prompt.jsonl",
        &[
            json!({"type":"session_meta","payload":{"id":"large-prompt-session"}}),
            codex(100, "2025-01-01T00:00:00Z"),
        ],
    );
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    let prompt = json!({"type":"event_msg","payload":{"type":"user_message","message":"PRIVATE_PROMPT".repeat(220_000)}});
    writeln!(file, "{prompt}").unwrap();
    writeln!(file, "invalid frame with private data").unwrap();
    writeln!(file, "{}", codex(150, "2025-01-01T00:00:01Z")).unwrap();
    drop(file);
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["codex".into()],
        ..Default::default()
    };
    let report = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(report.imported_records, 2);
    assert_eq!(report.error_count, 2);
    assert!(report.errors.iter().any(|e| e.contains("oversized JSONL")));
    assert!(report.errors.iter().any(|e| e.contains("invalid JSONL")));
    assert!(!report.errors.iter().any(|e| e.contains("PRIVATE_PROMPT")));
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.totals.input_tokens, 110);
    assert_eq!(summary.totals.cache_read_tokens, 40);
    assert_eq!(summary.totals.output_tokens, 20);
    assert_eq!(
        summary.totals.input_tokens + summary.totals.cache_read_tokens,
        150
    );
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .skipped_files,
        1
    );
    assert!(
        !serde_json::to_string(&store.records(&HistoryQuery::default()).unwrap())
            .unwrap()
            .contains("PRIVATE_PROMPT")
    );
}

#[test]
fn incomplete_tail_imports_valid_prefix_and_resumes_after_append_with_unlocked_progress() {
    let f = Fixture::new();
    let path = f.write(
        ".codex/sessions/append.jsonl",
        &[
            json!({"type":"session_meta","payload":{"id":"append-session"}}),
            codex(100, "2025-01-01T00:00:00Z"),
        ],
    );
    use std::io::Write;
    let completed = codex(150, "2025-01-01T00:00:01Z").to_string();
    let split = completed.len() / 2;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(&completed.as_bytes()[..split]).unwrap();
    drop(file);
    let store = f.store();
    let request = ImportRequest {
        source_ids: vec!["codex".into()],
        ..Default::default()
    };
    let mut snapshots = Vec::new();
    let report = store
        .import_from_home_with_progress(&request, &f.0, &mut |r| {
            // Re-enter the store: callbacks must run after the connection lock is
            // released, so async progress persistence cannot block history queries.
            let count = store.records(&HistoryQuery::default()).unwrap().len();
            snapshots.push((r.scanned_files, count));
        })
        .unwrap();
    assert_eq!(report.imported_records, 1);
    assert_eq!(report.error_count, 1);
    assert!(report.errors[0].contains("incomplete JSONL tail"));
    assert_eq!(snapshots.last(), Some(&(1, 1)));
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .skipped_files,
        1
    );
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(&completed.as_bytes()[split..]).unwrap();
    writeln!(file).unwrap();
    drop(file);
    let report = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(report.error_count, 0);
    assert_eq!(report.imported_records, 1);
    assert_eq!(report.duplicate_records, 1);
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.totals.input_tokens, 110);
    assert_eq!(summary.totals.cache_read_tokens, 40);
    assert_eq!(summary.totals.output_tokens, 20);
    assert_eq!(
        summary.totals.input_tokens + summary.totals.cache_read_tokens,
        150
    );
}

#[test]
fn codex_large_sparse_transcript_streams_without_losing_usage_after_large_frame() {
    let f = Fixture::new();
    let path = f.write(
        ".codex/sessions/large-snapshot.jsonl",
        &[
            json!({"type":"session_meta","payload":{"id":"large-snapshot-session"}}),
            codex(100, "2025-01-01T00:00:00Z"),
        ],
    );
    use std::io::{Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    // A sparse oversized frame proves the streaming budget covers authentic
    // transcripts larger than the old 256MiB bound without allocating it.
    file.seek(SeekFrom::Start(270 * 1024 * 1024)).unwrap();
    writeln!(file).unwrap();
    writeln!(file, "{}", codex(150, "2025-01-01T00:00:01Z")).unwrap();
    drop(file);
    let store = f.store();
    let report = store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["codex".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    assert_eq!(report.imported_records, 2);
    assert_eq!(report.error_count, 1);
    assert!(report.errors[0].contains("oversized JSONL"));
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 2);
    assert_eq!(summary.totals.input_tokens, 110);
    assert_eq!(summary.totals.cache_read_tokens, 40);
    assert_eq!(summary.totals.output_tokens, 20);
    assert_eq!(
        summary.totals.input_tokens + summary.totals.cache_read_tokens,
        150
    );
}

#[test]
fn codex_subagent_retained_baseline_is_quarantined_and_corrects_old_event_exactly() {
    let f = Fixture::new();
    let header = json!({"type":"session_meta","payload":{"id":"child-native","parent_thread_id":"parent-native","subagent_history_start_ordinal":246,"model_provider":"openai"}});
    let context = json!({"type":"turn_context","payload":{"model":"current-model"}});
    let first = json!({"type":"event_msg","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12645999,"cached_input_tokens":12382208,"output_tokens":2398,"reasoning_output_tokens":19},"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}}});
    let second = json!({"type":"event_msg","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12725400,"cached_input_tokens":12387968,"output_tokens":2414,"reasoning_output_tokens":19},"last_token_usage":{"input_tokens":79401,"cached_input_tokens":5760,"output_tokens":16,"reasoning_output_tokens":0}}}});
    // Reproduce the old importer: it lacked the inherited-history markers and
    // attributed the first lifetime total to the child's current model/date.
    let mut old_header = header.clone();
    old_header["payload"]
        .as_object_mut()
        .unwrap()
        .remove("parent_thread_id");
    old_header["payload"]
        .as_object_mut()
        .unwrap()
        .remove("subagent_history_start_ordinal");
    let mut old_state = adapters::ParseState::default();
    adapters::parse("codex", &old_header, "fixture", &mut old_state);
    adapters::parse("codex", &context, "fixture", &mut old_state);
    let old = adapters::parse("codex", &first, "fixture", &mut old_state).unwrap();
    let store = f.store();
    store.upsert_record(&old).unwrap();
    let mut unauthorized = old.clone();
    unauthorized.scope = "unattributed".into();
    unauthorized.provenance = "retainedBaseline".into();
    unauthorized.model_id = None;
    unauthorized.provider_id = None;
    assert!(store.upsert_record(&unauthorized).is_err());
    f.write(
        ".codex/sessions/child.jsonl",
        &[header, context, first, second],
    );
    let request = ImportRequest {
        source_ids: vec!["codex".into()],
        ..Default::default()
    };
    let report = store.import_from_home(&request, &f.0).unwrap();
    assert_eq!(report.error_count, 0);
    assert_eq!(report.updated_records, 1);
    assert_eq!(report.imported_records, 1);
    let summary = store
        .summary(&HistoryQuery::default(), &BTreeMap::new())
        .unwrap();
    assert_eq!(summary.records, 1);
    assert_eq!(summary.totals.input_tokens, 73641);
    assert_eq!(summary.totals.cache_read_tokens, 5760);
    assert_eq!(summary.totals.output_tokens, 16);
    assert_eq!(summary.totals.reasoning_tokens, 0);
    let query = HistoryQuery {
        scope: Some("unattributed".into()),
        ..Default::default()
    };
    let rows = store.records(&query).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].event_id, old.event_id);
    assert_eq!(rows[0].session_id, old.session_id);
    assert_eq!(rows[0].timestamp, old.timestamp);
    assert_eq!(rows[0].input_tokens, Some(263791));
    assert_eq!(rows[0].cache_read_tokens, Some(12382208));
    assert_eq!(rows[0].output_tokens, Some(2398));
    assert_eq!(rows[0].model_id, None);
    assert_eq!(rows[0].provider_id, None);
    assert_eq!(rows[0].provenance, "retainedBaseline");
    let baseline_summary = store.summary(&query, &BTreeMap::new()).unwrap();
    assert_eq!(baseline_summary.sessions, 0);
    assert_eq!(baseline_summary.estimated_cost_usd, None);
    assert_eq!(
        store
            .import_from_home(&request, &f.0)
            .unwrap()
            .skipped_files,
        1
    );
}

#[test]
fn codex_inherited_first_request_splits_measured_last_only_with_both_markers() {
    let event = json!({"type":"event_msg","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":30,"cached_input_tokens":10,"output_tokens":8,"reasoning_output_tokens":2}}}});
    for proven in [true, false] {
        let f = Fixture::new();
        let mut header = json!({"type":"session_meta","payload":{"id":"child","parent_thread_id":"parent","subagent_history_start_ordinal":4}});
        if !proven {
            header["payload"]
                .as_object_mut()
                .unwrap()
                .remove("parent_thread_id");
        }
        f.write(".codex/sessions/child.jsonl", &[header, event.clone()]);
        let store = f.store();
        let report = store
            .import_from_home(
                &ImportRequest {
                    source_ids: vec!["codex".into()],
                    ..Default::default()
                },
                &f.0,
            )
            .unwrap();
        assert_eq!(report.error_count, 0);
        let native = store.records(&HistoryQuery::default()).unwrap();
        assert_eq!(native.len(), 1);
        assert_eq!(native[0].input_tokens, Some(if proven { 20 } else { 60 }));
        assert_eq!(native[0].output_tokens, Some(if proven { 8 } else { 20 }));
        let baseline = store
            .records(&HistoryQuery {
                scope: Some("unattributed".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(baseline.len(), usize::from(proven));
        if proven {
            assert_eq!(baseline[0].input_tokens, Some(40));
            assert_eq!(baseline[0].cache_read_tokens, Some(30));
            assert_eq!(baseline[0].output_tokens, Some(12));
            assert_eq!(baseline[0].reasoning_tokens, Some(3));
            assert_ne!(baseline[0].event_id, native[0].event_id);
        }
    }
}

#[test]
fn a_missing_history_folder_or_file_is_not_an_error() {
    let f = Fixture::new();
    let mut paths = Vec::new();
    scan::files(&f.0.join("pruned/sessions"), &mut paths, 0).unwrap();
    assert!(paths.is_empty());
    let kept = f.write(".claude/projects/project/kept.jsonl", &[claude("msg-k", 1)]);
    let gone = f.write(".claude/projects/project/gone.jsonl", &[claude("msg-g", 1)]);
    scan::files(&f.0.join(".claude"), &mut paths, 0).unwrap();
    assert_eq!(paths.len(), 2);
    // A transcript pruned after the walk is skipped, not reported as an error.
    std::fs::remove_file(&gone).unwrap();
    assert!(scan::fingerprint(&gone).is_err());
    let store = f.store();
    let report = store
        .import_from_home(
            &ImportRequest {
                source_ids: vec!["claude-code".into()],
                ..Default::default()
            },
            &f.0,
        )
        .unwrap();
    assert_eq!(report.imported_records, 1);
    assert_eq!(report.error_count, 0);
    assert!(kept.exists());
}
