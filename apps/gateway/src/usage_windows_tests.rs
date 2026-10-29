//! Usage window folding (spec 04.4). Rows go through the real audit
//! chokepoint, so the verdicts are the ones the traffic feed resolved.
//! Content is the spec 00.9 sentinels only.

use chrono::{Duration, TimeZone, Utc};
use serde_json::json;

use super::*;
use crate::audit::{AuditConfig, AuditLogger};
use crate::config::GatewayConfig;
use crate::error::{ContentBlock, ContentBlockLayer, GatewayError};
use crate::evals::EvalsRunner;
use crate::state::AppState;
use crate::traffic::{DecidedBy, TrafficOutcome, TrafficVerdict, VerdictAction};

const CREDENTIAL: &str = "6650a1b2c3d4e5f6a7b8c9d0";

fn state_with(custody: GatewayCustody) -> AppState {
    let mut config = GatewayConfig::default();
    config.control_plane.enabled = true;
    config.control_plane.gateway_key = Some("rgw_test_window_reporter".to_owned());
    state_with_config(custody, config)
}

fn state_with_config(custody: GatewayCustody, config: GatewayConfig) -> AppState {
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = custody;
    state
}

pub(crate) fn record(request_id: &str, key_id: Option<&str>) -> AuditRecord {
    AuditRecord {
        key_id: key_id.map(str::to_owned),
        request_id: request_id.to_owned(),
        api_key: "rgw_test_window_key".to_owned(),
        user_name: None,
        org_id: Some("6650a1b2c3d4e5f6a7b8c9d1".to_owned()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "anthropic".to_owned(),
        model: "claude-test".to_owned(),
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 420,
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

/// A guardrail verdict row: a marker provider and no tokens.
fn verdict_row(request_id: &str) -> AuditRecord {
    AuditRecord {
        provider: "firewall".to_owned(),
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error: Some("RYU_TEST_DLP_MARKER".to_owned()),
        ..record(request_id, Some(CREDENTIAL))
    }
}

fn floor_block() -> GatewayError {
    GatewayError::ContentBlocked(Box::new(ContentBlock {
        layer: ContentBlockLayer::Platform,
        output: false,
        categories: vec!["S9"],
        screening_id: "scr_window_test".to_owned(),
        charged_micro_usd: None,
    }))
}

fn closed(state: &AppState) -> Vec<UsageWindow> {
    state
        .usage_windows
        .drain_closed(Utc::now() + Duration::minutes(2))
}

fn outcome<'a>(
    window: &'a UsageWindow,
    decided_by: &str,
    action: &str,
) -> Option<&'a OutcomeCount> {
    window
        .outcomes
        .iter()
        .find(|o| o.decided_by == decided_by && o.action == action)
}

#[test]
fn a_self_hosted_gateway_folds_nothing() {
    let state = state_with(GatewayCustody::SelfHosted);
    state.log_audit(record("req-self", Some(CREDENTIAL)));
    assert_eq!(state.usage_windows.open_count(), 0);
    assert!(closed(&state).is_empty());
}

#[test]
fn a_fleet_gateway_without_a_reporting_control_plane_folds_nothing() {
    // Nothing would drain the windows, so none are held.
    let disabled = state_with_config(GatewayCustody::Fleet, GatewayConfig::default());
    disabled.log_audit(record("req-disabled", Some(CREDENTIAL)));
    assert_eq!(disabled.usage_windows.open_count(), 0);

    let mut keyless = GatewayConfig::default();
    keyless.control_plane.enabled = true;
    let keyless = state_with_config(GatewayCustody::Fleet, keyless);
    keyless.log_audit(record("req-keyless", Some(CREDENTIAL)));
    assert_eq!(keyless.usage_windows.open_count(), 0);
}

#[test]
fn a_row_without_a_hosted_credential_is_skipped() {
    let state = state_with(GatewayCustody::Fleet);
    state.log_audit(record("req-master", None));
    state.log_audit(record("req-blank", Some("  ")));
    assert_eq!(state.usage_windows.open_count(), 0);
}

#[test]
fn non_model_rows_are_skipped() {
    let state = state_with(GatewayCustody::Fleet);
    let mut exec = record("req-exec", Some(CREDENTIAL));
    exec.event_type = EventType::ExecCall;
    state.log_audit(exec);
    assert_eq!(state.usage_windows.open_count(), 0);
}

#[test]
fn a_managed_node_folds_its_rows() {
    let state = state_with(GatewayCustody::ManagedNode);
    state.log_audit(record("req-node", Some(CREDENTIAL)));
    let windows = closed(&state);
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].requests, 1);
}

