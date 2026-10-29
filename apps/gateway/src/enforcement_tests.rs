//! Unit tests for the ladder wire, the posture a resolve gives a request, the
//! in-flight caps and the catalogue envelopes. Nothing here carries request
//! content; the end-to-end route coverage is in `enforcement_probe_tests`.

use std::sync::Arc;

use axum::body::to_bytes;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde_json::{json, Value};

use super::*;
use crate::screening::policy::CodeAction;
use crate::standing::{PlatformStanding, StandingRefusal, StandingState};

const APPEAL: &str = "https://ryu.example/appeal";

fn standing(ladder: Value) -> Value {
    json!({
        "state": "active",
        "refuses": "none",
        "reasonClass": null,
        "until": null,
        "appealUrl": APPEAL,
        "enforcementVersion": 3,
        "ladder": ladder,
    })
}

fn parse(value: &Value) -> PlatformStanding {
    PlatformStanding::from_wire(Some(value))
}

fn resolved(
    standing: PlatformStanding,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    active_gateways: Option<u64>,
) -> ResolvedOrg {
    ResolvedOrg {
        org_id: "org_ladder".to_owned(),
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        pool_allowances: std::collections::HashMap::new(),
        policy: crate::policy::EffectivePolicy::default(),
        credential_id: Some("cred_ladder".to_owned()),
        service_account_id: None,
        credential: None,
        identity_salt_epoch: 1,
        team_id: None,
        owner_user_id: None,
        owner_team_ids: None,
        limits: Arc::default(),
        billed_limits: Arc::default(),
        managed_tier_unavailable: false,
        limits_spend: None,
        active_gateways,
        policy_version: None,
        fetched_at: std::time::Instant::now(),
        standing,
        platform_floor: None,
        enforcement_seen: 0,
        credential_created_at: created_at,
    }
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-10-24T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc)
}

// ── wire ────────────────────────────────────────────────────────────────────

#[test]
fn an_absent_or_null_ladder_is_empty() {
    let mut value = standing(Value::Null);
    assert!(parse(&value).ladder.is_empty());
    value.as_object_mut().unwrap().remove("ladder");
    let parsed = parse(&value);
    assert!(parsed.ladder.is_empty());
    assert_eq!(parsed.state, StandingState::Active);
}

#[test]
fn ladder_entries_parse_with_their_numbers_and_labels() {
    let parsed = parse(&standing(json!([
        { "scope": "credential", "level": 2, "rpm": 6, "concurrency": 2,
          "reasonClass": "velocity", "until": "2026-10-25T00:00:00.000Z" },
        { "scope": "org", "subjectId": "org_other", "level": 3 },
        { "scope": "user", "subjectId": "usr_1", "level": 1 },
    ])));
    assert_eq!(parsed.refuses, StandingRefusal::None);
    assert_eq!(parsed.ladder.len(), 3);
    let first = &parsed.ladder[0];
    assert_eq!(first.scope, LadderScope::Credential);
    assert_eq!(
        (first.level, first.rpm, first.concurrency),
        (2, Some(6), Some(2))
    );
    assert_eq!(first.reason_class.as_deref(), Some("velocity"));
    assert_eq!(parsed.ladder[1].subject_id.as_deref(), Some("org_other"));
}

#[test]
fn a_malformed_ladder_makes_the_whole_standing_unavailable() {
    let bad = [
        json!({ "scope": "credential", "level": 2 }),
        json!([{ "scope": "tenant", "level": 2 }]),
        json!([{ "scope": "end_user", "level": 2 }]),
        json!([{ "scope": "credential", "level": 4 }]),
        json!([{ "scope": "credential", "level": "2" }]),
        json!([{ "scope": "credential" }]),
        json!([{ "scope": "credential", "level": 2, "rpm": 0 }]),
        json!([{ "scope": "credential", "level": 2, "concurrency": 0 }]),
        json!([{ "scope": "credential", "level": 2, "rpm": -1 }]),
        json!([{ "scope": "user", "level": 2 }]),
        json!([{ "scope": "org", "subjectId": " padded ", "level": 2 }]),
        json!([{ "scope": "org", "level": 2, "tpm": 10 }]),
        Value::Array(
            (0..17)
                .map(|_| json!({ "scope": "org", "level": 2 }))
                .collect(),
        ),
    ];
    for ladder in bad {
        let parsed = parse(&standing(ladder.clone()));
        assert_eq!(parsed.state, StandingState::StandingUnavailable, "{ladder}");
        assert_eq!(parsed.refuses, StandingRefusal::All, "{ladder}");
        assert!(
            matches!(
                parsed.refusal(GatewayCustody::SelfHosted),
                Some(GatewayError::StandingUnavailable)
            ),
            "{ladder}"
        );
    }
}

