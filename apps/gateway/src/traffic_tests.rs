//! Live traffic verdicts (spec 07.2): the structured, redacted verdict each
//! event carries, the org scope of `GET /v1/traffic`, and the request path end
//! to end with the audit store switched off.
//!
//! Test content is the test-only lexicon `RYU_TEST_LEXICON`, the AWS example
//! key and the standard test card number; no real harmful text is used.
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::audit::EventType;
use crate::config::{CustomPattern, CustomPatternKind, FirewallPolicy, ProviderId};
use crate::platform_floor::PlatformFloor;
use crate::policy::ResolveCache;
use crate::providers::Provider;
use crate::state::AppState;

const LEXICON: &str = "RYU_TEST_LEXICON";
const AWS_EXAMPLE_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const TEST_CARD: &str = "4111 1111 1111 1111";
/// A full Gateway key. Only its six-character prefix may reach the feed.
const FULL_KEY: &str = "rgw_traffic_full_key_0123456789";
const FLOOR_PATTERN: &str = "ryu_floor_test_lexicon";
const FIXTURE: &str = "traffic-fixture";

fn prompt() -> String {
    format!("echo {LEXICON} and {AWS_EXAMPLE_KEY} and {TEST_CARD} please")
}

fn record(request_id: &str) -> AuditRecord {
    AuditRecord {
        key_id: Some("cred_0123456789abcdef".to_owned()),
        request_id: request_id.to_owned(),
        api_key: FULL_KEY.to_owned(),
        user_name: None,
        org_id: Some("org_a".to_owned()),
        team_id: Some("team_1".to_owned()),
        team_ids: Some("team_1,team_2".to_owned()),
        project_id: None,
        provider: "openrouter".to_owned(),
        model: "fixture-model".to_owned(),
        input_tokens: 3,
        output_tokens: 1,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 120,
        eval_score: None,
        error: None,
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

/// A guardrail row as the pipeline writes it: provider tag, no tokens.
fn guardrail_record(request_id: &str, provider: &str, error: String) -> AuditRecord {
    AuditRecord {
        provider: provider.to_owned(),
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error: Some(error),
        ..record(request_id)
    }
}

fn publish(bus: &TrafficBus, record: &AuditRecord, outcome: TrafficOutcome) -> Value {
    let event = bus.enrich(
        traffic_event(record),
        record,
        outcome,
        GatewayCustody::Fleet,
    );
    bus.publish(event);
    bus.recent().pop().expect("published")
}

fn assert_no_leak(event: &Value) {
    let serialized = event.to_string();
    for private in [
        LEXICON,
        AWS_EXAMPLE_KEY,
        TEST_CARD,
        FULL_KEY,
        FLOOR_PATTERN,
        "cred_0123456789abcdef",
    ] {
        assert!(
            !serialized.contains(private),
            "event leaked {private}: {serialized}"
        );
    }
    for absent in ["end_user_hash", "upstream_subject", "messages", "prompt"] {
        assert!(event.get(absent).is_none(), "event carries {absent}");
    }
}

// ─── Verdict fields ────────────────────────────────────────────────────────

#[test]
fn an_allowed_completion_reports_no_decider_and_its_stage_latencies() {
    let bus = TrafficBus::new();
    bus.note_screen("req-allow", Some("/v1/chat/completions".to_owned()), 20);
    let rec = record("req-allow");
    let event = publish(&bus, &rec, TrafficOutcome::inferred(&rec));

    assert_eq!(event["kind"], "completion");
    assert_eq!(event["status"], 200);
    assert_eq!(event["verdict"]["decided_by"], "none");
    assert_eq!(event["verdict"]["action"], "allow");
    assert_eq!(event["verdict"]["code"], Value::Null);
    assert_eq!(event["route"], "/v1/chat/completions");
    assert_eq!(event["custody"], "fleet");
    assert_eq!(event["credential_origin"], "ryu_vault");
    assert_eq!(event["provider"], "openrouter");
    assert_eq!(event["model"], "fixture-model");
    assert_eq!(event["org_id"], "org_a");
    assert_eq!(event["team_ids"], json!(["team_1", "team_2"]));
    assert_eq!(event["credential_id_prefix"], "cred_012***");
    assert_eq!(event["api_key"], "rgw_tr***");
    assert_eq!(event["stage_latency_ms"]["screen"], 20);
    assert_eq!(event["stage_latency_ms"]["upstream"], 100);
    assert!(event["seq"].as_u64().is_some());
    assert_no_leak(&event);
}

#[test]
fn a_sanitize_noted_at_the_firewall_rides_on_the_completion() {
    let bus = TrafficBus::new();
    let layers = FirewallLayers {
        org_patterns: vec!["org_lexicon".to_owned()],
        ..FirewallLayers::default()
    };
    bus.note_verdict(
        "req-sanitize",
        firewall_verdict(
            "org_lexicon",
            &crate::firewall::DetectionKind::Secret,
            &layers,
            VerdictAction::Sanitize,
        ),
    );
    bus.note_screen("req-sanitize", None, 5);
    let rec = record("req-sanitize");
    let event = publish(&bus, &rec, TrafficOutcome::inferred(&rec));

    assert_eq!(event["kind"], "completion");
    assert_eq!(event["verdict"]["decided_by"], "org");
    assert_eq!(event["verdict"]["action"], "sanitize");
    assert_eq!(event["verdict"]["detector_ids"], json!(["org_lexicon"]));
    assert_eq!(event["status"], 200);
    assert_no_leak(&event);
}

#[test]
fn an_inspector_block_attributes_both_the_verdict_and_the_failure_row() {
    let bus = TrafficBus::new();
    // The inspector's reason is model output that can quote the prompt.
    let reason = format!("the user asked to {}", prompt());
    let verdict_row = guardrail_record(
        "req-inspect",
        "inspector",
        format!("inspector blocked: {reason} [prompt_attack]"),
    );
    let verdict = TrafficVerdict::new(DecidedBy::Inspector, VerdictAction::Block)
        .with_detector("prompt_attack")
        .with_detector(&reason);
    let first = publish(&bus, &verdict_row, TrafficOutcome::verdict(verdict));

    let error = GatewayError::FirewallBlocked(
        format!("Inbound content blocked by inspector: {reason} [prompt_attack]"),
        None,
    );
    let failure_row = AuditRecord {
        provider: "none".to_owned(),
        error: Some(error.to_string()),
        ..record("req-inspect")
    };
    let second = publish(&bus, &failure_row, TrafficOutcome::failure(&error));

    for event in [&first, &second] {
        assert_eq!(event["verdict"]["decided_by"], "inspector");
        assert_eq!(event["verdict"]["action"], "block");
        assert_eq!(
            event["verdict"]["detector_ids"],
            json!(["prompt_attack"]),
            "free text is never a detector id"
        );
        assert_eq!(event["error"], "blocked by inspector");
        assert_eq!(event["credential_origin"], "unknown");
        assert_no_leak(event);
    }
    assert_eq!(first["kind"], "verdict");
    assert_eq!(first["status"], Value::Null);
    assert_eq!(second["kind"], "failure");
    assert_eq!(second["status"], 403);
    assert_eq!(second["verdict"]["code"], "policy_violation");
    assert!(second["seq"].as_u64() > first["seq"].as_u64());
}

#[test]
fn a_floor_block_names_the_detection_kind_never_the_floor_pattern() {
    let bus = TrafficBus::new();
    let layers = FirewallLayers {
        floor_scans_inbound: true,
        floor_patterns: vec![FLOOR_PATTERN.to_owned()],
        ..FirewallLayers::default()
    };
    bus.note_verdict(
        "req-floor",
        firewall_verdict(
            FLOOR_PATTERN,
            &crate::firewall::DetectionKind::Secret,
            &layers,
            VerdictAction::Block,
        ),
    );
    let error = GatewayError::FirewallBlocked(
        format!("Inbound content blocked: {FLOOR_PATTERN} (Secret)"),
        None,
    );
    let rec = AuditRecord {
        provider: "none".to_owned(),
        error: Some(error.to_string()),
        ..record("req-floor")
    };
    let event = publish(&bus, &rec, TrafficOutcome::failure(&error));

    assert_eq!(event["kind"], "failure");
    assert_eq!(event["verdict"]["decided_by"], "platform_floor");
    assert_eq!(event["verdict"]["action"], "block");
    assert_eq!(event["verdict"]["detector_ids"], json!(["secret"]));
    assert_eq!(event["error"], "blocked by platform_floor");
    assert_eq!(event["status"], 403);
    // A failure while screening spent its whole latency screening.
    assert_eq!(event["stage_latency_ms"]["screen"], 120);
    assert_eq!(event["stage_latency_ms"]["upstream"], Value::Null);
    assert_no_leak(&event);
}

#[test]
fn each_refusal_reports_the_layer_and_code_the_client_received() {
    let cases: Vec<(GatewayError, &str, &str, u16, &str)> = vec![
        (
            GatewayError::RateLimited,
            "rate_limit",
            "block",
            429,
            "rate_limit_exceeded",
        ),
        (
            GatewayError::BudgetExceeded(None),
            "budget",
            "block",
            402,
            "budget_exceeded",
        ),
        (
            GatewayError::StandingUnavailable,
            "standing",
            "block",
            503,
            "standing_unavailable",
        ),
        (
            GatewayError::PlatformRefused {
                code: "feature_not_permitted",
                message: "fixed",
            },
            "platform_floor",
            "block",
            403,
            "feature_not_permitted",
        ),
        (
            GatewayError::ScreeningUnavailable {
                reason: "platform_floor_unavailable",
                retry_after_secs: 10,
            },
            "platform_floor",
            "block",
            503,
            "screening_unavailable",
        ),
        (
            GatewayError::PolicyViolation("locked guardrail".to_owned()),
            "org",
            "block",
            403,
            "policy_violation",
        ),
        (
            GatewayError::ProviderTransport("connect refused".to_owned()),
            "none",
            "allow",
            502,
            "provider_error",
        ),
    ];
    for (error, layer, action, status, code) in cases {
        let bus = TrafficBus::new();
        let rec = AuditRecord {
            provider: "none".to_owned(),
            error: Some("redacted".to_owned()),
            ..record("req-refused")
        };
        let event = publish(&bus, &rec, TrafficOutcome::failure(&error));
        assert_eq!(event["verdict"]["decided_by"], layer, "{error}");
        assert_eq!(event["verdict"]["action"], action, "{error}");
        assert_eq!(event["status"], status, "{error}");
        assert_eq!(event["verdict"]["code"], code, "{error}");
        assert_eq!(
            error.wire_status_and_code(),
            (StatusCode::from_u16(status).unwrap(), code),
            "{error}"
        );
    }
}

#[tokio::test]
async fn the_feed_code_matches_the_rendered_envelope_code() {
    let errors = vec![
        GatewayError::RateLimited,
        GatewayError::StandingUnavailable,
        GatewayError::PlatformRefused {
            code: "media_unscreenable",
            message: "fixed",
        },
        GatewayError::ScreeningUnavailable {
            reason: "platform_floor_unavailable",
            retry_after_secs: 10,
        },
        GatewayError::InvalidRequest {
            code: "invalid_end_user",
            message: "fixed",
        },
        GatewayError::FirewallBlocked("blocked".to_owned(), None),
        GatewayError::InsufficientCredits,
    ];
    for error in errors {
        let (status, code) = error.wire_status_and_code();
        let response = error.into_response();
        assert_eq!(response.status(), status);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], code);
    }
}