#[test]
fn outcomes_count_each_request_once_by_layer_action_and_category() {
    let state = state_with(GatewayCustody::Fleet);
    // Two allowed completions.
    state.log_audit(record("req-ok-1", Some(CREDENTIAL)));
    state.log_audit(record("req-ok-2", Some(CREDENTIAL)));
    // A floor block: the failure row carries the S9 code.
    let mut failed = record("req-floor", Some(CREDENTIAL));
    failed.error = Some("RYU_TEST_HAZARD_S9".to_owned());
    // A refused request names no upstream (`audit_failure` writes `none`).
    failed.provider = "none".to_owned();
    failed.input_tokens = 0;
    failed.output_tokens = 0;
    state.log_audit_with(failed, TrafficOutcome::failure(&floor_block()));
    // A node sanitize noted before its completion: one request, sanitized.
    state.traffic.note_verdict(
        "req-sanitized",
        TrafficVerdict::new(DecidedBy::Node, VerdictAction::Sanitize).with_detector("email"),
    );
    state.log_audit(record("req-sanitized", Some(CREDENTIAL)));
    // An org warn written as its own verdict row, then the completion.
    state.log_audit_with(
        verdict_row("req-warned"),
        TrafficOutcome::verdict(TrafficVerdict::new(DecidedBy::Org, VerdictAction::Warn)),
    );
    state.log_audit(record("req-warned", Some(CREDENTIAL)));
    // An auxiliary inspector row under an allowed request's id.
    let mut auxiliary = record("req-ok-1", Some(CREDENTIAL));
    auxiliary.provider = "inspector".to_owned();
    auxiliary.input_tokens = 7;
    auxiliary.output_tokens = 0;
    state.log_audit(auxiliary);

    let windows = closed(&state);
    assert_eq!(windows.len(), 1);
    let window = &windows[0];
    assert_eq!(window.credential_id, CREDENTIAL);
    assert_eq!(
        window.requests, 5,
        "auxiliary and verdict rows fold into their request"
    );
    assert_eq!(window.blocked, 1);
    assert_eq!(window.floor_blocks, 1);
    assert_eq!(window.input_tokens, 10 * 4 + 7, "every row's tokens count");
    assert_eq!(outcome(window, "none", "allow").unwrap().requests, 2);
    let floor = outcome(window, "platform_floor", "block").unwrap();
    assert_eq!(floor.requests, 1);
    assert_eq!(floor.categories.get("S9"), Some(&1));
    assert_eq!(outcome(window, "node", "sanitize").unwrap().requests, 1);
    assert_eq!(outcome(window, "org", "warn").unwrap().requests, 1);
    let total: u32 = window.outcomes.iter().map(|o| o.requests).sum();
    assert_eq!(total, window.requests);
    // Providers and models count requests with an upstream row only.
    assert_eq!(window.providers.get("anthropic"), Some(&4));
    assert_eq!(window.models.get("claude-test"), Some(&4));
    assert!(!window.providers.contains_key("inspector"));
}

#[test]
fn over_cap_and_deadline_degraded_come_from_the_verdict() {
    let state = state_with(GatewayCustody::Fleet);
    let mut refused = record("req-cap", Some(CREDENTIAL));
    refused.error = Some("RYU_TEST_OVER_CAP".to_owned());
    state.log_audit_with(
        refused,
        TrafficOutcome::failure(&GatewayError::ScreeningCapacityExceeded),
    );
    let mut degraded = TrafficVerdict::new(DecidedBy::PlatformFloor, VerdictAction::Warn);
    degraded.degraded = Some("deadline");
    state.traffic.note_verdict("req-deadline", degraded);
    state.log_audit(record("req-deadline", Some(CREDENTIAL)));
    let window = closed(&state).remove(0);
    assert_eq!(window.over_cap, 1);
    assert_eq!(window.deadline_degraded, 1);
    assert_eq!(window.blocked, 1);
    assert_eq!(
        window.floor_blocks, 0,
        "a capacity refusal counts in overCap only, never as floor probing"
    );
}

