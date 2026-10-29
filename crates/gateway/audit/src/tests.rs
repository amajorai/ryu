fn service_usage() -> AuditServiceUsage {
    AuditServiceUsage {
        requests: 1,
        documents: 0,
        provider_credits: Some(0),
        cost_source: AuditServiceCostSource::ProviderReported,
        cost_is_estimate: true,
    }
}

fn service_logger() -> (AuditLogger, String) {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir()
        .join(format!(
            "ryu-service-audit-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ))
        .to_string_lossy()
        .into_owned();
    (
        AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: path.clone(),
        })
        .unwrap(),
        path,
    )
}

#[test]
fn report_cursor_persists_across_reopen_and_never_moves_backwards() {
    let (logger, path) = service_logger();
    assert_eq!(logger.report_cursor("ingest").unwrap(), None);
    logger.set_report_cursor("ingest", 42).unwrap();
    logger.set_report_cursor("ingest", 7).unwrap();
    assert_eq!(logger.report_cursor("ingest").unwrap(), Some(42));
    assert_eq!(logger.report_cursor("other").unwrap(), None);
    drop(logger);
    let reopened = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path.clone(),
    })
    .unwrap();
    assert_eq!(reopened.report_cursor("ingest").unwrap(), Some(42));
    drop(reopened);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn key_id_round_trips_and_token_totals_survive_row_pruning() {
    let (logger, path) = service_logger();
    let mut record = sample_record("hosted-1", None);
    record.key_id = Some("cred_1".into());
    record.team_ids = Some("team_a,team_b".into());
    record.input_tokens = 30;
    record.output_tokens = 12;
    let api_key = record.api_key.clone();
    logger.log(record);
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 1);
    assert_eq!(rows[0].key_id.as_deref(), Some("cred_1"));
    assert_eq!(rows[0].team_ids.as_deref(), Some("team_a,team_b"));
    drop(logger);

    // Retention removes the row itself; the lifetime total must not drop.
    Connection::open(&path)
        .unwrap()
        .execute("DELETE FROM audit_log", [])
        .unwrap();
    let reopened = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path.clone(),
    })
    .unwrap();
    assert_eq!(reopened.token_usage(&api_key), 42);
    assert_eq!(reopened.db_path(), Some(path.as_str()));
    drop(reopened);
    let _ = std::fs::remove_file(&path);
}

/// Shared-budget reconciliation reports `summary()` as lifetime spend, so
/// retention removing old rows (on reopen or an explicit prune) must not
/// shrink it back to the retained window and reopen a reached hard cap.
#[test]
fn lifetime_summary_survives_row_pruning_reopen_and_prune() {
    let (logger, path) = service_logger();
    let mut priced = sample_record("priced", None);
    priced.managed_inference = true;
    priced.provider_cost_micro_usd = Some(1_250);
    logger.log(priced);
    let mut unpriced = sample_record("unpriced", None);
    unpriced.managed_inference = true;
    logger.log(unpriced);
    wait_for_rows(&logger, &AuditQuery::default(), 2);
    drop(logger);

    // Retention removes the rows themselves.
    Connection::open(&path)
        .unwrap()
        .execute("DELETE FROM audit_log", [])
        .unwrap();
    let reopened = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path.clone(),
    })
    .unwrap();
    let assert_lifetime = |summary: AuditSummary| {
        assert_eq!(summary.request_count, 2);
        assert_eq!(summary.input_tokens, 20);
        assert_eq!(summary.output_tokens, 10);
        assert_eq!(summary.reported_cost_micro_usd, 1_250);
        assert_eq!(summary.unpriced_input_tokens, 10);
        assert_eq!(summary.unpriced_output_tokens, 5);
    };
    assert_lifetime(reopened.summary().unwrap());
    reopened.prune().unwrap();
    assert_lifetime(reopened.summary().unwrap());
    drop(reopened);
    let _ = std::fs::remove_file(&path);
}

/// Databases from versions that predate the summary table are backfilled
/// once from the rows still present.
#[test]
fn missing_summary_row_is_backfilled_once_from_existing_rows() {
    let (logger, path) = service_logger();
    let mut priced = sample_record("priced", None);
    priced.managed_inference = true;
    priced.provider_cost_micro_usd = Some(700);
    logger.log(priced);
    wait_for_rows(&logger, &AuditQuery::default(), 1);
    drop(logger);

    Connection::open(&path)
        .unwrap()
        .execute("DROP TABLE audit_summary", [])
        .unwrap();
    let reopened = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path.clone(),
    })
    .unwrap();
    let summary = reopened.summary().unwrap();
    assert_eq!(summary.request_count, 1);
    assert_eq!(summary.reported_cost_micro_usd, 700);
    drop(reopened);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn service_store_preserves_usage_zero_estimates_and_privacy_without_inference_counts() {
    let (logger, path) = service_logger();
    let mut record = sample_record(
        "service-private",
        Some("https://private.example/query?key=secret"),
    );
    record.provider = "exa".into();
    record.command = Some("web.search".into());
    record.managed_inference = true;
    record.model = "private-query".into();
    record.backend = Some("https://private.example".into());
    record.duration_ms = Some(1000);
    record.widget_instance_id = Some("private-widget".into());
    record.skill_ids = Some("private-content".into());
    record.provider_cost_micro_usd = Some(0);
    record.cache_hit = true;
    logger.log_service(record, service_usage()).unwrap();
    let rows = wait_for_rows(
        &logger,
        &AuditQuery {
            event_type: Some("service_call".into()),
            ..Default::default()
        },
        1,
    );
    let row = &rows[0];
    assert_eq!(row.event_type, "service_call");
    assert!(row.model.is_empty());
    assert_eq!(row.input_tokens, 0);
    assert_eq!(row.output_tokens, 0);
    assert!(!row.cache_hit);
    assert!(row.backend.is_none());
    assert!(row.duration_ms.is_none());
    assert!(row.widget_instance_id.is_none());
    assert!(row.skill_ids.is_none());
    assert_eq!(row.error.as_deref(), Some("service_request_failed"));
    assert!(row.api_key.starts_with("key_"));
    assert!(!row.api_key.contains("sk-secret"));
    assert_eq!(row.service_usage, Some(service_usage()));
    assert_eq!(row.provider_cost_micro_usd, Some(0));
    assert!(row.managed_inference);
    let summary = logger.summary().unwrap();
    assert_eq!(summary.request_count, 0);
    assert_eq!(summary.input_tokens, 0);
    assert_eq!(summary.output_tokens, 0);
    assert_eq!(summary.reported_cost_micro_usd, 0);
    assert_eq!(logger.token_usage("sk-secret-1234567890"), 0);
    assert!(logger
        .usage_rollup(&AuditUsageQuery {
            timestamp_from: "2000-01-01T00:00:00Z".into(),
            timestamp_until: "2100-01-01T00:00:00Z".into(),
            provider: None,
            model: None,
            purpose: None,
        })
        .unwrap()
        .is_empty());
    let conn = Connection::open(path).unwrap();
    let (model, backend, error, key): (String, Option<String>, String, String) = conn
        .query_row(
            "SELECT model,backend,error,api_key FROM audit_log WHERE event_type='service_call'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert!(model.is_empty());
    assert!(backend.is_none());
    assert_eq!(error, "service_request_failed");
    assert_ne!(key, "sk-secret-1234567890");
}

#[test]
fn service_nullable_migration_and_legacy_log_path_survive_reopen() {
    let (logger, path) = service_logger();
    logger.log(sample_record("legacy-model", None));
    wait_for_rows(&logger, &AuditQuery::default(), 1);
    drop(logger);
    let conn = Connection::open(&path).unwrap();
    for column in [
        "service_requests",
        "service_documents",
        "service_provider_credits",
        "service_cost_source",
        "service_cost_is_estimate",
        "cache_read_tokens",
        "cache_write_tokens",
        "cache_write_1h_tokens",
    ] {
        conn.execute_batch(&format!("ALTER TABLE audit_log DROP COLUMN {column}"))
            .unwrap();
    }
    drop(conn);
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path.clone(),
    })
    .unwrap();
    assert!(logger.query(&AuditQuery::default()).unwrap()[0]
        .service_usage
        .is_none());
    let mut record = sample_record("service-after-upgrade", Some("delivery_uncertain"));
    record.provider = "tavily".into();
    record.command = Some("web.search".into());
    record.provider_cost_micro_usd = Some(77);
    let usage = AuditServiceUsage {
        cost_source: AuditServiceCostSource::ConfiguredEstimate,
        ..service_usage()
    };
    logger.log_service(record, usage.clone()).unwrap();
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 2);
    assert_eq!(rows[0].service_usage, Some(usage.clone()));
    assert!(rows[0].provider_cost_micro_usd.is_none());
    assert_eq!(rows[0].error.as_deref(), Some("delivery_uncertain"));
    assert_eq!(logger.summary().unwrap().request_count, 1);
    drop(logger);
    let reopened = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path,
    })
    .unwrap();
    assert_eq!(
        reopened
            .query(&AuditQuery {
                event_type: Some("service_call".into()),
                ..Default::default()
            })
            .unwrap()[0]
            .service_usage,
        Some(usage)
    );
    assert_eq!(reopened.summary().unwrap().request_count, 1);
}