#[test]
fn a_stronger_noted_verdict_replaces_a_weaker_one_and_ties_keep_the_first() {
    let bus = TrafficBus::new();
    bus.note_verdict(
        "req-merge",
        TrafficVerdict::new(DecidedBy::Node, VerdictAction::Warn).with_detector("first"),
    );
    bus.note_verdict(
        "req-merge",
        TrafficVerdict::new(DecidedBy::Evaluator, VerdictAction::Sanitize).with_evaluator("ev_a"),
    );
    bus.note_verdict(
        "req-merge",
        TrafficVerdict::new(DecidedBy::Agent, VerdictAction::Sanitize).with_detector("later"),
    );
    let rec = record("req-merge");
    let event = publish(&bus, &rec, TrafficOutcome::inferred(&rec));
    assert_eq!(event["verdict"]["decided_by"], "evaluator");
    assert_eq!(event["verdict"]["action"], "sanitize");
    assert_eq!(event["verdict"]["evaluator_ids"], json!(["ev_a"]));
}

/// The note `screening::admit` writes for a deadline-bound screen that let
/// the request through: the floor, `Allow`, `degraded = deadline`.
fn deadline_allow() -> TrafficVerdict {
    let mut verdict = TrafficVerdict::new(DecidedBy::PlatformFloor, VerdictAction::Allow);
    verdict.degraded = Some("deadline");
    verdict
}