#[test]
fn an_end_user_level_never_fails_or_narrows_the_whole_key() {
    let parsed = parse(&standing(json!([
        { "scope": "end_user", "subjectId": "eu1.1.0123456789abcdef0123456789abcdef", "level": 3 },
        { "scope": "forwarded_user", "subjectId": "fu_hash", "level": 2 },
    ])));
    assert_eq!(parsed.state, StandingState::Active);
    assert_eq!(parsed.ladder.len(), 2);
    assert!(Posture::of(&resolved(parsed, None, None), None, now()).is_empty());
}

#[test]
fn a_restricted_state_is_org_level_three() {
    let parsed = parse(&json!({
        "state": "restricted",
        "refuses": "none",
        "reasonClass": "fraud",
        "until": "2026-10-31T00:00:00.000Z",
        "appealUrl": APPEAL,
        "enforcementVersion": 1
    }));
    assert_eq!(parsed.refuses, StandingRefusal::None);
    assert_eq!(
        parsed.ladder,
        vec![LadderEntry::org_restricted(
            Some("fraud".to_owned()),
            Some("2026-10-31T00:00:00.000Z".to_owned())
        )]
    );
}

// ── posture ─────────────────────────────────────────────────────────────────

#[test]
fn levels_zero_and_one_change_nothing() {
    let parsed = parse(&standing(json!([
        { "scope": "credential", "level": 0 },
        { "scope": "org", "level": 1 },
    ])));
    assert!(Posture::of(&resolved(parsed, None, None), None, now()).is_empty());
}

#[test]
fn a_throttle_without_numbers_takes_the_defaults_and_names_its_subject() {
    let parsed = parse(&standing(json!([
        { "scope": "credential", "level": 2 },
        { "scope": "org", "level": 2, "rpm": 40, "concurrency": 9 },
    ])));
    let posture = Posture::of(&resolved(parsed, None, None), None, now());
    assert_eq!(
        posture.throttles,
        vec![
            Throttle {
                key: "abuse:credential:cred_ladder".to_owned(),
                rpm: DEFAULT_THROTTLE_RPM,
                concurrency: DEFAULT_THROTTLE_CONCURRENCY,
            },
            Throttle {
                key: "abuse:org:org_ladder".to_owned(),
                rpm: 40,
                concurrency: 9,
            },
        ]
    );
    assert!(posture.restricted.is_none());
    assert_eq!(
        posture.throttled.as_ref().unwrap().appeal_url.as_deref(),
        Some(APPEAL)
    );
}

#[test]
fn restrict_is_cumulative_with_throttle() {
    let parsed = parse(&standing(json!([
        { "scope": "credential", "level": 3, "reasonClass": "key_abuse" },
    ])));
    let posture = Posture::of(&resolved(parsed, None, None), None, now());
    assert_eq!(posture.throttles.len(), 1);
    let restricted = posture.restricted.expect("level 3 restricts");
    assert_eq!(restricted.reason_class.as_deref(), Some("key_abuse"));
    assert_eq!(restricted.appeal_url.as_deref(), Some(APPEAL));
}

fn posture_for(ladder: Value, user: Option<&str>) -> Posture {
    Posture::of(&resolved(parse(&standing(ladder)), None, None), user, now())
}

