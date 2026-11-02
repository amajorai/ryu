//! The failover note as Core messages: each verdict kind carries its sentences
//! as `{ message, args }` and renders them for the locale it is given.

use serde_json::{json, Value};

use super::*;
use crate::i18n::{messages, Message};

fn window(label: &str, used: f64, resets_at: Option<&str>) -> WindowReading {
    WindowReading {
        label: label.to_string(),
        model: None,
        used_percent: used,
        resets_at: resets_at.map(str::to_string),
        window_seconds: None,
    }
}

fn agent(id: &str, plan: Option<&str>, windows: Vec<WindowReading>) -> AgentWindows {
    AgentWindows {
        agent_id: id.to_string(),
        plan: plan.map(str::to_string),
        readable: true,
        windows,
    }
}

fn armed(notify_only: bool) -> RetryPolicy {
    RetryPolicy {
        enabled: true,
        notify_only,
        ..RetryPolicy::default()
    }
}

fn source(template: crate::i18n::Template) -> String {
    Message::new(template).source().to_string()
}

fn with_room() -> Vec<AgentWindows> {
    vec![
        agent(
            "acp:claude",
            Some("Max"),
            vec![window("Session", 100.0, None)],
        ),
        agent("acp:codex", None, vec![window("Session", 20.0, None)]),
    ]
}

fn wire(verdict: &Verdict) -> Vec<Value> {
    serde_json::to_value(verdict).unwrap()["messages"]
        .as_array()
        .cloned()
        .expect("a surfaced verdict carries its messages")
}

#[test]
fn a_reroute_names_both_plans_in_english() {
    let verdict = decide_in(
        &armed(false),
        "acp:claude",
        None,
        FailureKind::Other,
        &with_room(),
        "en",
    );
    assert_eq!(
        verdict.note(),
        Some(
            "Claude has reached its session limit on your Max plan. \
             Retrying on Codex, which has 80% left."
        )
    );
    let wire = wire(&verdict);
    assert_eq!(
        wire[0],
        json!({
            "message": source(messages::FAILOVER_OUT_OF_WINDOW_PLAN_MESSAGE),
            "args": { "agent": "Claude", "window": "session", "plan": "Max" },
        })
    );
    assert_eq!(
        wire[1]["message"],
        source(messages::FAILOVER_RETRYING_MESSAGE)
    );
    assert_eq!(wire[1]["args"]["agent"], "Codex");
    assert_eq!(wire[1]["args"]["headroom"]["number"], 80.0);
}

#[test]
fn a_held_verdict_carries_the_notify_only_sentence() {
    let verdict = decide_in(
        &armed(true),
        "acp:claude",
        None,
        FailureKind::Other,
        &with_room(),
        "ja",
    );
    assert!(matches!(verdict, Verdict::Held { .. }));
    let wire = wire(&verdict);
    assert_eq!(wire.len(), 2);
    assert_eq!(wire[1]["message"], source(messages::FAILOVER_HELD_MESSAGE));
    let note = verdict.note().unwrap();
    assert!(note.contains("Codex"), "{note}");
    assert!(note.contains("80"), "{note}");
}

#[test]
fn a_wait_writes_the_reset_day_in_the_locale() {
    let at = "2026-08-01T12:00:00Z";
    let readings = vec![agent(
        "acp:claude",
        Some("Max"),
        vec![window("Session", 100.0, Some(at))],
    )];
    let verdict = decide_in(
        &armed(false),
        "acp:claude",
        None,
        FailureKind::Other,
        &readings,
        "ja",
    );
    let Verdict::Wait { resets_at, .. } = &verdict else {
        panic!("expected a wait, got {verdict:?}");
    };
    assert_eq!(resets_at, at);
    let local = chrono::DateTime::parse_from_rfc3339(at)
        .unwrap()
        .with_timezone(&chrono::Local);
    let wire = wire(&verdict);
    assert_eq!(wire.len(), 1);
    assert_eq!(wire[0]["message"], source(messages::FAILOVER_WAIT_MESSAGE));
    assert_eq!(wire[0]["args"]["window"], "session");
    assert_eq!(
        wire[0]["args"]["date"]["date"],
        local.date_naive().format("%Y-%m-%d").to_string()
    );
    assert_eq!(wire[0]["args"]["time"], local.format("%H:%M").to_string());
    // Japanese writes the day as "8月1日土曜日", never an English "Sat 1 Aug".
    let note = verdict.note().unwrap();
    assert!(note.contains("曜日"), "{note}");
    assert!(!note.contains("Aug"), "{note}");
}

#[test]
fn no_candidate_names_the_spent_plan_and_that_nothing_had_room() {
    let readings = vec![agent(
        "acp:claude",
        None,
        vec![window("Session", 100.0, None)],
    )];
    let verdict = decide_in(
        &armed(false),
        "acp:claude",
        None,
        FailureKind::Other,
        &readings,
        "ja",
    );
    assert!(matches!(verdict, Verdict::NoCandidate { .. }));
    let wire = wire(&verdict);
    assert_eq!(
        wire[0]["message"],
        source(messages::FAILOVER_OUT_OF_WINDOW_MESSAGE)
    );
    assert_eq!(
        wire[1],
        json!({ "message": source(messages::FAILOVER_NO_CANDIDATE_MESSAGE), "args": {} })
    );
}

#[test]
fn a_cap_the_gateway_reported_without_windows_says_usage_limit() {
    let verdict = decide_in(
        &armed(false),
        "gateway",
        None,
        FailureKind::RateLimited,
        &[],
        "en",
    );
    assert_eq!(
        verdict.note(),
        Some("Gateway has reached its usage limit. No other plan with room was found.")
    );
}

#[test]
fn a_wait_writes_the_reset_day_in_arabic() {
    let at = "2026-08-01T12:00:00Z";
    let readings = vec![agent(
        "acp:claude",
        None,
        vec![window("Session", 100.0, Some(at))],
    )];
    let verdict = decide_in(
        &armed(false),
        "acp:claude",
        None,
        FailureKind::Other,
        &readings,
        "ar",
    );
    let note = verdict.note().unwrap();
    // The day is the Arabic weekday and month ("السبت، 1 أغسطس"); the local
    // zone may move it to July 31 or August 2, never to an English name.
    assert!(note.contains("أغسطس") || note.contains("يوليو"), "{note}");
    assert!(note.contains('،'), "{note}");
    assert!(!note.contains("Aug") && !note.contains("Sat"), "{note}");
}

#[test]
fn a_german_note_keeps_its_two_sentences_apart() {
    // Translated or still falling back to English, the two sentences stay
    // separated by a space and keep the plan name and the headroom.
    let verdict = decide_in(
        &armed(false),
        "acp:claude",
        None,
        FailureKind::Other,
        &with_room(),
        "de",
    );
    let note = verdict.note().unwrap();
    assert!(note.contains("Max"), "{note}");
    assert!(note.contains(". "), "{note}");
    assert!(note.contains("80"), "{note}");
}