#[test]
fn one_hour_cache_writes_round_trip_through_the_audit_log() {
    let (logger, _path) = service_logger();
    let mut record = sample_record("one-hour-cache", None);
    record.cache_write_tokens = Some(100);
    record.cache_write_1h_tokens = Some(60);
    logger.log(record);
    logger.log(sample_record("no-split", None));
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 2);
    let by_id = |id: &str| rows.iter().find(|row| row.request_id == id).unwrap();
    assert_eq!(by_id("one-hour-cache").cache_write_tokens, Some(100));
    assert_eq!(by_id("one-hour-cache").cache_write_1h_tokens, Some(60));
    assert_eq!(by_id("no-split").cache_write_1h_tokens, None);
}

#[test]
fn service_logging_rejects_secret_operation_provider_and_out_of_range_usage() {
    let logger = AuditLogger::default();
    let mut record = sample_record("service-invalid", None);
    record.provider = "tavily".into();
    record.command = Some("web.search?query=private".into());
    assert_eq!(
        logger.log_service(record.clone(), service_usage()),
        Err(ServiceAuditError::InvalidOperation)
    );
    record.command = Some("web.search".into());
    record.provider = "https://secret.example".into();
    assert_eq!(
        logger.log_service(record.clone(), service_usage()),
        Err(ServiceAuditError::InvalidProvider)
    );
    record.provider = "firecrawl".into();
    assert_eq!(
        logger.log_service(record.clone(), service_usage()),
        Err(ServiceAuditError::InvalidOperation)
    );
    record.provider = "tavily".into();
    let invalid = AuditServiceUsage {
        requests: u64::MAX,
        ..service_usage()
    };
    assert_eq!(
        logger.log_service(record.clone(), invalid),
        Err(ServiceAuditError::InvalidUsage)
    );
    record.event_type = EventType::ServiceCall;
    logger.log(record);
    assert!(logger.query(&AuditQuery::default()).unwrap().is_empty());
}
#[test]
fn sdk_usage_source_requires_a_known_authenticated_connection() {
    assert_eq!(super::local_usage_source("genai-groq", false), "byok");
    assert_eq!(super::local_usage_source("genai-vertex", false), "byok");
    assert_eq!(
        super::local_usage_source("genai-ollama", false),
        "self_hosted"
    );
    assert_eq!(
        super::local_usage_source("genai-unknown", false),
        "self_hosted"
    );
}
use super::*;

fn sample_record(request_id: &str, error: Option<&str>) -> AuditRecord {
    AuditRecord {
        key_id: None,
        request_id: request_id.to_string(),
        api_key: "sk-secret-1234567890".to_string(),
        user_name: Some("alice".to_string()),
        org_id: Some("org-1".to_string()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "openai".to_string(),
        model: "gpt-4o".to_string(),
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 42,
        eval_score: None,
        error: error.map(|e| e.to_string()),
        skill_ids: None,
        session_id: None,
        event_type: EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        user_id: None,
        agent_id: None,
        feature: None,
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
        widget_instance_id: None,
    }
}

#[test]
fn provider_prompt_cache_usage_roundtrips_and_preserves_reported_zero() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-cache-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };
    let logger = AuditLogger::new(&config).expect("logger");

    let mut hit = sample_record("cache-hit", None);
    hit.prompt_cache_outcome = Some("injected".to_owned());
    hit.prompt_cache_read_tokens = Some(900);
    hit.prompt_cache_write_tokens = Some(100);
    logger.log(hit);

    let mut miss = sample_record("cache-miss", None);
    miss.prompt_cache_outcome = Some("injected".to_owned());
    miss.prompt_cache_read_tokens = Some(0);
    miss.prompt_cache_write_tokens = Some(0);
    logger.log(miss);

    logger.log(sample_record("cache-unreported", None));

    let rows = wait_for_rows(&logger, &AuditQuery::default(), 3);
    let hit = rows
        .iter()
        .find(|row| row.request_id == "cache-hit")
        .unwrap();
    assert_eq!(hit.prompt_cache_outcome.as_deref(), Some("injected"));
    assert_eq!(hit.prompt_cache_read_tokens, Some(900));
    assert_eq!(hit.prompt_cache_write_tokens, Some(100));

    let miss = rows
        .iter()
        .find(|row| row.request_id == "cache-miss")
        .unwrap();
    assert_eq!(miss.prompt_cache_read_tokens, Some(0));
    assert_eq!(miss.prompt_cache_write_tokens, Some(0));

    let unreported = rows
        .iter()
        .find(|row| row.request_id == "cache-unreported")
        .unwrap();
    assert_eq!(unreported.prompt_cache_read_tokens, None);
    assert_eq!(unreported.prompt_cache_write_tokens, None);

    drop(logger);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn query_preserves_reported_provider_cache_usage() {
    let (logger, _path) = service_logger();
    let mut record = sample_record("cache-usage", None);
    record.provider = "openrouter".to_owned();
    record.input_tokens = 1000;
    record.cache_read_tokens = Some(800);
    record.cache_write_tokens = Some(100);
    logger.log(record);

    let rows = wait_for_rows(&logger, &AuditQuery::default(), 1);
    assert_eq!(rows[0].cache_read_tokens, Some(800));
    assert_eq!(rows[0].cache_write_tokens, Some(100));
}