fn restricted_with(ladder: Value) -> PlatformStanding {
    parse(&json!({
        "state": "restricted",
        "refuses": "none",
        "reasonClass": "fraud",
        "until": null,
        "appealUrl": APPEAL,
        "enforcementVersion": 1,
        "ladder": ladder,
    }))
}

#[test]
fn a_restricted_state_survives_an_org_throttle_entry() {
    // The state's org L3 is appended after the wire ladder; an earlier org
    // L2 for the same bucket must not cancel it, with or without an id.
    for ladder in [
        json!([{ "scope": "org", "level": 2, "rpm": 40, "concurrency": 9 }]),
        json!([{ "scope": "org", "subjectId": "org_ladder", "level": 2, "rpm": 40 }]),
    ] {
        let posture = Posture::of(
            &resolved(restricted_with(ladder.clone()), None, None),
            None,
            now(),
        );
        let restricted = posture.restricted.as_ref().expect("still restricted");
        assert_eq!(
            restricted.reason_class.as_deref(),
            Some("fraud"),
            "{ladder}"
        );
        assert_eq!(
            posture.throttles,
            vec![Throttle {
                key: "abuse:org:org_ladder".to_owned(),
                // The state's L3 carries no numbers, so it counts as the
                // default, which is lower than the throttle's.
                rpm: DEFAULT_THROTTLE_RPM,
                concurrency: DEFAULT_THROTTLE_CONCURRENCY,
            }],
            "{ladder}"
        );
        assert_eq!(
            posture.throttled.unwrap().reason_class.as_deref(),
            Some("fraud")
        );
    }
}

#[test]
fn a_level_three_entry_restricts_in_either_order() {
    let cases = [
        json!([{ "scope": "org", "level": 3 }, { "scope": "org", "level": 2 }]),
        json!([{ "scope": "org", "level": 2 }, { "scope": "org", "level": 3 }]),
        json!([{ "scope": "credential", "level": 2 }, { "scope": "credential", "level": 3 }]),
        json!([{ "scope": "credential", "level": 3 }, { "scope": "credential", "level": 2 }]),
        json!([
            { "scope": "credential", "level": 2 },
            { "scope": "credential", "subjectId": "cred_ladder", "level": 3 },
        ]),
        json!([
            { "scope": "credential", "subjectId": "cred_ladder", "level": 3 },
            { "scope": "credential", "level": 2 },
        ]),
    ];
    for ladder in cases {
        let posture = posture_for(ladder.clone(), None);
        assert!(posture.restricted.is_some(), "{ladder}");
        assert_eq!(posture.throttles.len(), 1, "{ladder}");
    }
}

#[test]
fn entries_for_one_bucket_keep_the_lowest_numbers() {
    let loose = json!({ "scope": "credential", "level": 2, "rpm": 50, "concurrency": 2 });
    let tight = json!({ "scope": "credential", "subjectId": "cred_ladder", "level": 2,
                        "rpm": 6, "concurrency": 7 });
    for ladder in [
        json!([loose.clone(), tight.clone()]),
        json!([tight.clone(), loose.clone()]),
    ] {
        let posture = posture_for(ladder.clone(), None);
        assert_eq!(
            posture.throttles,
            vec![Throttle {
                key: "abuse:credential:cred_ladder".to_owned(),
                rpm: 6,
                concurrency: 2,
            }],
            "{ladder}"
        );
        assert!(posture.restricted.is_none(), "{ladder}");
    }
}

#[test]
fn the_longest_restriction_is_the_one_reported() {
    let posture = posture_for(
        json!([
            { "scope": "credential", "level": 3, "reasonClass": "short",
              "until": "2026-10-25T00:00:00.000Z" },
            { "scope": "org", "level": 3, "reasonClass": "long",
              "until": "2026-11-25T00:00:00.000Z" },
            { "scope": "credential", "level": 3, "reasonClass": "middle",
              "until": "2026-11-01T00:00:00.000Z" },
        ]),
        None,
    );
    assert_eq!(
        posture.restricted.unwrap().reason_class.as_deref(),
        Some("long")
    );
}

