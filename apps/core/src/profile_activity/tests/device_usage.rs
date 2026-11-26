//! Tests of the device usage snapshot: what it counts, its plan and its body.

use super::*;
use crate::profile_activity::account_watch::{AccountWatch, UsageCarry};
use crate::profile_activity::activity_log::ActivityLog;
use crate::profile_activity::posting::{
    activity_body, gateway_config_reports_usage, valid_device_id,
};
use crate::profile_activity::usage::{
    aggregate_usage, plan_usage, snapshot_changed, usage_check_due, usage_day_eligible,
    GatewayUsageEvent, GatewayUsageRollup, UsagePlan, UsagePlanInputs, UsageState,
};

#[test]
fn usage_aggregates_own_and_unattributed_calls_only() {
    let events = [
        event("gpt-x", None, 100, 10, 2),
        event("gpt-x", Some("owner"), 50, 5, 1),
        event("claude-y", Some(" "), 7, 3, 1),
        event("gpt-x", Some("user-x"), 999, 999, 9),
        // An exec-only bucket carries no model call.
        event("exec", None, 0, 0, 0),
    ];
    let snapshot = aggregate_usage(day("2026-10-18"), &events, Some("owner"), 4);
    assert_eq!(snapshot.input_tokens, 157);
    assert_eq!(snapshot.output_tokens, 18);
    assert_eq!(snapshot.request_count, 4);
    assert_eq!(snapshot.session_count, 4);
    assert_eq!(
        snapshot.by_model,
        BTreeMap::from([("claude-y".to_owned(), 1), ("gpt-x".to_owned(), 3)])
    );
    // A legacy token sign-in has no user id: only member-less calls count.
    let legacy = aggregate_usage(day("2026-10-18"), &events, None, 0);
    assert_eq!(legacy.request_count, 3);
    assert_eq!(
        serde_json::to_value(&legacy).unwrap(),
        serde_json::json!({
            "day": "2026-10-18",
            "inputTokens": 107,
            "outputTokens": 13,
            "requestCount": 3,
            "sessionCount": 0,
            "byModel": { "claude-y": 1, "gpt-x": 2 },
        })
    );
}

#[test]
fn usage_by_model_is_capped_and_mongo_safe() {
    let mut events: Vec<GatewayUsageEvent> = (0..60)
        .map(|index| event(&format!("model-{index:02}"), None, 1, 1, index + 1))
        .collect();
    events.push(event("$where", None, 1, 1, 500));
    events.push(event(&"m".repeat(MAX_MODEL_KEY_UNITS + 1), None, 1, 1, 500));
    // 129 chars but 258 UTF-16 units: over the control plane's limit.
    events.push(event(&"\u{1F600}".repeat(129), None, 1, 1, 500));
    let snapshot = aggregate_usage(day("2026-10-18"), &events, None, 0);
    assert_eq!(snapshot.by_model.len(), MAX_BY_MODEL);
    // The busiest models are kept.
    assert_eq!(snapshot.by_model.get("model-59"), Some(&60));
    assert!(!snapshot.by_model.contains_key("model-00"));
    assert!(!snapshot.by_model.contains_key("$where"));
    // Their calls still count toward the totals.
    assert_eq!(snapshot.request_count, (1..=60).sum::<u64>() + 1500);
    // An empty snapshot omits byModel.
    let empty = aggregate_usage(day("2026-10-18"), &[], None, 0);
    assert!(empty.is_empty());
    assert!(serde_json::to_value(&empty)
        .unwrap()
        .get("byModel")
        .is_none());
}

#[test]
fn usage_needs_an_account_stable_since_the_day_began_or_core_started() {
    let today = day("2026-10-18");
    let yesterday = day("2026-10-17");
    // Core started today and the account never switched.
    let started = at("2026-10-18T08:00:00Z");
    assert!(usage_day_eligible(today, started, started));
    // Core was not running yesterday: nothing to vouch for.
    assert!(!usage_day_eligible(yesterday, started, started));
    // A switch today bars today, but not tomorrow.
    assert!(!usage_day_eligible(
        today,
        at("2026-10-18T09:00:00Z"),
        started
    ));
    assert!(usage_day_eligible(
        day("2026-10-19"),
        at("2026-10-18T09:00:00Z"),
        started
    ));
    // Core running since before yesterday with no switch covers both days.
    let long_ago = at("2026-10-16T12:00:00Z");
    assert!(usage_day_eligible(yesterday, long_ago, long_ago));
    assert!(usage_day_eligible(today, long_ago, long_ago));
    // A switch during yesterday bars yesterday's final snapshot.
    assert!(!usage_day_eligible(
        yesterday,
        at("2026-10-17T15:00:00Z"),
        long_ago
    ));

    let mut watch = AccountWatch::default();
    watch.observe(Some("a"), 0, started);
    assert!(watch.usage_eligible(today));
    watch.observe(Some("b"), 0, at("2026-10-18T10:00:00Z"));
    assert!(!watch.usage_eligible(today));
    watch.observe(Some("b"), 0, at("2026-10-18T11:00:00Z"));
    assert!(!watch.usage_eligible(today));
    assert!(watch.usage_eligible(day("2026-10-19")));
}

