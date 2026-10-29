//! Route-level preference stream, consent-write and support-grant invariants.
//!
//! Every case drives the shipping axum handlers over the preference store's real
//! SQLite file. Faults are injected only through an independent SQLite
//! connection, the same boundary a locked, full or damaged database presents;
//! durable effects are read back through that connection or a reopened store.
use super::*;
use axum::{body::Body, http::Request};
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;

const DELIVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

struct Harness {
    _directory: tempfile::TempDir,
    preferences_path: std::path::PathBuf,
    audit_path: std::path::PathBuf,
    state: ServerState,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let preferences_path = directory.path().join("preferences.db");
        let audit_path = directory.path().join("support-access-audit.db");
        let mut state = isolated_plugin_hook_test_state(directory.path());
        state.support_audit =
            crate::support_access::SupportAccessStore::open(audit_path.clone()).unwrap();
        let router = Router::new()
            .route("/api/preferences/stream", get(preferences_stream))
            .route(
                "/api/preferences/:key",
                get(get_preference).put(set_preference),
            )
            .route(
                "/api/support-access/diagnostics",
                get(support_access_diagnostics),
            )
            .layer(axum::Extension(
                None::<crate::identity_verify::VerifiedCaller>,
            ))
            .with_state(state.clone());
        Self {
            _directory: directory,
            preferences_path,
            audit_path,
            state,
            router,
        }
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn get(&self, key: &str) -> (StatusCode, Value) {
        self.send(
            Request::builder()
                .uri(format!("/api/preferences/{key}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    async fn put(&self, key: &str, value: &str) -> (StatusCode, Value) {
        self.send(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/preferences/{key}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "value": value }).to_string()))
                .unwrap(),
        )
        .await
    }

    async fn diagnostics(&self, actor: Option<&str>) -> (StatusCode, Value) {
        let mut request = Request::builder().uri("/api/support-access/diagnostics");
        if let Some(actor) = actor {
            request = request.header("x-ryu-support-actor", actor);
        }
        self.send(request.body(Body::empty()).unwrap()).await
    }

    /// A second SQLite connection to the same file, outside the store's handle.
    fn independent(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(&self.preferences_path).unwrap()
    }

    /// The exact persisted row (stored value and write timestamp).
    fn raw_record(&self, key: &str) -> Option<(String, i64)> {
        self.independent()
            .query_row(
                "SELECT value, updated_at FROM preferences WHERE key = ?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap()
    }

    /// Make SQLite refuse every insert or update of `key`.
    fn refuse_writes_to(&self, key: &str) {
        self.independent()
            .execute_batch(&format!(
                "CREATE TRIGGER refuse_insert BEFORE INSERT ON preferences
                 WHEN NEW.key = '{key}' BEGIN SELECT RAISE(ABORT, 'write refused'); END;
                 CREATE TRIGGER refuse_update BEFORE UPDATE ON preferences
                 WHEN NEW.key = '{key}' BEGIN SELECT RAISE(ABORT, 'write refused'); END;"
            ))
            .unwrap();
    }

    fn allow_writes(&self) {
        self.independent()
            .execute_batch("DROP TRIGGER refuse_insert; DROP TRIGGER refuse_update;")
            .unwrap();
    }

    fn reopen(&self) -> crate::server::preferences::PreferencesStore {
        crate::server::preferences::PreferencesStore::open(self.preferences_path.clone()).unwrap()
    }
}

/// Parse the `data:` payloads of complete server-sent events.
fn sse_payloads(wire: &str) -> Vec<Value> {
    wire.split("\n\n")
        .filter_map(|frame| frame.lines().find_map(|line| line.strip_prefix("data: ")))
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
}

fn next_event(
    events: &mut tokio::sync::broadcast::Receiver<crate::server::preferences::PreferenceEvent>,
) -> Option<(String, String)> {
    match events.try_recv() {
        Ok(event) => Some((event.key, event.value)),
        Err(TryRecvError::Empty) => None,
        Err(error) => panic!("preference change stream failed: {error}"),
    }
}