#[test]
fn a_user_entry_binds_only_to_that_verified_user() {
    let ladder = json!([{ "scope": "user", "subjectId": "usr_flagged", "level": 3 }]);
    // Another verified member on the same key, and a request with no
    // verified user, are not that user's traffic.
    assert!(posture_for(ladder.clone(), Some("usr_other")).is_empty());
    assert!(posture_for(ladder.clone(), None).is_empty());
    let posture = posture_for(ladder, Some("usr_flagged"));
    assert!(posture.restricted.is_some());
    assert_eq!(posture.throttles[0].key, "abuse:user:usr_flagged");
}

#[test]
fn a_credential_or_org_entry_naming_another_subject_does_not_bind() {
    for ladder in [
        json!([{ "scope": "credential", "subjectId": "cred_other", "level": 3 }]),
        json!([{ "scope": "org", "subjectId": "org_other", "level": 3 }]),
    ] {
        assert!(posture_for(ladder.clone(), None).is_empty(), "{ladder}");
    }
    // A key-less resolve has no id to match a named credential entry.
    let mut keyless = resolved(
        parse(&standing(json!([
            { "scope": "credential", "subjectId": "cred_ladder", "level": 3 },
        ]))),
        None,
        None,
    );
    keyless.credential_id = None;
    assert!(Posture::of(&keyless, None, now()).is_empty());
}

#[test]
fn a_mismatched_user_takes_no_in_flight_slot() {
    let in_flight = Arc::new(InFlight::default());
    let org = resolved(
        parse(&standing(json!([
            { "scope": "user", "subjectId": "usr_flagged", "level": 2, "concurrency": 1 },
        ]))),
        None,
        None,
    );
    for _ in 0..3 {
        let admitted = Enforcement::admit_at(
            GatewayCustody::Fleet,
            &in_flight,
            &org,
            Some("usr_other"),
            now(),
        )
        .expect("another member is admitted");
        assert!(admitted.is_none());
    }
    assert_eq!(in_flight.count("abuse:user:usr_flagged"), 0);
    let held = Enforcement::admit_at(
        GatewayCustody::Fleet,
        &in_flight,
        &org,
        Some("usr_flagged"),
        now(),
    )
    .unwrap();
    assert!(Enforcement::admit_at(
        GatewayCustody::Fleet,
        &in_flight,
        &org,
        Some("usr_flagged"),
        now(),
    )
    .is_err());
    drop(held);
}

#[test]
fn only_a_key_under_a_day_old_is_a_new_key() {
    let empty = PlatformStanding::active();
    let young = now() - chrono::Duration::hours(23);
    let old = now() - chrono::Duration::hours(25);
    assert_eq!(
        Posture::of(&resolved(empty.clone(), Some(young), None), None, now()).new_key,
        Some("newkey:cred_ladder".to_owned())
    );
    assert!(Posture::of(&resolved(empty.clone(), Some(old), None), None, now()).is_empty());
    // No `createdAt` on the resolve: the limit stays off.
    assert!(Posture::of(&resolved(empty, None, None), None, now()).is_empty());
}

#[test]
fn created_at_is_read_from_the_resolve_credential() {
    let at = crate::policy::parse_resolve_for_test(json!({
        "organization": { "id": "org_ladder" },
        "credential": {
            "id": "cred_ladder",
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"],
            "createdAt": "2026-10-24T08:30:00.000Z"
        },
        "standing": { "state": "active", "refuses": "none" }
    }))
    .credential_created_at;
    assert_eq!(
        at.map(|at| at.to_rfc3339()),
        Some("2026-10-24T08:30:00+00:00".to_owned())
    );
    let unparseable = crate::policy::parse_resolve_for_test(json!({
        "organization": { "id": "org_ladder" },
        "credential": {
            "id": "cred_ladder",
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"],
            "createdAt": "yesterday"
        },
        "standing": { "state": "active", "refuses": "none" }
    }));
    assert!(unparseable.credential_created_at.is_none());
}

// The admission caps and the catalogue envelopes (with the public error rows)
// live in a sibling file so each stays under the repository's file size limit.
#[path = "enforcement_admission_tests.rs"]
mod admission;