#[test]
fn an_allowed_deadline_bound_request_counts_as_deadline_degraded() {
    let state = state_with(GatewayCustody::Fleet);
    // The note `screening::admit` writes when the screen hit its deadline
    // and let the request through.
    let mut allowed = TrafficVerdict::new(DecidedBy::PlatformFloor, VerdictAction::Allow);
    allowed.degraded = Some("deadline");
    state.traffic.note_verdict("req-deadline-allow", allowed);
    state.log_audit(record("req-deadline-allow", Some(CREDENTIAL)));
    let window = closed(&state).remove(0);
    assert_eq!(window.requests, 1);
    assert_eq!(window.deadline_degraded, 1);
    assert_eq!(window.blocked, 0);
    assert_eq!(window.floor_blocks, 0);
    assert_eq!(outcome(&window, "none", "allow").unwrap().requests, 1);
}

#[test]
fn screening_health_and_platform_lock_refusals_are_never_floor_blocks() {
    let state = state_with(GatewayCustody::Fleet);
    let refusals = [
        GatewayError::ScreeningUnavailable {
            reason: "test_outage",
            retry_after_secs: 5,
        },
        GatewayError::ScreeningDegradedThrottle {
            retry_after_secs: 5,
        },
        GatewayError::PlatformRefused {
            code: "feature_not_permitted",
            message: "RYU_TEST_PLATFORM_LOCK",
        },
        GatewayError::PlatformRefused {
            code: "media_unscreenable",
            message: "RYU_TEST_MEDIA_UNSCREENABLE",
        },
    ];
    for (index, error) in refusals.iter().enumerate() {
        let mut refused = record(&format!("req-health-{index}"), Some(CREDENTIAL));
        refused.error = Some("RYU_TEST_SCREENING_HEALTH".to_owned());
        refused.provider = "none".to_owned();
        state.log_audit_with(refused, TrafficOutcome::failure(error));
    }
    // A real content decision of the floor still counts.
    let mut blocked = record("req-floor", Some(CREDENTIAL));
    blocked.error = Some("RYU_TEST_HAZARD_S9".to_owned());
    blocked.provider = "none".to_owned();
    state.log_audit_with(blocked, TrafficOutcome::failure(&floor_block()));
    let window = closed(&state).remove(0);
    assert_eq!(window.requests, 5);
    assert_eq!(window.blocked, 5);
    assert_eq!(window.over_cap, 0);
    assert_eq!(
        window.floor_blocks, 1,
        "only the content block probes the floor"
    );
    assert_eq!(
        outcome(&window, "platform_floor", "block")
            .unwrap()
            .requests,
        5,
        "outcomes still report every floor refusal"
    );
}

#[test]
fn a_floor_firewall_block_counts_as_a_floor_block() {
    let state = state_with(GatewayCustody::Fleet);
    // The firewall notes the floor's match, then the request fails with the
    // firewall's own error: the feed adopts the floor verdict and keeps the
    // error's `policy_violation` code.
    state.traffic.note_verdict(
        "req-floor-firewall",
        TrafficVerdict::new(DecidedBy::PlatformFloor, VerdictAction::Block).with_detector("secret"),
    );
    let mut blocked = record("req-floor-firewall", Some(CREDENTIAL));
    blocked.error = Some("RYU_TEST_DLP_MARKER".to_owned());
    blocked.provider = "none".to_owned();
    state.log_audit_with(
        blocked,
        TrafficOutcome::failure(&GatewayError::FirewallBlocked(
            "RYU_TEST_DLP_MARKER".to_owned(),
            None,
        )),
    );
    let window = closed(&state).remove(0);
    assert_eq!(window.blocked, 1);
    assert_eq!(window.floor_blocks, 1);
    assert_eq!(
        outcome(&window, "platform_floor", "block")
            .unwrap()
            .requests,
        1
    );
}

#[test]
fn latency_buckets_count_the_longest_terminal_row() {
    let state = state_with(GatewayCustody::Fleet);
    let mut fast = record("req-fast", Some(CREDENTIAL));
    fast.latency_ms = 80;
    let mut slow = record("req-slow", Some(CREDENTIAL));
    slow.latency_ms = 70_000;
    let mut retry = record("req-fast", Some(CREDENTIAL));
    retry.latency_ms = 300;
    state.log_audit(fast);
    state.log_audit(slow);
    state.log_audit(retry);
    let window = closed(&state).remove(0);
    assert_eq!(
        window.latency_ms_buckets,
        vec![
            LatencyBucket {
                le_ms: Some(500),
                requests: 1
            },
            LatencyBucket {
                le_ms: None,
                requests: 1
            },
        ]
    );
}