#[test]
fn an_allowing_deadline_note_still_marks_the_completion_degraded() {
    let bus = TrafficBus::new();
    bus.note_verdict("req-deadline", deadline_allow());
    let rec = record("req-deadline");
    let event = publish(&bus, &rec, TrafficOutcome::inferred(&rec));
    assert_eq!(event["kind"], "completion");
    assert_eq!(event["verdict"]["decided_by"], "none");
    assert_eq!(event["verdict"]["action"], "allow");
    assert_eq!(event["verdict"]["degraded"], "deadline");
}

#[test]
fn a_deadline_note_survives_a_stronger_verdict_in_either_order() {
    let bus = TrafficBus::new();
    bus.note_verdict("req-deadline-first", deadline_allow());
    bus.note_verdict(
        "req-deadline-first",
        TrafficVerdict::new(DecidedBy::Node, VerdictAction::Sanitize).with_detector("email"),
    );
    bus.note_verdict(
        "req-deadline-last",
        TrafficVerdict::new(DecidedBy::Node, VerdictAction::Sanitize).with_detector("email"),
    );
    bus.note_verdict("req-deadline-last", deadline_allow());
    for request_id in ["req-deadline-first", "req-deadline-last"] {
        let rec = record(request_id);
        let event = publish(&bus, &rec, TrafficOutcome::inferred(&rec));
        assert_eq!(event["verdict"]["action"], "sanitize", "{request_id}");
        assert_eq!(event["verdict"]["decided_by"], "node", "{request_id}");
        assert_eq!(event["verdict"]["degraded"], "deadline", "{request_id}");
    }
}