/// Block until the async writer thread has persisted at least `expected` rows.
fn wait_for_rows(logger: &AuditLogger, query: &AuditQuery, expected: usize) -> Vec<AuditEntry> {
    for _ in 0..100 {
        let rows = logger.query(query).expect("query failed");
        if rows.len() >= expected {
            return rows;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("timed out waiting for {expected} audit rows");
}

#[test]
fn redacts_api_key_to_prefix() {
    assert_eq!(redact_key("sk-secret-1234567890"), "sk-sec…");
    assert_eq!(redact_key("master"), "master");
    assert_eq!(redact_key("anonymous"), "anonymous");
}

#[test]
fn default_audit_path_follows_ryu_dir_before_platform_data_dir() {
    let isolated = Path::new("/tmp/ryu-dev-profile");
    let platform_data = Path::new("/Users/test/Library/Application Support");

    assert_eq!(
        std::path::PathBuf::from(default_audit_db_path_for(
            Some(isolated),
            Some(platform_data),
            "-dev",
        )),
        isolated.join("db").join("audit.db")
    );
    assert_eq!(
        std::path::PathBuf::from(default_audit_db_path_for(None, Some(platform_data), "")),
        platform_data.join("ryu").join("audit.db")
    );
    assert_eq!(
        std::path::PathBuf::from(default_audit_db_path_for(None, Some(platform_data), "-dev")),
        platform_data.join("ryu-dev").join("audit.db")
    );
    assert_eq!(default_audit_db_path_for(None, None, ""), "audit.db");
}

#[test]
fn default_audit_path_is_profile_scoped_without_ryu_dir() {
    // A standalone dev Gateway (no RYU_DIR) must not share the release
    // Gateway's audit.db, nor the spend.db budget counters stored beside it.
    let platform_data = Path::new("/home/test/.local/share");
    let release = std::path::PathBuf::from(default_audit_db_path_for(
        None,
        Some(platform_data),
        &profile_dir_suffix(None),
    ));
    let dev = std::path::PathBuf::from(default_audit_db_path_for(
        None,
        Some(platform_data),
        &profile_dir_suffix(Some("dev")),
    ));
    assert_eq!(release, platform_data.join("ryu").join("audit.db"));
    assert_eq!(dev, platform_data.join("ryu-dev").join("audit.db"));
    assert_ne!(
        release.with_file_name("spend.db"),
        dev.with_file_name("spend.db")
    );
}

#[test]
fn profile_dir_suffix_matches_the_gateway_profile_rule() {
    assert_eq!(profile_dir_suffix(None), "");
    assert_eq!(profile_dir_suffix(Some("")), "");
    assert_eq!(profile_dir_suffix(Some(" Release ")), "");
    assert_eq!(profile_dir_suffix(Some("dev")), "-dev");
    assert_eq!(profile_dir_suffix(Some(" Canary ")), "-canary");
}

#[test]
fn runtime_audit_path_override_wins_without_mutating_config() {
    assert_eq!(
        audit_db_path_for("/release/audit.db", Some(" /dev/audit.db ")),
        "/dev/audit.db"
    );
    assert_eq!(
        audit_db_path_for("/release/audit.db", Some("  ")),
        "/release/audit.db"
    );
    assert_eq!(
        audit_db_path_for("/release/audit.db", None),
        "/release/audit.db"
    );
}

#[test]
fn an_explicit_audit_path_is_opened_verbatim() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-explicit-{}", unique_suffix()));
    let explicit = dir.join("operator-audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: explicit.to_string_lossy().into_owned(),
    })
    .expect("explicit audit path should open");

    assert!(explicit.is_file());
    assert_eq!(logger.db_path.as_deref(), explicit.to_str());
    drop(logger);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stores_only_api_key_hash_and_supports_raw_key_filtering() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-hash-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    };
    let logger = AuditLogger::new(&config).expect("logger");
    let raw_key = "sk-secret-1234567890";
    logger.log(sample_record("req-hash", None));
    wait_for_rows(&logger, &AuditQuery::default(), 1);

    let conn = Connection::open(&db_path).unwrap();
    let (stored_key, prefix): (String, String) = conn
        .query_row(
            "SELECT api_key, api_key_prefix FROM audit_log WHERE request_id = 'req-hash'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_ne!(stored_key, raw_key);
    assert_eq!(stored_key, api_key_storage_key(raw_key));
    assert_eq!(prefix, "sk-sec…");
    assert!(!stored_key.contains("secret"));

    let filtered = logger
        .query(&AuditQuery {
            api_key: Some(raw_key.to_owned()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].api_key, "sk-sec…");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn migrates_legacy_raw_api_keys_before_serving_queries() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-migrate-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("audit.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            request_id TEXT NOT NULL,
            api_key TEXT NOT NULL,
            user_name TEXT,
            org_id TEXT,
            team_id TEXT,
            project_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_hit INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            eval_score REAL,
            error TEXT
        );
        INSERT INTO audit_log (request_id, api_key, provider, model)
        VALUES ('legacy-req', 'sk-legacy-secret', 'openai', 'gpt-4o');",
    )
    .unwrap();
    drop(conn);

    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .unwrap();
    let rows = logger
        .query(&AuditQuery {
            api_key: Some("sk-legacy-secret".to_owned()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].api_key, "sk-leg…");
    let summary = logger.summary().expect("backfilled summary");
    assert_eq!(summary.request_count, 1);

    let conn = Connection::open(&db_path).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT api_key FROM audit_log WHERE request_id = 'legacy-req'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(stored, "sk-legacy-secret");
    let _ = std::fs::remove_dir_all(&dir);
}

fn assert_no_raw_bytes_on_disk(db_path: &std::path::Path, raw: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let mut path = db_path.as_os_str().to_owned();
        path.push(suffix);
        let path = std::path::PathBuf::from(path);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        assert!(
            !bytes
                .windows(raw.len())
                .any(|window| window == raw.as_bytes()),
            "raw key bytes remain in {}",
            path.display()
        );
    }
}