#[test]
fn usage_rides_only_on_a_qualifying_day_from_a_local_gateway() {
    assert_eq!(plan_usage(usage_inputs(&[], &[])), UsagePlan::Today);
    assert_eq!(
        plan_usage(UsagePlanInputs {
            local_gateway: false,
            ..usage_inputs(&[], &[])
        }),
        UsagePlan::Skip
    );
    assert_eq!(
        plan_usage(UsagePlanInputs {
            today_qualifies: false,
            ..usage_inputs(&[], &[])
        }),
        UsagePlan::Skip
    );
    assert_eq!(
        plan_usage(UsagePlanInputs {
            today_check_due: false,
            ..usage_inputs(&[], &[])
        }),
        UsagePlan::Skip
    );
    assert_eq!(
        plan_usage(UsagePlanInputs {
            eligible_today: false,
            ..usage_inputs(&[], &[])
        }),
        UsagePlan::Skip
    );
    let now = Instant::now();
    assert!(usage_check_due(None, now));
    assert!(!usage_check_due(Some(now), now + Duration::from_secs(60)));
    assert!(usage_check_due(Some(now), now + USAGE_INTERVAL));
}

#[test]
fn yesterdays_final_snapshot_goes_first_and_once() {
    let today = day("2026-10-18");
    let yesterday = day("2026-10-17");
    let partial = aggregate_usage(yesterday, &[event("m", None, 1, 1, 1)], None, 0);
    let sent = vec![("a".to_owned(), partial.clone())];
    let eligible = |sent, settled| UsagePlanInputs {
        eligible_yesterday: true,
        ..usage_inputs(sent, settled)
    };
    assert_eq!(plan_usage(eligible(&sent, &[])), UsagePlan::YesterdayFinal);
    // Without a snapshot accepted while yesterday was today, there is no
    // final one: it would make yesterday an active day on its own.
    assert_eq!(plan_usage(eligible(&[], &[])), UsagePlan::Today);
    let other_sent = vec![("b".to_owned(), partial.clone())];
    assert_eq!(plan_usage(eligible(&other_sent, &[])), UsagePlan::Today);
    let settled = vec![("a".to_owned(), yesterday)];
    assert_eq!(plan_usage(eligible(&sent, &settled)), UsagePlan::Today);
    // Settled for another account, or for an older day, does not count.
    let other = vec![("b".to_owned(), yesterday)];
    assert_eq!(
        plan_usage(eligible(&sent, &other)),
        UsagePlan::YesterdayFinal
    );
    let older = vec![("a".to_owned(), day("2026-10-16"))];
    assert_eq!(
        plan_usage(eligible(&sent, &older)),
        UsagePlan::YesterdayFinal
    );

    // Accepting yesterday's snapshot settles it.
    let mut state = UsageState::default();
    state.accepted("a", partial, today);
    assert_eq!(state.settled, settled);
}

#[test]
fn a_rejected_snapshot_is_not_resent_for_that_day() {
    let today = day("2026-10-18");
    let mut state = UsageState::default();
    state.settle("a", today, today);
    assert_eq!(
        plan_usage(usage_inputs(&state.sent, &state.settled)),
        UsagePlan::Skip
    );
    // Settling again does not duplicate, and older days are pruned.
    state.settle("a", today, today);
    state.settle("a", day("2026-10-15"), today);
    state.settle("a", day("2026-10-19"), day("2026-10-19"));
    assert_eq!(
        state.settled,
        vec![("a".to_owned(), today), ("a".to_owned(), day("2026-10-19"))]
    );
}

#[test]
fn errored_and_denied_calls_add_tokens_but_not_requests() {
    let mut failed = event("gpt-x", None, 40, 0, 3);
    failed.error_count = 2;
    let mut denied = event("blocked", None, 0, 0, 1);
    denied.error_count = 1;
    let snapshot = aggregate_usage(day("2026-10-18"), &[failed, denied], None, 0);
    assert_eq!(snapshot.input_tokens, 40);
    assert_eq!(snapshot.request_count, 1);
    assert_eq!(snapshot.by_model, BTreeMap::from([("gpt-x".to_owned(), 1)]));
    let rollup: GatewayUsageRollup = serde_json::from_value(serde_json::json!({
        "events": [{ "model": "m", "requestCount": 4, "errorCount": 1 }]
    }))
    .unwrap();
    assert_eq!(rollup.events[0].error_count, 1);
}