#[test]
fn a_rate_limit_is_never_reattributed_to_a_noted_guardrail() {
    let bus = TrafficBus::new();
    bus.note_verdict(
        "req-limit",
        TrafficVerdict::new(DecidedBy::Node, VerdictAction::Block),
    );
    let rec = AuditRecord {
        error: Some("Rate limit exceeded".to_owned()),
        ..record("req-limit")
    };
    let event = publish(
        &bus,
        &rec,
        TrafficOutcome::failure(&GatewayError::RateLimited),
    );
    assert_eq!(event["verdict"]["decided_by"], "rate_limit");
    assert_eq!(event["error"], "Rate limit exceeded");
}

#[test]
fn firewall_matches_belong_to_the_broadest_layer_that_declared_them() {
    let layers = FirewallLayers {
        floor_scans_inbound: true,
        floor_patterns: vec!["floor_p".to_owned(), "shared".to_owned()],
        org_patterns: vec!["org_p".to_owned(), "shared".to_owned()],
        agent_patterns: vec!["agent_p".to_owned()],
        node_patterns: vec!["node_p".to_owned()],
    };
    assert_eq!(firewall_layer("floor_p", &layers), DecidedBy::PlatformFloor);
    assert_eq!(firewall_layer("shared", &layers), DecidedBy::PlatformFloor);
    assert_eq!(firewall_layer("org_p", &layers), DecidedBy::Org);
    assert_eq!(firewall_layer("agent_p", &layers), DecidedBy::Agent);
    assert_eq!(firewall_layer("node_p", &layers), DecidedBy::Node);
    // A curated pattern is the floor's while a floor scans inbound.
    assert_eq!(
        firewall_layer("aws_access_key", &layers),
        DecidedBy::PlatformFloor
    );
    let no_floor = FirewallLayers::default();
    assert_eq!(firewall_layer("aws_access_key", &no_floor), DecidedBy::Node);
}