#[test]
fn the_open_minute_stays_open_and_a_late_row_never_reopens_a_drained_minute() {
    let windows = UsageWindows::new();
    let at = Utc.with_ymd_and_hms(2026, 10, 23, 10, 0, 30).unwrap();
    let event =
        json!({ "kind": "completion", "verdict": { "decided_by": "none", "action": "allow" } });
    let row = record("req-a", Some(CREDENTIAL));
    windows.observe_at(at, GatewayCustody::Fleet, &row, &event, Some(100));
    assert!(
        windows.drain_closed(at).is_empty(),
        "the current minute is open"
    );
    let drained = windows.drain_closed(at + Duration::seconds(31));
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].minute, "2026-10-23T10:00:00Z");
    assert_eq!(drained[0].cost_micro_usd, 100);
    // A row stamped before the drain but folded after it lands in the next
    // minute, so the drained window is never sent again with other counts.
    windows.observe_at(
        at,
        GatewayCustody::Fleet,
        &record("req-b", Some(CREDENTIAL)),
        &event,
        None,
    );
    let later = windows.drain_closed(at + Duration::minutes(2));
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].minute, "2026-10-23T10:01:00Z");
}

#[test]
fn maps_are_held_to_their_caps() {
    let windows = UsageWindows::new();
    let at = Utc.with_ymd_and_hms(2026, 10, 23, 10, 0, 0).unwrap();
    let event =
        json!({ "kind": "completion", "verdict": { "decided_by": "none", "action": "allow" } });
    for index in 0..(MAX_MODELS + 10) {
        let mut row = record(&format!("req-{index}"), Some(CREDENTIAL));
        row.model = format!("model-{index}");
        row.provider = format!("provider-{index}");
        windows.observe_at(at, GatewayCustody::Fleet, &row, &event, None);
    }
    let window = windows.drain_closed(at + Duration::minutes(1)).remove(0);
    assert_eq!(window.models.len(), MAX_MODELS);
    assert_eq!(window.providers.len(), MAX_PROVIDERS);
    assert_eq!(window.models.get(OTHER_KEY), Some(&11));
    assert_eq!(window.models.values().sum::<u32>(), window.requests);
}

#[test]
fn the_wire_carries_every_required_key_in_camel_case() {
    let windows = UsageWindows::new();
    let at = Utc.with_ymd_and_hms(2026, 10, 23, 10, 0, 0).unwrap();
    let event =
        json!({ "kind": "completion", "verdict": { "decided_by": "none", "action": "allow" } });
    windows.observe_at(
        at,
        GatewayCustody::Fleet,
        &record("req-wire-1", Some(CREDENTIAL)),
        &event,
        None,
    );
    let window = windows.drain_closed(at + Duration::minutes(1)).remove(0);
    let wire = serde_json::to_value(&window).unwrap();
    for key in [
        "credentialId",
        "minute",
        "requests",
        "blocked",
        "floorBlocks",
        "overCap",
        "deadlineDegraded",
        "inputTokens",
        "outputTokens",
        "costMicroUsd",
        "models",
        "clientIpHashes",
        "userAgentFamilies",
        "endUsersSeen",
        "missingEndUser",
        "systemPromptHashes",
        "extractionHits",
        "rubricHits",
        "maxTokensP95",
        "simhashes",
        "outcomes",
        "providers",
        "latencyMsBuckets",
    ] {
        assert!(wire.get(key).is_some(), "missing {key}");
    }
    assert_eq!(wire["minute"], "2026-10-23T10:00:00Z");
    // Serde defaults: a window without the additive fields still parses.
    let mut legacy = wire.clone();
    for key in ["outcomes", "providers", "latencyMsBuckets"] {
        legacy.as_object_mut().unwrap().remove(key);
    }
    let parsed: UsageWindow = serde_json::from_value(legacy).unwrap();
    assert!(parsed.outcomes.is_empty());
    // Nothing but counts, names and the credential id leaves the Gateway.
    let text = wire.to_string();
    assert!(!text.contains("rgw_test_window_key"));
    assert!(!text.contains("req-wire-1"), "no request ids");
}