#[test]
fn a_restart_resumes_only_the_same_account_and_reads_from_its_sign_in() {
    let today = day("2026-10-18");
    let restart = at("2026-10-18T12:00:00Z");
    // The same account since before today: the whole day is readable.
    let mut watch = AccountWatch {
        carried: Some((Some("a".to_owned()), at("2026-10-16T09:00:00Z"))),
        ..AccountWatch::default()
    };
    watch.observe(Some("a"), 0, restart);
    assert!(watch.resumed);
    assert!(watch.usage_eligible(today));
    assert_eq!(
        watch.usage_window_start(today),
        Some(at("2026-10-18T00:00:00Z"))
    );
    // A different account was signed in before the restart: only usage
    // since the restart is read, so the earlier account's is never credited.
    let mut switched = AccountWatch {
        carried: Some((Some("a".to_owned()), at("2026-10-16T09:00:00Z"))),
        ..AccountWatch::default()
    };
    switched.observe(Some("b"), 0, restart);
    assert!(!switched.resumed);
    assert_eq!(switched.usage_window_start(today), Some(restart));
    // Signed out before the restart counts the same way.
    let mut signed_out = AccountWatch {
        carried: Some((None, at("2026-10-16T09:00:00Z"))),
        ..AccountWatch::default()
    };
    signed_out.observe(Some("a"), 0, restart);
    assert_eq!(signed_out.usage_window_start(today), Some(restart));
    // Nothing carried (first run): from the restart.
    let mut fresh = AccountWatch::default();
    fresh.observe(Some("a"), 0, restart);
    assert_eq!(fresh.usage_window_start(today), Some(restart));
}

#[test]
fn carried_sessions_survive_a_restart() {
    let today = day("2026-10-18");
    let mut before = ActivityLog::default();
    before.record(day("2026-10-17"), None, Some("old"));
    for conversation in ["c1", "c2", "c3"] {
        before.record(today, None, Some(conversation));
    }
    assert_eq!(before.sessions.len(), 2);
    let carry = UsageCarry {
        account: Some("a".to_owned()),
        since: Some(at("2026-10-16T09:00:00Z")),
        sessions: before.sessions.clone(),
    };
    let json = serde_json::to_vec(&carry).unwrap();
    let carry: UsageCarry = serde_json::from_slice(&json).unwrap();

    let mut after = ActivityLog::default();
    after.record(today, None, Some("c3"));
    after.record(today, None, Some("c4"));
    after.restore_sessions(carry.sessions, today);
    // The union, not just the conversations since the restart.
    assert_eq!(after.sessions_on(today, None), 4);
    // Days older than yesterday are dropped.
    let mut stale = ActivityLog::default();
    stale.restore_sessions(before.sessions, day("2026-10-20"));
    assert!(stale.sessions.is_empty());
}

#[test]
fn snapshots_are_resent_only_when_they_change() {
    let today = day("2026-10-18");
    let first = aggregate_usage(today, &[event("m", None, 1, 1, 1)], None, 1);
    let mut state = UsageState::default();
    assert!(snapshot_changed(&state.sent, "a", &first));
    state.accepted("a", first.clone(), today);
    assert!(!snapshot_changed(&state.sent, "a", &first));
    // Another account has not received it.
    assert!(snapshot_changed(&state.sent, "b", &first));
    let grown = aggregate_usage(today, &[event("m", None, 2, 1, 2)], None, 1);
    assert!(snapshot_changed(&state.sent, "a", &grown));
    state.accepted("a", grown.clone(), today);
    assert_eq!(state.sent.len(), 1);
    // An empty day is never sent.
    let empty = aggregate_usage(today, &[], None, 0);
    assert!(!snapshot_changed(&[], "a", &empty));
    // Snapshots older than yesterday are pruned.
    state.accepted("a", grown, day("2026-10-20"));
    assert_eq!(state.sent.len(), 1);
}

#[test]
fn body_carries_device_usage_only_with_a_device_id() {
    let usage = aggregate_usage(day("2026-10-18"), &[event("m", None, 3, 2, 1)], None, 1);
    assert_eq!(
        activity_body(None, None),
        serde_json::json!({ "source": "core" })
    );
    assert_eq!(
        activity_body(None, Some(&usage)),
        serde_json::json!({ "source": "core" })
    );
    let body = activity_body(Some("0f8b2c6e-1d2a-4b7e-9c3d-5e6f7a8b9c0d"), Some(&usage));
    assert_eq!(body["deviceId"], "0f8b2c6e-1d2a-4b7e-9c3d-5e6f7a8b9c0d");
    assert_eq!(body["usage"]["requestCount"], 1);
    assert_eq!(body["usage"]["day"], "2026-10-18");
}

#[test]
fn device_ids_match_the_control_plane_contract() {
    assert!(valid_device_id(&uuid::Uuid::new_v4().to_string()));
    assert!(!valid_device_id("short"));
    assert!(!valid_device_id(&"a".repeat(65)));
    assert!(!valid_device_id("not a valid id!"));
}

#[test]
fn a_reporting_gateway_config_never_gets_a_snapshot() {
    assert!(!gateway_config_reports_usage(None));
    assert!(!gateway_config_reports_usage(Some(
        "[server]\nport = 7981\n"
    )));
    assert!(!gateway_config_reports_usage(Some(
        "[control_plane]\nenabled = false\n"
    )));
    assert!(gateway_config_reports_usage(Some(
        "[control_plane]\nenabled = true\ngateway_key = \"gw\"\n"
    )));
    // Unparsable config is treated as reporting.
    assert!(gateway_config_reports_usage(Some("not = [valid")));
}