#[test]
fn credential_origin_follows_custody_and_never_guesses_before_binding() {
    let completion = TrafficKind::Completion;
    assert_eq!(
        credential_origin(GatewayCustody::Fleet, "openrouter", None, completion),
        "ryu_vault"
    );
    assert_eq!(
        credential_origin(GatewayCustody::Fleet, "vercel", None, completion),
        "ryu_fallback"
    );
    assert_eq!(
        credential_origin(GatewayCustody::Fleet, "ollama", None, completion),
        "local"
    );
    assert_eq!(
        credential_origin(GatewayCustody::ManagedNode, "openrouter", None, completion),
        "node_operator"
    );
    assert_eq!(
        credential_origin(
            GatewayCustody::SelfHosted,
            "anthropic",
            Some("/passthrough/anthropic/*path"),
            completion
        ),
        "caller_subscription"
    );
    assert_eq!(
        credential_origin(GatewayCustody::Fleet, "none", None, TrafficKind::Failure),
        "unknown"
    );
    assert_eq!(
        credential_origin(GatewayCustody::Fleet, "openai", None, TrafficKind::Verdict),
        "unknown"
    );
    assert_eq!(
        credential_origin(GatewayCustody::Fleet, "openai", None, TrafficKind::CacheHit),
        "local"
    );
}

#[test]
fn notes_are_bounded_and_evicted_oldest_first() {
    let bus = TrafficBus::new();
    for index in 0..(NOTE_CAPACITY + 50) {
        bus.note_screen(&format!("req-{index}"), None, 1);
    }
    let notes = bus.notes.lock().unwrap();
    assert_eq!(notes.entries.len(), NOTE_CAPACITY);
    assert_eq!(notes.order.len(), NOTE_CAPACITY);
    assert!(!notes.entries.contains_key("req-0"), "oldest evicted first");
    assert!(notes
        .entries
        .contains_key(&format!("req-{}", NOTE_CAPACITY + 49)));
}

#[test]
fn an_auxiliary_row_never_takes_the_note_from_the_requests_completion() {
    let bus = TrafficBus::new();
    bus.note_verdict(
        "req-aux",
        TrafficVerdict::new(DecidedBy::Node, VerdictAction::Sanitize).with_detector("secret"),
    );
    // The inspector's own model call, then a failed tool round, both under
    // the parent request id.
    let auxiliary = AuditRecord {
        provider: "openai".to_owned(),
        ..record("req-aux")
    };
    publish(&bus, &auxiliary, TrafficOutcome::inferred(&auxiliary));
    let failed_round = AuditRecord {
        error: Some("upstream provider request failed".to_owned()),
        ..record("req-aux")
    };
    publish(
        &bus,
        &failed_round,
        TrafficOutcome::failure(&GatewayError::ProviderTransport("reset".to_owned())),
    );
    let rec = record("req-aux");
    let completion = publish(&bus, &rec, TrafficOutcome::inferred(&rec));
    assert_eq!(completion["verdict"]["decided_by"], "node");
    assert_eq!(completion["verdict"]["action"], "sanitize");
}

#[test]
fn an_unattributed_fleet_block_never_echoes_its_pattern() {
    let bus = TrafficBus::new();
    let error = GatewayError::FirewallBlocked(
        format!("Inbound content blocked: {FLOOR_PATTERN} (Secret)"),
        None,
    );
    let rec = AuditRecord {
        provider: "none".to_owned(),
        error: Some(error.to_string()),
        ..record("req-unattributed")
    };
    let event = publish(&bus, &rec, TrafficOutcome::failure(&error));
    assert_eq!(event["verdict"]["decided_by"], "node");
    assert_eq!(event["error"], "blocked by node");
    assert_no_leak(&event);

    // Off the fleet the operator's own block message stays readable.
    let event = bus.enrich(
        traffic_event(&rec),
        &rec,
        TrafficOutcome::failure(&error),
        GatewayCustody::SelfHosted,
    );
    assert!(event["error"].as_str().unwrap().contains(FLOOR_PATTERN));
}

#[test]
fn a_debit_row_is_not_a_provider_attempt() {
    assert_eq!(
        credential_origin(
            GatewayCustody::Fleet,
            "credits-debit",
            None,
            TrafficKind::Failure
        ),
        "unknown"
    );
}