#[test]
fn database_hashed_by_an_older_build_is_scrubbed_once() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-scrub-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("audit.db");
    let raw = "sk-older-build-raw-secret-31415926";
    // Reproduce the older migration: a raw key hashed by an in-place UPDATE
    // with secure_delete off, leaving no prefix-NULL rows behind.
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA secure_delete=OFF;
         PRAGMA journal_mode=WAL;
         CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            request_id TEXT NOT NULL,
            api_key TEXT NOT NULL,
            api_key_prefix TEXT,
            user_name TEXT,
            org_id TEXT,
            team_id TEXT,
            project_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_hit INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            eval_score REAL,
            error TEXT
         );
         INSERT INTO audit_log (request_id, api_key, provider, model)
         VALUES ('old-req', '{raw}', 'openai', 'gpt-4o');
         INSERT INTO audit_log (request_id, api_key, api_key_prefix, provider, model)
         VALUES ('later-req', '{1}', 'sk-oth…', 'openai', 'gpt-4o');
         PRAGMA wal_checkpoint(TRUNCATE);
         UPDATE audit_log SET api_key = '{0}', api_key_prefix = '{2}'
         WHERE request_id = 'old-req';
         PRAGMA wal_checkpoint(TRUNCATE);",
        api_key_storage_key(raw),
        api_key_storage_key("sk-other-client-key"),
        redact_key(raw),
    ))
    .unwrap();
    drop(conn);
    let before = std::fs::read(&db_path).unwrap();
    assert!(
        before
            .windows(raw.len())
            .any(|window| window == raw.as_bytes()),
        "fixture must leave raw key bytes in free space"
    );

    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .unwrap();
    assert_eq!(logger.wait_for_raw_key_scrub(), RawKeyScrub::Done);
    assert_no_raw_bytes_on_disk(&db_path, raw);
    let rows = logger
        .query(&AuditQuery {
            api_key: Some(raw.to_owned()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(rows.len(), 1);
    drop(logger);

    // The marker makes later opens skip the rebuild.
    let conn = Connection::open(&db_path).unwrap();
    assert!(raw_key_scrub_done(&conn).unwrap());
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// An audit store whose only copy of `raw` sits in free space, as left by a
/// build that hashed keys in place without `secure_delete`.
fn store_with_raw_bytes_in_free_space(dir: &std::path::Path, raw: &str) -> std::path::PathBuf {
    let db_path = dir.join("audit.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA secure_delete=OFF;
         PRAGMA journal_mode=WAL;
         CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            request_id TEXT NOT NULL DEFAULT 'old-req',
            api_key TEXT NOT NULL,
            api_key_prefix TEXT,
            user_name TEXT,
            org_id TEXT,
            team_id TEXT,
            project_id TEXT,
            provider TEXT NOT NULL DEFAULT 'openai',
            model TEXT NOT NULL DEFAULT 'gpt-4o',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_hit INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            eval_score REAL,
            error TEXT
         );
         INSERT INTO audit_log (api_key) VALUES ('{raw}');
         PRAGMA wal_checkpoint(TRUNCATE);
         UPDATE audit_log SET api_key = '{}', api_key_prefix = '{}';
         PRAGMA wal_checkpoint(TRUNCATE);",
        api_key_storage_key(raw),
        redact_key(raw),
    ))
    .unwrap();
    drop(conn);
    db_path
}

#[test]
fn raw_key_scrub_needs_room_for_the_rebuild() {
    let mib = 1024 * 1024;
    assert!(scrub_fits(10 * mib, None, None, true));
    assert!(scrub_fits(
        10 * mib,
        Some(20 * mib + SCRUB_SPACE_MARGIN),
        None,
        true
    ));
    assert!(!scrub_fits(10 * mib, Some(20 * mib), None, true));
    assert!(scrub_fits(
        10 * mib,
        Some(10 * mib + SCRUB_SPACE_MARGIN),
        Some(u64::MAX),
        false
    ));
    assert!(!scrub_fits(10 * mib, Some(u64::MAX), Some(mib), false));
    assert!(!scrub_fits(u64::MAX, Some(u64::MAX - 1), None, true));
}

#[test]
fn raw_key_scrub_without_disk_room_is_deferred_not_fatal() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-scrub-room-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let raw = "sk-no-room-raw-secret-27182818";
    let db_path = store_with_raw_bytes_in_free_space(&dir, raw);
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch("PRAGMA secure_delete=ON;").unwrap();

    let outcome = run_raw_key_scrub(&conn, &db_path, &|_| Some(0));
    assert_eq!(outcome, RawKeyScrub::Deferred);
    assert!(
        !raw_key_scrub_done(&conn).unwrap(),
        "a skipped rebuild must be retried"
    );

    // The next attempt with room completes the rebuild and sets the marker.
    let outcome = run_raw_key_scrub(&conn, &db_path, &|_| None);
    assert_eq!(outcome, RawKeyScrub::Done);
    assert!(raw_key_scrub_done(&conn).unwrap());
    assert_no_raw_bytes_on_disk(&db_path, raw);
    assert_eq!(
        run_raw_key_scrub(&conn, &db_path, &|_| Some(0)),
        RawKeyScrub::Skipped
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn failed_raw_key_rebuild_is_logged_and_retried_not_fatal() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-scrub-fail-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let raw = "sk-busy-raw-secret-16180339";
    let db_path = store_with_raw_bytes_in_free_space(&dir, raw);
    let conn = Connection::open(&db_path).unwrap();
    raw_key_scrub_done(&conn).unwrap();
    // Another connection holds the write lock, so VACUUM fails with BUSY.
    let holder = Connection::open(&db_path).unwrap();
    holder
        .execute_batch("BEGIN IMMEDIATE; INSERT INTO audit_log (api_key) VALUES ('x');")
        .unwrap();
    let outcome = run_raw_key_scrub(&conn, &db_path, &|_| None);
    assert_eq!(outcome, RawKeyScrub::Deferred);
    holder.execute_batch("ROLLBACK;").unwrap();
    drop(holder);
    assert!(!raw_key_scrub_done(&conn).unwrap());
    drop(conn);

    // The next open still starts, and its background pass finishes the job.
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("a pending rebuild must never stop the audit store from opening");
    assert_eq!(logger.wait_for_raw_key_scrub(), RawKeyScrub::Done);
    assert_no_raw_bytes_on_disk(&db_path, raw);
    drop(logger);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hashing_a_raw_key_reschedules_the_rebuild() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-scrub-again-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    };
    let logger = AuditLogger::new(&config).unwrap();
    assert_eq!(logger.wait_for_raw_key_scrub(), RawKeyScrub::Done);
    drop(logger);
    let logger = AuditLogger::new(&config).unwrap();
    assert_eq!(logger.wait_for_raw_key_scrub(), RawKeyScrub::Skipped);
    drop(logger);

    // A raw key written by an older build is hashed on the next open, which
    // clears the marker so the background pass rebuilds the file again.
    let raw = "sk-reappeared-raw-secret-14142135";
    let conn = Connection::open(&db_path).unwrap();
    conn.execute(
        "INSERT INTO key_token_totals (api_key, tokens) VALUES (?1, 3)",
        params![raw],
    )
    .unwrap();
    drop(conn);
    let logger = AuditLogger::new(&config).unwrap();
    assert_eq!(logger.wait_for_raw_key_scrub(), RawKeyScrub::Done);
    assert_eq!(logger.token_usage(raw), 3);
    drop(logger);
    assert_no_raw_bytes_on_disk(&db_path, raw);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn legacy_raw_key_totals_are_rehashed_and_purged_from_disk() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-totals-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("audit.db");
    let raw = "sk-totals-raw-secret-9876";
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE key_token_totals (api_key TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0);
         INSERT INTO key_token_totals (api_key, tokens) VALUES ('{raw}', 40);
         INSERT INTO key_token_totals (api_key, tokens) VALUES ('{}', 2);
         INSERT INTO key_token_totals (api_key, tokens) VALUES ('anonymous', 5);",
        api_key_storage_key(raw)
    ))
    .unwrap();
    drop(conn);

    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .unwrap();
    assert_eq!(logger.wait_for_raw_key_scrub(), RawKeyScrub::Done);
    // Budget accounting sees the legacy usage under the hashed key.
    assert_eq!(logger.token_usage(raw), 42);
    assert_eq!(logger.token_usage("anonymous"), 5);
    let conn = Connection::open(&db_path).unwrap();
    let keys: Vec<String> = conn
        .prepare("SELECT api_key FROM key_token_totals ORDER BY api_key")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(keys.iter().all(|key| is_stored_api_key_form(key)));
    drop(conn);
    for suffix in ["", "-wal", "-shm"] {
        let mut path = db_path.as_os_str().to_owned();
        path.push(suffix);
        let path = std::path::PathBuf::from(path);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        assert!(
            !bytes
                .windows(raw.len())
                .any(|window| window == raw.as_bytes()),
            "raw key bytes remain in {}",
            path.display()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "{} is not owner-only", path.display());
        }
    }
    drop(logger);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rows_logged_during_the_rebuild_are_buffered_not_dropped() {
    // A rebuild that outlasts the bounded queue must not make `try_send`
    // fail: the drain keeps emptying it, and the rows come back in order.
    let (sender, mut receiver) = mpsc::sync_channel::<QueuedAudit>(4);
    let sent = std::thread::scope(|scope| {
        let producer = scope.spawn(|| {
            let mut accepted = 0;
            for index in 0..50 {
                let queued = QueuedAudit {
                    record: sample_record(&format!("backlog-{index}"), None),
                    service_usage: None,
                };
                // Retry briefly on a full queue so the test measures only
                // whether the drain keeps up, not scheduler luck.
                let mut queued = Some(queued);
                for _ in 0..200 {
                    match sender.try_send(queued.take().unwrap()) {
                        Ok(()) => {
                            accepted += 1;
                            break;
                        }
                        Err(mpsc::TrySendError::Full(back)) => {
                            queued = Some(back);
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(mpsc::TrySendError::Disconnected(_)) => return accepted,
                    }
                }
            }
            accepted
        });
        let ((), backlog) = buffer_while(&mut receiver, 1_000, || {
            std::thread::sleep(Duration::from_millis(300));
        });
        let accepted = producer.join().unwrap();
        (accepted, backlog)
    });
    let (accepted, backlog) = sent;
    // Rows sent while the work ran were buffered; any that landed after it
    // ended are still in the channel, never lost.
    let still_queued = std::iter::from_fn(|| receiver.try_recv().ok()).count();
    assert_eq!(accepted, 50);
    assert_eq!(backlog.len() + still_queued, 50);
    assert!(
        backlog.len() > 4,
        "the drain held more than the queue's capacity: {}",
        backlog.len()
    );
    let ids: Vec<&str> = backlog
        .iter()
        .map(|q| q.record.request_id.as_str())
        .collect();
    assert!(ids.windows(2).all(|pair| {
        let n = |id: &str| id.trim_start_matches("backlog-").parse::<u32>().unwrap();
        n(pair[0]) < n(pair[1])
    }));
}

#[test]
fn a_full_backlog_drops_rows_instead_of_growing_without_bound() {
    let (sender, mut receiver) = mpsc::sync_channel::<QueuedAudit>(8);
    let ((), backlog) = buffer_while(&mut receiver, 3, || {
        for index in 0..6 {
            sender
                .send(QueuedAudit {
                    record: sample_record(&format!("cap-{index}"), None),
                    service_usage: None,
                })
                .unwrap();
        }
        std::thread::sleep(Duration::from_millis(150));
    });
    assert_eq!(backlog.len(), 3);
}

#[test]
fn hex_shaped_raw_key_totals_are_rehashed_when_the_audit_log_proves_they_are_raw() {
    // `openssl rand -hex 32` mints exactly the shape of a SHA-256 lookup key.
    let raw = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
    assert!(is_stored_api_key_form(raw), "the shape alone is ambiguous");
    let dir = std::env::temp_dir().join(format!("ryu-audit-hexraw-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    };

    // A request made with the raw key leaves a hashed audit row.
    let logger = AuditLogger::new(&config).unwrap();
    let mut record = sample_record("hex-raw", None);
    record.api_key = raw.to_owned();
    logger.log(record);
    wait_for_rows(&logger, &AuditQuery::default(), 1);
    drop(logger);

    // A pre-hash build left the raw key itself in `key_token_totals`.
    let conn = Connection::open(&db_path).unwrap();
    let logged: i64 = conn
        .query_row(
            "SELECT tokens FROM key_token_totals WHERE api_key = ?1",
            params![api_key_storage_key(raw)],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        logged > 0,
        "the logged request counted toward the hashed key"
    );
    conn.execute(
        "INSERT INTO key_token_totals (api_key, tokens) VALUES (?1, 40)",
        params![raw],
    )
    .unwrap();
    drop(conn);

    let logger = AuditLogger::new(&config).unwrap();
    // The legacy total is merged under the hashed key, so budget accounting
    // (which looks the key up by its hash) sees it again.
    assert_eq!(logger.token_usage(raw), logged.unsigned_abs() + 40);
    drop(logger);
    let conn = Connection::open(&db_path).unwrap();
    let stored: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM key_token_totals WHERE api_key = ?1",
            params![raw],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 0, "no row stores the raw value");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn logs_and_queries_records_with_redaction() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-test-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };

    let logger = AuditLogger::new(&config).expect("logger");
    logger.log(sample_record("req-1", None));
    logger.log(sample_record("req-2", Some("provider exploded")));

    let all = wait_for_rows(&logger, &AuditQuery::default(), 2);
    // Newest-first ordering.
    assert_eq!(all[0].request_id, "req-2");
    // Raw key never returned.
    assert_eq!(all[0].api_key, "sk-sec…");
    assert!(!all[0].api_key.contains("1234567890"));

    // errors_only filter.
    let errors = logger
        .query(&AuditQuery {
            errors_only: true,
            ..Default::default()
        })
        .expect("query");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].request_id, "req-2");

    // provider filter.
    let by_provider = logger
        .query(&AuditQuery {
            provider: Some("openai".to_string()),
            ..Default::default()
        })
        .expect("query");
    assert_eq!(by_provider.len(), 2);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cursor_queries_are_exclusive_and_oldest_first() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-cursor-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .unwrap();
    logger.log(sample_record("req-1", None));
    logger.log(sample_record("req-2", None));
    logger.log(sample_record("req-3", None));

    let all = wait_for_rows(&logger, &AuditQuery::default(), 3);
    let cursor = all.last().expect("oldest row").id;
    let next = logger
        .query(&AuditQuery {
            id_after: Some(cursor),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        next.iter()
            .map(|entry| entry.request_id.as_str())
            .collect::<Vec<_>>(),
        vec!["req-2", "req-3"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn disabled_logger_returns_empty() {
    let logger = AuditLogger::disabled();
    assert!(!logger.is_enabled());
    assert!(logger.query(&AuditQuery::default()).unwrap().is_empty());
    let summary = logger.summary().expect("summary");
    assert_eq!(summary.request_count, 0);
    assert_eq!(summary.error_count, 0);
}

#[test]
fn summary_rolls_up_totals() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-sum-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };

    let logger = AuditLogger::new(&config).expect("logger");
    logger.log(sample_record("req-1", None));
    logger.log(sample_record("req-2", Some("boom")));
    logger.log(AuditLogger::make_control_record(
        "control-1".to_string(),
        "master".to_string(),
        "master-key".to_string(),
        None,
        "config.apply".to_string(),
        "gateway_config".to_string(),
        Some("firewall".to_string()),
    ));
    wait_for_rows(&logger, &AuditQuery::default(), 3);

    let summary = logger.summary().expect("summary");
    assert_eq!(summary.request_count, 2);
    assert_eq!(summary.error_count, 1);
    // Each sample record carries 10 input + 5 output tokens.
    assert_eq!(summary.input_tokens, 20);
    assert_eq!(summary.output_tokens, 10);

    let controls = logger
        .query(&AuditQuery {
            event_type: Some("control_change".to_string()),
            ..Default::default()
        })
        .expect("control query");
    assert_eq!(controls.len(), 1);
    assert_eq!(controls[0].user_name.as_deref(), Some("master-key"));

    let _ = std::fs::remove_dir_all(&dir);
}

fn priced_managed_record(request_id: &str, cost_micro_usd: u64) -> AuditRecord {
    let mut record = sample_record(request_id, None);
    record.managed_inference = true;
    record.provider_cost_micro_usd = Some(cost_micro_usd);
    record
}

/// Poll the lifetime summary until `done` holds (the writer is async).
fn wait_for_summary(logger: &AuditLogger, done: impl Fn(&AuditSummary) -> bool) -> AuditSummary {
    for _ in 0..1_000 {
        let summary = logger.summary().expect("summary");
        if done(&summary) {
            return summary;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for the audit summary");
}

fn audit_row_count(path: &str) -> i64 {
    Connection::open(path)
        .expect("count connection")
        .query_row("SELECT COUNT(*) FROM audit_log", [], |row| row.get(0))
        .expect("count rows")
}

fn reopen(path: &str) -> AuditLogger {
    AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: path.to_owned(),
    })
    .expect("reopen audit logger")
}

#[test]
fn failed_row_write_keeps_lifetime_totals() {
    let (logger, path) = service_logger();
    logger.injected_failures.store(1, Ordering::Release);
    logger.log(priced_managed_record("lost", 1_250));
    logger.log(priced_managed_record("kept", 700));

    wait_for_rows(&logger, &AuditQuery::default(), 1);
    let summary = wait_for_summary(&logger, |summary| summary.request_count == 2);
    assert_eq!(summary.reported_cost_micro_usd, 1_950);
    assert_eq!(summary.input_tokens, 20);
    assert_eq!(summary.output_tokens, 10);
    assert_eq!(
        audit_row_count(&path),
        1,
        "the failed row stays best-effort"
    );

    drop(logger);
    // Restart reloads per-key budgets from the durable totals, which must
    // still include the request whose row was lost.
    assert_eq!(reopen(&path).token_usage("sk-secret-1234567890"), 30);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn failed_counter_write_is_retried_without_new_rows() {
    let (logger, path) = service_logger();
    // Fail the row write AND the immediate counters-only write, so the
    // totals can only land through the writer's own backoff retry.
    logger.injected_failures.store(2, Ordering::Release);
    logger.log(priced_managed_record("lost", 1_250));

    let summary = wait_for_summary(&logger, |summary| summary.request_count == 1);
    assert_eq!(summary.reported_cost_micro_usd, 1_250);
    assert_eq!(logger.injected_failures.load(Ordering::Acquire), 0);
    assert_eq!(audit_row_count(&path), 0);

    drop(logger);
    assert_eq!(reopen(&path).token_usage("sk-secret-1234567890"), 15);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn usage_totals_survive_audit_queue_overflow() {
    let (logger, path) = service_logger();
    // Hold the write lock so the writer stalls on its first row while the
    // 1,000-slot queue fills and the rest of the burst is dropped.
    let blocker = Connection::open(&path).expect("blocker connection");
    blocker
        .execute_batch("BEGIN IMMEDIATE")
        .expect("hold write lock");
    for index in 0..1_500 {
        logger.log(sample_record(&format!("r{index}"), None));
    }
    blocker.execute_batch("COMMIT").expect("release write lock");
    drop(blocker);

    let summary = wait_for_summary(&logger, |summary| summary.request_count == 1_500);
    assert_eq!(summary.input_tokens, 15_000);
    assert_eq!(summary.output_tokens, 7_500);
    assert!(
        audit_row_count(&path) < 1_500,
        "the burst must have dropped rows for this test to prove anything"
    );

    drop(logger);
    assert_eq!(
        reopen(&path).token_usage("sk-secret-1234567890"),
        1_500 * 15
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn usage_rollup_uses_canonical_buckets_and_exact_event_math() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-usage-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("logger");

    let conn = Connection::open(&db_path).expect("writer connection");
    conn.execute_batch(
        "INSERT INTO audit_log (
             timestamp, request_id, api_key, provider, model, input_tokens,
             output_tokens, latency_ms, error, event_type, user_id, feature,
             managed_inference, provider_cost_micro_usd
         ) VALUES
             ('2026-08-22 10:01:00', 'model-1', 'master', 'openrouter', 'gpt-5',
              100, 40, 250, NULL, 'model_call', 'member-1', 'chat', 1, 90),
             ('2026-08-22 10:14:59', 'model-2', 'master', 'openrouter', 'gpt-5',
              20, 10, 750, 'failed', 'model_call', 'member-1', 'chat', 1, NULL),
             ('2026-08-22 10:12:00', 'exec-1', 'master', 'openrouter', 'gpt-5',
              0, 0, 0, NULL, 'exec_call', 'member-1', 'chat', 1, NULL),
             ('2026-08-22 10:15:00', 'model-3', 'master', 'anthropic', 'claude',
              9, 3, 100, NULL, 'model_call', NULL, 'agent', 0, NULL);
         UPDATE audit_log SET duration_ms = 2500 WHERE request_id = 'exec-1';",
    )
    .expect("seed usage rows");

    let events = logger
        .usage_rollup(&AuditUsageQuery {
            timestamp_from: "2026-08-22T10:00:00Z".to_owned(),
            timestamp_until: "2026-08-22T10:15:00Z".to_owned(),
            provider: Some("openrouter".to_owned()),
            model: Some("gpt-5".to_owned()),
            purpose: None,
        })
        .expect("usage rollup");
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.timestamp, "2026-08-22T10:00:00Z");
    assert_eq!(event.member_id.as_deref(), Some("member-1"));
    assert_eq!(event.feature.as_deref(), Some("chat"));
    assert_eq!(event.source, "managed");
    assert_eq!(event.input_tokens, 120);
    assert_eq!(event.output_tokens, 50);
    assert_eq!(event.request_count, 2);
    assert_eq!(event.error_count, 1);
    assert_eq!(event.latency_total_ms, 1000);
    assert_eq!(event.latency_samples, 2);
    assert_eq!(event.agent_seconds, 2.5);
    assert_eq!(event.cost_micro_usd, Some(90));
    assert_eq!(event.unpriced_input_tokens, 20);
    assert_eq!(event.unpriced_output_tokens, 10);

    let _ = std::fs::remove_dir_all(&dir);
}

fn rollup_window(purpose: Option<&str>) -> AuditUsageQuery {
    AuditUsageQuery {
        timestamp_from: "2026-08-22T10:00:00Z".to_owned(),
        timestamp_until: "2026-08-22T10:15:00Z".to_owned(),
        provider: None,
        model: None,
        purpose: purpose.map(str::to_owned),
    }
}

#[test]
fn usage_rollup_buckets_purposes_separately_and_sums_cache_tokens() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-purpose-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("logger");

    let conn = Connection::open(&db_path).expect("writer connection");
    conn.execute_batch(
        "INSERT INTO audit_log (
             timestamp, request_id, api_key, provider, model, input_tokens,
             output_tokens, latency_ms, event_type, feature, purpose,
             cache_read_tokens, cache_write_tokens
         ) VALUES
             ('2026-08-22 10:01:00', 'fg-1', 'master', 'anthropic', 'claude',
              10, 1, 5, 'model_call', 'chat', NULL, 100, 20),
             ('2026-08-22 10:02:00', 'cmp-1', 'master', 'anthropic', 'claude',
              30, 3, 5, 'model_call', 'chat', 'compaction', 400, NULL),
             ('2026-08-22 10:03:00', 'cmp-2', 'master', 'anthropic', 'claude',
              50, 5, 5, 'model_call', 'chat', 'compaction', 600, 70),
             ('2026-08-22 10:04:00', 'ttl-1', 'master', 'anthropic', 'claude',
              7, 2, 5, 'model_call', 'chat', 'auto_title', NULL, NULL);",
    )
    .expect("seed usage rows");

    let events = logger.usage_rollup(&rollup_window(None)).expect("rollup");
    assert_eq!(events.len(), 3, "one bucket per purpose: {events:?}");
    let by_purpose = |purpose: Option<&str>| {
        events
            .iter()
            .find(|event| event.purpose.as_deref() == purpose)
            .expect("purpose bucket")
    };
    let foreground = by_purpose(None);
    assert_eq!(
        (
            foreground.input_tokens,
            foreground.cache_read_tokens,
            foreground.cache_write_tokens
        ),
        (10, 100, 20)
    );
    let compaction = by_purpose(Some("compaction"));
    assert_eq!(compaction.request_count, 2);
    assert_eq!(compaction.input_tokens, 80);
    assert_eq!(compaction.cache_read_tokens, 1_000);
    assert_eq!(compaction.cache_write_tokens, 70);
    let title = by_purpose(Some("auto_title"));
    assert_eq!((title.cache_read_tokens, title.cache_write_tokens), (0, 0));

    let filtered = logger
        .usage_rollup(&rollup_window(Some("compaction")))
        .expect("filtered rollup");
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].purpose.as_deref(), Some("compaction"));
    assert_eq!(filtered[0].request_count, 2);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn raw_audit_query_returns_the_purpose_column() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-raw-purpose-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("logger");

    let mut tagged = sample_record("tagged", None);
    tagged.purpose = Some("compaction".to_owned());
    logger.log(tagged);
    logger.log(sample_record("foreground", None));
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 2);
    let by_id = |id: &str| rows.iter().find(|row| row.request_id == id).expect("row");
    assert_eq!(by_id("tagged").purpose.as_deref(), Some("compaction"));
    assert_eq!(by_id("foreground").purpose, None);
    // Serialized as `null` for foreground rows (never omitted), so a client
    // can tell a Gateway that records purposes from one that does not.
    let wire = serde_json::to_value(by_id("foreground")).unwrap();
    assert!(wire.get("purpose").is_some_and(serde_json::Value::is_null));
    drop(logger);

    // A row written before the column existed reads back as no purpose.
    let conn = Connection::open(&db_path).unwrap();
    conn.execute("UPDATE audit_log SET purpose = NULL", [])
        .unwrap();
    drop(conn);
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("logger");
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 2);
    assert!(rows.iter().all(|row| row.purpose.is_none()));
    drop(logger);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn invalid_purpose_is_stored_as_null() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-bad-purpose-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("logger");

    let mut valid = sample_record("valid", None);
    valid.purpose = Some("plugin:@ryu/notes".to_owned());
    logger.log(valid);
    for (id, purpose) in [
        ("upper", "Compaction".to_owned()),
        ("space", "auto title".to_owned()),
        ("long", "a".repeat(MAX_PURPOSE_LEN + 1)),
        ("empty", String::new()),
    ] {
        let mut record = sample_record(id, None);
        record.purpose = Some(purpose);
        logger.log(record);
    }
    wait_for_rows(&logger, &AuditQuery::default(), 5);

    let conn = Connection::open(&db_path).expect("reader");
    let mut stmt = conn
        .prepare("SELECT request_id, purpose FROM audit_log ORDER BY request_id")
        .unwrap();
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for (id, purpose) in rows {
        if id == "valid" {
            assert_eq!(purpose.as_deref(), Some("plugin:@ryu/notes"));
        } else {
            assert_eq!(purpose, None, "{id} must be dropped");
        }
    }
    assert_eq!(
        valid_purpose(&"a".repeat(MAX_PURPOSE_LEN)).map(str::len),
        Some(64)
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn purpose_migration_is_idempotent_on_an_existing_database() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-purpose-mig-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("audit.db");
    // A pre-purpose database: the column is absent until the logger opens it.
    let legacy = Connection::open(&db_path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE audit_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                 request_id TEXT NOT NULL,
                 api_key TEXT NOT NULL,
                 provider TEXT NOT NULL,
                 model TEXT NOT NULL,
                 input_tokens INTEGER NOT NULL DEFAULT 0,
                 output_tokens INTEGER NOT NULL DEFAULT 0,
                 cache_hit INTEGER NOT NULL DEFAULT 0,
                 latency_ms INTEGER NOT NULL DEFAULT 0,
                 eval_score REAL,
                 error TEXT
             );
             INSERT INTO audit_log (timestamp, request_id, api_key, provider, model, input_tokens)
             VALUES ('2026-08-22 10:01:00', 'legacy', 'master', 'anthropic', 'claude', 4);",
        )
        .unwrap();
    drop(legacy);

    for _ in 0..2 {
        let logger = AuditLogger::new(&AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_owned(),
        })
        .expect("migrated logger");
        let events = logger.usage_rollup(&rollup_window(None)).expect("rollup");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].purpose, None);
        assert_eq!(events[0].input_tokens, 4);
    }
    let conn = Connection::open(&db_path).unwrap();
    let purpose_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('audit_log') WHERE name = 'purpose'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(purpose_columns, 1);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn persists_managed_provider_cost_and_separates_unpriced_tokens() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-cost-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    })
    .expect("logger");

    let mut priced = sample_record("priced", None);
    priced.managed_inference = true;
    priced.provider_cost_micro_usd = Some(1_250);
    logger.log(priced);

    let mut unpriced = sample_record("unpriced", None);
    unpriced.managed_inference = true;
    logger.log(unpriced);
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 2);

    let priced_row = rows
        .iter()
        .find(|row| row.request_id == "priced")
        .expect("priced row");
    assert!(priced_row.managed_inference);
    assert_eq!(priced_row.provider_cost_micro_usd, Some(1_250));

    let summary = logger.summary().expect("summary");
    assert_eq!(summary.reported_cost_micro_usd, 1_250);
    assert_eq!(summary.unpriced_input_tokens, 10);
    assert_eq!(summary.unpriced_output_tokens, 5);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn control_record_shape() {
    let record = AuditLogger::make_control_record(
        "control-id".to_string(),
        "master".to_string(),
        "loopback-admin".to_string(),
        Some("user-123".to_string()),
        "firewall.update".to_string(),
        "firewall_policy".to_string(),
        Some("enabled, policy".to_string()),
    );
    assert_eq!(record.event_type, EventType::ControlChange);
    assert_eq!(record.event_type.as_str(), "control_change");
    assert_eq!(record.user_name.as_deref(), Some("loopback-admin"));
    assert_eq!(record.user_id.as_deref(), Some("user-123"));
    assert_eq!(record.model, "firewall_policy");
    assert_eq!(
        record.command.as_deref(),
        Some("firewall.update: enabled, policy")
    );
    assert_eq!(record.backend.as_deref(), Some("gateway_admin"));
    assert_eq!(record.input_tokens, 0);
    assert_eq!(record.output_tokens, 0);
}

