//! Tests of the profile activity ping: posting rules, attribution and sessions.

use crate::profile_activity::account_watch::AccountWatch;
use crate::profile_activity::activity_log::{note_turn, ActivityLog};
use crate::profile_activity::attribution::{
    current_attribution, dispatch_attribution, turn_attribution, with_attribution,
    ActivityAttribution,
};
use crate::profile_activity::usage::{GatewayUsageEvent, UsagePlanInputs, UsageSnapshot};

use super::*;

fn day(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .with_timezone(&Utc)
}

fn marker(on: &str, account: &str) -> ActivityMarker {
    ActivityMarker {
        day: day(on),
        account: account.to_owned(),
    }
}

fn inputs<'a>(
    account: Option<&'a str>,
    posted: Option<&'a ActivityMarker>,
    refused: Option<&'a ActivityMarker>,
) -> PostInputs<'a> {
    PostInputs {
        enabled: true,
        account,
        active_day: Some(day("2026-10-18")),
        last_unattributed_turn: 1,
        baseline: 0,
        authored_turn_today: false,
        today: day("2026-10-18"),
        posted,
        refused,
    }
}

#[test]
fn patrol_and_untrusted_callers_do_not_count() {
    assert!(turn_counts_toward_activity(None, false));
    assert!(turn_counts_toward_activity(Some("ryu"), false));
    assert!(turn_counts_toward_activity(Some("my-cron-agent"), false));
    assert!(!turn_counts_toward_activity(
        Some(crate::agents::patrol::AGENT_ID),
        false
    ));
    assert!(!turn_counts_toward_activity(Some(" patrol "), false));
    assert!(!turn_counts_toward_activity(None, true));
    assert!(!turn_counts_toward_activity(Some("ryu"), true));
}

#[test]
fn posts_once_per_day_per_account() {
    assert!(should_post(inputs(Some("a"), None, None)));
    let today_a = marker("2026-10-18", "a");
    assert!(!should_post(inputs(Some("a"), Some(&today_a), None)));
    // An account switch re-posts the same day.
    assert!(should_post(inputs(Some("b"), Some(&today_a), None)));
    // Yesterday's post does not cover today.
    let yesterday_a = marker("2026-10-17", "a");
    assert!(should_post(inputs(Some("a"), Some(&yesterday_a), None)));
    // A refused token is not retried the same day, but a new token is.
    assert!(!should_post(inputs(Some("a"), None, Some(&today_a))));
    assert!(should_post(inputs(Some("b"), None, Some(&today_a))));
}

#[test]
fn skips_when_disabled_signed_out_or_idle_today() {
    assert!(!should_post(PostInputs {
        enabled: false,
        ..inputs(Some("a"), None, None)
    }));
    assert!(!should_post(inputs(None, None, None)));
    assert!(!should_post(PostInputs {
        active_day: None,
        ..inputs(Some("a"), None, None)
    }));
    // Activity from yesterday must never be credited to today.
    assert!(!should_post(PostInputs {
        active_day: Some(day("2026-10-17")),
        ..inputs(Some("a"), None, None)
    }));
}

#[test]
fn account_switch_does_not_inherit_the_previous_accounts_activity() {
    let mut log = ActivityLog::default();
    let mut watch = AccountWatch::default();
    let today = day("2026-10-18");
    let observe = |watch: &mut AccountWatch, log: &ActivityLog, account: &str| PostInputs {
        last_unattributed_turn: log.last_unattributed_turn,
        baseline: watch.observe(Some(account), log.counter, at("2026-10-18T09:00:00Z")),
        ..inputs(None, None, None)
    };

    // Signed in as A at start; a turn under A posts for A.
    assert_eq!(
        watch.observe(Some("a"), log.counter, at("2026-10-18T09:00:00Z")),
        0
    );
    log.record(today, None, None);
    let a = observe(&mut watch, &log, "a");
    assert!(should_post(PostInputs {
        account: Some("a"),
        ..a
    }));

    // Switch to B with no new turn: nothing to post for B.
    let b = observe(&mut watch, &log, "b");
    assert!(!should_post(PostInputs {
        account: Some("b"),
        ..b
    }));

    // A turn after the switch credits B.
    log.record(today, None, None);
    let b = observe(&mut watch, &log, "b");
    assert!(should_post(PostInputs {
        account: Some("b"),
        ..b
    }));

    // Switching back to A re-bases A too.
    let a = observe(&mut watch, &log, "a");
    assert!(!should_post(PostInputs {
        account: Some("a"),
        ..a
    }));
}