#[tokio::test]
async fn preference_stream_redacts_secrets_on_the_wire_and_releases_subscription_on_disconnect() {
    let harness = Harness::new();
    let preferences = &harness.state.preferences;
    assert_eq!(preferences.live_subscriber_count(), 0);
    let response = harness
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/preferences/stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[axum::http::header::CONTENT_TYPE],
        "text/event-stream"
    );
    assert_eq!(preferences.live_subscriber_count(), 1);
    let mut stream = response.into_body().into_data_stream();

    let secret = "unsplash-secret-value";
    assert_eq!(
        harness.put("unsplash-access-key", secret).await,
        (
            StatusCode::OK,
            json!({ "ok": true, "key": "unsplash-access-key" })
        )
    );
    let theme = r#"{"preset":"midnight","mode":"dark"}"#;
    assert_eq!(harness.put("theme", theme).await.0, StatusCode::OK);

    let mut wire = String::new();
    while sse_payloads(&wire).len() < 2 {
        let chunk = tokio::time::timeout(DELIVERY_TIMEOUT, stream.next())
            .await
            .expect("the stream must deliver both acknowledged writes")
            .expect("the stream must stay open while the client is connected")
            .unwrap();
        wire.push_str(std::str::from_utf8(&chunk).unwrap());
    }
    assert!(!wire.contains(secret), "secret reached the stream: {wire}");
    assert_eq!(
        sse_payloads(&wire),
        vec![
            json!({ "key": "unsplash-access-key", "value": "" }),
            json!({ "key": "theme", "value": theme }),
        ]
    );
    // A read reports only that the credential is set; it is sealed at rest.
    assert_eq!(
        harness.get("unsplash-access-key").await,
        (
            StatusCode::OK,
            json!({ "key": "unsplash-access-key", "value": ryu_crypto::redact::REDACTED })
        )
    );
    let (sealed, _) = harness.raw_record("unsplash-access-key").unwrap();
    assert!(sealed.starts_with("enc:v1:") && !sealed.contains(secret));
    // Saving the form unchanged sends the placeholder back: the credential stays.
    assert_eq!(
        harness
            .put("unsplash-access-key", ryu_crypto::redact::REDACTED)
            .await,
        (
            StatusCode::OK,
            json!({ "ok": true, "key": "unsplash-access-key" })
        )
    );
    assert_eq!(harness.raw_record("unsplash-access-key").unwrap().0, sealed);
    assert_eq!(
        harness
            .state
            .preferences
            .get("unsplash-access-key")
            .await
            .unwrap()
            .as_deref(),
        Some(secret)
    );

    drop(stream);
    assert_eq!(
        preferences.live_subscriber_count(),
        0,
        "a disconnected stream must release its change subscription"
    );
    let daylight = r#"{"preset":"daylight","mode":"light"}"#;
    assert_eq!(harness.put("theme", daylight).await.0, StatusCode::OK);
    assert_eq!(
        harness.reopen().get("theme").await.unwrap().as_deref(),
        Some(daylight)
    );
}

#[tokio::test]
async fn refused_consent_write_returns_error_and_keeps_persisted_opt_out_authoritative() {
    let harness = Harness::new();
    let key = crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY;
    assert_eq!(harness.put(key, "false").await.0, StatusCode::OK);
    assert_eq!(harness.put("theme", "dark").await.0, StatusCode::OK);
    let opted_out = harness.raw_record(key).unwrap();
    let mut events = harness.state.preferences.subscribe();
    harness.refuse_writes_to(key);

    let (status, body) = harness.put(key, "true").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body, json!({ "error": "writing preference" }));
    assert_eq!(next_event(&mut events), None);
    assert_eq!(
        harness.get(key).await,
        (StatusCode::OK, json!({ "key": key, "value": "false" }))
    );
    assert_eq!(harness.raw_record(key).unwrap(), opted_out);
    assert!(!crate::privacy::crash_reports_enabled(&harness.reopen()).await);

    // The refusal is scoped to the failed key; other settings still save.
    assert_eq!(harness.put("theme", "light").await.0, StatusCode::OK);
    assert_eq!(
        next_event(&mut events),
        Some(("theme".to_owned(), "light".to_owned()))
    );

    harness.allow_writes();
    assert_eq!(
        harness.put(key, "true").await,
        (StatusCode::OK, json!({ "ok": true, "key": key }))
    );
    assert_eq!(
        next_event(&mut events),
        Some((key.to_owned(), "true".to_owned()))
    );
    assert_eq!(next_event(&mut events), None);
    assert_eq!(
        harness.get(key).await,
        (StatusCode::OK, json!({ "key": key, "value": "true" }))
    );
    let reopened = harness.reopen();
    assert!(crate::privacy::crash_reports_enabled(&reopened).await);
    assert_eq!(
        reopened.get("theme").await.unwrap().as_deref(),
        Some("light")
    );
}