#[test]
fn agent_control_record_keeps_the_agent_passport_link() {
    let record = AuditLogger::make_control_record_with_agent(
        "control-agent-id".to_owned(),
        "master".to_owned(),
        "member@example.com".to_owned(),
        Some("user-123".to_owned()),
        Some("agent-support".to_owned()),
        "agent.update".to_owned(),
        "agent:agent-support".to_owned(),
        Some("successful Core agent-management mutation".to_owned()),
    );
    assert_eq!(record.agent_id.as_deref(), Some("agent-support"));
    assert_eq!(record.user_id.as_deref(), Some("user-123"));
    assert_eq!(record.event_type, EventType::ControlChange);
}

/// Log a record with an explicit session_id.
fn sample_record_with_session(request_id: &str, session_id: &str) -> AuditRecord {
    AuditRecord {
        session_id: Some(session_id.to_string()),
        ..sample_record(request_id, None)
    }
}

/// A member's usage view pins `user_id` to the caller, so rows attributed to
/// another member (or to no one) must never match.
#[test]
fn user_id_filter_returns_only_that_members_rows() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-user-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };
    let logger = AuditLogger::new(&config).expect("logger");

    for (request_id, user_id) in [
        ("req-alice-1", Some("alice")),
        ("req-alice-2", Some("alice")),
        ("req-bob", Some("bob")),
        ("req-anon", None),
    ] {
        logger.log(AuditRecord {
            user_id: user_id.map(str::to_owned),
            ..sample_record(request_id, None)
        });
    }
    wait_for_rows(&logger, &AuditQuery::default(), 4);

    let alice_rows = logger
        .query(&AuditQuery {
            user_id: Some("alice".to_owned()),
            ..Default::default()
        })
        .expect("query by user_id");
    assert_eq!(alice_rows.len(), 2);
    assert!(alice_rows
        .iter()
        .all(|entry| entry.user_id.as_deref() == Some("alice")));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Verifies that logging two different sessions and querying by session_id returns