#[test]
fn first_observation_counts_turns_since_start() {
    let mut log = ActivityLog::default();
    log.record(day("2026-10-18"), None, None);
    let mut watch = AccountWatch::default();
    assert_eq!(
        watch.observe(Some("a"), log.counter, at("2026-10-18T09:00:00Z")),
        0
    );
    // Signing in later re-bases: signed-out turns do not count.
    let mut watch = AccountWatch::default();
    watch.observe(None, 0, at("2026-10-18T09:00:00Z"));
    assert_eq!(
        watch.observe(Some("a"), log.counter, at("2026-10-18T09:00:00Z")),
        1
    );
}

#[test]
fn verified_authors_count_only_for_their_own_account() {
    let mut log = ActivityLog::default();
    let today = day("2026-10-18");
    // Another verified user on a shared node.
    log.record(today, Some("user-x"), None);
    assert_eq!(log.last_unattributed_turn, 0);
    assert!(log.authors.contains("user-x"));
    let base = PostInputs {
        last_unattributed_turn: log.last_unattributed_turn,
        ..inputs(Some("owner"), None, None)
    };
    // The signed-in owner is not user-x: no post.
    assert!(!should_post(base));
    // When the signed-in account is user-x, its own turn counts even
    // when it ran before the task observed the account.
    assert!(should_post(PostInputs {
        authored_turn_today: true,
        baseline: 5,
        ..base
    }));
    // An unattributed (loopback / scheduled) turn counts for the owner.
    log.record(today, None, None);
    assert!(should_post(PostInputs {
        last_unattributed_turn: log.last_unattributed_turn,
        ..base
    }));
}

#[test]
fn a_new_day_resets_attribution() {
    let mut log = ActivityLog::default();
    assert!(log.record(day("2026-10-17"), None, None));
    assert!(!log.record(day("2026-10-17"), None, None));
    assert!(log.record(day("2026-10-17"), Some("x"), None));
    // First turn of the next day is by another user: yesterday's
    // unattributed turn must not credit the owner today.
    assert!(log.record(day("2026-10-18"), Some("x"), None));
    assert_eq!(log.last_unattributed_turn, 0);
    assert_eq!(log.counter, 4);
}

#[test]
fn patrol_never_counts_even_with_a_matching_author() {
    // Patrol is excluded by agent id alone, so a forwarded identity cannot
    // turn a health-bot run into streak activity.
    assert!(!turn_counts_toward_activity(
        Some(crate::agents::patrol::AGENT_ID),
        false
    ));
    let mut log = ActivityLog::default();
    // note_turn returns before recording; mirror that here.
    if turn_counts_toward_activity(Some(crate::agents::patrol::AGENT_ID), false) {
        log.record(day("2026-10-18"), Some("owner"), None);
    }
    assert_eq!(log.counter, 0);
}

#[test]
fn account_key_is_stable_and_does_not_contain_the_token() {
    let key = account_key("secret-token");
    assert_eq!(key, account_key("secret-token"));
    assert_ne!(key, account_key("other-token"));
    assert_eq!(key.len(), ACCOUNT_KEY_BYTES * 2);
    assert!(!key.contains("secret"));
}

#[test]
fn endpoint_does_not_double_the_api_mount() {
    assert_eq!(
        activity_endpoint("https://api.example/"),
        "https://api.example/api/profile/me/activity"
    );
    assert_eq!(
        activity_endpoint("https://api.example/api"),
        "https://api.example/api/profile/me/activity"
    );
}

#[test]
fn marker_round_trips_through_json() {
    let original = marker("2026-10-18", "abc");
    let bytes = serde_json::to_vec(&original).unwrap();
    assert_eq!(
        serde_json::from_slice::<ActivityMarker>(&bytes).unwrap(),
        original
    );
}

fn event(
    model: &str,
    member: Option<&str>,
    input: u64,
    output: u64,
    requests: u64,
) -> GatewayUsageEvent {
    GatewayUsageEvent {
        model: model.to_owned(),
        member_id: member.map(str::to_owned),
        input_tokens: input,
        output_tokens: output,
        request_count: requests,
        error_count: 0,
    }
}