#[tokio::test]
async fn expired_support_grant_stays_refused_and_audited_when_its_durable_sweep_cannot_write() {
    let harness = Harness::new();
    let enabled = crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY;
    let expiry = crate::privacy::SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY;
    let expired_at = chrono::Utc::now().timestamp_millis() - 60_000;
    assert_eq!(harness.put(enabled, "true").await.0, StatusCode::OK);
    assert_eq!(
        harness.put(expiry, &expired_at.to_string()).await.0,
        StatusCode::OK
    );
    assert_eq!(harness.put("theme", "dark").await.0, StatusCode::OK);
    let expiry_record = harness.raw_record(expiry).unwrap();
    let theme_record = harness.raw_record("theme").unwrap();
    let refusal = json!({
        "error": "support access is not granted",
        "code": "support_access_off",
    });
    harness.refuse_writes_to(enabled);

    assert_eq!(
        harness.diagnostics(Some("support-engineer-a")).await,
        (StatusCode::FORBIDDEN, refusal.clone())
    );
    // The durable sweep could not write, so the stale grant is still stored,
    // yet the request-time gate refused it and recorded the refusal.
    assert_eq!(harness.raw_record(enabled).unwrap().0, "true");
    let refused = |actor: &str| {
        (
            actor.to_owned(),
            "access_refused".to_owned(),
            Some("grant off or expired".to_owned()),
        )
    };
    let audit_rows = |entries: Vec<crate::support_access::AuditEntry>| {
        entries
            .into_iter()
            .map(|entry| (entry.actor, entry.action, entry.detail))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        audit_rows(harness.state.support_audit.list().await.unwrap()),
        vec![refused("support-engineer-a")]
    );

    harness.allow_writes();
    assert_eq!(
        harness.diagnostics(None).await,
        (StatusCode::FORBIDDEN, refusal)
    );
    assert_eq!(harness.raw_record(enabled).unwrap().0, "false");
    assert_eq!(
        harness.get(enabled).await,
        (StatusCode::OK, json!({ "key": enabled, "value": "false" }))
    );
    let reopened = harness.reopen();
    assert_eq!(
        crate::privacy::support_access_local(&reopened).await,
        crate::privacy::SupportAccessLocal {
            enabled: false,
            expiry_ms: expired_at,
        }
    );
    assert_eq!(harness.raw_record(expiry).unwrap(), expiry_record);
    assert_eq!(harness.raw_record("theme").unwrap(), theme_record);
    let audit = crate::support_access::SupportAccessStore::open(harness.audit_path.clone())
        .unwrap()
        .list()
        .await
        .unwrap();
    assert!(audit.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    assert_eq!(
        audit_rows(audit),
        vec![
            refused("support-engineer-a"),
            refused(crate::support_access::UNKNOWN_ACTOR)
        ]
    );
}

// OTLP content settings. The route re-reads both stored values after a write to
// either key and applies them to the process-global telemetry state, so every
// case sends a real PUT and reads that state back. Export consent stays off for
// the writes (the Gateway respawn is gated on it); the `TestStateGuard` resets
// and restores the globals.

async fn assert_put_applies(harness: &Harness, key: &str, sent: &str) {
    let (status, body) = harness.put(key, sent).await;
    assert_eq!(status, StatusCode::OK, "PUT {key}={sent:?}: {body}");
    assert_eq!(
        harness.raw_record(key).map(|(stored, _)| stored).as_deref(),
        Some(sent),
        "{key} is persisted exactly as sent"
    );
    // The generic read treats a blank stored value as unset, so `""` reads back
    // as null while the row itself keeps the blank string.
    let read_back = if sent.trim().is_empty() {
        Value::Null
    } else {
        json!(sent)
    };
    let (status, body) = harness.get(key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], read_back, "GET {key} after PUT {sent:?}");
}