/// only the rows that belong to the requested session (M4 / #176 AC4).
#[test]
fn session_id_filter_returns_only_matching_session() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-session-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };

    let logger = AuditLogger::new(&config).expect("logger");

    // Two requests belonging to session A.
    logger.log(sample_record_with_session("req-a1", "session-A"));
    logger.log(sample_record_with_session("req-a2", "session-A"));
    // One request belonging to session B.
    logger.log(sample_record_with_session("req-b1", "session-B"));

    // Wait for all three rows to be persisted.
    wait_for_rows(&logger, &AuditQuery::default(), 3);

    // Querying by session-A must return exactly two rows.
    let session_a_rows = logger
        .query(&AuditQuery {
            session_id: Some("session-A".to_string()),
            ..Default::default()
        })
        .expect("query by session_id");
    assert_eq!(session_a_rows.len(), 2, "expected 2 rows for session-A");
    for entry in &session_a_rows {
        assert_eq!(entry.session_id.as_deref(), Some("session-A"));
    }

    // Querying by session-B must return exactly one row.
    let session_b_rows = logger
        .query(&AuditQuery {
            session_id: Some("session-B".to_string()),
            ..Default::default()
        })
        .expect("query by session_id session-B");
    assert_eq!(session_b_rows.len(), 1, "expected 1 row for session-B");
    assert_eq!(session_b_rows[0].request_id, "req-b1");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn timestamp_range_accepts_iso_bounds_and_excludes_upper_bound() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-timestamp-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    };
    let logger = AuditLogger::new(&config).expect("logger");
    logger.log(sample_record("req-time", None));
    let rows = wait_for_rows(&logger, &AuditQuery::default(), 1);
    let iso_timestamp = format!("{}Z", rows[0].timestamp.replace(' ', "T"));

    let in_range = logger
        .query(&AuditQuery {
            timestamp_from: Some(iso_timestamp.clone()),
            timestamp_until: Some("2999-01-01T00:00:00Z".to_string()),
            ..Default::default()
        })
        .expect("query by ISO timestamp range");
    assert_eq!(in_range.len(), 1);

    let at_upper_bound = logger
        .query(&AuditQuery {
            timestamp_until: Some(iso_timestamp),
            ..Default::default()
        })
        .expect("query by exclusive upper bound");
    assert!(at_upper_bound.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

/// #523: the credential-read constructor produces a distinct, attributable
/// record (domain in `command`, source in `backend`/`model`) that is NOT a
/// sandbox exec — so identity reads are filterable and never look like execs.
#[test]
fn credential_read_record_shape() {
    let rec = AuditLogger::make_credential_read_record(
        "req-id".to_string(),
        "sk-core".to_string(),
        "manual".to_string(),
        "app.example.com".to_string(),
        Some("session-X".to_string()),
        None,
    );
    assert_eq!(rec.event_type, EventType::CredentialRead);
    assert_eq!(rec.event_type.as_str(), "credential_read");
    assert_eq!(rec.provider, "identity");
    // Source is attributable via both backend and the model slot.
    assert_eq!(rec.backend.as_deref(), Some("manual"));
    assert_eq!(rec.model, "manual");
    // The domain — never a secret — lands in the command slot.
    assert_eq!(rec.command.as_deref(), Some("app.example.com"));
    assert_eq!(rec.session_id.as_deref(), Some("session-X"));
    // Inert exec-only fields don't masquerade as an execution.
    assert!(rec.duration_ms.is_none());
    assert!(rec.exit_code.is_none());
}

/// §4.4: the widget `callTool` constructor produces an attributable
/// `ExecCall` tagged `feature="widget"` (backend=origin_server,
/// command=tool_id) carrying the per-render instance id — so it drains the
/// exec budget like any tool run but is filterable per widget.
#[test]
fn widget_call_record_shape() {
    let rec = AuditLogger::make_widget_call_record(
        "req-id".to_string(),
        "sk-core".to_string(),
        "io.ryu.checklist".to_string(),
        "checklist.toggle".to_string(),
        Some("agent-1".to_string()),
        Some("conv-9".to_string()),
        "wi-abc".to_string(),
        12,
        None,
    );
    assert_eq!(rec.event_type, EventType::ExecCall);
    assert_eq!(rec.feature.as_deref(), Some("widget"));
    assert_eq!(rec.backend.as_deref(), Some("io.ryu.checklist"));
    assert_eq!(rec.command.as_deref(), Some("checklist.toggle"));
    assert_eq!(rec.agent_id.as_deref(), Some("agent-1"));
    assert_eq!(rec.session_id.as_deref(), Some("conv-9"));
    assert_eq!(rec.widget_instance_id.as_deref(), Some("wi-abc"));
}

/// §4.4: the widget follow-up constructor is its own `WidgetFollowUp`
/// discriminator (never an exec) so follow-ups are filterable on their own.
#[test]
fn widget_followup_record_shape() {
    let rec = AuditLogger::make_widget_followup_record(
        "req-id".to_string(),
        "sk-core".to_string(),
        "io.ryu.checklist".to_string(),
        Some("conv-9".to_string()),
        "wi-abc".to_string(),
        Some("firewall: prompt_injection".to_string()),
    );
    assert_eq!(rec.event_type, EventType::WidgetFollowUp);
    assert_eq!(rec.event_type.as_str(), "widget_follow_up");
    assert_eq!(rec.feature.as_deref(), Some("widget"));
    assert_eq!(rec.command.as_deref(), Some("follow_up"));
    assert_eq!(rec.session_id.as_deref(), Some("conv-9"));
    assert_eq!(rec.widget_instance_id.as_deref(), Some("wi-abc"));
    assert!(rec.duration_ms.is_none());
}

/// §4.4: logging widget rows and querying by `widget_instance_id` returns
/// only the rows for that rendered widget.
#[test]
fn widget_instance_id_filter_returns_only_matching_widget() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-widget-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let config = AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_string(),
    };

    let logger = AuditLogger::new(&config).expect("logger");
    logger.log(AuditLogger::make_widget_call_record(
        "req-w1".to_string(),
        "sk-core".to_string(),
        "io.ryu.checklist".to_string(),
        "checklist.toggle".to_string(),
        None,
        Some("conv-9".to_string()),
        "wi-A".to_string(),
        5,
        None,
    ));
    logger.log(AuditLogger::make_widget_followup_record(
        "req-w2".to_string(),
        "sk-core".to_string(),
        "io.ryu.checklist".to_string(),
        Some("conv-9".to_string()),
        "wi-B".to_string(),
        None,
    ));
    wait_for_rows(&logger, &AuditQuery::default(), 2);

    let wi_a = logger
        .query(&AuditQuery {
            widget_instance_id: Some("wi-A".to_string()),
            ..Default::default()
        })
        .expect("query by widget_instance_id");
    assert_eq!(wi_a.len(), 1);
    assert_eq!(wi_a[0].request_id, "req-w1");
    assert_eq!(wi_a[0].widget_instance_id.as_deref(), Some("wi-A"));
    assert_eq!(wi_a[0].feature.as_deref(), Some("widget"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn agent_id_filter_returns_only_matching_rows() {
    let dir = std::env::temp_dir().join(format!("ryu-audit-agent-{}", unique_suffix()));
    let db_path = dir.join("audit.db");
    let logger = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db_path.to_str().unwrap().to_owned(),
    })
    .expect("logger");

    let mut agent_a = sample_record("req-agent-a", None);
    agent_a.agent_id = Some("agent-a".to_owned());
    let mut agent_b = sample_record("req-agent-b", None);
    agent_b.agent_id = Some("agent-b".to_owned());
    logger.log(agent_a);
    logger.log(agent_b);

    let rows = wait_for_rows(
        &logger,
        &AuditQuery {
            agent_id: Some("agent-a".to_owned()),
            ..Default::default()
        },
        1,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].agent_id.as_deref(), Some("agent-a"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// Cheap unique-ish suffix for temp dirs without pulling extra deps into tests.
fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