fn usage_inputs<'a>(
    sent: &'a [(String, UsageSnapshot)],
    settled: &'a [(String, NaiveDate)],
) -> UsagePlanInputs<'a> {
    UsagePlanInputs {
        local_gateway: true,
        today_qualifies: true,
        account: "a",
        today: day("2026-10-18"),
        eligible_today: true,
        eligible_yesterday: false,
        today_check_due: true,
        sent,
        settled,
    }
}

#[test]
fn sub_turns_inherit_the_parent_turns_attribution() {
    let author = ActivityAttribution::Author("user-b".to_owned());
    // A delegated sub-turn carries no author of its own.
    assert_eq!(
        turn_attribution(Some("ryu"), false, None, Some(&author)),
        author
    );
    // Its own verified author still wins.
    assert_eq!(
        turn_attribution(Some("ryu"), false, Some("user-c"), Some(&author)),
        ActivityAttribution::Author("user-c".to_owned())
    );
    // An excluded parent (Patrol, an outside caller) keeps its fan-out excluded.
    assert_eq!(
        turn_attribution(
            Some("ryu"),
            false,
            None,
            Some(&ActivityAttribution::Excluded)
        ),
        ActivityAttribution::Excluded
    );
    // A scheduled run has no parent: it counts for the signed-in account.
    assert_eq!(
        turn_attribution(Some("my-cron-agent"), false, None, None),
        ActivityAttribution::Unattributed
    );
    // Patrol and untrusted callers are excluded whatever they inherit.
    assert_eq!(
        turn_attribution(
            Some(crate::agents::patrol::AGENT_ID),
            false,
            None,
            Some(&author)
        ),
        ActivityAttribution::Excluded
    );
    assert_eq!(
        turn_attribution(None, true, Some("user-b"), None),
        ActivityAttribution::Excluded
    );
}

#[tokio::test]
async fn attribution_flows_through_the_task_and_the_host_conversation() {
    assert_eq!(current_attribution(), None);
    let author = ActivityAttribution::Author("user-b".to_owned());
    let inside = with_attribution(Some(author.clone()), async {
        // A nested sub-turn resolves against the scoped parent.
        turn_attribution(Some("ryu"), false, None, current_attribution().as_ref())
    })
    .await;
    assert_eq!(inside, author);
    // `None` leaves the task unscoped.
    assert_eq!(
        with_attribution(None, async { current_attribution() }).await,
        None
    );

    // A tool call arriving off-task resolves from its host conversation.
    note_turn(&author, Some("conv-attribution-test"), false);
    assert_eq!(
        dispatch_attribution(Some("conv-attribution-test")),
        Some(author.clone())
    );
    assert_eq!(dispatch_attribution(Some("conv-never-seen")), None);
    // The task's own scope wins over the remembered conversation.
    let scoped = with_attribution(Some(ActivityAttribution::Excluded), async {
        dispatch_attribution(Some("conv-attribution-test"))
    })
    .await;
    assert_eq!(scoped, Some(ActivityAttribution::Excluded));
}

#[test]
fn sessions_count_only_the_signed_in_accounts_conversations() {
    let mut log = ActivityLog::default();
    let today = day("2026-10-18");
    log.record(today, None, Some("c1"));
    log.record(today, None, Some("c1"));
    log.record(today, Some("owner"), Some("c2"));
    log.record(today, Some("owner"), Some("c1"));
    log.record(today, Some("user-x"), Some("c3"));
    assert_eq!(log.sessions_on(today, Some("owner")), 2);
    assert_eq!(log.sessions_on(today, Some("user-x")), 2);
    assert_eq!(log.sessions_on(today, None), 1);
    // Yesterday's sessions survive the rollover for the final snapshot.
    log.record(day("2026-10-19"), None, Some("c9"));
    assert_eq!(log.sessions_on(today, Some("owner")), 2);
    assert_eq!(log.sessions_on(day("2026-10-19"), Some("owner")), 1);
    // A gap of more than a day drops them.
    log.record(day("2026-10-21"), None, None);
    assert_eq!(log.sessions_on(day("2026-10-19"), None), 0);
}

mod account_backend;
mod device_usage;
