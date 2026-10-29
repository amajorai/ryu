//! Unit tests for the in-flight admission caps and the catalogue envelopes,
//! including the public error rows they must match. Helpers come from
//! `enforcement_tests.rs`.

use super::*;

// ── admission ───────────────────────────────────────────────────────────────

fn throttled(concurrency: u32) -> PlatformStanding {
    parse(&standing(json!([
        { "scope": "credential", "level": 2, "concurrency": concurrency },
    ])))
}

#[test]
fn nothing_is_enforced_off_the_fleet() {
    let in_flight = Arc::new(InFlight::default());
    let young = Some(now() - chrono::Duration::minutes(5));
    for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
        let admitted = Enforcement::admit_at(
            custody,
            &in_flight,
            &resolved(throttled(1), young, None),
            None,
            now(),
        )
        .expect("admitted");
        assert!(admitted.is_none(), "{custody:?}");
    }
    assert_eq!(in_flight.count("abuse:credential:cred_ladder"), 0);
}

#[test]
fn the_in_flight_cap_refuses_and_frees_on_drop() {
    let in_flight = Arc::new(InFlight::default());
    let org = resolved(throttled(2), None, None);
    let first = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now())
        .unwrap()
        .unwrap();
    let second = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now())
        .unwrap()
        .unwrap();
    let third = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now());
    let Err(GatewayError::AbuseThrottled(detail)) = third else {
        panic!("third request must be throttled: {third:?}");
    };
    assert_eq!(detail.retry_after_secs, Some(CONCURRENCY_RETRY_AFTER_SECS));
    assert_eq!(detail.appeal_url.as_deref(), Some(APPEAL));
    // A clone of the request keeps the slot; the last drop frees it.
    let clone = Arc::clone(&first);
    drop(first);
    assert_eq!(in_flight.count("abuse:credential:cred_ladder"), 2);
    drop(clone);
    assert_eq!(in_flight.count("abuse:credential:cred_ladder"), 1);
    assert!(Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).is_ok());
    drop(second);
}

#[test]
fn a_refused_request_holds_no_slot() {
    let in_flight = Arc::new(InFlight::default());
    // Two subjects; the second is full, so the first slot is given back.
    let standing = parse(&standing(json!([
        { "scope": "org", "level": 2, "concurrency": 5 },
        { "scope": "credential", "level": 2, "concurrency": 1 },
    ])));
    let org = resolved(standing, None, None);
    let held = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).unwrap();
    assert!(Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).is_err());
    assert_eq!(in_flight.count("abuse:org:org_ladder"), 1);
    drop(held);
    assert_eq!(in_flight.count("abuse:org:org_ladder"), 0);
}

#[test]
fn caps_are_this_replicas_share_of_the_fleet() {
    let in_flight = Arc::new(InFlight::default());
    // 4 in flight across 2 gateways: 2 here.
    let org = resolved(throttled(4), None, Some(2));
    let a = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).unwrap();
    let b = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).unwrap();
    assert!(Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).is_err());
    drop((a, b));
}

#[test]
fn a_new_key_has_its_own_in_flight_cap_and_code() {
    let in_flight = Arc::new(InFlight::default());
    let org = resolved(
        PlatformStanding::active(),
        Some(now() - chrono::Duration::hours(1)),
        None,
    );
    let held: Vec<_> = (0..NEW_KEY_CONCURRENCY)
        .map(|_| {
            Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now()).unwrap()
        })
        .collect();
    let refused = Enforcement::admit_at(GatewayCustody::Fleet, &in_flight, &org, None, now());
    assert!(matches!(
        refused,
        Err(GatewayError::NewKeyRateLimited { .. })
    ));
    drop(held);
}

#[test]
fn retry_after_covers_one_refill() {
    assert_eq!(retry_after(1), 60);
    assert_eq!(retry_after(7), 9);
    assert_eq!(retry_after(60), 1);
    assert_eq!(retry_after(600), 1);
}

#[test]
fn the_strict_matrix_blocks_every_flag() {
    assert_eq!(strict(CodeAction::Flag, true), CodeAction::Block);
    assert_eq!(strict(CodeAction::Flag, false), CodeAction::Flag);
    assert_eq!(strict(CodeAction::Allow, true), CodeAction::Allow);
    assert_eq!(strict(CodeAction::Block, false), CodeAction::Block);
}

// ── catalogue ───────────────────────────────────────────────────────────────