#[test]
fn seq_is_strictly_increasing_across_publishers() {
    let bus = Arc::new(TrafficBus::new());
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let bus = Arc::clone(&bus);
            std::thread::spawn(move || {
                for _ in 0..40 {
                    bus.publish(json!({ "request_id": "same" }));
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let seqs: Vec<u64> = bus
        .recent()
        .iter()
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seqs.len(), 160);
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(*seqs.last().unwrap(), 160);
}

// ─── Org scope ─────────────────────────────────────────────────────────────

#[test]
fn the_master_key_sees_every_org_and_a_tenant_only_its_own() {
    assert_eq!(
        TrafficScope::for_caller(true, None, None).unwrap(),
        TrafficScope::All
    );
    assert_eq!(
        TrafficScope::for_caller(true, Some("org_a"), Some("org_b")).unwrap(),
        TrafficScope::Org("org_b".to_owned())
    );
    assert_eq!(
        TrafficScope::for_caller(false, Some("org_a"), None).unwrap(),
        TrafficScope::Org("org_a".to_owned())
    );
    assert_eq!(
        TrafficScope::for_caller(false, Some("org_a"), Some("org_a")).unwrap(),
        TrafficScope::Org("org_a".to_owned())
    );
    let refused = TrafficScope::for_caller(false, Some("org_a"), Some("org_b")).unwrap_err();
    assert_eq!(refused.wire_status_and_code().0, StatusCode::FORBIDDEN);
    assert_eq!(
        TrafficScope::for_caller(false, None, None).unwrap(),
        TrafficScope::All
    );
    for malformed in ["", " org_a", "org\u{7}a"] {
        assert!(TrafficScope::for_caller(true, None, Some(malformed)).is_err());
    }
    let long = "o".repeat(257);
    assert!(TrafficScope::for_caller(true, None, Some(&long)).is_err());

    let scope = TrafficScope::Org("org_a".to_owned());
    assert!(scope.admits(&json!({ "org_id": "org_a" })));
    assert!(!scope.admits(&json!({ "org_id": "org_b" })));
    assert!(
        !scope.admits(&json!({ "org_id": null })),
        "no org never matches"
    );
    assert!(!scope.admits(&json!({})));
    assert!(TrafficScope::All.admits(&json!({ "org_id": null })));
}

// ─── Request path end to end ───────────────────────────────────────────────

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Counts every completion, keeps the last body and answers a fixed reply.
struct FixtureProvider {
    calls: Arc<AtomicUsize>,
    last_body: Arc<std::sync::Mutex<Option<Value>>>,
}

impl Provider for FixtureProvider {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.last_body.lock().unwrap() = Some(body.clone());
        Box::pin(async {
            Ok(json!({
                "id": "chatcmpl-traffic",
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

/// A control plane resolving every `rgw_` token to `org_traffic`.
async fn control_plane() -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new().route(
        "/api/control-plane/gateway/resolve",
        axum::routing::get(|headers: axum::http::HeaderMap| async move {
            let token = headers
                .get("x-gateway-key")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            if !token.starts_with("rgw_") {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            axum::Json(json!({
                "organization": { "id": "org_traffic" },
                "credential": {
                    "id": "cred_traffic_0123456789",
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                },
                "managedInference": false,
                "standing": { "state": "active", "refuses": "none" },
                "platformFloorUnavailable": false
            }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), task)
}

fn floor() -> Arc<PlatformFloor> {
    PlatformFloor::from_wire(
        Some(&json!({
            "version": 1,
            "contentHash": "hash-1",
            "issuedAt": "2026-10-23T09:00:00.000Z",
            "overlay": {
                "enabled": true,
                "scan_inbound": true,
                "policy": "block",
                "custom_patterns": [{ "name": FLOOR_PATTERN, "regex": LEXICON, "kind": "secret" }]
            },
            "allowedProviders": [],
            "allowedModels": []
        })),
        false,
    )
    .expect("valid floor")
}

struct Harness {
    state: Arc<AppState>,
    app: axum::Router,
    calls: Arc<AtomicUsize>,
    last_body: Arc<std::sync::Mutex<Option<Value>>>,
}

/// A Gateway on `custody` with the audit store switched off, so every event
/// below proves the feed no longer depends on audit being enabled.
fn gateway(
    custody: GatewayCustody,
    resolve_url: Option<String>,
    configure: impl FnOnce(&mut crate::config::GatewayConfig),
) -> Harness {
    let mut config = crate::config::GatewayConfig::default();
    config.cache.enabled = false;
    config.routing.default_provider = ProviderId::from(FIXTURE);
    config.routing.fallback_chain = vec![];
    configure(&mut config);
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state.custody = custody;
    state.platform_floor.clear();
    if let Some(url) = resolve_url {
        state.resolve_cache = Some(ResolveCache::for_test(url, reqwest::Client::new()));
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let last_body = Arc::new(std::sync::Mutex::new(None));
    state
        .provider_runtime
        .register_for_test(Arc::new(FixtureProvider {
            calls: Arc::clone(&calls),
            last_body: Arc::clone(&last_body),
        }));
    let state = Arc::new(state);
    Harness {
        app: crate::api::router(Arc::clone(&state)),
        state,
        calls,
        last_body,
    }
}

fn loopback() -> axum::extract::ConnectInfo<std::net::SocketAddr> {
    axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 9)))
}

fn chat(token: Option<&str>, content: &str) -> Request<Body> {
    chat_body(
        token,
        json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": content }] }),
    )
}

fn chat_body(token: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .extension(loopback());
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, body)
}

#[tokio::test]
async fn fleet_allow_and_floor_block_reach_the_feed_with_audit_off() {
    let (url, server) = control_plane().await;
    let harness = gateway(GatewayCustody::Fleet, Some(url), |config| {
        config.auth.require_auth = true;
        config.firewall.locked_fields = Vec::new();
    });
    harness.state.platform_floor.observe(Some(&floor()));
    let token = "rgw_traffic_tenant_key_0123456789";

    let (status, body) = send(&harness.app, chat(Some(token), "hello")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(&harness.app, chat(Some(token), &prompt())).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        harness.calls.load(Ordering::SeqCst),
        1,
        "the block never dispatched"
    );

    let events = harness.state.traffic.recent();
    let allowed = events
        .iter()
        .find(|event| event["kind"] == "completion")
        .expect("completion event");
    assert_eq!(allowed["verdict"]["decided_by"], "none");
    assert_eq!(allowed["verdict"]["action"], "allow");
    assert_eq!(allowed["route"], "/v1/chat/completions");
    assert_eq!(allowed["custody"], "fleet");
    assert_eq!(allowed["credential_origin"], "ryu_vault");
    assert_eq!(allowed["org_id"], "org_traffic");
    assert_eq!(allowed["credential_id_prefix"], "cred_tra***");
    assert_eq!(allowed["status"], 200);
    assert!(allowed["stage_latency_ms"]["screen"].is_u64());
    assert!(allowed["stage_latency_ms"]["upstream"].is_u64());

    let blocked = events
        .iter()
        .find(|event| event["kind"] == "failure")
        .expect("the floor block appears with audit off");
    assert_eq!(blocked["verdict"]["decided_by"], "platform_floor");
    assert_eq!(blocked["verdict"]["action"], "block");
    assert_eq!(blocked["verdict"]["detector_ids"], json!(["secret"]));
    assert_eq!(blocked["verdict"]["code"], "policy_violation");
    assert_eq!(blocked["status"], 403);
    assert_eq!(blocked["route"], "/v1/chat/completions");
    assert_eq!(blocked["credential_origin"], "unknown");
    assert_eq!(blocked["org_id"], "org_traffic");
    for event in &events {
        let serialized = event.to_string();
        for private in [LEXICON, AWS_EXAMPLE_KEY, TEST_CARD, token, FLOOR_PATTERN] {
            assert!(
                !serialized.contains(private),
                "leaked {private}: {serialized}"
            );
        }
    }
    server.abort();
}

#[tokio::test]
async fn a_floor_block_in_a_residual_carrier_never_echoes_the_floor_pattern() {
    let (url, server) = control_plane().await;
    let harness = gateway(GatewayCustody::Fleet, Some(url), |config| {
        config.auth.require_auth = true;
        config.firewall.locked_fields = Vec::new();
    });
    harness.state.platform_floor.observe(Some(&floor()));
    let token = "rgw_traffic_tenant_key_0123456789";

    // The message text is clean; the lexicon rides in a top-level `prompt`,
    // which only the residual screen reads.
    let body = json!({
        "model": "fixture-model",
        "messages": [{ "role": "user", "content": "hello" }],
        "prompt": LEXICON
    });
    let (status, body) = send(&harness.app, chat_body(Some(token), body)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(harness.calls.load(Ordering::SeqCst), 0);

    let events = harness.state.traffic.recent();
    let blocked = events
        .iter()
        .find(|event| event["kind"] == "failure")
        .expect("the residual block appears on the feed");
    assert_eq!(blocked["verdict"]["decided_by"], "platform_floor");
    assert_eq!(blocked["verdict"]["detector_ids"], json!(["secret"]));
    for event in &events {
        let serialized = event.to_string();
        for private in [LEXICON, FLOOR_PATTERN, token] {
            assert!(
                !serialized.contains(private),
                "leaked {private}: {serialized}"
            );
        }
    }
    server.abort();
}

#[tokio::test]
async fn a_node_sanitize_rides_on_the_completion_event() {
    let harness = gateway(GatewayCustody::SelfHosted, None, |config| {
        config.auth.require_auth = false;
        config.firewall.enabled = true;
        config.firewall.scan_inbound = true;
        config.firewall.policy = FirewallPolicy::Sanitize;
        config.firewall.custom_patterns = vec![CustomPattern {
            name: "node_test_lexicon".to_owned(),
            regex: LEXICON.to_owned(),
            kind: CustomPatternKind::Secret,
        }];
    });

    let (status, body) = send(&harness.app, chat(None, &format!("echo {LEXICON}"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let forwarded = harness
        .last_body
        .lock()
        .unwrap()
        .clone()
        .expect("dispatched");
    assert!(
        !forwarded.to_string().contains(LEXICON),
        "sanitized upstream"
    );

    let events = harness.state.traffic.recent();
    let completion = events
        .iter()
        .find(|event| event["kind"] == "completion")
        .expect("completion event");
    assert_eq!(completion["verdict"]["decided_by"], "node");
    assert_eq!(completion["verdict"]["action"], "sanitize");
    assert_eq!(
        completion["verdict"]["detector_ids"],
        json!(["node_test_lexicon"])
    );
    assert_eq!(completion["custody"], "self_hosted");
    assert_eq!(completion["credential_origin"], "node_operator");
    assert!(!completion.to_string().contains(LEXICON));
}

/// Read SSE `data:` payloads until the stream is quiet for a moment.
async fn read_sse(body: Body) -> Vec<Value> {
    let mut stream = body.into_data_stream();
    let mut text = String::new();
    while let Ok(Some(Ok(chunk))) =
        tokio::time::timeout(Duration::from_millis(300), stream.next()).await
    {
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str(data).expect("event JSON"))
        .collect()
}

fn traffic_request(query: &str, token: &str) -> Request<Body> {
    Request::builder()
        .uri(format!("/v1/traffic{query}"))
        .header("authorization", format!("Bearer {token}"))
        .extension(loopback())
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn the_sse_feed_filters_by_org_and_keeps_every_row_of_a_request() {
    let master = "traffic-master-key";
    let harness = gateway(GatewayCustody::Fleet, None, |config| {
        config.auth.require_auth = true;
        config.auth.master_key = Some(master.to_owned());
    });
    let bus = &harness.state.traffic;
    for (request_id, org, outcome) in [
        (
            "req-a",
            "org_a",
            TrafficOutcome::verdict(TrafficVerdict::new(
                DecidedBy::Evaluator,
                VerdictAction::Sanitize,
            )),
        ),
        ("req-a", "org_a", TrafficOutcome::default()),
        ("req-b", "org_b", TrafficOutcome::default()),
    ] {
        let rec = AuditRecord {
            org_id: Some(org.to_owned()),
            ..record(request_id)
        };
        bus.publish(bus.enrich(traffic_event(&rec), &rec, outcome, GatewayCustody::Fleet));
    }

    let response = harness
        .app
        .clone()
        .oneshot(traffic_request("?org=org_a", master))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let events = read_sse(response.into_body()).await;
    assert_eq!(
        events.len(),
        2,
        "both rows of req-a, none of org_b: {events:?}"
    );
    assert!(events.iter().all(|event| event["org_id"] == "org_a"));
    assert_eq!(events[0]["kind"], "verdict");
    assert_eq!(events[1]["kind"], "completion");
    assert_eq!(events[1]["verdict"]["action"], "sanitize");

    let response = harness
        .app
        .clone()
        .oneshot(traffic_request("", master))
        .await
        .unwrap();
    let events = read_sse(response.into_body()).await;
    assert_eq!(events.len(), 3, "the master key sees every org");

    // A tenant key is never admitted to the fleet feed.
    let response = harness
        .app
        .clone()
        .oneshot(traffic_request("?org=org_a", "rgw_not_master"))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
}