#[tokio::test]
async fn otlp_content_mode_write_applies_live_and_only_an_explicit_opt_in_enables_content() {
    use crate::privacy::ContentMode::{Content, MetadataOnly};
    let _telemetry = crate::telemetry::TestStateGuard::acquire();
    let harness = Harness::new();
    let key = crate::privacy::DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY;
    assert_eq!(crate::telemetry::content_mode(), MetadataOnly);

    // Each opt-in is followed by a value that must take it back, so a write
    // that stopped applying cannot hide behind the previous step's result.
    let steps = [
        ("content", Content),
        ("garbage", MetadataOnly),
        ("content", Content),
        ("", MetadataOnly),
        ("content", Content),
        ("metadata_only", MetadataOnly),
        (" CONTENT ", Content),
        ("true", MetadataOnly),
        ("full", Content),
        ("metadata_only", MetadataOnly),
    ];
    for (sent, expected) in steps {
        assert_put_applies(&harness, key, sent).await;
        assert_eq!(
            crate::telemetry::content_mode(),
            expected,
            "content mode after PUT {sent:?}"
        );
    }
}

#[tokio::test]
async fn otlp_max_content_bytes_write_applies_live_and_unusable_values_fall_back_to_the_default() {
    use crate::privacy::ContentMode::{Content, MetadataOnly};
    let _telemetry = crate::telemetry::TestStateGuard::acquire();
    let harness = Harness::new();
    let bytes_key = crate::privacy::DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY;
    let mode_key = crate::privacy::DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY;
    let default = crate::privacy::DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES;
    assert_eq!(default, 750_000);
    assert_eq!(crate::telemetry::max_content_bytes(), default);

    let steps = [
        ("2048", 2048),
        ("0", default),
        ("2048", 2048),
        ("x", default),
        ("2048", 2048),
        ("", default),
        (" 4096 ", 4096),
        ("-5", default),
        ("1", 1),
        ("1.5", default),
    ];
    for (sent, expected) in steps {
        assert_put_applies(&harness, bytes_key, sent).await;
        assert_eq!(
            crate::telemetry::max_content_bytes(),
            expected,
            "byte cap after PUT {sent:?}"
        );
        assert_eq!(
            crate::telemetry::content_mode(),
            MetadataOnly,
            "a byte-cap write must not turn content on (PUT {sent:?})"
        );
    }

    // The two keys share one handler arm that re-reads both stored values: a
    // write to one must leave the other's applied value alone.
    assert_put_applies(&harness, mode_key, "content").await;
    assert_put_applies(&harness, bytes_key, "2048").await;
    assert_eq!(crate::telemetry::content_mode(), Content);
    assert_eq!(crate::telemetry::max_content_bytes(), 2048);
    assert_put_applies(&harness, bytes_key, "x").await;
    assert_eq!(crate::telemetry::content_mode(), Content);
    assert_eq!(crate::telemetry::max_content_bytes(), default);
    assert_put_applies(&harness, bytes_key, "4096").await;
    assert_put_applies(&harness, mode_key, "metadata_only").await;
    assert_eq!(crate::telemetry::content_mode(), MetadataOnly);
    assert_eq!(crate::telemetry::max_content_bytes(), 4096);
}

#[tokio::test]
async fn otlp_content_never_enables_without_export_consent_whatever_the_stored_mode_is() {
    use crate::privacy::ContentMode::{Content, MetadataOnly};
    let _telemetry = crate::telemetry::TestStateGuard::acquire();
    let harness = Harness::new();
    let key = crate::privacy::DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY;
    // Consent can only be on when an OTLP destination is active, which Core
    // seeds once at startup; the seam supplies one for the test process.
    crate::telemetry::seed_otlp_endpoint_for_test("https://otlp.preferences-route.test");

    // Consent without the separate content opt-in still carries metadata only.
    crate::telemetry::set_export_consent(true);
    assert!(
        crate::telemetry::is_export_consented(),
        "an active endpoint lets the consent toggle take effect"
    );
    assert_eq!(crate::telemetry::content_mode(), MetadataOnly);
    assert!(!crate::telemetry::content_enabled());

    // The opt-in is stored while consent is off: the mode is applied, but no
    // span may carry content.
    crate::telemetry::set_export_consent(false);
    assert_put_applies(&harness, key, "content").await;
    assert_eq!(crate::telemetry::content_mode(), Content);
    assert!(!crate::telemetry::is_export_consented());
    assert!(
        !crate::telemetry::content_enabled(),
        "content mode without export consent must not enable content"
    );

    // Both switches on is the only state in which content is built, and
    // withdrawing consent closes it again without touching the stored mode.
    crate::telemetry::set_export_consent(true);
    assert!(crate::telemetry::content_enabled());
    crate::telemetry::set_export_consent(false);
    assert_eq!(crate::telemetry::content_mode(), Content);
    assert!(!crate::telemetry::content_enabled());
}