async fn render(error: GatewayError) -> (StatusCode, Option<String>, Value) {
    let response = error.into_response();
    let status = response.status();
    let retry = response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, retry, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn the_ladder_codes_render_as_catalogued() {
    let refusal = LadderRefusal {
        appeal_url: Some(APPEAL.to_owned()),
        reason_class: Some("velocity".to_owned()),
        until: Some("2026-10-25T00:00:00.000Z".to_owned()),
        retry_after_secs: Some(6),
    };
    let (status, retry, body) =
        render(GatewayError::AbuseThrottled(Box::new(refusal.clone()))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(retry.as_deref(), Some("6"));
    let error = &body["error"];
    assert_eq!(error["type"], "rate_limit_exceeded");
    assert_eq!(error["code"], "abuse_throttled");
    assert_eq!(error["layer"], "platform");
    assert_eq!(error["remedy"], "appeal");
    assert_eq!(error["appeal_url"], APPEAL);
    assert_eq!(error["reason_class"], "velocity");
    assert_eq!(error["retry_after"], 6);

    let restricted = LadderRefusal {
        retry_after_secs: None,
        ..refusal
    };
    let (status, retry, body) = render(GatewayError::AccountRestricted(Box::new(restricted))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(retry.is_none());
    let error = &body["error"];
    assert_eq!(error["type"], "policy_violation");
    assert_eq!(error["code"], "account_restricted");
    assert_eq!(error["layer"], "platform");
    assert_eq!(error["remedy"], "appeal");
    assert_eq!(error["appeal_url"], APPEAL);
    assert_eq!(error["until"], "2026-10-25T00:00:00.000Z");

    let (status, retry, body) = render(GatewayError::NewKeyRateLimited {
        retry_after_secs: 2,
    })
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(retry.as_deref(), Some("2"));
    let error = &body["error"];
    assert_eq!(error["type"], "rate_limit_exceeded");
    assert_eq!(error["code"], "new_key_rate_limited");
    assert_eq!(error["remedy"], "none");
    assert!(error.get("appeal_url").is_none());
}

#[test]
fn ladder_refusals_are_safety_outcomes_with_their_wire_codes() {
    let cases = [
        (
            GatewayError::AbuseThrottled(Box::default()),
            StatusCode::TOO_MANY_REQUESTS,
            "abuse_throttled",
        ),
        (
            GatewayError::AccountRestricted(Box::default()),
            StatusCode::FORBIDDEN,
            "account_restricted",
        ),
        (
            GatewayError::NewKeyRateLimited {
                retry_after_secs: 1,
            },
            StatusCode::TOO_MANY_REQUESTS,
            "new_key_rate_limited",
        ),
    ];
    for (error, status, code) in cases {
        assert!(error.is_safety_outcome(), "{code}");
        assert!(error.ends_hosted_attempt(), "{code}");
        assert_eq!(error.wire_status_and_code(), (status, code));
    }
}

// ── floor list ──────────────────────────────────────────────────────────────

fn floor_with(restricted: Value) -> Option<Arc<crate::platform_floor::PlatformFloor>> {
    crate::platform_floor::PlatformFloor::from_wire(
        Some(&json!({
            "version": 2,
            "overlay": { "enabled": true },
            "restrictedModels": restricted,
        })),
        false,
    )
}

#[test]
fn the_floor_carries_the_restricted_model_list() {
    let floor = floor_with(json!(["vendor/small-model", "other/mini"])).expect("parses");
    assert_eq!(
        floor.restricted_models,
        vec!["vendor/small-model".to_owned(), "other/mini".to_owned()]
    );
    assert!(floor_with(json!([])).unwrap().restricted_models.is_empty());
    for bad in [
        json!([""]),
        json!([" padded "]),
        json!(["a".repeat(257)]),
        json!([7]),
        json!("vendor/small-model"),
        Value::Array(
            (0..=MAX_RESTRICTED_MODELS)
                .map(|i| json!(format!("m{i}")))
                .collect(),
        ),
    ] {
        assert!(floor_with(bad.clone()).is_none(), "{bad}");
    }
}

// ── public docs ─────────────────────────────────────────────────────────────

const ERRORS_PAGE: &str =
    include_str!("../../fumadocs/content/docs/gateway/managed-data-plane.mdx");
/// The ladder-code rows moved from the errors page to the account standing page.
const STANDING_PAGE: &str =
    include_str!("../../fumadocs/content/docs/gateway/account-standing.mdx");

/// The public account standing page has one row per ladder code, with the
/// status, `type` and `Retry-After` the Gateway really sends, and neither
/// public page names the internal enforcement route or its secret.
#[tokio::test]
async fn the_errors_page_matches_the_ladder_codes() {
    let mut misses = Vec::new();
    for error in [
        GatewayError::AbuseThrottled(Box::new(LadderRefusal {
            retry_after_secs: Some(6),
            ..LadderRefusal::default()
        })),
        GatewayError::AccountRestricted(Box::default()),
        GatewayError::NewKeyRateLimited {
            retry_after_secs: 2,
        },
    ] {
        let (status, retry, body) = render(error).await;
        let code = body["error"]["code"].as_str().unwrap().to_owned();
        let kind = body["error"]["type"].as_str().unwrap().to_owned();
        let remedy = body["error"]["remedy"].as_str().unwrap().to_owned();
        let Some(row) = STANDING_PAGE
            .lines()
            .find(|line| line.starts_with('|') && line.contains(&format!("`code: \"{code}\"`")))
        else {
            misses.push(format!("{code}: no row"));
            continue;
        };
        if !row.contains(&format!("`{}`", status.as_u16())) {
            misses.push(format!("{code}: status"));
        }
        if !row.contains(&format!("`type: \"{kind}\"`")) {
            misses.push(format!("{code}: type"));
        }
        if !row.contains(&format!("`remedy: \"{remedy}\"`")) {
            misses.push(format!("{code}: remedy"));
        }
        if retry.is_some() != row.contains("Retry-After") {
            misses.push(format!("{code}: Retry-After"));
        }
    }
    for needle in [
        "/internal/enforcement",
        "x-ryu-internal-secret",
        "RYU_VAULT_INTERNAL_SECRET",
    ] {
        for (page, text) in [
            ("managed-data-plane", ERRORS_PAGE),
            ("account-standing", STANDING_PAGE),
        ] {
            if text.contains(needle) {
                misses.push(format!("{page} names {needle}"));
            }
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}
